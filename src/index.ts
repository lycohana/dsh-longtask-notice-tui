import type {Context} from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import type {} from "@deepseek-ai/dsh-agent";
import type {NotificationConfig, SecretProvider} from "./types.js";
import {normalizeConfig} from "./config.js";
import {createChannels} from "./channels/index.js";
import {NotifierEngine} from "./engine.js";
import {MemoryStateStore} from "./storage.js";
import {openTurnToTaskEvent, sessionEventToTaskEvent} from "./dsh-adapter.js";

export type * from "./events.js";
export {NotifierEngine} from "./engine.js";

export const name = "longtask-notice-tui";

export type Config = {
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
  channels?: NotificationConfig["channels"];
};

const channelSchema = z.union([
  z.object({
    type: z.const("smtp"),
    id: z.string().default("default-email"),
    host: z.string().default(""),
    port: z.number().step(1).min(1).max(65535).default(587),
    secure: z.boolean().default(false),
    requireTls: z.boolean().default(true),
    from: z.string().default(""),
    to: z.array(z.string()).default([]),
    username: z.string().default(""),
    passwordRef: z.string().default(""),
    replyTo: z.string().default(""),
  }),
  z.object({
    type: z.const("webhook"),
    id: z.string().default("default-webhook"),
    url: z.string().default(""),
    headers: z.dict(z.string()).default({}),
    secretRef: z.string().default(""),
    timeoutMs: z.number().step(100).min(100).max(120000).default(10000),
    allowInsecureHttp: z.boolean().default(false),
    allowPrivateNetwork: z.boolean().default(false),
  }),
]);

export const Config: Schemastery<Config> = z.object({
  enabled: z.boolean().default(true),
  thresholdSeconds: z.number().step(1).min(1).max(31536000).default(600),
  notify: z.object({
    completed: z.boolean().default(true),
    failed: z.boolean().default(true),
    cancelled: z.boolean().default(true),
    inputRequired: z.boolean().default(true),
  }).default({completed: true, failed: true, cancelled: true, inputRequired: true}),
  retry: z.object({
    maxAttempts: z.number().step(1).min(1).max(10).default(3),
    baseDelayMs: z.number().step(100).min(0).max(300000).default(1000),
    maxDelayMs: z.number().step(100).min(0).max(3600000).default(30000),
  }).default({maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30000}),
  channels: z.array(channelSchema).default([]),
});

type NoticeSettings = {
  enabled: boolean;
  thresholdSeconds: number;
};

const NoticeSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  thresholdSeconds: z.number().step(1).min(1).max(31536000).default(600),
});

interface CommandService {
  register(definition: {
    name: string;
    description: string;
    input?: {hint: string};
    handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>;
  }): () => void;
}

interface CommandContext {
  commands: CommandService;
}

interface CommandInvocation {
  rawInput?: string;
  signal?: AbortSignal;
}

interface CommandResultSuccess {
  kind: "success";
  text?: string;
}

interface CommandResultError {
  kind: "error";
  text: string;
}

type CommandResult = CommandResultSuccess | CommandResultError;

interface SettingsScope<T> {
  get(): T;
  update(patch: object): Promise<void>;
  watch(callback: (next: T, previous: T) => void | Promise<void>): () => void;
}

interface SettingsService {
  register<T>(namespace: string, schema: unknown, options?: {base?: Partial<T>}): SettingsScope<T>;
}

const SECRET_ENV_PREFIX = "DSH_NOTICE_";

export function apply(ctx: Context, config: Config = {}): void {
  const resolvedConfig: NotificationConfig = {
    enabled: config.enabled ?? true,
    thresholdSeconds: config.thresholdSeconds ?? 600,
    notify: {
      completed: config.notify?.completed ?? true,
      failed: config.notify?.failed ?? true,
      cancelled: config.notify?.cancelled ?? true,
      inputRequired: config.notify?.inputRequired ?? true,
    },
    retry: {
      maxAttempts: config.retry?.maxAttempts ?? 3,
      baseDelayMs: config.retry?.baseDelayMs ?? 1000,
      maxDelayMs: config.retry?.maxDelayMs ?? 30000,
    },
    channels: config.channels ?? [],
  };
  const normalized = normalizeConfig(resolvedConfig);
  const engine = new NotifierEngine(
    normalized,
    new MemoryStateStore(),
    createChannels(normalized, environmentSecrets),
    {logger: debugLogger},
  );
  const settings = registerSettings(ctx, normalized);
  const ready = engine.start();
  const applySettings = (next: NoticeSettings): Promise<void> => ready.then(() => engine.reloadConfig({
    ...normalized,
    enabled: next.enabled,
    thresholdSeconds: next.thresholdSeconds,
  }));

  if (settings) {
    void applySettings(settings.get()).catch((error: unknown) => {
      debugLogger.error?.("settings initialization failed", {error: errorText(error)});
    });
    const unwatch = settings.watch((next) => {
      void applySettings(next).catch((error: unknown) => {
        debugLogger.error?.("settings update failed", {error: errorText(error)});
      });
    });
    ctx.effect(() => () => unwatch(), "longtask-notice settings");
  }

  ctx.on("session/created", (session) => {
    const taskEvent = openTurnToTaskEvent(session);
    if (!taskEvent) return;
    void ready
      .then(() => engine.handle(taskEvent))
      .catch((error: unknown) => debugLogger.error?.("session recovery failed", {error: errorText(error)}));
  });

  ctx.on("session/event", (session, event) => {
    const taskEvent = sessionEventToTaskEvent(session, event);
    if (!taskEvent) return;
    void ready
      .then(() => engine.handle(taskEvent))
      .catch((error: unknown) => debugLogger.error?.("task event handling failed", {error: errorText(error)}));
  });

  ctx.on("session/disposed", (session) => {
    void ready
      .then(() => engine.forgetSession(String(session.id)))
      .catch((error: unknown) => debugLogger.error?.("session cleanup failed", {error: errorText(error)}));
  });

  ctx.inject(["commands"], (commandCtx) => {
    const commands = (commandCtx as unknown as CommandContext).commands;
    const dispose = commands.register({
      name: "notice",
      description: "Control long-task notifications",
      input: {hint: "status | on | off | threshold <seconds> | test"},
      handler: async (invocation) => {
        try {
          await ready;
          return await runNoticeCommand(engine, settings, applySettings, invocation.rawInput ?? "");
        } catch (error) {
          return failure(errorText(error));
        }
      },
    });
    ctx.effect(() => () => dispose(), "longtask-notice commands");
  });

  ctx.effect(() => () => {
    void engine.stop();
  }, "longtask-notice engine");
}

const environmentSecrets: SecretProvider = {
  async getSecret(reference: string): Promise<string | undefined> {
    if (!reference) return undefined;
    const envName = reference.startsWith(SECRET_ENV_PREFIX) ? reference : `${SECRET_ENV_PREFIX}${reference}`;
    return process.env[envName];
  },
};

const debugLogger = {
  info: (message: string, details?: Record<string, unknown>) => debugWrite("info", message, details),
  warn: (message: string, details?: Record<string, unknown>) => debugWrite("warn", message, details),
  error: (message: string, details?: Record<string, unknown>) => debugWrite("error", message, details),
};

function registerSettings(ctx: Context, config: ReturnType<typeof normalizeConfig>): SettingsScope<NoticeSettings> | undefined {
  const service = ctx.get("settings", false) as SettingsService | undefined;
  if (!service) return undefined;
  try {
    return service.register("longtask-notice", NoticeSettingsSchema, {
      base: {
        enabled: config.enabled,
        thresholdSeconds: config.thresholdSeconds,
      },
    });
  } catch (error) {
    debugLogger.warn?.("settings service unavailable", {error: errorText(error)});
    return undefined;
  }
}

async function runNoticeCommand(
  engine: NotifierEngine,
  settings: SettingsScope<NoticeSettings> | undefined,
  applySettings: (next: NoticeSettings) => Promise<void>,
  rawInput: string,
): Promise<CommandResult> {
  const parts = rawInput.trim().split(/\s+/u).filter(Boolean);
  const subcommand = (parts.shift() ?? "status").toLowerCase();
  switch (subcommand) {
    case "status":
      return success(JSON.stringify(engine.getStatus(), null, 2));
    case "help":
      return success("Usage: /notice [status|on|off|threshold <seconds>|test]");
    case "on":
    case "enable":
      await updateNoticeSettings(engine, settings, applySettings, {enabled: true});
      return success("long-task notifications enabled");
    case "off":
    case "disable":
      await updateNoticeSettings(engine, settings, applySettings, {enabled: false});
      return success("long-task notifications disabled");
    case "threshold": {
      const value = parts.length === 1 ? Number(parts[0]) : Number.NaN;
      if (!Number.isInteger(value) || value < 1 || value > 31536000) {
        return failure("threshold must be an integer between 1 and 31536000 seconds");
      }
      await updateNoticeSettings(engine, settings, applySettings, {thresholdSeconds: value});
      return success(`long-task threshold set to ${value} seconds`);
    }
    case "test":
      return success(JSON.stringify(await engine.testChannels(), null, 2));
    default:
      return failure(`unknown /notice action: ${subcommand}. Use /notice help`);
  }
}

async function updateNoticeSettings(
  engine: NotifierEngine,
  settings: SettingsScope<NoticeSettings> | undefined,
  applySettings: (next: NoticeSettings) => Promise<void>,
  patch: Partial<NoticeSettings>,
): Promise<void> {
  if (!settings) {
    if (patch.enabled !== undefined) {
      await engine.setEnabled(patch.enabled);
    }
    if (patch.thresholdSeconds !== undefined) {
      const current = engine.getStatus();
      await applySettings({
        enabled: current.enabled,
        thresholdSeconds: patch.thresholdSeconds,
      });
    }
    return;
  }
  await settings.update(patch);
  await applySettings(settings.get());
}

function debugWrite(level: string, message: string, details?: Record<string, unknown>): void {
  if (process.env.DSH_TUI_DEBUG !== "1") return;
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  process.stderr.write(`[longtask-notice:${level}] ${message}${suffix}\n`);
}

function success(text: string): CommandResult {
  return {kind: "success", text};
}

function failure(text: string): CommandResult {
  return {kind: "error", text: text || "command failed"};
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
