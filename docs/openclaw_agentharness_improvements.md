# Native Tool Capability API for AgentHarness Extensions

## Purpose

This document defines the public OpenClaw API for an `AgentHarness` extension that needs to expose selected native OpenClaw tools to an external runtime.

It is intended for harness implementers.

This API is generic. OpenClaw core does not know or care which external runtime consumes it.

---

## What This Enables

An opted-in harness can expose a selected subset of the native OpenClaw tools that are valid for the current agent attempt.

The framework constructs the allowed native-tool set as:

```text
effective OpenClaw tool policy
∩ harness-declared native tool subset
```

For that exact intersection, the harness receives:

```text
- serializable tool definitions;
- an attempt-bound executor;
- normal native tool behavior under the current attempt identity.
```

The executor runs preconstructed native tool instances. It does not impersonate a session, reconstruct a session graph, or make raw Gateway RPC calls.

---

## Harness Declaration

Declare the capability on the harness definition:

```ts
nativeToolCapability?: {
  /**
   * Native OpenClaw tool names this harness may expose to its external runtime.
   *
   * Omitted means this harness receives no native tools.
   */
  tools?: string[];
};
```

Example:

```ts
export const myHarness: AgentHarness = {
  id: "example-harness",
  label: "Example Harness",

  nativeToolCapability: {
    tools: ["sessions_send"],
  },

  supports(ctx) {
    return { supported: true };
  },

  async runAttempt(params) {
    // Consume params.nativeToolDefinitions and params.nativeToolExecutor.
  },
};
```

This declaration is an extension-level ceiling. It does not replace ordinary OpenClaw tool policy.

A tool is available only when it is allowed by both:

```text
1. Existing OpenClaw policy for the current attempt.
2. harness.nativeToolCapability.tools.
```

---

## Attempt Parameters

An opted-in harness may receive these optional fields on its attempt parameters:

```ts
type AgentHarnessToolDefinition = {
  name: string;
  description: string;
  parameters: unknown;
};

type AgentHarnessNativeToolResult = {
  content: Array<{
    type: string;
    text?: string;
    data?: unknown;
  }>;
  details: unknown;
  isError: boolean;
  terminate?: boolean;
};

type AgentHarnessNativeToolExecutor = (request: {
  callId: string;
  toolName: string;
  arguments: unknown;
  signal?: AbortSignal;
}) => Promise<AgentHarnessNativeToolResult>;
```

```ts
params.nativeToolDefinitions?: AgentHarnessToolDefinition[];
params.nativeToolExecutor?: AgentHarnessNativeToolExecutor;
```

Do not rely on a particular empty-vs-undefined representation when the capability is absent. Treat missing definitions or a missing executor as native-tool capability unavailable.

---

## Definition and Executor Invariant

The definitions supplied to the harness and the names accepted by the executor are the same set.

```text
nativeToolDefinitions names
=
nativeToolExecutor accepted names
=
policy ∩ nativeToolCapability.tools
```

A harness must not assume it can call a tool that was not supplied in `nativeToolDefinitions`.

The executor rejects unavailable names with a deterministic tool-level error result.

---

## Normal Harness Consumption Pattern

At attempt start:

```ts
async runAttempt(params) {
  const definitions = params.nativeToolDefinitions ?? [];
  const executeNativeTool = params.nativeToolExecutor;

  if (!executeNativeTool) {
    // Continue without native tools, or fail deterministically if this
    // harness requires them for the configured mode.
  }

  // Convert `definitions` into the external runtime's tool-definition format.
  // Do not hand-write duplicate schemas for native tools.
}
```

When the external runtime emits a tool call:

```ts
const result = await executeNativeTool({
  callId: externalToolCall.id,
  toolName: externalToolCall.name,
  arguments: externalToolCall.arguments,
  signal: attemptSignal,
});
```

Then convert `result` into the external runtime's normal tool-result format.

Preserve:

```text
- content;
- details;
- isError;
- terminate.
```

Do not turn a native business-level failure into a transport exception.

For example, a native result with a forbidden or timeout status should normally remain a tool result with:

```ts
isError: true;
```

so the external model can inspect the content and details.

The result is the OpenClaw-sanitized native tool result. Harnesses must relay
the supplied `content`, `details`, `isError`, and `terminate` without assuming
that raw tool output, media payloads, or sensitive fields are preserved.

---

## Executor Semantics

The OpenClaw executor performs the native execution path for the selected tool instance.

It:

```text
1. Checks whether the current attempt is still active.
2. Rejects unavailable tool names.
3. Applies tool.prepareArguments(...) when present.
4. Invokes the native tool instance.
5. Sanitizes the native result.
6. Classifies errors using OpenClaw's normal native error semantics.
7. Delivers the normal onAgentToolResult observer callback.
8. Returns a transport-neutral result object.
```

The executor applies tool-specific argument preparation but does not provide
the embedded agent loop's TypeBox validation/coercion layer.

External runtimes should submit arguments conforming to the supplied
`parameters` schema. Malformed arguments may produce a normalized native
tool error or tool-specific defensive handling.

The harness must not duplicate:

```text
- native argument alias normalization;
- native error-status classification;
- session authorization;
- session visibility checks;
- Gateway dispatch behavior;
- tool-specific business logic.
```

Those behaviors remain inside the bound OpenClaw tool instance.

---

## Attempt Lifetime

The executor is valid only during the active harness attempt.

After normal completion, failure, or abort, calls through a retained executor reference fail deterministically with a tool-level inactive-attempt result.

Harness implementations must therefore:

```text
- associate external-runtime tool calls only with the active attempt;
- remove any external-session-to-attempt transport association when runAttempt exits;
- reject late tool calls rather than routing them to a later attempt.
```

The external-session association is transport-only.

It is not session authority.

The native executor's bound tool closure remains the authority for the actual OpenClaw requester identity and native session behavior.

---

## First Consumer: `sessions_send`

A harness that needs child-to-parent communication may declare:

```ts
nativeToolCapability: {
  tools: ["sessions_send"],
}
```

Do not implement `sessions_send` yourself.

Do not call Gateway RPC directly.

Do not add a broker route or a static source session identity.

Expose the supplied `sessions_send` definition to the external runtime and forward its tool call to `params.nativeToolExecutor`.

The native `sessions_send` instance runs under the current attempt's true session context.

For a child harness that needs its parent target, use normal attempt metadata such as:

```ts
params.spawnedBy
```

Provide that parent session key to the external runtime as execution context or a system instruction. The external runtime should call the standard native tool schema using that normal target value.

Do not add a custom `parent` argument or alter the native tool schema.

---

## Non-Goals

Version 1 does not provide:

```text
- MCP;
- ACPX integration;
- raw Gateway RPC forwarding;
- custom broker routes;
- static source identities;
- session-ID authority mappings;
- custom session graph logic;
- replay integration;
- subscription UI tool start/end events;
- OpenClaw transcript ownership for external-runtime tool calls;
- approval-flow adaptation;
- progress streaming beyond the current executor interface.
```

These are not required to consume the native-tool capability.

---

## Adapter Test Checklist

A harness integration should test:

```text
1. The harness declares only the intended native-tool subset.
2. The supplied definitions are converted without a hand-written duplicate schema.
3. An external tool call reaches nativeToolExecutor with original call ID,
   name, arguments, and active abort signal.
4. Successful native results preserve content, details, isError, and terminate.
5. Structured native failures remain tool results with isError true.
6. Unknown external tool names do not reach nativeToolExecutor.
7. Missing nativeToolExecutor produces deterministic failure.
8. Late external tool calls fail after runAttempt completion or failure.
9. Parent targeting uses normal attempt metadata, not a replacement identity.
```

---

## Integration Boundary

OpenClaw core owns:

```text
- native tool construction;
- ordinary tool-policy filtering;
- capability intersection;
- session-bound native tool identity;
- argument preparation;
- native execution;
- result sanitation;
- native error classification;
- observer callback delivery;
- attempt invalidation.
```

The external harness owns:

```text
- external-runtime tool registration;
- external-runtime tool-call transport;
- conversion between external tool messages and the generic API;
- active external-session-to-attempt association;
- cleanup of that transport association;
- external-runtime-specific display and continuation behavior.
```
