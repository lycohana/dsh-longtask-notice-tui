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
});
