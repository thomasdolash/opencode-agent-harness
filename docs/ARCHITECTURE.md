# OpenCode Agent Harness Ground Truth

This document describes the current truth of
`opencode-agent-harness` as it exists today.

It is not a speculative plan.
It is a status document for:

- what this plugin is
- what is proven working
- what is not done yet
- what follow-up work is reasonable next

If code, config, or deployment reality changes, update this file to match.

## 1. What This Repository Is

`opencode-agent-harness` is a standalone OpenClaw plugin repository mounted into
the gateway as a linked local plugin.

Current host path:

- `/home/comra/_workspace/oc_stack/_repositories/opencode-agent-harness`

Current container path:

- `/home/node/repositories/opencode-agent-harness`

Its job is narrow:

- register a native agent harness with id `opencode`
- route OpenClaw agent turns into OpenCode native sessions
- persist a simple OpenClaw-session to OpenCode-session binding

It is not:

- a provider plugin
- an auth/onboarding plugin
- a tool bridge
- a permissions bridge
- a Codex-parity rewrite

The bundled `extensions/opencode` plugin remains the provider-facing OpenCode
surface. This repo is the harness-only runtime adapter.

## 2. Current File Shape

Current core files:

- `package.json`
- `package-lock.json`
- `openclaw.plugin.json`
- `tsconfig.json`
- `src/index.ts`
- `src/harness.ts`
- `src/config.ts`
- `src/app-server/shared-client.ts`
- `src/app-server/session-binding.ts`
- `src/app-server/run-attempt.ts`
- `scripts/smoke-run-attempt.ts`
- `scripts/live-gateway-probe.ts`
- `scripts/opencode-sse-probe.ts`
- `scripts/demo-no-sdk.ts`

Current plugin behavior:

- `src/index.ts` registers only an agent harness
- `src/harness.ts` exposes harness id `opencode` with `deliveryDefaults.sourceVisibleReplies: "automatic"`
- `src/app-server/shared-client.ts` owns OpenCode SDK wiring, scoped SSE subscription, poll fallback
- `src/app-server/session-binding.ts` owns sidecar persistence
- `src/app-server/run-attempt.ts` owns the turn execution path with streaming gate via `supportsStreaming`

## 3. Deployment Shape That Is Known Good

Known-good workflow is:

1. run a normal OpenClaw gateway container
2. mount the standalone plugin repo into the container
3. link/load the plugin from that mounted path
4. configure an agent/model route that selects runtime `opencode`

This is intentionally better than rebuilding bundled extensions for every edit.

Current OpenClaw-side reality:

- the gateway loads the plugin from `src/index.ts`
- the plugin is visible in startup logs
- the harness is selected for the `opencode` agent path
- the WebUI can use it successfully for live turns
- `/v1/chat/completions` streaming works with progressive chunks

## 4. What Is Done

The following is complete and proven working.

### Harness registration

- standalone plugin repo exists
- plugin id is `opencode-agent-harness`
- manifest activation includes `onAgentHarnesses: ["opencode"]`
- plugin registers harness id `opencode`
- no provider registration is performed here

### Native client seam

- OpenCode SDK is loaded from `@opencode-ai/sdk`
- managed server mode is supported
- remote server mode is supported by config
- health checks are implemented
- optional minimum-version enforcement is implemented

### Session binding

- one OpenClaw session file maps to one OpenCode session id
- binding is persisted in a sidecar JSON file
- later turns reuse the bound OpenCode session
- reset clears the sidecar binding

### Turn execution

- a turn can create a native OpenCode session
- a later turn can resume that session
- final assistant text is returned to OpenClaw in a valid harness result shape
- streaming delivers progressive assistant text via the Gateway agent-event bus

### Streaming (progressive assistant text)

Progressive SSE streaming is now working end-to-end:

- the harness subscribes to the OpenCode server's scoped SSE endpoint
  (`/event?directory=...`) which delivers `message.part.delta` events
- unscoped `/global/event` only emits `server.connected` and is not used
- `supportsStreaming` gates on `onPartialReply`, `onAgentEvent`, or block
  callbacks — whichever the Gateway provides
- assistant deltas are emitted to the Gateway's global agent-event bus via
  `emitAgentEvent`, which the `/v1/chat/completions` SSE consumer reads
- a live probe measured 118 progressive chunks for `openclaw/opencode`
  vs 145 for `openclaw/default` baseline
- a synchronous dispatch pattern avoids stalling the SSE event loop on
  callback resolution
- a poll-based text growth fallback runs concurrently in case SSE is silent

### Validation

These checks have passed locally in this repo:

- `npm run typecheck`
- `npm run smoke`

These checks have passed against the live gateway/WebUI:

- harness selection logs show `selectedHarnessId: "opencode"`
- a visible assistant reply is produced
- second-turn session continuity works
- `/reset` clears prior session context
- basic file operations and command execution work through the harnessed agent
- a real `openclaw agent --agent opencode` probe reaches the native harness path
- `openclaw/opencode` streams progressively through `/v1/chat/completions`
  (118 chunks, chunk-level timing comparable to the default harness)

## 5. What Is Not Done

The following is intentionally incomplete or still rough.

### Runtime selection tightening

The clean ideal is model-scoped runtime selection with a narrow exact mapping.

Current reality is more blunt:

- a wildcard `*/* -> agentRuntime.id: "opencode"` workaround was used to force
  reliable selection

This works, but it is broader than desired.

### Tooling and UX polish

- no refined event projection beyond the current thin path
- no deep UX tuning for partial replies
- no dedicated operator diagnostics beyond logs and sidecar inspection

### Reasoning visibility integration

OpenClaw already has a gateway-owned reasoning visibility gate via
`/reasoning on|off|stream` and `reasoningDefault`.

Current reality:

- OpenCode reasoning/thinking text can leak into normal visible replies
- the harness does not yet reliably project OpenCode reasoning into the
  existing OpenClaw reasoning-visibility path
- the harness does not yet reliably suppress reasoning when the active
  OpenClaw reasoning visibility state expects it to be hidden

This means the current implementation is functionally working but not yet fully
aligned with OpenClaw's existing reasoning controls.

### Safety/policy integration

- no permission-bridge layer between OpenCode and OpenClaw
- no dynamic tool-bridge translation layer
- no special handling for advanced runtime-policy edge cases

### Robustness gaps

- no replay recovery machinery
- no reconnect/seq-gap repair logic
- no durable dedupe layer
- no compaction integration
- no side-question specialization support
- no load or chaos testing

## 6. Known Quirks

These are real quirks observed so far.

- runtime selection currently depends on a broader config hammer than we want (not fully tested)
- reasoning/thinking text can currently surface more directly than desired
  instead of always obeying OpenClaw's existing reasoning visibility controls
- the current live `opencode` route appears to prefer a gateway-managed
  workspace path under `/home/node/agent-workspaces/...` rather than the caller
  probe directory
- the currently active live model only accepted `thinking off` during probe
  runs

## 7. Current Testing Convention

Short-term working convention for this repo is:

- required: `npm run typecheck`
- required: `npm run smoke`
- required: one manual WebUI/native-turn validation after meaningful runtime
  changes
- optional: extra live testing against a running gateway

We are not optimizing for Vitest-first iteration right now.

Current smoke coverage proves:

- first run creates a native session
- second run reuses the same binding
- reset clears the binding
- managed shared-client startup path behaves as expected

## 8. MVP Status

MVP is functionally achieved.

Definition satisfied in practice:

- dedicated harness-only plugin repo exists
- harness id `opencode` is registered
- OpenClaw can select it
- first turn works
- second turn resumes
- reset clears state
- harness path is usable from the OpenClaw WebUI
- provider and harness responsibilities remain separate
- progressive SSE streaming works through `/v1/chat/completions`

This is no longer a theory or scaffolding exercise.

## 9. Immediate Reality-Based Gaps

If we want to improve the current implementation without bloating it, the most
obvious gaps are:

- tighten runtime selection so the wildcard mapping is no longer needed
- document the exact known-good OpenClaw config and plugin-link workflow
- add one or two more narrow smoke checks for edit/shell behavior
- improve diagnostics around session creation and session reuse failures
- route reasoning/thinking visibility through OpenClaw's existing
  `/reasoning on|off|stream` expectations instead of leaking raw thought text

## 10. What Could Be Done Next

These are reasonable follow-up items.
None are required to claim the current MVP works.

Detailed research and implementation planning now live in:

- `docs/IMPLEMENTATION-PLAN.md`

### Config and selection cleanup

- replace the wildcard runtime mapping with the narrowest reliable exact
  model-scoped mapping
- document the exact working config in this repo
- confirm whether the selection workaround is an OpenClaw config issue or a
  harness-selection nuance worth fixing upstream

### Better validation

- add one more smoke script path covering file read/edit/command behavior
- add a small live-check script for a running gateway if it stays lightweight
- capture a short known-good manual test checklist in this repo

### Better operator visibility

- add clearer structured logs around create-session, resume-session, and reset
- add minimal diagnostics metadata to the sidecar only if it helps debugging
- document how to inspect the binding file and what healthy state looks like

### Better runtime ergonomics

- improve partial reply behavior if the current stream path proves noisy
- make managed-server startup failure messages more explicit
- tighten SDK compatibility assumptions now that the real response shape is
  known
- align OpenCode reasoning/thinking output with OpenClaw's reasoning visibility
  controls so hidden reasoning stays hidden and visible reasoning uses the
  expected OpenClaw delivery shape

### Larger follow-up work that is valid but intentionally deferred

- permission bridging
- dynamic tool bridging
- workspace/path remapping if a real deployment requires it
- richer event projection
- broader automated test coverage
- replay/reconnect support
- compaction support
- side-question support

## 11. Non-Goals For The Current Baseline

These remain out of scope for the current working baseline:

- reimplementing OpenCode provider metadata here
- merging this repo back into a large bundled experimental extension
- porting Codex harness complexity without a specific need
- adding ACP or generic transport abstractions for their own sake
- adding metrics/replay/dedupe infrastructure before a concrete need appears

## 12. Bottom Line

This repository now contains a real, working first implementation of an
OpenCode native agent harness for OpenClaw WebUI use, including progressive
SSE streaming.

The most important thing to preserve is the narrow shape:

- harness-only plugin
- standalone linked repo
- small runtime modules
- real session continuity
- real reset behavior
- real progressive streaming
- no speculative platform sprawl

Future work should improve this baseline, not bury it.