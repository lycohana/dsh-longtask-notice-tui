import type {TaskEvent} from "../types.js";

const EVENT_TYPES = new Set<TaskEvent["eventType"]>([
  "task.started",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "task.input_required",
]);
const PRIVACY_CLASSES = new Set<TaskEvent["privacyClass"]>([
  "public",
  "internal",
  "sensitive",
]);

export class InvalidTaskEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTaskEventError";
  }
}

export function validateTaskEvent(event: TaskEvent): TaskEvent {
  if (!event || typeof event !== "object") {
    throw new InvalidTaskEventError("event must be an object");
  }
  if (!EVENT_TYPES.has(event.eventType)) {
    throw new InvalidTaskEventError("unsupported task event type");
  }
  if (event.eventVersion !== "1.0") {
    throw new InvalidTaskEventError("unsupported task event version");
  }
  for (const [field, value] of Object.entries({
    eventId: event.eventId,
    scope: event.scope,
    taskId: event.taskId,
    sessionId: event.sessionId,
    occurredAt: event.occurredAt,
  })) {
    if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\r\n]/.test(value)) {
      throw new InvalidTaskEventError(`${field} must be a bounded single-line string`);
    }
  }
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 0) {
    throw new InvalidTaskEventError("sequence must be a non-negative safe integer");
  }
  if (!PRIVACY_CLASSES.has(event.privacyClass)) {
    throw new InvalidTaskEventError("unknown privacy class");
  }
  assertDate(event.occurredAt, "occurredAt");
  if (event.startedAt) {
    assertDate(event.startedAt, "startedAt");
  }
  if (event.summary && event.summary.length > 1024) {
    throw new InvalidTaskEventError("summary is too long");
  }
  if (event.lastReply !== undefined && !isSafeReply(event.lastReply, 12000)) {
    throw new InvalidTaskEventError("lastReply is invalid or too long");
  }
  if (event.error) {
    if (!isSafeSummary(event.error.code, 128) || !isSafeSummary(event.error.summary, 1024)) {
      throw new InvalidTaskEventError("invalid error payload");
    }
  }
  if (event.request) {
    if (!isSafeSummary(event.request.requestId, 256) || !isSafeSummary(event.request.summary, 1024)) {
      throw new InvalidTaskEventError("invalid input request payload");
    }
    if (!["confirmation", "clarification", "approval", "other"].includes(event.request.kind)) {
      throw new InvalidTaskEventError("invalid input request kind");
    }
  }
  if (event.eventType === "task.failed" && !event.error) {
    throw new InvalidTaskEventError("task.failed requires an error payload");
  }
  if (event.eventType === "task.input_required" && !event.request) {
    throw new InvalidTaskEventError("task.input_required requires a request payload");
  }
  return event;
}

function assertDate(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new InvalidTaskEventError(`${field} must be an ISO date`);
  }
}

function isSafeSummary(value: string, maxLength: number): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\r\n]/.test(value);
}

function isSafeReply(value: string, maxLength: number): boolean {
  return typeof value === "string"
    && value.length <= maxLength
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}
