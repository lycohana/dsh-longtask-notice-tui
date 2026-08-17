import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {WebhookChannel} from "../src/channels/webhook.ts";
import type {NotificationMessage, SecretProvider} from "../src/types.ts";

const message: NotificationMessage = {
  type: "completed",
  taskId: "task-1",
  sessionId: "session-1",
  state: "task.completed",
  summary: "Done",
  occurredAt: new Date(0).toISOString(),
  idempotencyKey: "session-1:task-1:completed",
};

const secrets: SecretProvider = {
  async getSecret(reference: string): Promise<string | undefined> {
    return reference === "HOOK_SECRET" ? "secret" : undefined;
  },
};

describe("WebhookChannel", () => {
  it("posts JSON with an HMAC signature and idempotency key", async () => {
    let request: RequestInit | undefined;
    const channel = new WebhookChannel(
      {type: "webhook", id: "hook", url: "https://example.com/notify", secretRef: "HOOK_SECRET"},
      secrets,
      {
        resolveHost: async () => ["203.0.113.10"],
        fetch: async (_input, init) => {
          request = init;
          return new Response(null, {status: 204});
        },
      },
    );

    const result = await channel.send(message);
    const headers = new Headers(request?.headers);
    assert.equal(result.accepted, true);
    assert.equal(headers.get("x-dsh-idempotency-key"), message.idempotencyKey);
    assert.match(headers.get("x-dsh-signature") ?? "", /^sha256=[a-f0-9]{64}$/);
    assert.equal(request?.method, "POST");
  });

  it("fails closed for a private resolved address", async () => {
    const channel = new WebhookChannel(
      {type: "webhook", id: "hook", url: "https://example.com/notify"},
      secrets,
      {resolveHost: async () => ["127.0.0.1"], fetch: async () => new Response(null, {status: 204})},
    );
    await assert.rejects(() => channel.send(message), /private or local/);
  });
});
