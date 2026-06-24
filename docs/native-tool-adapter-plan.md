# Native Tool Adapter — Implementation Plan

## 1. Current Branch and Commit

- **Branch**: `native-tool-bridge` (tracking `origin/master`, created at `fac7315`)
- **Commit**: `fac7315` — "Documentation for improved openclaw agent-harness API surface."
- **Prior bridge excluded**: The `src/bridge/` directory (audit, broker-route, bridge-policy, constrained-send, reply-retriever, reverse-binding-registry) and the prior `opencode-plugin/src/` are the old sessions_send bridge and must remain excluded.

## 2. Source Locations

| Symbol | File | Line | Notes |
|--------|------|------|-------|
| `AgentHarness` object | `src/harness.ts` | 30–83 | No `nativeToolCapability` field yet |
| `runAttempt` entry | `src/harness.ts` | 58–63 | Delegates to `runOpenCodeHarnessAttempt` |
| `runOpenCodeHarnessAttempt` | `src/app-server/run-attempt.ts` | 285–572 | Receives `AgentHarnessAttemptParams` |
| `AgentHarnessAttemptParams` | `node_modules/openclaw/dist/plugin-sdk/types-Tcpca_5M.d.ts` | 1579 | Contains `spawnedBy?: string \| null` |
| Managed server creation | `src/app-server/shared-client.ts` | 1152–1173 | `ensureManagedOpenCodeServer()` — singleton |
| SDK client creation | `src/app-server/shared-client.ts` | 1130–1140 | `createSdkClient()` — calls `createOpencodeClient({ baseUrl })` |
| Session create | `@opencode-ai/sdk/dist/gen/types.gen.d.ts` | `SessionCreateData` | Body only: `{ parentID?, title? }` — no tool/agent fields |
| Session prompt | `@opencode-ai/sdk/dist/gen/types.gen.d.ts` | `SessionPromptData` | Body includes `tools?: { [key: string]: boolean }` — toggle only, no definition |
| OpenCode tool plugin API | `@opencode-ai/plugin/dist/index.d.ts` | 173–181 | `Hooks.tool`: `{ [key: string]: ToolDefinition }` — **process-global** |
| `ToolDefinition` | `@opencode-ai/plugin/dist/tool.d.ts` | 47–55 | `tool({ description, args, execute })` — `execute` receives `ToolContext` |
| `ToolContext` | `@opencode-ai/plugin/dist/tool.d.ts` | 2–16 | `{ sessionID, abort: AbortSignal, agent, directory, worktree }` |
| `ToolResult` | `@opencode-ai/plugin/dist/tool.d.ts` | 39–46 | `string \| { title?, output, metadata?, attachments? }` |
| Harness `reset` | `src/harness.ts` | 65–75 | Clears binding — must also clear attempt-tool binding |
| Harness `dispose` | `src/harness.ts` | 77–82 | Clears shared client — must also clear attempt-tool binding |

## 3. Decision: Option B — Static OpenCode Plugin Tool With Attempt-Local Dispatch

**Option A (Per-Session Dynamic Registration) is not feasible.**

Evidence from the installed `@opencode-ai/sdk` and `@opencode-ai/plugin` types:

1. **`@opencode-ai/plugin` tools are process-global.** The `Hooks.tool` property is a static `{ [key: string]: ToolDefinition }` map returned from the `server()` function at plugin load time. There is no `registerTool` or `unregisterTool` method on any API object (`PluginInput`, `Hooks`, `ToolContext`, etc.).

2. **`createOpencodeServer()` passes `Config` at startup only.** The `Config` type has `plugin?: Array<string>` — plugin paths loaded once at server boot. No runtime add/remove API exists.

3. **`session.prompt()` body has `tools?: { [key: string]: boolean }` for toggling existing tools only.** This enables/disables built-in or plugin tools by name; it does not accept new tool definitions.

4. **`session.create()` body is `{ parentID?, title? }`** — no tool metadata whatsoever.

Therefore the only viable design is a static plugin tool that uses the OpenCode session ID as a lookup key to find the active harness attempt's native executor.

## 4. Proposed Transport Shape

```
OpenCode tool callback receives ToolContext { sessionID, args, abort }
  ↓
  lookup: activeAttemptMap.get(sessionID)
  ↓
  found? → call activeAttempt.nativeToolExecutor({
             callId,
             toolName: "sessions_send",
             arguments: args,
             signal: abort,
           })
  ↓
  convert result → OpenCode ToolResult (string)
  ↓
  return to OpenCode runtime
```

The conversion mapping:

| Native result (`AgentHarnessNativeToolResult`) | OpenCode `ToolResult` |
|---|---|
| `{ content: [{ type:"text", text }] }`, `isError: false` | `{ title: "sessions_send", output: text }` or raw `text` string |
| `{ content: [{ type:"text", text }] }`, `isError: true` | `{ title: "sessions_send (error)", output: text }` |
| Executor throws / not available | `"Native tool not available"` (transport-level, not a rethrow) |
| Stale callback (no active attempt) | `"Native tool call discarded: no active harness attempt"` |

## 5. Active-Attempt Binding Lifecycle

**Data structure**: A `Map<string, { executor: NativeToolExecutor; cleanup: () => void }>` — keyed by `openCodeSessionId`.

| Event | Action |
|-------|--------|
| `runAttempt` starts, before prompt | Register binding for `openCodeSessionId` → executor, and `params.abortSignal` listener to unregister on abort |
| Normal return | Remove binding |
| Throw during attempt | Remove binding (in `finally` block) |
| `abortSignal` fires | Remove binding |
| Harness `reset` | Remove binding for the session's `openCodeSessionId` |
| Late call (no binding) | Deterministic error string — no throw, no crash |

**Cleanup guarantee**: The existing `runOpenCodeHarnessAttempt` has a `try/finally` block (`run-attempt.ts:569-571`). The binding removal belongs in that `finally` and also as an `abortSignal` listener.

## 6. Result Mapping

| Scenario | Native executor returns | OpenCode result |
|----------|------------------------|-----------------|
| Success | `{ content: [{ type:"text", text:"done" }], details: {...}, isError: false }` | `"done"` (or `{ output: "done" }`) |
| Tool-level error | `{ content: [{ type:"text", text:"permission denied" }], details: {...}, isError: true }` | `{ title: "sessions_send: error", output: "permission denied" }` |
| Executor throws | Error thrown | `"Native tool execution failed: <message>"` |
| Executor unavailable | `nativeToolExecutor` is undefined | `"Native tool capability not available for this attempt"` |
| Stale attempt | Missing from map | `"Native tool call discarded: no active harness attempt"` |

## 7. Parent-Target Context Injection via `params.spawnedBy`

`params.spawnedBy` is already typed on `AgentHarnessAttemptParams` (`spawnedBy?: string | null`).

Injection plan:

1. **At session prompt time** (`run-attempt.ts:367-480`), when building the request payload, include a system instruction if `params.spawnedBy` is set:

```ts
const systemPrefix = params.spawnedBy
  ? `You are an OpenClaw child session. Your parent session key is ${params.spawnedBy}. Use sessions_send with that standard sessionKey target to contact the parent.`
  : undefined;
const requestPayload = {
  parts: [{ type: "text", text: promptText }],
  ...(systemPrefix ? { system: systemPrefix } : {}),
};
```

2. **No schema changes to `sessions_send`.** The parent session key is a runtime value injected into the model's context, not a custom argument field. This matches the spec requirement: "Do not add a custom `parent` argument or modify the native `sessions_send` schema."

3. The `sessions_send` tool definition received from `params.nativeToolDefinitions` already contains the standard schema. The adapter does not alter it.

## 8. OpenClaw Core Change Required

**Yes.** The current installed SDK (`openclaw@2026.6.8`) does **not** include:

- `nativeToolCapability` on the `AgentHarness` type
- `nativeToolDefinitions` on `AgentHarnessAttemptParams`
- `nativeToolExecutor` on `AgentHarnessAttemptParams`
- `AgentHarnessNativeToolResult` or `AgentHarnessNativeToolExecutor` types

The `openclaw_agentharness_improvements.md` document describes a forward-looking API. Implementation must wait until SDK is updated, then:

1. Add `nativeToolCapability: { tools: ["sessions_send"] }` to the harness declaration in `src/harness.ts`
2. Destructure `params.nativeToolDefinitions` and `params.nativeToolExecutor` in `run-attempt.ts`

Until then, the adapter code can be written and type-asserted, but it will not compile/typecheck.

## 9. File-by-File Implementation Plan

### 9.1 New file: `src/native-tool-bridge/plugin-bridge.ts`

Purpose: Global `Map<sessionId, executor>` plus registration/cleanup helpers.

```
- AttemptBridge: { openCodeSessionId, attemptId, executor, definitions }
- registerAttemptBridge(params) → void
- unregisterAttemptBridge(sessionId) → void
- getAttemptBridge(sessionId) → AttemptBridge | undefined
```

### 9.2 New file: `src/native-tool-bridge/opencode-tool-plugin.ts`

Purpose: The single OpenCode plugin file that registers the `sessions_send` tool definition process-wide. Imports `plugin-bridge.ts` for lookup.

```
- server() → Hooks with tool.sessions_send
  execute(args, context) {
    bridge = getAttemptBridge(context.sessionID)
    if (!bridge) return "Native tool call discarded: no active harness attempt"
    result = await bridge.executor({ callId: callID, toolName: "sessions_send", arguments: args, signal: context.abort })
    return convertNativeToolResult(result)
  }
```

The plugin's `tool` definition uses `tool.schema.object({...})` reflecting the standard `sessions_send` schema from `nativeToolDefinitions`.

### 9.3 Modify: `src/harness.ts`

```
- import { nativeToolCapability } — add to AgentHarness object:
    nativeToolCapability: { tools: ["sessions_send"] }
```

### 9.4 Modify: `src/app-server/run-attempt.ts`

In `runOpenCodeHarnessAttempt`:

```
- Destructure params.nativeToolDefinitions and params.nativeToolExecutor
- After session is created/resumed, register attempt bridge:
    registerAttemptBridge({
      openCodeSessionId,
      executor: params.nativeToolExecutor,
    })
- In the finally block: unregisterAttemptBridge(openCodeSessionId)
- On abortSignal: unregisterAttemptBridge(openCodeSessionId)
- Inject spawnedBy → system instruction in request payload
```

### 9.5 Modify: `src/app-server/shared-client.ts`

In `ensureManagedOpenCodeServer`, when `mode === "managed"`:

```
- Pass a Config object to createOpencodeServer that includes the plugin:
    plugin: [path_to_native_tool_plugin_ts]
```

This requires the managed server to load the `opencode-tool-plugin.ts` at startup. Since the managed server is created via `sdk.createOpencodeServer({ config: { plugin: [...] } })`, we need to resolve the plugin file path.

### 9.6 Modify: `src/harness.ts` — `reset()` handler

```
- Look up openCodeSessionId from the binding file
- unregisterAttemptBridge(openCodeSessionId)
```

### 9.7 Optional: New file under `opencode-plugin/`

If remote-mode support is required and the server is not managed by this harness, the plugin could be a separate deployable module in `opencode-plugin/src/`. But for the first iteration with managed mode, embedding the plugin definition and injecting it via `Config.plugin` is simpler.

## 10. Tests

### 10.1 Unit test: `tests/native-tool-bridge/attempt-bridge.test.ts`

- Register bridge, verify lookup returns it
- Unregister, verify lookup returns undefined
- Double register replaces previous (new attempt)
- Register → unregister → late call returns deterministic message

### 10.2 Unit test: `tests/native-tool-bridge/result-conversion.test.ts` (or inline)

- Success result → string output
- Error result → contains error info, no throw
- Executor throw → caught, string error
- Null/undefined executor → capability-unavailable message

### 10.3 Unit test: `tests/native-tool-bridge/spawnedBy-injection.test.ts`

- `runOpenCodeHarnessAttempt` with `params.spawnedBy` set
- Verify system instruction includes parent session key
- Verify system instruction absent when `spawnedBy` is undefined

### 10.4 Smoke update: `scripts/smoke-run-attempt.ts`

After the OpenClaw SDK update that includes `nativeToolExecutor`/`nativeToolDefinitions`, extend the smoke to:

- Pass fake `nativeToolDefinitions` and `nativeToolExecutor`
- Verify tool call from SDK → executor → result conversion
- Verify spawnedBy injection in prompt payload

## 11. Implementation Order

| Step | Depends on |
|------|------------|
| 1. Create `src/native-tool-bridge/plugin-bridge.ts` | Nothing |
| 2. Write unit tests for bridge lifecycle | Step 1 |
| 3. Create `src/native-tool-bridge/opencode-tool-plugin.ts` | Step 1 |
| 4. Add `nativeToolCapability` to harness declaration in `src/harness.ts` | Requires OpenClaw SDK update |
| 5. Wire `nativeToolDefinitions`/`nativeToolExecutor` into `src/app-server/run-attempt.ts` | Requires OpenClaw SDK update |
| 6. Inject `spawnedBy` into prompt system instruction | SDK-independent, can start now |
| 7. Wire managed server plugin loading in `src/app-server/shared-client.ts` | Step 3 |
| 8. Add `reset` cleanup for bridge | Step 1 |
| 9. Extend smoke test | Steps 4–8 |
| 10. Typecheck + full test suite | All above |

Steps 4, 5, and 10 are blocked on the OpenClaw SDK update. Steps 1–3 and 6 can start immediately.
