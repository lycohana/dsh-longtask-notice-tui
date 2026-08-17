import nodemailer from "nodemailer";
import type {SmtpChannelConfig, NotificationChannel, NotificationMessage, SecretProvider, DeliveryResult} from "../types.js";

interface SmtpTransport {
  sendMail(message: {
    from: string | {name: string; address: string};
    to: string[];
    replyTo?: string;
    subject: string;
    text: string;
  }): Promise<{accepted?: string[]; messageId?: string}>;
  close(): void;
}

interface SmtpTransportOptions {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
  auth?: {user: string; pass: string};
  tls: {rejectUnauthorized: true};
}

type SmtpTransportFactory = (options: SmtpTransportOptions) => SmtpTransport;

const defaultTransportFactory: SmtpTransportFactory = (options) => {
  const transport = nodemailer.createTransport(options);
  return {
    async sendMail(message) {
      const result = await transport.sendMail(message);
      return {
        accepted: Array.isArray(result.accepted)
          ? result.accepted.filter((item): item is string => typeof item === "string")
          : undefined,
        messageId: typeof result.messageId === "string" ? result.messageId : undefined,
      };
    },
    close() {
      transport.close();
    },
  };
};

export class SmtpChannel implements NotificationChannel {
  readonly id: string;

  constructor(
    private readonly config: SmtpChannelConfig,
    private readonly secrets: SecretProvider,
    private readonly createTransport: SmtpTransportFactory = defaultTransportFactory,
  ) {
    this.id = config.id;
  }

  async send(message: NotificationMessage): Promise<DeliveryResult> {
    const password = this.config.passwordRef
      ? await this.secrets.getSecret(this.config.passwordRef)
      : undefined;
    if (this.config.username && !password) {
      throw new Error(`missing SMTP secret for channel ${this.id}`);
    }

    const transport = this.createTransport({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      requireTLS: this.config.requireTls ?? true,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 15000,
      auth: this.config.username
        ? {user: this.config.username, pass: password ?? ""}
        : undefined,
      tls: {rejectUnauthorized: true},
    });

    try {
      const address = this.config.from?.trim() || this.config.username?.trim();
      if (!address) throw new Error(`missing SMTP sender address for channel ${this.id}`);
      const buildMail = (sender: string) => ({
        from: this.config.displayName?.trim()
          ? {name: this.config.displayName.trim(), address: sender}
          : sender,
        to: this.config.to,
        replyTo: this.config.replyTo,
        subject: subjectFor(message),
        text: textFor(message),
      });
      let result;
      try {
        result = await transport.sendMail(buildMail(address));
      } catch (error) {
        const authorizedAddress = this.config.username?.trim();
        if (!authorizedAddress || sameAddress(address, authorizedAddress) || !isAuthorizedSenderError(error)) {
          throw error;
        }
        // Some SMTP providers reject aliases with 553 even though SMTP AUTH
        // succeeded. Retry with the authenticated user while preserving the
        // optional display name.
        result = await transport.sendMail(buildMail(authorizedAddress));
      }
      return {
        accepted: Array.isArray(result.accepted) && result.accepted.length > 0,
        providerId: typeof result.messageId === "string" ? result.messageId : undefined,
      };
    } finally {
      transport.close();
    }
  }
}

function sameAddress(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function isAuthorizedSenderError(error: unknown): boolean {
  const responseCode = typeof error === "object" && error !== null && "responseCode" in error
    ? (error as {responseCode?: unknown}).responseCode
    : undefined;
  if (responseCode === 553) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\b553\b/.test(message) && /(mail from|sender|authorized user)/iu.test(message);
}

function subjectFor(message: NotificationMessage): string {
  return `[dsh] ${typeLabel(message.type, message.language)}: ${cleanHeader(message.summary || message.taskId)}`.slice(0, 998);
}

function textFor(message: NotificationMessage): string {
  const lang = message.language ?? "zh";
  const isEnglish = lang === "en";
  const primary = cleanReply(message.lastReply) || cleanText(message.summary || message.taskId);
  const lines = [
    isEnglish ? "Last reply" : "最后回复",
    primary,
    "",
    isEnglish ? "Task details" : "任务信息",
    isEnglish ? `Type: ${typeLabel(message.type, lang)}` : `类型：${typeLabel(message.type, lang)}`,
    isEnglish ? `State: ${stateLabel(message.state, lang)}` : `状态：${stateLabel(message.state, lang)}`,
    isEnglish ? `Task: ${message.taskId}` : `任务：${message.taskId}`,
    isEnglish ? `Session: ${message.sessionId}` : `会话：${message.sessionId}`,
    isEnglish ? `Occurred: ${message.occurredAt}` : `发生时间：${message.occurredAt}`,
    message.startedAt ? (isEnglish ? `Started: ${message.startedAt}` : `开始时间：${message.startedAt}`) : undefined,
    typeof message.durationMs === "number" ? (isEnglish ? `Duration: ${formatDuration(message.durationMs)}` : `耗时：${formatDuration(message.durationMs)}`) : undefined,
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

function cleanHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, 180);
}

function cleanText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\r\n]+/g, " ").slice(0, 1024);
}

function cleanReply(value: string | undefined): string {
  return (value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 12000);
}

function formatDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}
