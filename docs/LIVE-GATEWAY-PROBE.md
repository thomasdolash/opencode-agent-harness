# Live Gateway Probe

This probe now focuses on the primary question for the real OpenClaw ->
OpenCode path: does the `opencode` route produce progressively visible reply
chunks, or does it still behave like final-only delivery.

It does two things:

- runs a long first turn on `agentId: "opencode"` with no tool use and records
  stdout chunk timing
- runs a second turn on the same session key to confirm session continuity via a
  remembered token

When OpenClaw exposes the session file in the second-turn JSON result, the probe
also reads the harness binding sidecar so we can confirm the native OpenCode
session id.

## Usage

From this repository:

```bash
npm run probe:live
npm run probe:live -- --agent opencode
```

Useful overrides:

```bash
npm run probe:live -- --model <provider/model>
npm run probe:live -- --workspace /path/to/worktree
npm run probe:live -- --session-key agent:opencode:opencode-live-probe-manual
npm run probe:live -- --thinking off
```

## Requirements

- a reachable OpenClaw gateway for the local `openclaw` CLI
- this plugin linked into that gateway
- routing/config that selects the `opencode` runtime for the chosen agent/model
- a live OpenCode backend behind that route

## What Success Looks Like

The script prints:

- the exact `openclaw agent` commands it ran
- a visible-text preview for turn 1 and turn 2
- a streaming summary for turn 1 stdout chunk timing
- a final JSON result with:
  `streamingObserved`
  `stdoutChunkCount`
  `firstChunkAtMs`
  `lastChunkAtMs`
  continuity evidence
  optional binding metadata

The probe exits non-zero when it does not observe progressive stdout chunks on
turn 1. That is intentional: this script is now primarily a streaming
verification tool.

## Secondary Findings

Earlier probe iterations also surfaced a real workspace-path finding on the live
route: the agent reported `cwd` under `/home/node/agent-workspaces/...` instead
of the caller-provided temp directory.

That finding still matters, but it is no longer the primary pass/fail check for
this probe.
