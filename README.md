# opencode-agent-harness

If you want to skip ACP agent complexity and run OpenCode agents directly, this repository is for you.
It provides an OpenClaw plugin that registers a native `opencode` harness for OpenCode-backed WebUI and CLI turns.

The built `dist/` directory is loaded as an OpenClaw plugin via
`openclaw.plugin.json`. Mount the repository into the gateway container
and link it through OpenClaw's plugin loader.

## Repository Layout

- `src/index.ts` — plugin entry, registers the harness with OpenClaw
- `src/harness.ts` — harness declaration and selection behavior
- `src/config.ts` — plugin config parsing
- `src/app-server/shared-client.ts` — OpenCode SDK client, SSE subscription, multipart assistant text assembly
- `src/app-server/session-binding.ts` — sidecar session binding persistence
- `src/app-server/run-attempt.ts` — native turn execution, streaming gate, agent-event emission bridge
- `scripts/smoke-run-attempt.ts` — local smoke validation


## Validation

```bash
npm run typecheck
npm run smoke
```

## Build & Install

```bash
npm install
npm run build
```

## Required openclaw configuration

```jsonc
{
  "agents": {
    "list": [
      {
        "id": "your-agent-id",
        "models": [
            // Wildcard: This agentId will always attempt to use the OpenCode harness:
            "*": { 
                "agentRuntime": {
                    "id": "opencode"
                }
            },

            // Or, per-provider wildcard:
            "openrouter/*": {
              "agentRuntime": {
                  "id": "opencode"
                }

            },
              // Or, define harness use per-model:
              "openrouter/deepseek/deepseek-v4-flash": {
              "agentRuntime": {
                  "id": "opencode"
            }
          }
        ]
      }
    ]
  }
}
```