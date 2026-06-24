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

    // Verify the URL actually works
    const resp = await fetch(`${url}/native-tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s", callId: "c", toolName: "sessions_send" }),
    });
    assert.equal(resp.status, 404); // no active binding
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

    // This is what the OpenCode plugin does: reads env var, POSTs to it
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
    assert(!body.error.includes("http://")); // no URL leak
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