import {BarkChannel} from "./bark.js";
import {SmtpChannel} from "./smtp.js";
import {WebhookChannel} from "./webhook.js";
import type {NotificationChannel, NormalizedConfig, SecretProvider} from "../types.js";

export function createChannels(
  config: NormalizedConfig,
  secrets: SecretProvider,
): NotificationChannel[] {
  return config.channels.filter((channel) => channel.enabled !== false).map((channel) => channel.type === "smtp"
    ? new SmtpChannel(channel, secrets)
    : channel.type === "webhook"
      ? new WebhookChannel(channel, secrets)
      : new BarkChannel(channel, secrets));
}

export {BarkChannel} from "./bark.js";
export {SmtpChannel} from "./smtp.js";
export {WebhookChannel} from "./webhook.js";
