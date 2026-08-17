import assert from "node:assert/strict";
import {describe, it} from "node:test";
import type {Session, SessionEvent} from "@deepseek-ai/dsh-session";
import {openTurnToTaskEvent, sessionEventToTaskEvent} from "../src/dsh-adapter.ts";

function session(events: readonly SessionEvent[]): Session {
  return {id: "session-1", events} as unknown as Session;
}

function turnStart(seq: number, turn = 1): SessionEvent {
  return {seq, time: 0, type: "turn/start", data: {turn}} as SessionEvent;
}

function turnEnd(seq: number, reason: "completed" | "blocked", turn = 1): SessionEvent {
  return {
    seq,
    time: 1000,
    type: "turn/end",
    data: reason === "completed"
      ? {turn, reason: {kind: "completed"}}
      : {turn, reason: {kind: "blocked"}},
  } as SessionEvent;
}

describe("dsh-session adapter", () => {
  it("maps a blocked turn to an immediate input request", () => {
    const mapped = sessionEventToTaskEvent(session([]), turnEnd(1, "blocked"));
    assert.equal(mapped?.eventType, "task.input_required");
    assert.equal(mapped?.request?.kind, "other");
  });

  it("keeps the last visible assistant reply for the notification", () => {
    const end = turnEnd(2, "completed");
    const mapped = sessionEventToTaskEvent(session([
      turnStart(0),
      {
        seq: 1,
        time: 900,
        type: "assistant/message",
        data: {
          turn: 1,
          step: 1,
          message: {
            id: "message-1",
            role: "assistant",
            source: {kind: "model", provider: "test", model: "test-model"},
            content: [{type: "text", text: "最终回复\n第二行"}],
          },
        },
      } as unknown as SessionEvent,
      end,
    ]), end);

    assert.equal(mapped?.lastReply, "最终回复\n第二行");
  });

  it("recovers only the latest open turn from a session log", () => {
    const restored = session([
      turnStart(0),
      turnEnd(1, "completed"),
      turnStart(2, 2),
    ]);
    const recovered = openTurnToTaskEvent(restored);
    assert.equal(recovered?.eventType, "task.started");
    assert.equal(recovered?.taskId, "session-1:turn:2");

    const closed = session([turnStart(0), turnEnd(1, "completed")]);
    assert.equal(openTurnToTaskEvent(closed), undefined);
  });
});
