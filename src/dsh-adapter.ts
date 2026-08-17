import type {Session, SessionEvent, TurnEndReason} from "@deepseek-ai/dsh-session";
import type {TaskEvent} from "./types.js";

export function sessionEventToTaskEvent(session: Session, event: SessionEvent): TaskEvent | undefined {
  if (event.type === "turn/start") {
    return {
      eventType: "task.started",
      eventVersion: "1.0",
      eventId: eventId(session, event.seq),
      scope: sessionScope(session),
      sequence: event.seq,
      privacyClass: "internal",
      taskId: turnId(session, event.data.turn),
      sessionId: sessionScope(session),
      occurredAt: iso(event.time),
      startedAt: iso(event.time),
      summary: `Turn ${event.data.turn} started`,
    };
  }

  if (event.type !== "turn/end") {
    return undefined;
  }
  return turnEndToTaskEvent(session, event);
}

/**
 * Recover only the currently open turn from a restored session log.
 *
 * Terminal events are intentionally not replayed here: replaying them after a
 * plugin restart could resend an already delivered final notification. The
 * next live `turn/end` event will close this reconstructed task.
 */
export function openTurnToTaskEvent(session: Session): TaskEvent | undefined {
  const openStarts = new Map<number, SessionEvent<"turn/start">>();
  for (const event of session.events) {
    if (event.type === "turn/start") {
      openStarts.set(event.data.turn, event);
    } else if (event.type === "turn/end") {
      openStarts.delete(event.data.turn);
    }
  }

  const latest = [...openStarts.values()].sort((left, right) => right.seq - left.seq)[0];
  return latest ? sessionEventToTaskEvent(session, latest) : undefined;
}

function turnEndToTaskEvent(
  session: Session,
  event: SessionEvent<"turn/end">,
): TaskEvent {
  const reason = event.data.reason;
  const common = {
    eventVersion: "1.0" as const,
    eventId: eventId(session, event.seq),
    scope: sessionScope(session),
    sequence: event.seq,
    privacyClass: "internal" as const,
    taskId: turnId(session, event.data.turn),
    sessionId: sessionScope(session),
    occurredAt: iso(event.time),
    lastReply: lastAssistantReply(session, event.data.turn, event.seq),
  };

  if (reason.kind === "blocked") {
    return {
      ...common,
      eventType: "task.input_required",
      summary: "The turn is blocked and may need user input",
      request: {
        requestId: `${common.taskId}:input`,
        kind: "other",
        summary: "The turn stopped in a blocked state; provide input or confirmation if needed",
      },
    };
  }

  if (reason.kind === "completed") {
    return {
      ...common,
      eventType: "task.completed",
      summary: "Task completed",
    };
  }

  if (reason.kind === "aborted") {
    return {
      ...common,
      eventType: "task.cancelled",
      summary: "Task cancelled",
    };
  }

  return {
    ...common,
    eventType: "task.failed",
    summary: failureSummary(reason),
    error: {
      code: failureCode(reason),
      summary: failureSummary(reason),
    },
  };
}

function failureCode(reason: Exclude<TurnEndReason, {kind: "completed" | "aborted" | "blocked"}>): string {
  if (reason.kind === "error") {
    return safeToken(reason.error.code, "TURN_ERROR");
  }
  return `TURN_${reason.kind.toUpperCase().replace(/-/g, "_")}`;
}

function failureSummary(reason: Exclude<TurnEndReason, {kind: "completed" | "aborted" | "blocked"}>): string {
  if (reason.kind === "error") {
    return safeText(reason.error.message, "Task failed");
  }
  return `Task ended with ${reason.kind}`;
}

function sessionScope(session: Session): string {
  return String(session.id);
}

function turnId(session: Session, turn: number): string {
  return `${sessionScope(session)}:turn:${turn}`;
}

function eventId(session: Session, sequence: number): string {
  return `${sessionScope(session)}:${sequence}`;
}

function lastAssistantReply(session: Session, turn: number, beforeSequence: number): string | undefined {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index];
    if (event === undefined || event.seq > beforeSequence || event.type !== "assistant/message" || event.data.turn !== turn) {
      continue;
    }
    const reply = event.data.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const normalized = safeReply(reply);
    if (normalized) return normalized;
  }
  return undefined;
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

function safeText(value: string, fallback: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f\r\n]+/g, " ").trim().slice(0, 1024);
  return normalized || fallback;
}

function safeReply(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 12000);
}

function safeToken(value: string, fallback: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 128);
  return normalized || fallback;
}
