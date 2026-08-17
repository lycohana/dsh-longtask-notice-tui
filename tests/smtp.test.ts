import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {SmtpChannel} from "../src/channels/smtp.ts";
import type {NotificationMessage, SecretProvider} from "../src/types.ts";

const message: NotificationMessage = {
  type: "test",
  taskId: "test-task",
  sessionId: "test-session",
  state: "test",
  summary: "长任务通知渠道测试",
  lastReply: "最终回复内容",
  occurredAt: new Date(0).toISOString(),
  idempotencyKey: "test:0",
};

describe("SmtpChannel", () => {
  it("sends a real test email payload through the SMTP transport", async () => {
    let sent: Record<string, unknown> | undefined;
    let closed = false;
    const secrets: SecretProvider = {
      async getSecret(reference: string): Promise<string | undefined> {
        return reference === "SMTP_PASSWORD" ? "secret" : undefined;
      },
    };
    const channel = new SmtpChannel(
      {
        type: "smtp",
        id: "email",
        host: "smtp.example.com",
        port: 587,
        secure: false,
        requireTls: true,
        from: "",
        displayName: "dawndream",
        to: ["user@example.com"],
        username: "dsh@example.com",
        passwordRef: "SMTP_PASSWORD",
      },
      secrets,
      () => ({
        async sendMail(mail) {
          sent = mail as unknown as Record<string, unknown>;
          return {accepted: ["user@example.com"], messageId: "smtp-test-1"};
        },
        close() {
          closed = true;
        },
      }),
    );

    const result = await channel.send(message);

    assert.deepEqual(result, {accepted: true, providerId: "smtp-test-1"});
    assert.deepEqual(sent?.from, {name: "dawndream", address: "dsh@example.com"});
    assert.deepEqual(sent?.to, ["user@example.com"]);
    assert.match(String(sent?.subject), /渠道测试/);
    assert.match(String(sent?.text), /渠道测试/);
    assert.doesNotMatch(String(sent?.text), /Channel test|Last reply|Task details/);
    assert.match(String(sent?.text), /最后回复/);
    assert.match(String(sent?.text), /最终回复内容/);
    assert.match(String(sent?.text), /任务信息/);
    assert.equal(closed, true);
  });

  it("renders only the selected English notification language", async () => {
    let sent: Record<string, unknown> | undefined;
    const channel = new SmtpChannel(
      {
        type: "smtp",
        id: "email",
        host: "smtp.example.com",
        port: 587,
        secure: false,
        requireTls: true,
        from: "user@example.com",
        to: ["user@example.com"],
      },
      {getSecret: async () => undefined},
      () => ({
        async sendMail(mail) {
          sent = mail as unknown as Record<string, unknown>;
          return {accepted: ["user@example.com"], messageId: "smtp-en"};
        },
        close() {},
      }),
    );

    await channel.send({...message, language: "en", summary: "dsh-longtask-notice channel test", lastReply: "Final reply content"});

    assert.match(String(sent?.text), /Last reply/);
    assert.match(String(sent?.text), /Task details/);
    assert.match(String(sent?.text), /Channel test/);
    assert.doesNotMatch(String(sent?.text), /最后回复|任务信息|渠道测试/);
  });

  it("falls back to the authenticated user when the provider rejects an alias", async () => {
    const senders: string[] = [];
    let calls = 0;
    const channel = new SmtpChannel(
      {
        type: "smtp",
        id: "email",
        host: "smtp.example.com",
        port: 587,
        secure: false,
        requireTls: true,
        from: "alias@example.com",
        to: ["user@example.com"],
        username: "dsh@example.com",
        passwordRef: "SMTP_PASSWORD",
      },
      {getSecret: async () => "secret"},
      () => ({
        async sendMail(mail) {
          calls += 1;
          senders.push(typeof mail.from === "string" ? mail.from : mail.from.address);
          if (calls === 1) {
            const error = new Error("553 Mail from must equal authorized user") as Error & {responseCode: number};
            error.responseCode = 553;
            throw error;
          }
          return {accepted: ["user@example.com"], messageId: "smtp-fallback"};
        },
        close() {},
      }),
    );

    const result = await channel.send(message);

    assert.equal(result.accepted, true);
    assert.deepEqual(senders, ["alias@example.com", "dsh@example.com"]);
  });
});
