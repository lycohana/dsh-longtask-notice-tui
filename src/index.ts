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

interface CommandService {
  register(definition: {
    name: string;
    description: string;
    handler: () => unknown | Promise<unknown>;
  }): () => void;
}

interface CommandResult {
  kind: "success" | "error";
  text?: string;
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
  const ready = engine.start();

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

  const commands = ctx.get("commands", false) as CommandService | undefined;
  if (commands) {
    const disposers = [
      commands.register({
        name: "longtask-notice-status",
        description: "Show long-task notification status",
        handler: () => success(JSON.stringify(engine.getStatus())),
      }),
      commands.register({
        name: "longtask-notice-test",
        description: "Send a test notification through every configured channel",
        handler: async () => success(JSON.stringify(await engine.testChannels())),
      }),
      commands.register({
        name: "longtask-notice-enable",
        description: "Enable long-task notifications",
        handler: async () => {
          await engine.setEnabled(true);
          return success("long-task notifications enabled");
        },
      }),
      commands.register({
        name: "longtask-notice-disable",
        description: "Disable long-task notifications",
        handler: async () => {
          await engine.setEnabled(false);
          return success("long-task notifications disabled");
        },
      }),
    ];
    ctx.effect(() => () => {
      for (const dispose of disposers) dispose();
    }, "longtask-notice commands");
  }

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

function debugWrite(level: string, message: string, details?: Record<string, unknown>): void {
  if (process.env.DSH_TUI_DEBUG !== "1") return;
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  process.stderr.write(`[longtask-notice:${level}] ${message}${suffix}\n`);
}

function success(text: string): CommandResult {
  return {kind: "success", text};
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
