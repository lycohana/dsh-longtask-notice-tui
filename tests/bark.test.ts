import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {BarkChannel} from "../src/channels/bark.ts";
import type {NotificationMessage, SecretProvider} from "../src/types.ts";

const message: NotificationMessage = {
  type: "completed",
  taskId: "task-1",
  sessionId: "session-1",
  state: "task.completed",
  summary: "Done",
  lastReply: "最终回复内容",
  occurredAt: new Date(0).toISOString(),
  idempotencyKey: "session-1:task-1:completed",
};

const secrets: SecretProvider = {
  async getSecret(reference: string): Promise<string | undefined> {
    return reference === "BARK_DEVICE_KEY" ? "device-key" : undefined;
  },
};

describe("BarkChannel", () => {
  it("posts a Bark JSON push with the device key and last reply", async () => {
    let input: string | URL | undefined;
    let request: RequestInit | undefined;
    const channel = new BarkChannel(
      {type: "bark", id: "bark", apiUrl: "https://api.day.app", deviceKeyRef: "BARK_DEVICE_KEY"},
      secrets,
      {
        resolveHost: async () => ["203.0.113.10"],
        fetch: async (requestInput, init) => {
          input = requestInput;
          request = init;
          return new Response(null, {status: 200, headers: {"x-request-id": "bark-1"}});
        },
      },
    );

    const result = await channel.send(message);
    const payload = JSON.parse(String(request?.body)) as {device_key: string; title: string; body: string};
    const headers = new Headers(request?.headers);

    assert.deepEqual(result, {accepted: true, providerId: "bark-1"});
    assert.equal(new URL(String(input)).pathname, "/push");
    assert.equal(request?.method, "POST");
    assert.equal(payload.device_key, "device-key");
    assert.match(payload.title, /完成/);
    assert.match(payload.body, /最后回复/);
    assert.doesNotMatch(payload.body, /Last reply|State:|Task:|Session:|Summary:/);
    assert.match(payload.body, /最终回复内容/);
    assert.equal(headers.get("x-dsh-idempotency-key"), message.idempotencyKey);
  });

  it("renders only the selected English notification language", async () => {
    let body = "";
    const channel = new BarkChannel(
      {type: "bark", id: "bark", apiUrl: "https://api.day.app", deviceKeyRef: "BARK_DEVICE_KEY"},
      secrets,
      {
        resolveHost: async () => ["203.0.113.10"],
        fetch: async (_input, init) => {
          const payload = JSON.parse(String(init?.body)) as {body: string};
          body = payload.body;
          return new Response(null, {status: 200});
        },
      },
    );

    await channel.send({...message, language: "en"});

    assert.match(body, /Last reply/);
    assert.match(body, /State: Completed/);
    assert.doesNotMatch(body, /最后回复|状态：|任务：|会话：|摘要：/);
  });

  it("supports a custom Bark server without adding a second push path", async () => {
    let requestUrl = "";
    const channel = new BarkChannel(
      {type: "bark", id: "bark", apiUrl: "https://bark.example.com/api/push", deviceKeyRef: "BARK_DEVICE_KEY"},
      secrets,
      {
        resolveHost: async () => ["203.0.113.10"],
        fetch: async (input) => {
          requestUrl = String(input);
          return new Response(null, {status: 200});
        },
      },
    );

    await channel.send(message);
    assert.equal(new URL(requestUrl).pathname, "/api/push");
  });

  it("fails closed for a private resolved address", async () => {
    const channel = new BarkChannel(
      {type: "bark", id: "bark", apiUrl: "https://bark.example.com", deviceKeyRef: "BARK_DEVICE_KEY"},
      secrets,
      {resolveHost: async () => ["127.0.0.1"], fetch: async () => new Response(null, {status: 200})},
    );
    await assert.rejects(() => channel.send(message), /private or local/);
  });
});
