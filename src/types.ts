export type TaskEventType =
  | "task.started"
  | "task.completed"
  | "task.failed"
  | "task.cancelled"
  | "task.input_required";

export type TaskTerminalState = "completed" | "failed" | "cancelled";
export type PrivacyClass = "public" | "internal" | "sensitive";
export type NotificationType =
  | "completed"
  | "failed"
  | "cancelled"
  | "input_required"
  | "test";

export type NoticeLanguage = "zh" | "en";

export interface TaskError {
  code: string;
  summary: string;
}

export interface InputRequest {
  requestId: string;
  kind: "confirmation" | "clarification" | "approval" | "other";
  summary: string;
}

export interface TaskEvent {
  eventType: TaskEventType;
  eventVersion: "1.0";
  eventId: string;
  scope: string;
  sequence: number;
  privacyClass: PrivacyClass;
  taskId: string;
  sessionId: string;
  occurredAt: string;
  startedAt?: string;
  summary?: string;
  lastReply?: string;
  error?: TaskError;
  request?: InputRequest;
}

export interface SmtpChannelConfig {
  type: "smtp";
  id: string;
  enabled?: boolean;
  host: string;
  port: number;
  secure: boolean;
  requireTls?: boolean;
  from?: string;
  displayName?: string;
  to: string[];
  username?: string;
  passwordRef?: string;
  replyTo?: string;
}

export interface WebhookChannelConfig {
  type: "webhook";
  id: string;
  enabled?: boolean;
  url: string;
  headers?: Record<string, string>;
  secretRef?: string;
  timeoutMs?: number;
  allowInsecureHttp?: boolean;
  allowPrivateNetwork?: boolean;
}

export interface BarkChannelConfig {
  type: "bark";
  id: string;
  enabled?: boolean;
  /** Bark server base URL; defaults to https://api.day.app. */
  apiUrl?: string;
  /** Secret reference containing the Bark device_key. */
  deviceKeyRef?: string;
  timeoutMs?: number;
  allowInsecureHttp?: boolean;
  allowPrivateNetwork?: boolean;
}

export type ChannelConfig = SmtpChannelConfig | WebhookChannelConfig | BarkChannelConfig;

export interface NotificationConfig {
  enabled?: boolean;
  thresholdSeconds?: number;
  notify?: {
    completed?: boolean;
    failed?: boolean;
    cancelled?: boolean;
    inputRequired?: boolean;
  };
  retry?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
  channels: ChannelConfig[];
}

export interface NormalizedConfig {
  enabled: boolean;
  thresholdSeconds: number;
  notify: {
    completed: boolean;
    failed: boolean;
    cancelled: boolean;
    inputRequired: boolean;
  };
  retry: {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
  channels: ChannelConfig[];
}

export interface NotificationMessage {
  type: NotificationType;
  language?: NoticeLanguage;
  taskId: string;
  sessionId: string;
  state: TaskEventType | "test";
  summary: string;
  lastReply?: string;
  occurredAt: string;
  startedAt?: string;
  durationMs?: number;
  error?: TaskError;
  request?: InputRequest;
  idempotencyKey: string;
}

export interface DeliveryResult {
  accepted: boolean;
  providerId?: string;
  detail?: string;
}

export interface NotificationChannel {
  readonly id: string;
  send(message: NotificationMessage): Promise<DeliveryResult>;
}

export interface SecretProvider {
  getSecret(reference: string): Promise<string | undefined>;
}

export interface StateStore {
  load(): Promise<PersistedState | null>;
  save(state: PersistedState): Promise<void>;
}

export type TrackedTaskState = "running" | "long_running" | "awaiting_input" | TaskTerminalState;
export type DeliveryState = "pending" | "sending" | "sent" | "failed";

export interface DeliveryRecord {
  state: DeliveryState;
  attempts: number;
  lastAttemptAt?: string;
  lastError?: string;
}

export interface TaskRecord {
  key: string;
  taskId: string;
  sessionId: string;
  scope: string;
  startedAt: string;
  lastEventAt: string;
  state: TrackedTaskState;
  summary?: string;
  lastReply?: string;
  error?: TaskError;
  request?: InputRequest;
  processedEventIds: string[];
  deliveries: Record<string, DeliveryRecord>;
}

export interface PersistedState {
  version: 1;
  enabledOverride?: boolean;
  tasks: Record<string, TaskRecord>;
}

export interface EngineStatus {
  enabled: boolean;
  thresholdSeconds: number;
  runningTasks: number;
  longRunningTasks: number;
  awaitingInputTasks: number;
  terminalTasks: number;
  failedDeliveries: number;
  trackedTasks: number;
}

export interface Logger {
  info?(message: string, details?: Record<string, unknown>): void;
  warn?(message: string, details?: Record<string, unknown>): void;
  error?(message: string, details?: Record<string, unknown>): void;
}
