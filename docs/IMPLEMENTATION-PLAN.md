# OpenCode Agent Harness Implementation Plan

This document is the follow-up to `docs/ARCHITECTURE.md`.

`ARCHITECTURE.md` is the ground-truth status file.
This file is the implementation-planning file.

It focuses on the major unfinished chunks, the real API surface currently
available, and the most practical path to solve each one.

## 1. Priorities

Recommended order:

1. runtime selection cleanup
2. workspace/directory propagation
3. reasoning visibility integration
4. streaming and event projection
5. transcript/context/usage propagation
6. diagnostics and validation expansion

That order keeps us on the narrowest path toward a better v1 without dragging
in Codex-sized complexity too early.

## 2. Runtime Selection Cleanup

### Gap

Current live config used a broad wildcard runtime mapping to force harness
selection.

That works, but it is wider than necessary and makes it harder to reason about
why a given model/session selected `opencode`.

### Confirmed surface

OpenClaw's agent harness docs say:

- model-scoped runtime policy wins first
- provider-scoped runtime policy comes next
- `auto` then asks harnesses whether they support the resolved provider/model
- plugin harness failures do not replay through embedded fallback once claimed
- stale session runtime pins and legacy whole-agent runtime pins are ignored by
  selection

Relevant local references:

- `/home/comra/_workspace/repos/openclaw/src/agents/harness/selection.ts`
- `/home/comra/_workspace/repos/openclaw/src/agents/harness/types.ts`
- `/home/comra/_workspace/oc_stack/_repositories/opencode-agent-harness/src/harness.ts`

Current harness behavior:

- `supports()` returns true when `requestedRuntime === "opencode"`
- otherwise it returns true when the resolved provider is in `providerIds`
- default provider ids are `["opencode"]`

### Plan

1. Replace the wildcard config with the narrowest exact mapping that matches
   the real resolved model ref in OpenClaw.
2. Prefer model-scoped routing for the canonical test model:
   `agents.list[].models["provider/model"].agentRuntime.id = "opencode"` or
   `agents.defaults.models["provider/model"].agentRuntime.id = "opencode"`.
3. Use provider-scoped routing only if the intention is "all models under this
   provider should go through OpenCode".
4. Keep `supports()` simple and deterministic:
   forced runtime should stay highest priority
   provider support should stay the fallback claim path
5. Capture one known-good config example in repo docs once the exact shape is
   proven.

### Validation

- `/status` should show `Runtime: opencode`
- debug logs should show `selectedReason: "forced_plugin"` or the expected
  automatic support path
- removing the wildcard should not change the selected runtime for the target
  model

## 3. Workspace and Directory Propagation

### Gap

The current harness does not deliberately bind OpenCode sessions to the
OpenClaw working directory.

That means the live session may work, but it is not yet explicitly anchored to
`params.workspaceDir` / `params.cwd`.

### Confirmed surface

OpenClaw run params already provide:

- `workspaceDir`
- optional `cwd`

Relevant local reference:

- `/home/comra/_workspace/repos/openclaw/src/agents/embedded-agent-runner/run/params.ts`

OpenCode SDK request types expose directory/workspace routing:

- `SessionCreateData.query.directory`
- `SessionCreateData.query.workspace`
- `SessionPromptData.query.directory`
- `SessionPromptAsyncData.query.directory`
- `SessionMessagesData.query.directory`
- `V2SessionContextData.path.sessionID` plus the v2 context endpoint

Relevant local reference:

- `/home/comra/_workspace/oc_stack/_repositories/opencode-agent-harness/node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts`

### Plan

1. Extend the local client wrapper so `createSession`, `message`,
   `streamMessage`, and future `context` fetches can accept directory/workspace
   options.
2. Resolve one canonical execution directory per turn:
   prefer `params.cwd`
   otherwise use `params.workspaceDir`
3. Pass that directory into OpenCode session creation and prompt calls.
4. Persist the chosen directory in the sidecar only if it helps detect invalid
   reuse across changed workspaces.
5. Add a smoke case that asserts the client receives the expected directory.

### Validation

- first turn creates a session bound to the expected directory
- resumed turn uses the same directory
- manual live test can read/write in the expected project root without relying
  on implicit server defaults

### Latest live finding

The first real `openclaw agent --agent opencode` file-write probe did not land
in the caller-provided probe directory. The reply reported `cwd` under a
gateway-managed workspace path (`/home/node/agent-workspaces/...`) instead.

That is a real workspace-propagation signal, but it should stay secondary to
the primary streaming investigation unless it blocks a narrower streaming-only
prompt.

## 4. Reasoning Visibility Integration

### Gap

This is the most important correctness gap.

Today:

- reasoning text can exist in OpenCode output
- we now suppress it from the normal visible final reply text
- but we do not yet correctly map OpenClaw's `/reasoning off|on|stream`
  behavior into the harness

### Confirmed surface

OpenClaw clearly treats these as separate concepts:

- `thinkLevel` is model effort / reasoning effort
- `reasoningLevel` is visibility and delivery policy

OpenClaw docs and code confirm:

- thinking resolution is host-owned
- reasoning visibility is session/directive owned
- reasoning streaming is delivered through `onReasoningStream`
- typing may also start from reasoning before visible assistant text

Relevant references:

- `https://docs.openclaw.ai/tools/thinking`
- `/home/comra/_workspace/repos/openclaw/src/auto-reply/reply/get-reply.ts`
- `/home/comra/_workspace/repos/openclaw/src/auto-reply/reply/agent-runner-execution.ts`
- `/home/comra/_workspace/repos/openclaw/src/agents/embedded-agent-subscribe.ts`

Important constraint:

- plugin harness `runAttempt(...)` params currently receive `thinkLevel`
- they do not appear to receive a clean `resolvedReasoningLevel`
- `onReasoningStream` callback presence is not a safe proxy for visible
  reasoning, because OpenClaw may also use reasoning callbacks to drive typing
  behavior

OpenCode SDK gives us reasoning data:

- `session.next.reasoning.started`
- `session.next.reasoning.delta`
- `session.next.reasoning.ended`
- final `type: "reasoning"` parts

### Plan

1. Keep the current safety rule:
   never merge reasoning parts into visible assistant text
2. Add a small harness-owned reasoning accumulator separate from assistant text.
3. Do not surface reasoning based on `thinkLevel`.
4. Make the proper bridge an explicit upstream requirement:
   OpenClaw should expose the effective reasoning visibility state to native
   harnesses, ideally as a field on `AgentHarnessAttemptParams`
5. After that bridge exists, map behavior like this:
   `off`: collect reasoning only for classification/debugging, never display
   `on`: persist reasoning in transcript/history shape but do not live-stream it
   `stream`: emit reasoning through `onReasoningStream` and use the same
   host-owned delivery behavior OpenClaw already uses
6. Mirror the Codex pattern once the host signal exists:
   keep visible final answer separate
   optionally mirror reasoning into `messagesSnapshot`
   never let reasoning contaminate `assistantTexts`

### Validation

- `/reasoning off`: no visible thought text, no reasoning preview
- `/reasoning on`: no leakage into final answer, reasoning available only in
  the expected OpenClaw-owned place
- `/reasoning stream`: reasoning arrives progressively through the existing
  gateway path

### Likely upstream change

This likely needs a small OpenClaw host/runtime change before the harness can
be fully correct.

Most likely fix:

- expose `resolvedReasoningLevel` directly to agent harness attempts

Alternative fix:

- split typing-start-on-reasoning from user-visible reasoning delivery so
  `onReasoningStream` means only one thing

## 5. Streaming and Event Projection

### Gap

The current path can emit partial text, but it still behaves too much like
"wait for the complete answer".

We are also leaving most native OpenCode events unused.

### Confirmed surface

OpenClaw already owns:

- channel preview streaming
- block streaming
- chunking and chunk flush policy
- `text_end` vs `message_end`

Relevant docs:

- `https://docs.openclaw.ai/concepts/streaming`

OpenClaw harness params already expose:

- `onPartialReply`
- `onAssistantMessageStart`
- `onReasoningStream`
- `onReasoningEnd`
- `onAgentEvent`
- `blockReplyBreak`
- `blockReplyChunking`

OpenCode SDK event stream gives us:

- `session.next.text.started|delta|ended`
- `session.next.reasoning.started|delta|ended`
- `session.next.tool.called|progress|success|failed`
- `session.next.step.ended` with finish/cost/token totals

Relevant local references:

- `/home/comra/_workspace/oc_stack/_repositories/opencode-agent-harness/src/app-server/shared-client.ts`
- `/home/comra/_workspace/oc_stack/_repositories/opencode-agent-harness/node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts`

### Plan

1. Stop treating streaming as "partial text plus final fetch only".
2. Introduce a small event projector layer for OpenCode events.
3. Map `text.delta` to `onPartialReply`.
4. Map `text.started` to `onAssistantMessageStart`.
5. Map reasoning events into the separate reasoning accumulator, and later into
   `onReasoningStream` once the host visibility bridge is correct.
6. Forward tool lifecycle events through `onAgentEvent` first, before inventing
   any transcript-mirroring complexity.
7. Keep chunking/block flush decisions host-owned; the harness should emit
   clean progressive text and let OpenClaw handle delivery policy.
8. Continue falling back to a final message fetch at turn completion until the
   event projector is reliable enough to trust as the canonical final state.

### Validation

- partial text appears earlier in WebUI
- no duplicate text between streamed output and final answer
- block streaming behavior remains controlled by OpenClaw config, not by ad hoc
  harness chunking

## 6. Transcript, Context, and Usage Propagation

### Gap

The harness currently returns a very thin result:

- final assistant text
- minimal `messagesSnapshot`
- no rich usage projection
- no local mirror of prompt/tool/reasoning context

This is probably why the MVP works for native continuity but still feels thin
from OpenClaw's perspective.

### Confirmed surface

`AgentHarnessAttemptResult` supports:

- `messagesSnapshot`
- `lastAssistant`
- `currentAttemptAssistant`
- `attemptUsage`
- `contextBudgetStatus`

OpenClaw status formatting uses session `contextBudgetStatus` when available.

Relevant local references:

- `/home/comra/_workspace/repos/openclaw/src/agents/embedded-agent-runner/run/types.ts`
- `/home/comra/_workspace/repos/openclaw/src/status/status-message.ts`

OpenCode SDK exposes:

- `session.next.step.ended` tokens and cost
- `/api/session/{sessionID}/context`
- normal session message listing

Codex already demonstrates the richer pattern:

- mirror user prompt
- keep reasoning separate
- attach tool transcript entries
- populate assistant usage

Relevant local references:

- `/home/comra/_workspace/repos/openclaw/extensions/codex/src/app-server/event-projector.ts`
- `/home/comra/_workspace/repos/openclaw/extensions/codex/src/app-server/transcript-mirror.ts`

### Plan

1. Expand `messagesSnapshot` to include at least:
   the user prompt mirror
   the final assistant message
2. Add attempt-local usage projection from `session.next.step.ended.tokens`.
3. Set `lastAssistant.usage` and `currentAttemptAssistant.usage` when usage is
   available.
4. Add `attemptUsage` to the result.
5. Investigate whether `contextBudgetStatus` can be truthfully populated from
   native data.
6. If OpenCode does not expose a reliable current-token-count surface, do not
   fake it.
7. As a second pass, consider tool transcript entries in `messagesSnapshot`.

### Validation

- `/status` usage metadata becomes less empty
- local transcript/history becomes useful even if OpenCode still owns native
  continuity
- future context-engine work has better material than a single assistant reply

### Important note

We should prefer "accurate but partial" over "complete-looking but fake".

If we can only supply:

- better transcript mirroring
- usage totals
- context budget denominator

that is still worthwhile even if exact live context-token count remains unknown.

## 7. Diagnostics and Operator Visibility

### Gap

The plugin is debuggable, but not yet comfortably operable.

We still rely too much on:

- raw gateway logs
- manual sidecar inspection
- source reading

### Confirmed surface

Current plugin already has debug logger wiring and session sidecar persistence.

Relevant local references:

- `/home/comra/_workspace/oc_stack/_repositories/opencode-agent-harness/src/logger.ts`
- `/home/comra/_workspace/oc_stack/_repositories/opencode-agent-harness/src/app-server/session-binding.ts`

### Plan

1. Keep routine success logs at `debug`, not `info`.
2. Standardize log events around:
   create-session
   resume-session
   prompt-start
   prompt-complete
   prompt-failed
   reset
3. Add targeted error metadata:
   session id
   session file
   directory/cwd
   mode (`managed` vs `remote`)
4. Only extend the sidecar if it clearly helps with debugging:
   last used model
   createdAt
   optionally last successful directory
5. Document exact inspection commands in repo docs.

### Validation

- a failed live turn should be diagnosable from one log slice plus one sidecar
  file
- normal successful turns should not spam info logs

## 8. Validation Expansion

### Gap

The current smoke test proves the happy-path harness seam, but not much more.

### Confirmed surface

Current required checks:

- `npm run typecheck`
- `npm run smoke`

Current smoke covers:

- create session
- reuse session
- reset

### Plan

1. Keep the no-Vitest short-term convention.
2. Keep the local smoke focused on harness seams, but use the live probe for
   the primary UX question: does the real `opencode` route emit progressive
   visible reply chunks.
3. The live probe should measure streaming first:
   run a long no-tool turn
   record stdout chunk timing
   report whether multiple visible chunks arrived over time
4. Treat workspace drift as a captured finding, not the primary pass/fail gate
   for the streaming probe.
5. Add a tiny manual live checklist doc:
   first turn
   second turn
   `/reset`
   streamed visible reply
   reasoning off
6. Do not broaden into slow integration infrastructure until these narrow checks
   stop buying us enough confidence.

## 9. Deferred But Legitimate Follow-Up Work

These are valid future chunks, but they should stay behind the items above.

### Tool bridge / richer tool projection

OpenCode emits native tool events.
OpenClaw also has its own tool policy and transcript expectations.

Recommended path:

1. first forward native tool events through `onAgentEvent`
2. then add transcript mirroring only for the cases that materially improve UX
3. do not attempt a full runtime-neutral dynamic tool bridge yet

### Compaction support

This is a real long-term requirement if OpenCode is going to be treated as a
first-class native runtime.

Recommended path:

1. wait until transcript/context mirroring is richer
2. inspect OpenCode's native session context/compaction surfaces
3. only then decide whether compaction should be native-owned, host-owned, or
   hybrid

### Replay / reconnect / dedupe

Useful, but not needed for the current MVP line.

Recommended path:

1. first stabilize event projection
2. then add message ids / idempotency structure
3. only after that add reconnect repair or duplicate suppression logic

### Side-question support

Not urgent.
Implement only after the main turn path is solid.

## 10. SDK Harness Spec Coverage Review

This section maps the current repository against the official
`sdk-agent-harness` reference.

### Already covered well enough for v1

- native harness registration
- harness selection support logic
- native session sidecar binding
- reset clearing sidecar state
- hard-fail behavior once the harness claims a run
- basic final assistant reply projection
- terminal outcome classification helper usage

### Intentionally split elsewhere

The spec says most harnesses should also register a provider so model refs,
auth, and `/model` behavior stay visible in OpenClaw.

In our current shape, that is intentionally split:

- provider-facing OpenCode behavior remains outside this repo
- this repo is harness-only

That is acceptable as long as the provider half continues to exist and stays
compatible with the harness route.

### Missing: tool injection

This is the largest spec gap after reasoning integration.

The spec explicitly says:

- OpenClaw core constructs the tool list
- the prepared attempt passes tools into the harness
- dynamic tool results should come back through the harness result shape rather
  than bypassing OpenClaw delivery

Current repo reality:

- `run-attempt.ts` currently sends only prompt `parts`
- `params.tools` is not injected into OpenCode at all
- OpenCode-native tool lifecycle events are not yet projected into
  `toolMetas`, `messagesSnapshot`, `onAgentEvent`, or media/tool result fields

What this means:

- the harness currently works because OpenCode can still operate in its own
  native way for basic tasks
- but it is not yet honoring the full OpenClaw-prepared tool policy surface
- tool behavior cannot yet be considered spec-complete

Recommended plan for tool injection:

1. Inspect the exact shape of `params.tools` reaching the harness in live runs.
2. Run those tools through `params.runtimePlan.tools.normalize(...)` before any
   provider-side adaptation.
3. Decide the first integration mode:
   pass a reduced allow/disable map into OpenCode if that is all the SDK can
   represent cleanly
   or build an adapter layer if OpenCode can accept a richer tool manifest
4. Project native OpenCode tool events back into OpenClaw first through:
   `onAgentEvent`
   `toolMetas`
   `messagesSnapshot` where useful
5. Return media/tool outputs through the harness result instead of custom
   channel sends.

Important note:

We should not fake "full tool injection" if OpenCode's public request surface
only accepts a boolean tool allow-map today. A partial but accurate adapter is
better than pretending the two runtimes have identical tool schemas.

### Missing: transcript mirror

The spec expects native harnesses to keep mirroring user-visible output into
OpenClaw transcript/session history.

Current repo reality:

- sidecar binding exists
- `messagesSnapshot` is extremely thin
- user prompt mirroring is not implemented
- reasoning/tool transcript mirroring is not implemented

This is a correctness and compatibility gap, not just a UX nicety.

Recommended plan:

1. Mirror the user prompt into `messagesSnapshot`.
2. Mirror the final assistant reply.
3. Add reasoning and tool transcript entries only after visibility/tool policy
   handling is correct.

### Missing: tool and media result projection

The spec calls out that harnesses should keep tool/media output on the normal
OpenClaw delivery path.

Current repo reality:

- no dedicated tool result projection
- no tool media URL projection
- no `didSendViaMessagingTool` semantics beyond default false values

Recommended plan:

1. Start with text tool-result projection only.
2. Then project output paths/media URLs when OpenCode exposes them through
   `session.next.tool.success`.
3. Keep channel delivery OpenClaw-owned.

### Missing: runtimePlan integration

The spec calls out `params.runtimePlan` as a host-owned policy bundle.

Current repo reality:

- the harness does not use `runtimePlan`

That is not automatically wrong for a thin MVP, but it is a real spec gap.

Most relevant runtime plan seams for us are:

- `runtimePlan.tools.normalize(...)`
- `runtimePlan.tools.logDiagnostics(...)`
- `runtimePlan.transcript.resolvePolicy(...)`
- `runtimePlan.delivery.isSilentPayload(...)`
- `runtimePlan.outcome.classifyRunResult(...)`

Recommended plan:

1. Use `runtimePlan.tools.*` as part of the tool injection work.
2. Use `runtimePlan.transcript.resolvePolicy(...)` when transcript mirroring
   gets richer.
3. Use `runtimePlan.delivery.isSilentPayload(...)` before assuming a native
   empty or special payload should be shown.
4. Keep provider/model switching strictly out of harness logic.

### Probably not needed yet: tool-result middleware registration

The spec documents runtime-neutral tool-result middleware registration for
trusted plugins.

Current repo reality:

- this plugin does not register middleware

That is fine for now.
This seam becomes relevant only if we want a plugin-local transform to run on
tool results before they are fed back to the model across targeted runtimes.

### Current bottom line against the spec

The harness is already legitimate as a native harness MVP, but it is still
below the full intended SDK surface in these areas:

- tool injection
- runtimePlan usage
- transcript mirroring
- tool/media result projection
- reasoning visibility bridging

Those are the main spec-shaped gaps that still matter.

## 11. Recommended Next Execution Sequence

If work resumes immediately, the best sequence is:

1. wire directory propagation
2. expand streaming from text-only partials to native event projection
3. add transcript mirror + usage projection
4. decide whether reasoning visibility needs an upstream OpenClaw patch now or
   can be staged behind the other improvements
5. tighten runtime selection once the exact final config is proven

That sequence improves the live experience without forcing us to solve the
hardest host-API gap first.

## 12. Research Handoff For The Next Session

This section captures the concrete findings from the most recent source
inspection so the next session can move straight into implementation.

### Confirmed OpenCode surface

The OpenCode SDK exposes more than the harness uses today. The methods that
matter most here are:

- `session.create`
- `session.prompt`
- `session.message`
- `session.promptAsync`
- `session.messages`
- `session.command`
- `session.shell`
- `session.abort`
- `session.revert`
- `session.unrevert`
- `event.subscribe`

The current harness is already using the right core path for native turns:
subscribe to SSE, prompt asynchronously, then fetch messages for finalization if
needed.

### Confirmed OpenClaw surface

OpenClaw already has the delivery lanes we need:

- `onPartialReply`
- `onAssistantMessageStart`
- `onReasoningStream`
- `onReasoningEnd`
- `onBlockReply`
- `onBlockReplyFlush`
- `onAgentEvent`
- `blockReplyBreak`
- `blockReplyChunking`

The OpenClaw embedded subscriber also already treats assistant text, reasoning,
and block delivery as separate concerns. So the task is integration, not
invention.

### Confirmed Codex reference pattern

The Codex extension is the best local model for a fuller harness.

The big lessons from it are:

- assistant text and reasoning are tracked separately
- tool progress is projected separately
- visible delivery is coordinated through OpenClaw, not dumped straight out of
  the model wrapper
- its harness defaults to `sourceVisibleReplies: "message_tool"`

That makes Codex the right reference when we want to expand OpenCode beyond the
thin MVP shape.

### What the latest live behavior suggests

The harness changes already proved that:

- OpenCode sessions can be created and resumed
- the real `openclaw agent --agent opencode` path can reach the harness
- a same-session follow-up turn can recall prior-turn state
- the currently active live model required `thinking off` for the probe route

The remaining streaming problem is therefore likely one of:

- reasoning visibility not being bridged as a first-class host signal
- the UI consuming the final block lane instead of the progressive assistant
  lane
- the CLI/gateway path buffering visible output until turn completion
- the harness still relying on a mixed event projector that merges
  `message.part.updated`, `message.part.delta`, and `session.next.text.*`
  instead of one narrow canonical assistant-text surface

A separate live finding also appeared:

- the file-write probe reported `cwd` under `/home/node/agent-workspaces/...`
  instead of the caller-supplied probe directory

That workspace finding matters, but it should not dominate the next probe. The
next probe should be judged first on whether progressive visible output is
observed on the real route.

Report comparison notes that should stay attached to the plan:

- the external research report was directionally correct that the issue is
  harness-local and that OpenClaw preview streaming should own progressive
  delivery
- the report's strongest old block-lane claim is now stale for this repo: the
  live code no longer mirrors every partial text update into `onBlockReply`
- the more precise live bug was assistant-message identification: OpenCode can
  emit a user `message.part.updated` before assistant output begins, so the
  harness must filter assistant partials by known assistant message ids
- the current code now includes that assistant-id guard, which means future
  streaming investigation should focus less on replaying old block-lane fixes
  and more on whether the mixed event surface still causes partial buffering or
  duplication
- the healthy baseline remains: raw OpenCode SSE emits incremental assistant
  deltas, so if WebUI still shows a final wall of text, the remaining fault is
  between the harness projector and OpenClaw's progressive delivery path

The main caution is that `thinkLevel` is not the same thing as reasoning
visibility. If the next change conflates those, we will keep chasing the wrong
problem.

### Best next implementation chunks

1. Map OpenCode reasoning events into OpenClaw reasoning callbacks without
   leaking them into visible assistant text.
2. Verify live OpenClaw stream/block settings before blaming the SDK bridge.
3. Add a small event-projector layer only if direct forwarding still does not
   give enough control.
4. Keep the harness narrow; do not broaden into provider/tool/permission bridge
   work unless a concrete gap forces it.

### Useful logs to watch

When the harness is behaving well, logs should show:

- OpenCode session creation or resumption
- assistant start before final completion
- repeated assistant deltas while the model is thinking/typing
- separate tool lifecycle events when tools are used
- no reasoning text leaking into the normal visible answer

If the UI still prints a wall of text, inspect the OpenClaw delivery path and
channel config before changing the OpenCode wrapper again.
