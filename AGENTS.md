# opencode-agent-harness

OpenClaw plugin that registers the native `opencode` agent harness and provides
a loopback callback bridge for native OpenClaw tool invocation from OpenCode.

## Quick commands

```bash
npm run typecheck          # tsc --noEmit (no linter/formatter in repo)
npm run smoke              # offline SDK-faked smoke (no server needed)
npm run build              # tsc -> dist/ (required before plugin loads)
```

## Testing

- **Unit tests**: Node.js built-in `node:test` via `scripts/run-tests.ts`
  - `npm test` — runs all `tests/**/*.test.ts`
  - `npm run test:bridge` — only `tests/native-tool-bridge/`
- **Smoke** (`scripts/smoke-run-attempt.ts`): fakes the SDK entirely — no running server required.

## Architecture

- **Harness id**: `opencode`. Activation: `openClaw.plugin.json` `"onAgentHarnesses": ["opencode"]`
- **Two server modes**:
  - `managed` (default) — launches `@opencode-ai/sdk/server` in-process
  - `remote` — requires `server.baseUrl`
- **Session binding**: One OpenClaw session file → one OpenCode session id, persisted in sidecar `<sessionFile>.opencode-harness-binding.json`
- **Streaming**: Subscribes to SSE events and polls for fallback text growth. Progressive assistant text via `emitAgentEvent`.
- **Native tool bridge**: Loopback HTTP callback server (`src/native-tool-bridge/callback-server.ts`) + OpenCode plugin (`src/native-tool-bridge/opencode-tool-plugin.ts`). The bridge maps OpenCode session IDs to active harness attempt bindings and forwards tool calls to `params.nativeToolExecutor`.
- **Transcript mirror**: OpenCode turns mirrored into OpenClaw transcript format with idempotency.

## Native tool bridge

| File | Purpose |
|------|---------|
| `src/native-tool-bridge/callback-server.ts` | Loopback HTTP server (port 14796 by default) that registers attempt bindings and proxies tool callbacks to the native executor |
| `src/native-tool-bridge/opencode-tool-plugin.ts` | OpenCode plugin loaded by managed server; static `sessions_send` tool that POSTs to the callback server |
| `tests/native-tool-bridge/callback-server.test.ts` | Unit tests for registry lifecycle, HTTP endpoint, and result conversion |

- The callback server starts before the OpenCode server and binds to `127.0.0.1:14796`
- The callback URL is passed to the plugin via `process.env.OPENCODE_NATIVE_TOOL_CALLBACK_URL`
- Attempt bindings are registered after the OpenCode session ID is known and unregistered in `finally`
- Duplicate registrations throw; unregister is identity-safe
- The OpenCode plugin exposes only `sessions_send` with `sessionKey`, `message`, `timeoutSeconds`

## Plugin config requirements

- `server` section is required (even in managed mode). Remote mode requires `server.baseUrl`.
- Gateway config must set `agentRuntime: { id: "opencode" }` per model/provider to route turns through this harness.

## Gateway operations

- **NEVER** `docker restart` the Gateway container without explicit approval.
- **Only** restart the Gateway with:
  ```bash
  openclaw gateway restart --safe --skip-deferral
  ```
  This runs on the host, NOT inside docker.

## Key env vars

| Var | Purpose |
|-----|---------|
| `OPENCODE_SERVER_BASE_URL` | Remote mode base URL fallback |
| `OPENCODE_NATIVE_TOOL_CALLBACK_URL` | Set by harness before managed server startup; read by OpenCode plugin |

## Script execution

All scripts use `node --import tsx` — never `ts-node` or `npx tsx`.

## Conventions

- ESM (`"type": "module"`), `verbatimModuleSyntax`, `NodeNext` module resolution.
- No linter, no formatter config in repo.
- `dist/`, `node_modules/`, `.local/`, `.env` gitignored.
- Plugin SDK imports from `openclaw/plugin-sdk/*` (peer dependency).
- OpenCode SDK imports from `@opencode-ai/sdk/*` (dependency).