import type {
  ChannelConfig,
  NormalizedConfig,
  NotificationConfig,
  SmtpChannelConfig,
  WebhookChannelConfig,
} from "./types.js";

const DEFAULT_THRESHOLD_SECONDS = 600;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30000;

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export function normalizeConfig(input: NotificationConfig): NormalizedConfig {
  if (!input || !Array.isArray(input.channels)) {
    throw new ConfigurationError("channels must be an array");
  }

  const config: NormalizedConfig = {
    enabled: input.enabled ?? true,
    thresholdSeconds: input.thresholdSeconds ?? DEFAULT_THRESHOLD_SECONDS,
    notify: {
      completed: input.notify?.completed ?? true,
      failed: input.notify?.failed ?? true,
      cancelled: input.notify?.cancelled ?? true,
      inputRequired: input.notify?.inputRequired ?? true,
    },
    retry: {
      maxAttempts: input.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      baseDelayMs: input.retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
      maxDelayMs: input.retry?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    },
    channels: input.channels.map((channel) => ({...channel})),
  };

  validateNumber("thresholdSeconds", config.thresholdSeconds, 1, 31536000);
  validateNumber("retry.maxAttempts", config.retry.maxAttempts, 1, 10);
  validateNumber("retry.baseDelayMs", config.retry.baseDelayMs, 0, 300000);
  validateNumber("retry.maxDelayMs", config.retry.maxDelayMs, 0, 3600000);
  if (config.retry.maxDelayMs < config.retry.baseDelayMs) {
    throw new ConfigurationError("retry.maxDelayMs must be >= retry.baseDelayMs");
  }

  const ids = new Set<string>();
  for (const channel of config.channels) {
    if (ids.has(channel.id)) {
      throw new ConfigurationError(`duplicate channel id: ${channel.id}`);
    }
    ids.add(channel.id);
    validateChannel(channel);
  }
  return config;
}

function validateChannel(channel: ChannelConfig): void {
  if (!/^[a-z0-9][a-z0-9.-]{1,63}$/.test(channel.id)) {
    throw new ConfigurationError(`invalid channel id: ${channel.id}`);
  }
  if (channel.type === "smtp") {
    validateSmtp(channel);
    return;
  }
  validateWebhook(channel);
}

function validateSmtp(channel: SmtpChannelConfig): void {
  if (!channel.host || /[\r\n]/.test(channel.host)) {
    throw new ConfigurationError("smtp.host must be a non-empty hostname");
  }
  validateNumber("smtp.port", channel.port, 1, 65535);
  validateHeader("smtp.from", channel.from);
  if (!channel.to.length || channel.to.some((address) => !isEmail(address))) {
    throw new ConfigurationError("smtp.to must contain valid email addresses");
  }
  if (channel.username && /[\r\n]/.test(channel.username)) {
    throw new ConfigurationError("smtp.username contains a line break");
  }
  if (channel.passwordRef && !/^[A-Za-z_][A-Za-z0-9_:-]{1,127}$/.test(channel.passwordRef)) {
    throw new ConfigurationError("smtp.passwordRef is not a valid secret reference");
  }
}

function validateWebhook(channel: WebhookChannelConfig): void {
  let parsed: URL;
  try {
    parsed = new URL(channel.url);
  } catch {
    throw new ConfigurationError(`invalid webhook URL for ${channel.id}`);
  }
  if (parsed.username || parsed.password) {
    throw new ConfigurationError("webhook URL must not contain credentials");
  }
  if (parsed.protocol !== "https:" && !(channel.allowInsecureHttp && parsed.protocol === "http:")) {
    throw new ConfigurationError("webhook URL must use https unless allowInsecureHttp is enabled");
  }
  validateNumber(`${channel.id}.timeoutMs`, channel.timeoutMs ?? 10000, 100, 120000);
  if (channel.secretRef && !/^[A-Za-z_][A-Za-z0-9_:-]{1,127}$/.test(channel.secretRef)) {
    throw new ConfigurationError("webhook.secretRef is not a valid secret reference");
  }
  for (const [name, value] of Object.entries(channel.headers ?? {})) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(value)) {
      throw new ConfigurationError(`invalid webhook header: ${name}`);
    }
  }
}

function validateHeader(name: string, value: string): void {
  if (!value || /[\r\n]/.test(value)) {
    throw new ConfigurationError(`${name} must be non-empty and must not contain line breaks`);
  }
}

function validateNumber(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigurationError(`${name} must be an integer between ${min} and ${max}`);
  }
}

function isEmail(value: string): boolean {
  return /^[^\s@\r\n]+@[^\s@\r\n]+\.[^\s@\r\n]+$/.test(value);
}
