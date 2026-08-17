# Design: dsh-longtask-notice-tui

## 1. Product policy

The plugin observes task lifecycle events and sends actionable notifications.

The default policy is deliberately quiet:

```text
task.started
    |
    +-- duration >= threshold --> mark as long-running; send nothing
    |
    +-- task.completed --------------------> send final notification
    +-- task.failed ------------------------> send final notification
    +-- task.cancelled ---------------------> send final notification
    +-- task.input_required ----------------> send immediately
```

The threshold is configurable. The default is 10 minutes. Crossing the threshold is a state transition, not a notification trigger.

## 2. Required host contract

The current dsh-ecosystem-spec v0.15 registry exposes `LocalStorage`, `Command`, and `MessageObserver`. It does not expose a task lifecycle event or an outbound notification capability.

This plugin therefore needs an experimental dsh-TUI contract before it can make a public conformance claim. The preferred direction is a host-provided task observer with events such as:

- `task.started`
- `task.completed`
- `task.failed`
- `task.cancelled`
- `task.input_required`

The plugin must not infer these states by parsing message text. If the host already has an internal task event API, the adapter should map that API to this contract rather than creating a second source of truth.

## 3. Event data requirements

Each event should provide:

- stable `eventId` and `taskId`
- `sessionId` and runtime scope
- monotonic sequence within the scope
- event type and version
- `startedAt` and `occurredAt`
- short, redacted summary
- error code/summary for failures
- request ID and redacted summary for input requests
- privacy classification

Full prompts, transcripts, credentials, tokens, and arbitrary tool output are not required by the plugin and should not be sent to it by default.

## 4. State model

Task state and delivery state are separate.

```text
Task:     observed -> running -> long_running -> terminal
Delivery: pending -> sending -> sent
                         |
                         +-> retrying -> failed
```

The plugin persists only the minimum state required for recovery and deduplication. A notification idempotency key is derived from:

```text
taskId + notificationType + policyVersion
```

Repeated events, reconnects, and process restarts must not create duplicate terminal notifications.

On restart, an active task is reconstructed from `startedAt`; if it has crossed the threshold, it is marked `long_running` without sending a threshold notification.

## 5. Notification channels

### SMTP

- TLS or STARTTLS with certificate verification
- configurable sender, recipients, subject, and text/HTML templates
- retryable network errors with bounded exponential backoff
- credentials supplied through a host secret reference or environment injection

### Generic Webhook

- HTTP POST with a versioned JSON payload
- configurable headers
- optional HMAC signature
- timeout, bounded retries, and an idempotency header

Provider-specific integrations such as Slack, Telegram, and enterprise chat should be added outside the core plugin through Webhook configuration first.

## 6. Configuration

Non-secret configuration should include:

```json
{
  "thresholdSeconds": 600,
  "notify": {
    "completed": true,
    "failed": true,
    "cancelled": true,
    "inputRequired": true
  },
  "channels": ["smtp", "webhook"]
}
```

Secrets must not be stored in ordinary plugin storage. Until dsh-TUI exposes a secret-store contract, the first implementation should use explicit environment/host configuration and document the limitation.

## 7. Planned commands

Commands remain flat action leaves to match the current v0.15 boundary:

- `com.t-auto.dsh.longtask-notice.status`
- `com.t-auto.dsh.longtask-notice.test-channel`
- `com.t-auto.dsh.longtask-notice.reload`
- `com.t-auto.dsh.longtask-notice.enable`
- `com.t-auto.dsh.longtask-notice.disable`

Commands must not bind to a single Presentation during activation.

## 8. Verification plan

- threshold boundary tests using a fake clock
- restart and recovery tests
- duplicate and out-of-order event tests
- concurrent task tests
- SMTP/Webhook adapter tests with fake transports
- retry and idempotency tests
- secret and payload redaction tests
- deactivate, uninstall, and purge cleanup tests
- manifest, contract, and host negotiation fixtures after the experimental contract is registered

## 9. Open decisions

1. Confirm the dsh-TUI host runtime API and plugin SDK entry signature.
2. Decide whether the task observer contract belongs in dsh-ecosystem-spec or remains TUI-private initially.
3. Decide how the host provides SMTP/Webhook secrets.
4. Confirm whether `task.input_required` is a single event type or a family of approval/clarification events.
