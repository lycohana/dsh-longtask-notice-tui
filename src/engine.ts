import {normalizeConfig} from "./config.js";
import {validateTaskEvent} from "./contracts/task-lifecycle.js";
import {systemClock, type Clock, type TimerHandle} from "./time.js";
import type {
  DeliveryRecord,
  EngineStatus,
  Logger,
  NormalizedConfig,
  NotificationChannel,
  NotificationConfig,
  NotificationMessage,
  NotificationType,
  NoticeLanguage,
  PersistedState,
  StateStore,
  TaskEvent,
  TaskRecord,
  TaskTerminalState,
} from "./types.js";

const STATE_VERSION = 1 as const;
const MAX_PROCESSED_EVENT_IDS = 100;

export interface ProcessResult {
  duplicate: boolean;
  notificationsSent: number;
  deliveryFailures: number;
}

export interface EngineOptions {
  clock?: Clock;
  logger?: Logger;
  language?: NoticeLanguage;
}

export class NotifierEngine {
  private config: NormalizedConfig;
  private state: PersistedState = {version: STATE_VERSION, tasks: {}};
  private readonly clock: Clock;
  private readonly logger: Logger;
  private language: NoticeLanguage;
  private readonly timers = new Map<string, TimerHandle>();
  private queue: Promise<unknown> = Promise.resolve();
  private started = false;

  constructor(
    config: NotificationConfig,
    private readonly store: StateStore,
    private channels: readonly NotificationChannel[],
    options: EngineOptions = {},
  ) {
    this.config = normalizeConfig(config);
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? {};
    this.language = options.language ?? defaultLanguage();
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    const persisted = await this.store.load();
    this.state = normalizeState(persisted);
    this.started = true;
    for (const record of Object.values(this.state.tasks)) {
      this.scheduleThreshold(record);
    }
    await this.store.save(this.state);
  }

  async stop(): Promise<void> {
    for (const timer of this.timers.values()) {
      this.clock.clearTimer(timer);
    }
    this.timers.clear();
    await this.queue;
    await this.store.save(this.state);
    this.started = false;
  }

  async handle(event: TaskEvent): Promise<ProcessResult> {
    return this.enqueue(() => this.processEvent(event));
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.enqueue(async () => {
      this.state.enabledOverride = enabled;
      await this.store.save(this.state);
    });
  }

  async reloadConfig(config: NotificationConfig, channels?: readonly NotificationChannel[]): Promise<void> {
    const normalized = normalizeConfig(config);
    await this.enqueue(async () => {
      this.config = normalized;
      if (channels !== undefined) {
        this.channels = channels;
      }
      for (const record of Object.values(this.state.tasks)) {
        this.scheduleThreshold(record);
      }
      await this.store.save(this.state);
    });
  }

  setLanguage(language: NoticeLanguage): void {
    this.language = language;
  }

  async forgetSession(sessionId: string): Promise<void> {
    await this.enqueue(async () => {
      for (const [key, record] of Object.entries(this.state.tasks)) {
        if (record.sessionId !== sessionId) {
          continue;
        }
        this.clearTimer(key);
        delete this.state.tasks[key];
      }
      await this.store.save(this.state);
    });
  }

  getStatus(): EngineStatus {
    const records = Object.values(this.state.tasks);
    return {
      enabled: this.isEnabled(),
      thresholdSeconds: this.config.thresholdSeconds,
      runningTasks: records.filter((record) => record.state === "running").length,
      longRunningTasks: records.filter((record) => record.state === "long_running").length,
      awaitingInputTasks: records.filter((record) => record.state === "awaiting_input").length,
      terminalTasks: records.filter((record) => isTerminal(record.state)).length,
      failedDeliveries: records.reduce(
        (count, record) => count + Object.values(record.deliveries).filter((delivery) => delivery.state === "failed").length,
        0,
      ),
      trackedTasks: records.length,
    };
  }

  async testChannels(channelIds?: readonly string[], language: NoticeLanguage = this.language): Promise<{channelId: string; accepted: boolean; detail?: string}[]> {
    const message: NotificationMessage = {
      type: "test",
      language,
      taskId: "test-task",
      sessionId: "test-session",
      state: "test",
      summary: language === "en" ? "dsh-longtask-notice channel test" : "长任务通知渠道测试",
      occurredAt: new Date(this.clock.now()).toISOString(),
      idempotencyKey: `test:${this.clock.now()}`,
    };
    const selected = channelIds === undefined
      ? this.channels
      : this.channels.filter((channel) => channelIds.includes(channel.id));
    return Promise.all(selected.map(async (channel) => {
        try {
          const result = await channel.send(message);
          return {channelId: channel.id, accepted: result.accepted, detail: result.detail};
        } catch (error) {
          return {channelId: channel.id, accepted: false, detail: errorMessage(error)};
        }
      }));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async processEvent(rawEvent: TaskEvent): Promise<ProcessResult> {
    const event = validateTaskEvent(rawEvent);
    const key = taskKey(event.sessionId, event.taskId);
    let record: TaskRecord | undefined = this.state.tasks[key];

    if (event.eventType === "task.started" && record && isTerminal(record.state)) {
      record = undefined;
      delete this.state.tasks[key];
    }
    if (!record) {
      record = createTaskRecord(event, key);
      this.state.tasks[key] = record;
    }
    if (record.processedEventIds.includes(event.eventId)) {
      return {duplicate: true, notificationsSent: 0, deliveryFailures: 0};
    }

    rememberEvent(record, event.eventId);
    record.lastEventAt = event.occurredAt;
    record.summary = safeSummary(event.summary ?? record.summary);
    if (event.lastReply !== undefined) {
      record.lastReply = safeReply(event.lastReply);
    }
    if (event.error) {
      record.error = {
        code: safeSummary(event.error.code),
        summary: safeSummary(event.error.summary),
      };
    }
    if (event.request) {
      record.request = {...event.request, summary: safeSummary(event.request.summary)};
    }

    if (event.eventType === "task.started") {
      if (!isTerminal(record.state)) {
        record.state = "running";
        record.startedAt = event.startedAt ?? record.startedAt;
      }
      this.scheduleThreshold(record);
      await this.store.save(this.state);
      return {duplicate: false, notificationsSent: 0, deliveryFailures: 0};
    }

    if (isTerminalEvent(event.eventType)) {
      const shouldNotify = record.state === "long_running"
        || record.state === "awaiting_input"
        || hasReachedThreshold(record, event, this.config.thresholdSeconds);
      record.state = terminalState(event.eventType);
      this.clearTimer(record.key);
      await this.store.save(this.state);
      return shouldNotify
        ? this.notify(record, event, terminalStateToNotification(record.state))
        : {duplicate: false, notificationsSent: 0, deliveryFailures: 0};
    }

    record.state = "awaiting_input";
    this.clearTimer(record.key);
    await this.store.save(this.state);
    return this.isEnabled() && this.config.notify.inputRequired
      ? this.notify(record, event, "input_required")
      : {duplicate: false, notificationsSent: 0, deliveryFailures: 0};
  }

  private async markLongRunning(key: string): Promise<void> {
    const record = this.state.tasks[key];
    this.timers.delete(key);
    if (!record || record.state !== "running") {
      return;
    }
    record.state = "long_running";
    await this.store.save(this.state);
  }

  private scheduleThreshold(record: TaskRecord): void {
    this.clearTimer(record.key);
    if (isTerminal(record.state) || record.state === "long_running" || record.state === "awaiting_input") {
      return;
    }
    const target = Date.parse(record.startedAt) + this.config.thresholdSeconds * 1000;
    const delay = Math.max(0, target - this.clock.now());
    const timer = this.clock.setTimer(delay, () => {
      void this.enqueue(() => this.markLongRunning(record.key));
    });
    this.timers.set(record.key, timer);
  }

  private clearTimer(key: string): void {
    const timer = this.timers.get(key);
    if (timer) {
      this.clock.clearTimer(timer);
      this.timers.delete(key);
    }
  }

  private async notify(
    record: TaskRecord,
    event: TaskEvent,
    type: NotificationType,
  ): Promise<ProcessResult> {
    if (!this.isEnabled() || !this.isNotificationEnabled(type) || this.channels.length === 0) {
      return {duplicate: false, notificationsSent: 0, deliveryFailures: 0};
    }
    const eventKey = type === "input_required"
      ? `${type}:${event.request?.requestId ?? event.eventId}`
      : type;
    const message = buildMessage(record, event, type, eventKey, this.clock.now(), this.language);
    let notificationsSent = 0;
    let deliveryFailures = 0;
    for (const channel of this.channels) {
      const deliveryKey = `${eventKey}|${channel.id}`;
      const delivery = record.deliveries[deliveryKey];
      if (delivery?.state === "sent") {
        continue;
      }
      const result = await this.deliver(record, deliveryKey, channel, message);
      if (result) {
        notificationsSent += 1;
      } else {
        deliveryFailures += 1;
      }
    }
    await this.store.save(this.state);
    return {duplicate: false, notificationsSent, deliveryFailures};
  }

  private async deliver(
    record: TaskRecord,
    deliveryKey: string,
    channel: NotificationChannel,
    message: NotificationMessage,
  ): Promise<boolean> {
    const previous = record.deliveries[deliveryKey];
    const startAttempt = previous?.state === "failed" ? 0 : previous?.attempts ?? 0;
    for (let attempt = startAttempt + 1; attempt <= this.config.retry.maxAttempts; attempt += 1) {
      const delivery: DeliveryRecord = {
        state: "sending",
        attempts: attempt,
        lastAttemptAt: new Date(this.clock.now()).toISOString(),
      };
      record.deliveries[deliveryKey] = delivery;
      await this.store.save(this.state);
      try {
        const result = await channel.send(message);
        if (!result.accepted) {
          throw new Error(result.detail || "notification channel rejected the message");
        }
        delivery.state = "sent";
        await this.store.save(this.state);
        return true;
      } catch (error) {
        delivery.state = "failed";
        delivery.lastError = errorMessage(error);
        this.logger.warn?.("notification delivery attempt failed", {
          channelId: channel.id,
          attempt,
          error: delivery.lastError,
        });
        await this.store.save(this.state);
        if (attempt < this.config.retry.maxAttempts) {
          await this.clock.sleep(retryDelay(this.config, attempt));
        }
      }
    }
    return false;
  }

  private isEnabled(): boolean {
    return this.state.enabledOverride ?? this.config.enabled;
  }

  private isNotificationEnabled(type: NotificationType): boolean {
    if (type === "test") {
      return true;
    }
    if (type === "input_required") {
      return this.config.notify.inputRequired;
    }
    return this.config.notify[type];
  }
}

function normalizeState(value: PersistedState | null): PersistedState {
  if (!value || value.version !== STATE_VERSION || !value.tasks || typeof value.tasks !== "object") {
    return {version: STATE_VERSION, tasks: {}};
  }
  return {
    version: STATE_VERSION,
    enabledOverride: typeof value.enabledOverride === "boolean" ? value.enabledOverride : undefined,
    tasks: value.tasks,
  };
}

function createTaskRecord(event: TaskEvent, key: string): TaskRecord {
  return {
    key,
    taskId: event.taskId,
    sessionId: event.sessionId,
    scope: event.scope,
    startedAt: event.startedAt ?? event.occurredAt,
    lastEventAt: event.occurredAt,
    state: "running",
    summary: safeSummary(event.summary),
    lastReply: event.lastReply ? safeReply(event.lastReply) : undefined,
    processedEventIds: [],
    deliveries: {},
  };
}

function rememberEvent(record: TaskRecord, eventId: string): void {
  record.processedEventIds.push(eventId);
  if (record.processedEventIds.length > MAX_PROCESSED_EVENT_IDS) {
    record.processedEventIds.splice(0, record.processedEventIds.length - MAX_PROCESSED_EVENT_IDS);
  }
}

function buildMessage(
  record: TaskRecord,
  event: TaskEvent,
  type: NotificationType,
  eventKey: string,
  now: number,
  language: NoticeLanguage,
): NotificationMessage {
  const startedAt = record.startedAt;
  const durationMs = Math.max(0, now - Date.parse(startedAt));
  return {
    type,
    language,
    taskId: record.taskId,
    sessionId: record.sessionId,
    state: event.eventType,
    summary: safeSummary(event.summary ?? record.summary ?? "Task state changed"),
    occurredAt: event.occurredAt,
    startedAt,
    durationMs,
    lastReply: safeReply(event.lastReply ?? record.lastReply) || undefined,
    error: event.error,
    request: event.request,
    idempotencyKey: `${record.key}:${eventKey}`,
  };
}

function defaultLanguage(): NoticeLanguage {
  return process.env.DSH_TUI_LANG?.toLowerCase() === "en" ? "en" : "zh";
}

function retryDelay(config: NormalizedConfig, attempt: number): number {
  const exponential = config.retry.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(config.retry.maxDelayMs, exponential);
}

function hasReachedThreshold(record: TaskRecord, event: TaskEvent, thresholdSeconds: number): boolean {
  const startedAt = Date.parse(record.startedAt);
  const occurredAt = Date.parse(event.occurredAt);
  return Number.isFinite(startedAt)
    && Number.isFinite(occurredAt)
    && occurredAt - startedAt >= thresholdSeconds * 1000;
}

function taskKey(sessionId: string, taskId: string): string {
  return `${sessionId}\u0000${taskId}`;
}

function isTerminal(value: TaskRecord["state"]): boolean {
  return value === "completed" || value === "failed" || value === "cancelled";
}

function isTerminalEvent(value: TaskEvent["eventType"]): boolean {
  return value === "task.completed" || value === "task.failed" || value === "task.cancelled";
}

function terminalState(eventType: TaskEvent["eventType"]): TaskTerminalState {
  if (eventType === "task.completed") {
    return "completed";
  }
  if (eventType === "task.failed") {
    return "failed";
  }
  return "cancelled";
}

function terminalStateToNotification(state: TaskTerminalState): NotificationType {
  return state;
}

function safeSummary(value: string | undefined): string {
  return (value ?? "").replace(/[\u0000-\u001f\u007f\r\n]+/g, " ").slice(0, 1024).trim();
}

function safeReply(value: string | undefined): string {
  return (value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 12000);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return safeSummary(error.message) || "unknown error";
  }
  return "unknown error";
}
