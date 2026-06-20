# OpenCode Agent Harness — Architecture

Ground-truth status document for what this plugin is, what works, and what does not.

## What This Is

`opencode-agent-harness` is an OpenClaw plugin that:

- registers agent harness id `opencode`
- routes OpenClaw agent turns into native OpenCode sessions
- persists an OpenClaw-session to OpenCode-session binding

## File Shape

- `src/index.ts` — plugin entry, registers only the harness
- `src/harness.ts` — harness id `opencode`, delivery defaults
- `src/config.ts` — plugin config parsing
- `src/app-server/shared-client.ts` — SDK wiring, SSE subscription, poll fallback, multipart text assembly
- `src/app-server/session-binding.ts` — sidecar binding persistence
- `src/app-server/run-attempt.ts` — turn execution with streaming gate
- `scripts/smoke-run-attempt.ts` — local smoke validation

## What Is Done

### Harness registration

- Plugin id `opencode-agent-harness`, manifest activation includes `onAgentHarnesses: ["opencode"]`
- Registers harness id `opencode`, no provider registration

### Native client seam

- OpenCode SDK loaded from `@opencode-ai/sdk`
- Managed server mode and remote server mode supported
- Health checks and optional minimum-version enforcement

### Session binding

- One OpenClaw session file maps to one OpenCode session id, persisted in a sidecar JSON file
- Later turns reuse the bound session; reset clears the binding

### Turn execution

- Creates native OpenCode sessions, resumes existing ones
- Returns final assistant text in valid harness result shape
- Streams progressive assistant text via the Gateway agent-event bus

### Streaming

- Subscribes to scoped SSE (`/event?directory=...`) for `message.part.delta`,
  `message.part.updated`, `session.next.text.delta`, and related events
- Delivers assistant deltas through `emitAgentEvent` for `/v1/chat/completions`
- Poll-based text growth fallback runs concurrently

### Multipart assistant turns

A turn that emits visible assistant text across multiple assistant message ids
(e.g. A1 → tool → A2) accumulates all segments in chronological order. The
single-message projection gate (`targetAssistantMessageId`) was replaced with a
set of accepted assistant message ids. All visible text parts from any accepted
assistant message id within the active turn are assembled into the final reply.

### Validation

- `npm run typecheck` and `npm run smoke` pass locally
- Live gateway tests confirm harness selection, session continuity, reset
  behavior, and progressive streaming

## What Is Not Done

- Runtime selection is broader than desired (wildcard workaround for model-scoped routing)
- Reasoning visibility not yet bridged to OpenClaw's `/reasoning on|off|stream` controls
- No permission bridge, dynamic tool bridge, or advanced runtime-policy handling
- No replay recovery, reconnect repair, dedupe, or compaction
- No load or chaos testing

## Testing Convention

- Required: `npm run typecheck`, `npm run smoke`
- Required after runtime changes: one manual WebUI validation turn
- Optional: live testing against a running gateway

Smoke coverage proves: first-run session creation, second-run binding reuse,
reset clears binding, shared-client startup path.
