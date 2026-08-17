import nodemailer from "nodemailer";
import type {SmtpChannelConfig, NotificationChannel, NotificationMessage, SecretProvider, DeliveryResult} from "../types.js";

export class SmtpChannel implements NotificationChannel {
  readonly id: string;

  constructor(
    private readonly config: SmtpChannelConfig,
    private readonly secrets: SecretProvider,
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

    const transport = nodemailer.createTransport({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      requireTLS: this.config.requireTls ?? true,
      auth: this.config.username
        ? {user: this.config.username, pass: password}
        : undefined,
      tls: {rejectUnauthorized: true},
    });

    try {
      const result = await transport.sendMail({
        from: this.config.from,
        to: this.config.to,
        replyTo: this.config.replyTo,
        subject: subjectFor(message),
        text: textFor(message),
      });
      return {
        accepted: Array.isArray(result.accepted) && result.accepted.length > 0,
        providerId: typeof result.messageId === "string" ? result.messageId : undefined,
      };
    } finally {
      transport.close();
    }
  }
}

function subjectFor(message: NotificationMessage): string {
  const label = {
    completed: "completed",
    failed: "failed",
    cancelled: "cancelled",
    input_required: "input required",
    test: "channel test",
  }[message.type];
  return `[dsh] ${label}: ${cleanHeader(message.summary || message.taskId)}`.slice(0, 998);
}

function textFor(message: NotificationMessage): string {
  const lines = [
    `dsh-TUI task ${message.type}`,
    `Task: ${message.taskId}`,
    `Session: ${message.sessionId}`,
    `State: ${message.state}`,
    `Occurred: ${message.occurredAt}`,
    message.startedAt ? `Started: ${message.startedAt}` : undefined,
    typeof message.durationMs === "number" ? `Duration: ${formatDuration(message.durationMs)}` : undefined,
    `Summary: ${cleanText(message.summary)}`,
    message.error ? `Error: ${cleanText(message.error.code)} - ${cleanText(message.error.summary)}` : undefined,
    message.request ? `Request: ${cleanText(message.request.kind)} - ${cleanText(message.request.summary)}` : undefined,
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

function cleanHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, 180);
}

function cleanText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\r\n]+/g, " ").slice(0, 1024);
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
