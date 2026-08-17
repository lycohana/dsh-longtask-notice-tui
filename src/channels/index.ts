import {SmtpChannel} from "./smtp.js";
import {WebhookChannel} from "./webhook.js";
import type {NotificationChannel, NormalizedConfig, SecretProvider} from "../types.js";

export function createChannels(
  config: NormalizedConfig,
  secrets: SecretProvider,
): NotificationChannel[] {
  return config.channels.map((channel) => channel.type === "smtp"
    ? new SmtpChannel(channel, secrets)
    : new WebhookChannel(channel, secrets));
}

export {SmtpChannel} from "./smtp.js";
export {WebhookChannel} from "./webhook.js";
