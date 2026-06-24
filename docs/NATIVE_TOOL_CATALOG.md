# OpenCode Native Tool Catalog v1

## Architecture

```text
OpenClaw spawned child
→ effective subagent policy allows curated session tools
→ harness nativeToolCapability requests curated tools
→ params.nativeToolDefinitions contains currently effective tools
→ OpenCode static catalog exposes named tools
→ plugin callback POSTs to loopback callback server
→ active attempt binding lookup
→ params.nativeToolExecutor
→ native OpenClaw tool execution
→ model-readable result renderer
```

The native executor remains the only authority for:

```text
tool availability
session identity
visibility
argument validation
native execution
result semantics
```

## Catalog v1

| Tool | Purpose | Worker/Orchestrator |
|------|---------|-------------------|
| `sessions_send` | Send a message to a visible session | Worker |
| `sessions_list` | List visible sessions with filters | Worker |
| `sessions_history` | Fetch sanitized transcript history for a visible session | Worker |

### sessions_send

- **OpenCode-facing arguments**: `sessionKey` (string), `message` (string), `timeoutSeconds` (integer, optional, min 0)
- **Renderer**: Generic text joiner — concatenates all text content parts in order
- **Native availability**: Requires `sessions_send` in `params.nativeToolDefinitions`

### sessions_list

- **OpenCode-facing arguments**: `kinds` (string[], optional), `limit` (integer, optional), `activeMinutes` (integer, optional), `label` (string, optional), `agentId` (string, optional), `search` (string, optional), `includeDerivedTitles` (boolean, optional), `includeLastMessage` (boolean, optional)
- **Renderer**: Parses JSON session array (`{sessions: [...]}` or bare array); renders one compact line per session with key, agent ID, kind, label, title, and last-message preview when available
- **Native availability**: Requires `sessions_list` in `params.nativeToolDefinitions`

### sessions_history

- **OpenCode-facing arguments**: `sessionKey` (string, required), `limit` (integer, optional), `includeTools` (boolean, optional)
- **Renderer**: Parses JSON `{messages: [...]}` or bare array; renders `role: content` lines with content truncated at 500 chars; marks `toolCall`/`toolResult` roles with `[role]` prefix
- **Native availability**: Requires `sessions_history` in `params.nativeToolDefinitions`

## Complete Canonical Schemas

### sessions_list

| Field | Type | Required | Default | Bounds | Native when omitted |
|-------|------|----------|---------|--------|-------------------|
| `kinds` | `string[]` | no | — | enum: `"main"`, `"group"`, `"cron"`, `"hook"`, `"node"`, `"other"` | All kinds returned |
| `limit` | `integer` | no | — | minimum: 1 | Server default |
| `activeMinutes` | `integer` | no | — | minimum: 1 | No time filter |
| `messageLimit` | `integer` | no | 0 | minimum: 0, capped at 20 server-side | No message hydration |
| `label` | `string` | no | — | minLength: 1 | No label filter |
| `agentId` | `string` | no | — | minLength: 1, maxLength: 64 | All agents |
| `search` | `string` | no | — | minLength: 1 | No search |
| `includeDerivedTitles` | `boolean` | no | `false` | — | No titles |
| `includeLastMessage` | `boolean` | no | `false` | — | No preview |

**Native result**: `{ sessions: [{ key, agentId, kind, channel, label, derivedTitle, lastMessagePreview, spawnedBy, parentSessionKey, updatedAt, sessionId, model, contextTokens, deliveryContext, origin }] }`

### sessions_history

| Field | Type | Required | Default | Bounds | Native when omitted |
|-------|------|----------|---------|--------|-------------------|
| `sessionKey` | `string` | **yes** | — | — | Tool returns error |
| `limit` | `integer` | no | — | minimum: 1 | Server default |
| `includeTools` | `boolean` | no | `false` | — | Tool call/result messages stripped via `stripToolMessages` |

**Native result**: `{ sessionKey, messages: [{ role, content, ... }], truncated, droppedMessages, contentTruncated, contentRedacted, bytes }`
- Messages capped at 80KB JSON bytes (`SESSIONS_HISTORY_MAX_BYTES`)
- Individual text fields truncated to 4000 chars (`SESSIONS_HISTORY_TEXT_MAX_CHARS`)
- Thinking signatures removed
- Tool payload text redacted

## Deferred Tools (v2+ — Orchestrator Profile)

These are intentionally excluded from the default worker catalog:

| Tool | Reason |
|------|--------|
| `sessions_spawn` | Requires child lifecycle management and ACP awareness |
| `sessions_yield` | Coordinates with `sessions_spawn` for turn-based waiting |
| `subagents` | Run management (`list`/`cancel`); depends on spawn lifecycle |
| `session_status` | Session metadata — diagnostic/orchestrator layer |
| `gateway` | Admin tool; denied to subagents by Gateway policy |
| `agents_list` | Admin tool; denied to subagents by Gateway policy |
| `cron` | Scheduling — entirely separate domain |

## Required Gateway Configuration

```json5
tools: {
  subagents: {
    tools: {
      allow: [
        "sessions_send",
        "sessions_list",
        "sessions_history",
      ],
    },
  },
}
```

This allows the tools to survive spawned-subagent policy filtering. The harness (`nativeToolCapability` in `src/harness.ts`) still controls which tools it requests, and the native executor remains authoritative for availability, identity, visibility, and execution.

## Managed OpenCode Server Lifecycle

Static plugin tools are registered when the managed OpenCode server is created. Changing the catalog source file does **not** update an already-running managed server.

After catalog changes, recreate the managed server through the normal cleanup path:

```ts
import { clearSharedOpenCodeHarnessClientAndWait } from "./src/app-server/shared-client.js";
await clearSharedOpenCodeHarnessClientAndWait();
```

The next harness attempt will create a fresh managed server.

## Callback Server Behavior

- Loopback-only HTTP callback server (`src/native-tool-bridge/callback-server.ts`)
- Default port: **14796**
- **Ephemeral-port fallback**: When the default port is occupied (EADDRINUSE), the server auto-retries on an OS-assigned ephemeral port
- Callback URL propagated to OpenCode plugin via `process.env.OPENCODE_NATIVE_TOOL_CALLBACK_URL`
- Per-attempt bindings are registered after OpenCode session creation and removed in `finally`
- Duplicate registration throws; unregister is identity-safe
- The callback server checks `params.nativeToolDefinitions` before forwarding: a tool not in the current attempt's definitions returns a deterministic 404
- Multiple stop calls are safe (no-op after first)