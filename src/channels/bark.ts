import {lookup} from "node:dns/promises";
import {isIP} from "node:net";
import type {BarkChannelConfig, DeliveryResult, NotificationChannel, NotificationMessage, SecretProvider} from "../types.js";
import type {FetchLike, ResolveHost} from "./webhook.js";

export const DEFAULT_BARK_API_URL = "https://api.day.app";

export interface BarkChannelOptions {
  fetch?: FetchLike;
  resolveHost?: ResolveHost;
}

export class BarkChannel implements NotificationChannel {
  readonly id: string;
  private readonly fetcher: FetchLike;
  private readonly resolveHost: ResolveHost;

  constructor(
    private readonly config: BarkChannelConfig,
    private readonly secrets: SecretProvider,
    options: BarkChannelOptions = {},
  ) {
    this.id = config.id;
    this.fetcher = options.fetch ?? fetch;
    this.resolveHost = options.resolveHost ?? resolvePublicAddresses;
  }

  async send(message: NotificationMessage): Promise<DeliveryResult> {
    const deviceKey = await this.secrets.getSecret(this.config.deviceKeyRef ?? "");
    if (!deviceKey) {
      throw new Error(`missing Bark device_key for channel ${this.id}`);
    }

    const target = pushUrl(this.config.apiUrl ?? DEFAULT_BARK_API_URL);
    await assertAllowedTarget(target, this.config.allowInsecureHttp ?? false, this.config.allowPrivateNetwork ?? false, this.resolveHost);

    const response = await this.fetcher(target, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "user-agent": "dsh-longtask-notice-tui/0.1",
        "x-dsh-idempotency-key": message.idempotencyKey,
      },
      body: JSON.stringify({
        device_key: deviceKey,
        title: titleFor(message),
        body: bodyFor(message),
      }),
      redirect: "error",
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 10000),
    });
    if (!response.ok) {
      throw new Error(`Bark returned HTTP ${response.status}`);
    }
    return {accepted: true, providerId: response.headers.get("x-request-id") ?? undefined};
  }
}

function pushUrl(apiUrl: string): URL {
  const target = new URL(apiUrl);
  const pathname = target.pathname.replace(/\/+$/u, "");
  if (!pathname.endsWith("/push")) target.pathname = `${pathname}/push`;
  return target;
}

function titleFor(message: NotificationMessage): string {
  const language = message.language ?? "zh";
  return message.type === "test"
    ? `dsh-TUI · ${language === "en" ? "Bark channel test" : "Bark 渠道测试"}`
    : `dsh-TUI · ${typeLabel(message.type, language)}`;
}

function bodyFor(message: NotificationMessage): string {
  const language = message.language ?? "zh";
  const isEnglish = language === "en";
  const primary = cleanReply(message.lastReply) || cleanText(message.summary || message.taskId);
  const lines = [
    isEnglish ? "Last reply" : "最后回复",
    primary,
    "",
    isEnglish ? `State: ${stateLabel(message.state, language)}` : `状态：${stateLabel(message.state, language)}`,
    isEnglish ? `Task: ${message.taskId}` : `任务：${message.taskId}`,
    isEnglish ? `Session: ${message.sessionId}` : `会话：${message.sessionId}`,
    isEnglish ? `Summary: ${cleanText(message.summary)}` : `摘要：${cleanText(message.summary)}`,
    message.error ? (isEnglish ? `Error: ${cleanText(message.error.code)} - ${cleanText(message.error.summary)}` : `错误：${cleanText(message.error.code)} - ${cleanText(message.error.summary)}`) : undefined,
    message.request ? (isEnglish ? `Request: ${cleanText(message.request.kind)} - ${cleanText(message.request.summary)}` : `请求：${cleanText(message.request.kind)} - ${cleanText(message.request.summary)}`) : undefined,
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

function typeLabel(type: NotificationMessage["type"], language: NotificationMessage["language"] = "zh"): string {
  if (language === "en") {
    return {
      completed: "Completed",
      failed: "Failed",
      cancelled: "Cancelled",
      input_required: "Input required",
      test: "Channel test",
    }[type];
  }
  return {
    completed: "完成",
    failed: "失败",
    cancelled: "取消",
    input_required: "需要输入",
    test: "渠道测试",
  }[type];
}

function stateLabel(state: NotificationMessage["state"], language: NotificationMessage["language"] = "zh"): string {
  if (language === "en") {
    return {
      "task.completed": "Completed",
      "task.failed": "Failed",
      "task.cancelled": "Cancelled",
      "task.input_required": "Input required",
      "task.started": "Started",
      test: "Test",
    }[state];
  }
  return {
    "task.completed": "完成",
    "task.failed": "失败",
    "task.cancelled": "取消",
    "task.input_required": "需要输入",
    "task.started": "开始",
    test: "测试",
  }[state];
}

function cleanText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\r\n]+/gu, " ").slice(0, 1024).trim();
}

function cleanReply(value: string | undefined): string {
  return (value ?? "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .trim()
    .slice(0, 12000);
}

async function assertAllowedTarget(
  target: URL,
  allowInsecureHttp: boolean,
  allowPrivateNetwork: boolean,
  resolveHost: ResolveHost,
): Promise<void> {
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new Error("Bark API URL protocol is not supported");
  }
  if (target.protocol === "http:" && !allowInsecureHttp) {
    throw new Error("insecure Bark API URLs require explicit HTTP allowance");
  }
  if (allowPrivateNetwork) return;
  const addresses = await resolveHost(target.hostname);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error("Bark API target resolves to a private or local network address");
  }
}

async function resolvePublicAddresses(hostname: string): Promise<string[]> {
  if (isIP(hostname)) return [hostname];
  const addresses = await lookup(hostname, {all: true});
  return addresses.map((entry) => entry.address);
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const octets = address.split(".").map(Number);
    return octets[0] === 10
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || octets[0] === 0;
  }
  const normalized = address.toLowerCase();
  return normalized === "::1"
    || normalized === "::"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || normalized.startsWith("fe8")
    || normalized.startsWith("fe9")
    || normalized.startsWith("fea")
    || normalized.startsWith("feb");
}
