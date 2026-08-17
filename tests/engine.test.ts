import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {NotifierEngine} from "../src/engine.ts";
import {MemoryStateStore} from "../src/storage.ts";
import type {Clock, TimerHandle} from "../src/time.ts";
import type {DeliveryResult, NotificationChannel, NotificationMessage, TaskEvent} from "../src/types.ts";

class FakeClock implements Clock {
  private nextId = 1;
  private readonly timers = new Map<number, {at: number; callback: () => void}>();

  constructor(public current = 0) {}

  now(): number {
    return this.current;
  }

  setTimer(delayMs: number, callback: () => void): TimerHandle {
    const id = this.nextId++;
    this.timers.set(id, {at: this.current + delayMs, callback});
    return {handle: id};
  }

  clearTimer(handle: TimerHandle): void {
    this.timers.delete(handle.handle as number);
  }

  async sleep(delayMs: number): Promise<void> {
    this.current += delayMs;
  }

  async advance(delayMs: number): Promise<void> {
    this.current += delayMs;
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.at <= this.current)
      .sort(([, left], [, right]) => left.at - right.at);
    for (const [id, timer] of due) {
      this.timers.delete(id);
      timer.callback();
    }
    await flushMicrotasks();
  }
}

class RecordingChannel implements NotificationChannel {
  readonly messages: NotificationMessage[] = [];

  constructor(readonly id: string, private readonly result: DeliveryResult = {accepted: true}) {}

  async send(message: NotificationMessage): Promise<DeliveryResult> {
    this.messages.push(message);
    return this.result;
  }
}

function event(overrides: Partial<TaskEvent>): TaskEvent {
  return {
    eventType: "task.started",
    eventVersion: "1.0",
    eventId: "event-1",
    scope: "session-1",
    sequence: 1,
    privacyClass: "internal",
    taskId: "task-1",
    sessionId: "session-1",
    occurredAt: new Date(0).toISOString(),
    startedAt: new Date(0).toISOString(),
    summary: "A test task",
    ...overrides,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("NotifierEngine", () => {
  it("marks a task long-running at the threshold without notifying", async () => {
    const clock = new FakeClock();
    const channel = new RecordingChannel("test");
    const engine = new NotifierEngine(
      {thresholdSeconds: 10, channels: [{type: "webhook", id: "test", url: "https://example.com/hook"}]},
      new MemoryStateStore(),
      [channel],
      {clock},
    );
    await engine.start();

    await engine.handle(event({}));
    assert.equal(engine.getStatus().runningTasks, 1);
    await clock.advance(9999);
    assert.equal(engine.getStatus().longRunningTasks, 0);
    await clock.advance(1);
    assert.equal(engine.getStatus().longRunningTasks, 1);
    assert.equal(channel.messages.length, 0);
  });

  it("sends one terminal notification and ignores duplicate events", async () => {
    const channel = new RecordingChannel("test");
    const engine = new NotifierEngine({channels: [{type: "webhook", id: "test", url: "https://example.com/hook"}]}, new MemoryStateStore(), [channel]);
    await engine.start();

    await engine.handle(event({eventId: "start", sequence: 1}));
    const result = await engine.handle(event({
      eventType: "task.completed",
      eventId: "done",
      sequence: 2,
      occurredAt: new Date(5000).toISOString(),
      summary: "Finished",
    }));
    const duplicate = await engine.handle(event({
      eventType: "task.completed",
      eventId: "done",
      sequence: 2,
      occurredAt: new Date(5000).toISOString(),
      summary: "Finished",
    }));

    assert.equal(result.notificationsSent, 1);
    assert.equal(duplicate.duplicate, true);
    assert.equal(channel.messages.length, 1);
    assert.equal(channel.messages[0]?.type, "completed");
    assert.equal(engine.getStatus().terminalTasks, 1);
  });

  it("sends input-required immediately and does not mark it long-running", async () => {
    const clock = new FakeClock();
    const channel = new RecordingChannel("test");
    const engine = new NotifierEngine({thresholdSeconds: 1, channels: [{type: "webhook", id: "test", url: "https://example.com/hook"}]}, new MemoryStateStore(), [channel], {clock});
    await engine.start();

    await engine.handle(event({eventId: "start", sequence: 1}));
    await engine.handle(event({
      eventType: "task.input_required",
      eventId: "input",
      sequence: 2,
      request: {requestId: "request-1", kind: "confirmation", summary: "Continue?"},
    }));
    await clock.advance(5000);

    assert.equal(channel.messages.length, 1);
    assert.equal(channel.messages[0]?.type, "input_required");
    assert.equal(engine.getStatus().awaitingInputTasks, 1);
    assert.equal(engine.getStatus().longRunningTasks, 0);
  });

  it("retries a failed channel with bounded attempts", async () => {
    const channel = new RecordingChannel("test", {accepted: false, detail: "offline"});
    const engine = new NotifierEngine({retry: {maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0}, channels: [{type: "webhook", id: "test", url: "https://example.com/hook"}]}, new MemoryStateStore(), [channel]);
    await engine.start();

    await engine.handle(event({eventId: "start", sequence: 1}));
    const result = await engine.handle(event({eventType: "task.failed", eventId: "failed", sequence: 2, error: {code: "E_TEST", summary: "failed"}}));

    assert.equal(result.deliveryFailures, 1);
    assert.equal(channel.messages.length, 2);
    assert.equal(engine.getStatus().failedDeliveries, 1);
  });
});
