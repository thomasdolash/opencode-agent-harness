import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  startNativeToolCallbackServer,
  stopNativeToolCallbackServer,
  registerNativeToolAttempt,
  unregisterNativeToolAttempt,
  getActiveBindingCount,
  type NativeToolAttemptBinding,
  type AgentHarnessNativeToolExecutor,
} from "../../src/native-tool-bridge/callback-server.js";
import {
  CATALOG_ENTRIES,
  buildCatalogEntryMap,
  invokeNativeToolViaCallback,
  type NativeToolCatalogEntry,
} from "../../src/native-tool-bridge/tool-catalog.js";

const CALLBACK_URL_KEY = "OPENCODE_NATIVE_TOOL_CALLBACK_URL";

function makeBinding(overrides?: Partial<NativeToolAttemptBinding>): NativeToolAttemptBinding {
  const hasExecutor = "nativeToolExecutor" in (overrides ?? {});
  return {
    openCodeSessionId: "test-session-1",
    ...overrides,
    nativeToolDefinitions: overrides?.nativeToolDefinitions ?? [
      { name: "sessions_send", description: "Test tool", parameters: {} },
    ],
    nativeToolExecutor: hasExecutor ? (overrides?.nativeToolExecutor as AgentHarnessNativeToolExecutor | undefined) : (async () => ({
      content: [{ type: "text", text: "ok" }],
      details: {},
      isError: false,
    })),
  };
}

describe("callback server registry", () => {
  afterEach(() => {
    stopNativeToolCallbackServer();
  });

  it("register and lookup works", async () => {
    const url = await startNativeToolCallbackServer("127.0.0.1", 0);
    assert(url.startsWith("http://127.0.0.1:"));
    const binding = makeBinding();
    registerNativeToolAttempt("test-session-1", binding);
    assert.equal(getActiveBindingCount(), 1);
  });

  it("duplicate registration throws", async () => {
    await startNativeToolCallbackServer("127.0.0.1", 0);
    registerNativeToolAttempt("test-session-1", makeBinding());
    assert.throws(() => {
      registerNativeToolAttempt("test-session-1", makeBinding());
    }, /already registered/);
  });

  it("identity-conditional unregister does not remove replacement", async () => {
    await startNativeToolCallbackServer("127.0.0.1", 0);
    const binding1 = makeBinding({ openCodeSessionId: "test-session-1" });
    registerNativeToolAttempt("test-session-1", binding1);
    const binding2 = makeBinding({ openCodeSessionId: "test-session-1" });
    registerNativeToolAttempt("test-session-2", binding2);
    unregisterNativeToolAttempt("test-session-1", binding2);
    assert.equal(getActiveBindingCount(), 2);
  });

  it("unregister deletes only matching binding", async () => {
    await startNativeToolCallbackServer("127.0.0.1", 0);
    const binding = makeBinding();
    registerNativeToolAttempt("test-session-1", binding);
    unregisterNativeToolAttempt("test-session-1", binding);
    assert.equal(getActiveBindingCount(), 0);
  });

  it("lookup after unregister fails", async () => {
    await startNativeToolCallbackServer("127.0.0.1", 0);
    const binding = makeBinding();
    registerNativeToolAttempt("test-session-1", binding);
    unregisterNativeToolAttempt("test-session-1", binding);
    assert.equal(getActiveBindingCount(), 0);
  });
});

describe("callback server HTTP endpoint", () => {
  afterEach(() => {
    stopNativeToolCallbackServer();
  });

  it("valid request invokes executor with expected fields", async () => {
    const url = await startNativeToolCallbackServer("127.0.0.1", 0);
    const executor: AgentHarnessNativeToolExecutor = async (request) => {
      assert.equal(request.callId, "call-1");
      assert.equal(request.toolName, "sessions_send");
      assert.deepEqual(request.arguments, { sessionKey: "parent-key", message: "hello" });
      return { content: [{ type: "text", text: "done" }], details: {}, isError: false };
    };
    registerNativeToolAttempt("test-session-1", makeBinding({ nativeToolExecutor: executor }));

    const resp = await fetch(`${url}/native-tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "test-session-1",
        callId: "call-1",
        toolName: "sessions_send",
        arguments: { sessionKey: "parent-key", message: "hello" },
      }),
    });

    assert.equal(resp.status, 200);
    const body = await resp.json() as { ok: boolean; result: { content: Array<{ type: string; text: string }> } };
    assert(body.ok);
    assert.equal(body.result.content[0].text, "done");
  });

  it("executor result returns intact with isError", async () => {
    const url = await startNativeToolCallbackServer("127.0.0.1", 0);
    const executor: AgentHarnessNativeToolExecutor = async () => ({
      content: [{ type: "text", text: "error occurred" }],
      details: { status: "error" },
      isError: true,
    });
    registerNativeToolAttempt("test-session-1", makeBinding({ nativeToolExecutor: executor }));

    const resp = await fetch(`${url}/native-tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "test-session-1",
        callId: "call-1",
        toolName: "sessions_send",
        arguments: {},
      }),
    });

    const body = await resp.json() as { ok: boolean; result: { isError: boolean } };
    assert(body.ok);
    assert(body.result.isError);
  });

  it("no active attempt returns 404", async () => {
    const url = await startNativeToolCallbackServer("127.0.0.1", 0);
    const resp = await fetch(`${url}/native-tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "nonexistent",
        callId: "call-1",
        toolName: "sessions_send",
        arguments: {},
      }),
    });
    assert.equal(resp.status, 404);
    const body = await resp.json() as { ok: boolean; error: string };
    assert(!body.ok);
    assert(body.error.includes("No active harness attempt"));
  });

  it("tool not in definitions returns 404", async () => {
    const url = await startNativeToolCallbackServer("127.0.0.1", 0);
    registerNativeToolAttempt("test-session-1", makeBinding({
      nativeToolDefinitions: [{ name: "other_tool", description: "Other", parameters: {} }],
    }));

    const resp = await fetch(`${url}/native-tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "test-session-1",
        callId: "call-1",
        toolName: "sessions_send",
        arguments: {},
      }),
    });
    assert.equal(resp.status, 404);
    const body = await resp.json() as { ok: boolean; error: string };
    assert(body.error.includes("Native tool not available"));
  });

  it("missing executor returns 503", async () => {
    const url = await startNativeToolCallbackServer("127.0.0.1", 0);
    registerNativeToolAttempt("test-session-1", makeBinding({ nativeToolExecutor: undefined }));

    const resp = await fetch(`${url}/native-tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "test-session-1",
        callId: "call-1",
        toolName: "sessions_send",
        arguments: {},
      }),
    });
    assert.equal(resp.status, 503);
  });

  it("malformed JSON rejected", async () => {
    const url = await startNativeToolCallbackServer("127.0.0.1", 0);
    const resp = await fetch(`${url}/native-tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    assert.equal(resp.status, 400);
  });

  it("unsupported method rejected", async () => {
    const url = await startNativeToolCallbackServer("127.0.0.1", 0);
    const resp = await fetch(`${url}/native-tool`, { method: "GET" });
    assert.equal(resp.status, 405);
  });

  it("unsupported path rejected", async () => {
    const url = await startNativeToolCallbackServer("127.0.0.1", 0);
    const resp = await fetch(`${url}/other-path`, { method: "POST" });
    assert.equal(resp.status, 404);
  });

  it("executor throw returns transport error", async () => {
    const url = await startNativeToolCallbackServer("127.0.0.1", 0);
    const executor: AgentHarnessNativeToolExecutor = async () => {
      throw new Error("simulated failure");
    };
    registerNativeToolAttempt("test-session-1", makeBinding({ nativeToolExecutor: executor }));

    const resp = await fetch(`${url}/native-tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "test-session-1",
        callId: "call-1",
        toolName: "sessions_send",
        arguments: {},
      }),
    });
    assert.equal(resp.status, 500);
    const body = await resp.json() as { ok: boolean; error: string };
    assert(body.error.includes("simulated failure"));
  });
});

describe("callback server lifecycle", () => {
  afterEach(() => {
    stopNativeToolCallbackServer();
    delete process.env[CALLBACK_URL_KEY];
  });

  it("returns actual selected URL with ephemeral port", async () => {
    const url = await startNativeToolCallbackServer("127.0.0.1", 0);
    assert(url.startsWith("http://127.0.0.1:"));
    const portMatch = url.match(/:(\d+)$/);
    assert(portMatch);
    assert(Number(portMatch[1]) > 0);

    const resp = await fetch(`${url}/native-tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s", callId: "c", toolName: "sessions_send" }),
    });
    assert.equal(resp.status, 404);
  });

  it("stop removes listener", async () => {
    const url = await startNativeToolCallbackServer("127.0.0.1", 0);
    stopNativeToolCallbackServer();
    await assert.rejects(async () => {
      await fetch(`${url}/native-tool`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    });
  });

  it("restart clears stale bindings", async () => {
    const url1 = await startNativeToolCallbackServer("127.0.0.1", 0);
    registerNativeToolAttempt("s1", makeBinding());
    assert.equal(getActiveBindingCount(), 1);
    stopNativeToolCallbackServer();

    const url2 = await startNativeToolCallbackServer("127.0.0.1", 0);
    assert.equal(getActiveBindingCount(), 0);
    assert(url2 !== url1);
  });
});

describe("callback URL propagation without provider call", () => {
  afterEach(() => {
    stopNativeToolCallbackServer();
    delete process.env[CALLBACK_URL_KEY];
  });

  it("env var matches actual server URL", async () => {
    const url = await startNativeToolCallbackServer("127.0.0.1", 0);
    process.env[CALLBACK_URL_KEY] = url;
    assert.equal(process.env[CALLBACK_URL_KEY], url);
  });

  it("can issue loopback request to live callback server via env var URL", async () => {
    const url = await startNativeToolCallbackServer("127.0.0.1", 0);
    process.env[CALLBACK_URL_KEY] = url;
    registerNativeToolAttempt("test-session-p", makeBinding());

    const callbackUrl = process.env[CALLBACK_URL_KEY];
    const resp = await fetch(`${callbackUrl}/native-tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "test-session-p",
        callId: "probe-call-id",
        toolName: "sessions_send",
        arguments: { sessionKey: "parent", message: "probe" },
      }),
    });
    assert.equal(resp.status, 200);
    const body = await resp.json() as { ok: boolean; result: { content: Array<{ type: string; text: string }> } };
    assert(body.ok);
    assert.equal(body.result.content[0].text, "ok");
  });
});

describe("env var lifecycle", () => {
  afterEach(() => {
    stopNativeToolCallbackServer();
    delete process.env[CALLBACK_URL_KEY];
  });

  it("prior absent -> cleanup removes it", async () => {
    delete process.env[CALLBACK_URL_KEY];
    assert.equal(process.env[CALLBACK_URL_KEY], undefined);

    const url = await startNativeToolCallbackServer("127.0.0.1", 0);
    process.env[CALLBACK_URL_KEY] = url;
    assert(process.env[CALLBACK_URL_KEY] !== undefined);

    stopNativeToolCallbackServer();
    delete process.env[CALLBACK_URL_KEY];
    assert.equal(process.env[CALLBACK_URL_KEY], undefined);
  });
});

describe("error mapping", () => {
  afterEach(() => {
    stopNativeToolCallbackServer();
  });

  it("callback server returns deterministic error for missing fields", async () => {
    const url = await startNativeToolCallbackServer("127.0.0.1", 0);
    const resp = await fetch(`${url}/native-tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = await resp.json() as { ok: boolean; error: string };
    assert(!body.ok);
    assert(!body.error.includes("http://"));
  });

  it("callback server unavailable produces fetch error", async () => {
    const resp = await fetch("http://127.0.0.1:1/native-tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s", callId: "c", toolName: "n" }),
    }).catch((e) => e);
    assert(resp instanceof Error);
  });

  it("native result with multiple text items", async () => {
    const url = await startNativeToolCallbackServer("127.0.0.1", 0);
    const executor: AgentHarnessNativeToolExecutor = async () => ({
      content: [
        { type: "text", text: "first line" },
        { type: "text", text: "second line" },
      ],
      details: {},
      isError: false,
    });
    registerNativeToolAttempt("test-session-1", makeBinding({ nativeToolExecutor: executor }));

    const resp = await fetch(`${url}/native-tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "test-session-1",
        callId: "call-1",
        toolName: "sessions_send",
        arguments: {},
      }),
    });
    const body = await resp.json() as { ok: boolean; result: { content: Array<{ type: string; text?: string }> } };
    assert(body.ok);
    assert.equal(body.result.content.length, 2);
  });

  it("native result with no text items", async () => {
    const url = await startNativeToolCallbackServer("127.0.0.1", 0);
    const executor: AgentHarnessNativeToolExecutor = async () => ({
      content: [],
      details: {},
      isError: false,
    });
    registerNativeToolAttempt("test-session-1", makeBinding({ nativeToolExecutor: executor }));

    const resp = await fetch(`${url}/native-tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "test-session-1",
        callId: "call-1",
        toolName: "sessions_send",
        arguments: {},
      }),
    });
    const body = await resp.json() as { ok: boolean; result: { content: Array<{ type: string; text?: string }> } };
    assert(body.ok);
    assert.equal(body.result.content.length, 0);
  });
});

describe("tool catalog", () => {
  it("sessions_send remains registered and behaves identically", () => {
    const entry = CATALOG_ENTRIES.find((e) => e.name === "sessions_send");
    assert(entry);
    assert.equal(entry.name, "sessions_send");
    assert(typeof entry.description === "string" && entry.description.length > 0);
    assert(entry.args.sessionKey);
    assert(entry.args.message);
    assert(entry.args.timeoutSeconds?.optional === true);
  });

  it("catalog registration produces only enabled static tools", () => {
    const toolMap = buildCatalogEntryMap(CATALOG_ENTRIES);
    const names = Object.keys(toolMap).sort();
    assert.deepEqual(names, ["sessions_history", "sessions_list", "sessions_send"]);
  });

  it("every catalog entry has a corresponding tool in the map", () => {
    const toolMap = buildCatalogEntryMap(CATALOG_ENTRIES);
    for (const entry of CATALOG_ENTRIES) {
      assert(toolMap[entry.name], `Missing tool for catalog entry: ${entry.name}`);
      assert.equal(toolMap[entry.name].description, entry.description);
    }
  });

  it("unknown catalog tools cannot be registered", () => {
    const fakeEntry: NativeToolCatalogEntry = {
      name: "sessions_spawn",
      description: "spawn",
      args: { task: { type: "string", description: "task" } },
    };
    const toolMap = buildCatalogEntryMap([fakeEntry]);
    assert(toolMap.sessions_spawn);
    // verify no mappings for non-catalog tools
    assert(!("gateway" in toolMap));
    assert(!("agents_list" in toolMap));
    assert(!("cron" in toolMap));
    assert(!("session_status" in toolMap));
  });

  it("invokeNativeToolViaCallback sends sessionId, fresh callId, toolName, arguments", async () => {
    const url = await startNativeToolCallbackServer("127.0.0.1", 0);
    process.env[CALLBACK_URL_KEY] = url;

    const received: Array<Record<string, unknown>> = [];
    const executor: AgentHarnessNativeToolExecutor = async (request) => {
      received.push({ callId: request.callId, toolName: request.toolName, args: request.arguments });
      return { content: [{ type: "text", text: "ok" }], details: {}, isError: false };
    };
    registerNativeToolAttempt("test-session-catalog", makeBinding({
      openCodeSessionId: "test-session-catalog",
      nativeToolExecutor: executor,
      nativeToolDefinitions: [{ name: "sessions_list", description: "", parameters: {} }],
    }));

    const result = await invokeNativeToolViaCallback({
      toolName: "sessions_list",
      nativeArgs: { kinds: ["main"] },
      context: { sessionID: "test-session-catalog" },
      renderTitle: "sessions_list",
    });

    const parsed = JSON.parse(result) as { title: string; output: string };
    assert.equal(parsed.title, "sessions_list");
    assert.equal(parsed.output, "ok");
    assert.equal(received.length, 1);
    assert.equal(received[0].toolName, "sessions_list");
    assert(typeof received[0].callId === "string" && (received[0].callId as string).length > 0);
    assert.deepEqual(received[0].args, { kinds: ["main"] });
  });

  it("catalog tool unavailable from current nativeToolDefinitions returns deterministic error", async () => {
    const url = await startNativeToolCallbackServer("127.0.0.1", 0);
    process.env[CALLBACK_URL_KEY] = url;

    registerNativeToolAttempt("test-other", makeBinding({
      openCodeSessionId: "test-other",
      nativeToolDefinitions: [{ name: "other_tool", description: "Other", parameters: {} }],
    }));

    const result = await invokeNativeToolViaCallback({
      toolName: "sessions_list",
      nativeArgs: {},
      context: { sessionID: "test-other" },
      renderTitle: "sessions_list",
    });

    const parsed = JSON.parse(result) as { title: string; output: string };
    assert(parsed.title.includes("error"));
    assert(parsed.output.includes("Native tool not available") || parsed.output.includes("failed"));
  });

  it("multiple text result chunks are joined in order", async () => {
    const url = await startNativeToolCallbackServer("127.0.0.1", 0);
    process.env[CALLBACK_URL_KEY] = url;

    const executor: AgentHarnessNativeToolExecutor = async () => ({
      content: [
        { type: "text", text: "alpha" },
        { type: "text", text: "beta" },
        { type: "text", text: "gamma" },
      ],
      details: {},
      isError: false,
    });
    registerNativeToolAttempt("test-join", makeBinding({
      openCodeSessionId: "test-join",
      nativeToolExecutor: executor,
      nativeToolDefinitions: [{ name: "sessions_list", description: "", parameters: {} }],
    }));

    const result = await invokeNativeToolViaCallback({
      toolName: "sessions_list",
      nativeArgs: {},
      context: { sessionID: "test-join" },
      renderTitle: "sessions_list",
    });

    const parsed = JSON.parse(result) as { title: string; output: string };
    assert.equal(parsed.title, "sessions_list");
    assert.equal(parsed.output, "alpha\nbeta\ngamma");
  });

  it("error native results use the error title path", async () => {
    const url = await startNativeToolCallbackServer("127.0.0.1", 0);
    process.env[CALLBACK_URL_KEY] = url;

    const executor: AgentHarnessNativeToolExecutor = async () => ({
      content: [{ type: "text", text: "permission denied" }],
      details: { status: "error" },
      isError: true,
    });
    registerNativeToolAttempt("test-err", makeBinding({
      openCodeSessionId: "test-err",
      nativeToolExecutor: executor,
      nativeToolDefinitions: [{ name: "sessions_list", description: "", parameters: {} }],
    }));

    const result = await invokeNativeToolViaCallback({
      toolName: "sessions_list",
      nativeArgs: {},
      context: { sessionID: "test-err" },
      renderTitle: "sessions_list",
    });

    const parsed = JSON.parse(result) as { title: string; output: string };
    assert(parsed.title.includes("error"));
    assert.equal(parsed.output, "permission denied");
  });

  it("callback transport unchanged for sessions_send", async () => {
    const url = await startNativeToolCallbackServer("127.0.0.1", 0);
    process.env[CALLBACK_URL_KEY] = url;

    const executor: AgentHarnessNativeToolExecutor = async (request) => {
      assert.equal(request.toolName, "sessions_send");
      assert.deepEqual(request.arguments, { sessionKey: "parent", message: "hello", timeoutSeconds: 30 });
      return { content: [{ type: "text", text: "delivered" }], details: {}, isError: false };
    };
    registerNativeToolAttempt("test-send", makeBinding({
      openCodeSessionId: "test-send",
      nativeToolExecutor: executor,
      nativeToolDefinitions: [{ name: "sessions_send", description: "", parameters: {} }],
    }));

    const result = await invokeNativeToolViaCallback({
      toolName: "sessions_send",
      nativeArgs: { sessionKey: "parent", message: "hello", timeoutSeconds: 30 },
      context: { sessionID: "test-send" },
      renderTitle: "sessions_send",
    });

    const parsed = JSON.parse(result) as { title: string; output: string };
    assert.equal(parsed.title, "sessions_send");
    assert.equal(parsed.output, "delivered");
  });
});

describe("sessions_list catalog entry", () => {
  afterEach(() => {
    stopNativeToolCallbackServer();
    delete process.env[CALLBACK_URL_KEY];
  });

  it("has correct schema fields", () => {
    const entry = CATALOG_ENTRIES.find((e) => e.name === "sessions_list")!;
    assert(entry);
    assert(typeof entry.description === "string" && entry.description.length > 0);
    assert(entry.args.kinds);
    assert(entry.args.limit);
    assert(entry.args.activeMinutes);
    assert(entry.args.label);
    assert(entry.args.agentId);
    assert(entry.args.search);
    assert(entry.args.includeDerivedTitles);
    assert(entry.args.includeLastMessage);
  });

  it("callback argument serialization preserves expected fields", async () => {
    const url = await startNativeToolCallbackServer("127.0.0.1", 0);
    process.env[CALLBACK_URL_KEY] = url;

    const received: Array<Record<string, unknown>> = [];
    const executor: AgentHarnessNativeToolExecutor = async (request) => {
      received.push(request.arguments as Record<string, unknown>);
      return { content: [{ type: "text", text: "[]" }], details: {}, isError: false };
    };
    registerNativeToolAttempt("test-ls", makeBinding({
      openCodeSessionId: "test-ls",
      nativeToolExecutor: executor,
      nativeToolDefinitions: [{ name: "sessions_list", description: "", parameters: {} }],
    }));

    await invokeNativeToolViaCallback({
      toolName: "sessions_list",
      nativeArgs: { kinds: ["main", "subagent"], limit: 10, agentId: "opencode" },
      context: { sessionID: "test-ls" },
      renderTitle: "sessions_list",
    });

    assert.equal(received.length, 1);
    assert.deepEqual(received[0], { kinds: ["main", "subagent"], limit: 10, agentId: "opencode" });
  });

  it("native result rendering works for structured sessions_list output", async () => {
    const entry = CATALOG_ENTRIES.find((e) => e.name === "sessions_list")!;
    const rendered = entry.renderResult!({
      content: [{ type: "text", text: JSON.stringify([
        { key: "agent:main:abc", agentId: "default", kind: "main", label: "My Session" },
        { key: "agent:opencode:subagent:123", agentId: "opencode", kind: "subagent", spawnedBy: "agent:main:abc", lastMessagePreview: "Hello world" },
      ]) }],
      details: {},
      isError: false,
    });
    assert.equal(rendered.title, "sessions_list");
    assert(rendered.output.includes("agent:main:abc"));
    assert(rendered.output.includes("agent=default"));
    assert(rendered.output.includes("agent:opencode:subagent:123"));
    assert(rendered.output.includes("agent=opencode"));
    assert(!rendered.output.includes("Native tool completed"));
  });

  it("unavailable-per-attempt returns callback error", async () => {
    const url = await startNativeToolCallbackServer("127.0.0.1", 0);
    process.env[CALLBACK_URL_KEY] = url;

    registerNativeToolAttempt("test-ls-unavail", makeBinding({
      openCodeSessionId: "test-ls-unavail",
      nativeToolDefinitions: [],
    }));

    const result = await invokeNativeToolViaCallback({
      toolName: "sessions_list",
      nativeArgs: {},
      context: { sessionID: "test-ls-unavail" },
      renderTitle: "sessions_list",
    });

    const parsed = JSON.parse(result) as { title: string; output: string };
    assert(parsed.title.includes("error"));
  });
});

describe("sessions_history catalog entry", () => {
  afterEach(() => {
    stopNativeToolCallbackServer();
    delete process.env[CALLBACK_URL_KEY];
  });

  it("has correct schema fields", () => {
    const entry = CATALOG_ENTRIES.find((e) => e.name === "sessions_history")!;
    assert(entry);
    assert(typeof entry.description === "string" && entry.description.length > 0);
    assert(entry.args.sessionKey);
    assert(entry.args.limit);
    assert(entry.args.includeTools);
    // sessionKey is not optional
    assert(!entry.args.sessionKey.optional);
  });

  it("callback argument serialization preserves expected fields", async () => {
    const url = await startNativeToolCallbackServer("127.0.0.1", 0);
    process.env[CALLBACK_URL_KEY] = url;

    const received: Array<Record<string, unknown>> = [];
    const executor: AgentHarnessNativeToolExecutor = async (request) => {
      received.push(request.arguments as Record<string, unknown>);
      return { content: [{ type: "text", text: "[]" }], details: {}, isError: false };
    };
    registerNativeToolAttempt("test-hx", makeBinding({
      openCodeSessionId: "test-hx",
      nativeToolExecutor: executor,
      nativeToolDefinitions: [{ name: "sessions_history", description: "", parameters: {} }],
    }));

    await invokeNativeToolViaCallback({
      toolName: "sessions_history",
      nativeArgs: { sessionKey: "agent:main:test", limit: 5, includeTools: true },
      context: { sessionID: "test-hx" },
      renderTitle: "sessions_history",
    });

    assert.equal(received.length, 1);
    assert.deepEqual(received[0], { sessionKey: "agent:main:test", limit: 5, includeTools: true });
  });

  it("native result rendering works for structured sessions_history output", async () => {
    const entry = CATALOG_ENTRIES.find((e) => e.name === "sessions_history")!;
    const rendered = entry.renderResult!({
      content: [{ type: "text", text: JSON.stringify({
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi there" },
        ],
      }) }],
      details: {},
      isError: false,
    });
    assert.equal(rendered.title, "sessions_history");
    assert(rendered.output.includes("user: Hello"));
    assert(rendered.output.includes("assistant: Hi there"));
    assert(!rendered.output.includes("Native tool completed"));
  });

  it("unavailable-per-attempt returns callback error", async () => {
    const url = await startNativeToolCallbackServer("127.0.0.1", 0);
    process.env[CALLBACK_URL_KEY] = url;

    registerNativeToolAttempt("test-hx-unavail", makeBinding({
      openCodeSessionId: "test-hx-unavail",
      nativeToolDefinitions: [],
    }));

    const result = await invokeNativeToolViaCallback({
      toolName: "sessions_history",
      nativeArgs: { sessionKey: "agent:main:x" },
      context: { sessionID: "test-hx-unavail" },
      renderTitle: "sessions_history",
    });

    const parsed = JSON.parse(result) as { title: string; output: string };
    assert(parsed.title.includes("error"));
  });
});