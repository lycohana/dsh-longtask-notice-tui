import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {ConfigurationError, normalizeConfig} from "../src/config.ts";

describe("configuration", () => {
  it("defaults the threshold to ten minutes", () => {
    const config = normalizeConfig({channels: []});
    assert.equal(config.thresholdSeconds, 600);
    assert.equal(config.notify.inputRequired, true);
  });

  it("rejects credentials embedded in webhook URLs", () => {
    assert.throws(
      () => normalizeConfig({channels: [{type: "webhook", id: "hook", url: "https://user:pass@example.com/path"}]}),
      ConfigurationError,
    );
  });

  it("rejects SMTP header injection", () => {
    assert.throws(
      () => normalizeConfig({channels: [{type: "smtp", id: "smtp", host: "smtp.example.com", port: 587, secure: false, from: "a@example.com\r\nBcc: bad@example.com", to: ["a@example.com"]}]}),
      ConfigurationError,
    );
  });

  it("allows the sender address to fall back to the SMTP username", () => {
    const config = normalizeConfig({channels: [{
      type: "smtp",
      id: "smtp",
      host: "smtp.example.com",
      port: 587,
      secure: false,
      username: "user@example.com",
      from: "",
      to: ["user@example.com"],
    }]});
    assert.equal((config.channels[0] as {from?: string}).from, "");
  });

  it("accepts the Bark official API default with a device key reference", () => {
    const config = normalizeConfig({channels: [{
      type: "bark",
      id: "bark",
      deviceKeyRef: "BARK_DEVICE_KEY",
    }]});
    const channel = config.channels[0];
    assert.equal(channel?.type, "bark");
    assert.equal(channel?.apiUrl, undefined);
    assert.equal(channel?.deviceKeyRef, "BARK_DEVICE_KEY");
  });

  it("rejects credentials embedded in a Bark API URL", () => {
    assert.throws(
      () => normalizeConfig({channels: [{type: "bark", id: "bark", apiUrl: "https://user:pass@example.com", deviceKeyRef: "BARK_DEVICE_KEY"}]}),
      ConfigurationError,
    );
  });
});
