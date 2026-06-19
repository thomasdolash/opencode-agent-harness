# opencode-agent-harness

Standalone OpenClaw plugin that registers a native `opencode` agent harness for
OpenCode-backed WebUI turns.

This repository is intentionally narrow. It exists to let OpenClaw select a
native OpenCode runtime path without bundling the work into the main OpenClaw
extension tree.

## What It Does

- registers harness id `opencode`
- starts or connects to an OpenCode server
- creates and resumes native OpenCode sessions
- stores a simple OpenClaw-session to OpenCode-session binding
- returns normal OpenClaw-visible assistant replies
- **streams progressive assistant text** via the Gateway's agent-event bus
  (118 chunks observed vs 145 for the embedded default harness)
- clears the binding on harness reset

## What It Is Not

- not a provider plugin
- not an auth/onboarding plugin
- not a dynamic tool bridge
- not a permission bridge
- not a Codex-parity port

The provider-facing OpenCode surface remains separate. This repository is the
harness-only runtime adapter.

## Repository Layout

- `src/index.ts`: plugin entry, registers only the harness
- `src/harness.ts`: harness declaration and selection behavior
- `src/config.ts`: plugin config parsing
- `src/app-server/shared-client.ts`: OpenCode SDK client, managed server seam,
  scoped SSE subscription (`/event?directory=...`), poll-based text growth
  fallback
- `src/app-server/session-binding.ts`: sidecar binding persistence
- `src/app-server/run-attempt.ts`: native turn execution, streaming gate
  (`supportsStreaming`), agent-event emission bridge
- `scripts/smoke-run-attempt.ts`: local smoke validation
- `scripts/live-gateway-probe.ts`: chunk-count comparison between default and
  opencode harnesses over the Gateway OpenAI API
- `scripts/opencode-sse-probe.ts`: standalone OpenCode server SSE probe
  (spawns its own server, confirms `message.part.delta` delivery)
- `scripts/demo-no-sdk.ts`: bare-fetch demo proving REST atomically materializes
- `docs/ARCHITECTURE.md`: current ground truth, status, and follow-up work

## Streaming Architecture

```
HTTP client → Gateway /v1/chat/completions → opencode harness
                                                ↓
                            subscribes to GET /event?directory=...
                                                ↓
                           receives message.part.delta events
                                                ↓
                            emitAssistantPartial → onPartialText
                                                ↓
                     emitHarnessAgentEvent → emitAgentEvent (global bus)
                                                ↓
                      Gateway SSE consumer writes delta.content chunks
```

The harness subscribes to the OpenCode server's SSE endpoint with the same
directory scoping used for session and prompt calls. Unscoped `/global/event`
only emits `server.connected`. Scoped `/event?directory=...` emits
`message.part.delta`, `message.part.updated`, `session.status`, `session.diff`,
and other session events.

The Gateway's OpenAI-compatible SSE route (`/v1/chat/completions`) subscribes
to the global agent-event bus via `onAgentEvent`. When the harness emits
assistant deltas through `emitAgentEvent`, the Gateway consumer writes
`delta.content` chunks to the HTTP response SSE stream.