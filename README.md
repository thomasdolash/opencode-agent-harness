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
- `src/app-server/shared-client.ts`: OpenCode SDK client and managed server seam
- `src/app-server/session-binding.ts`: sidecar binding persistence
- `src/app-server/run-attempt.ts`: thin native turn execution path
- `scripts/smoke-run-attempt.ts`: local smoke validation
- `docs/ARCHITECTURE.md`: current ground truth, status, and follow-up work

## Local Development

Install dependencies:

```bash
npm install
```

Run the required local checks:

```bash
npm run typecheck
npm run smoke
```

## Known-Good Usage Shape

This plugin is intended to be mounted into an OpenClaw gateway as a linked local
plugin.

Known-good workflow:

1. run a normal OpenClaw gateway container
2. mount this repository into the container
3. link/load the plugin from the mounted path
4. configure an agent/model route that selects runtime `opencode`

Current plugin config surface:

- `server.mode`
- `server.baseUrl`
- `server.hostname`
- `server.port`
- `server.timeoutMs`
- `server.minVersion`

## Current Status

The first MVP is working:

- harness selection works in the live gateway
- first-turn and second-turn native session behavior work
- reset clears session continuity
- local typecheck and smoke pass

The main known follow-up gaps are:

- runtime selection is still broader than desired in the current OpenClaw config
- reasoning visibility is not yet fully aligned with OpenClaw's existing
  `/reasoning on|off|stream` controls
- progressive streaming behavior still needs improvement

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the detailed
done/not-done/next-work breakdown.
