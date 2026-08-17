import {lookup} from "node:dns/promises";
import {createHmac} from "node:crypto";
import {isIP} from "node:net";
import type {DeliveryResult, NotificationChannel, NotificationMessage, SecretProvider, WebhookChannelConfig} from "../types.js";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type ResolveHost = (hostname: string) => Promise<string[]>;

export interface WebhookChannelOptions {
  fetch?: FetchLike;
  resolveHost?: ResolveHost;
}

export class WebhookChannel implements NotificationChannel {
  readonly id: string;
  private readonly fetcher: FetchLike;
  private readonly resolveHost: ResolveHost;

  constructor(
    private readonly config: WebhookChannelConfig,
    private readonly secrets: SecretProvider,
    options: WebhookChannelOptions = {},
  ) {
    this.id = config.id;
    this.fetcher = options.fetch ?? fetch;
    this.resolveHost = options.resolveHost ?? resolvePublicAddresses;
  }

  async send(message: NotificationMessage): Promise<DeliveryResult> {
    const target = new URL(this.config.url);
    await assertAllowedTarget(target, this.config.allowPrivateNetwork ?? false, this.resolveHost);

    const body = JSON.stringify(message);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "dsh-longtask-notice-tui/0.1",
      "x-dsh-idempotency-key": message.idempotencyKey,
      ...(this.config.headers ?? {}),
    };
    if (this.config.secretRef) {
      const secret = await this.secrets.getSecret(this.config.secretRef);
      if (!secret) {
        throw new Error(`missing webhook secret for channel ${this.id}`);
      }
      headers["x-dsh-signature"] = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    }

    const response = await this.fetcher(target, {
      method: "POST",
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 10000),
    });
    if (!response.ok) {
      throw new Error(`webhook returned HTTP ${response.status}`);
    }
    return {accepted: true, providerId: response.headers.get("x-request-id") ?? undefined};
  }
}

async function assertAllowedTarget(target: URL, allowPrivateNetwork: boolean, resolveHost: ResolveHost): Promise<void> {
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new Error("webhook URL protocol is not supported");
  }
  if (target.protocol === "http:" && target.hostname !== "localhost" && !allowPrivateNetwork) {
    throw new Error("insecure webhook URLs require explicit private-network allowance");
  }
  if (allowPrivateNetwork) {
    return;
  }
  const addresses = await resolveHost(target.hostname);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error("webhook target resolves to a private or local network address");
  }
}

async function resolvePublicAddresses(hostname: string): Promise<string[]> {
  if (isIP(hostname)) {
    return [hostname];
  }
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
      || octets[0] === 169 && octets[1] === 254
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
