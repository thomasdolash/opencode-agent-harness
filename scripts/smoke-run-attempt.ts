#!/usr/bin/env -S node --import tsx

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { runOpenCodeHarnessAttempt } from "../src/app-server/run-attempt.js";
import {
  clearSharedOpenCodeHarnessClientAndWait,
  createSharedOpenCodeHarnessClient,
} from "../src/app-server/shared-client.js";
import {
  clearOpenCodeHarnessBinding,
  readOpenCodeHarnessBinding,
} from "../src/app-server/session-binding.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-agent-harness-"));
const sessionFile = path.join(tempRoot, "session.json");

let createSessionCalls = 0;
const messageCalls = [];
const streamedPartials: string[] = [];
let managedServerStarts = 0;
let managedServerStops = 0;
const managedClientBaseUrls: string[] = [];

const fakeClient = {
  async createSession() {
    createSessionCalls += 1;
    return { id: "open-code-session-1" };
  },
  async message(sessionId: string, payload: unknown) {
    messageCalls.push({ sessionId, payload });
    return {
      text: `reply-${messageCalls.length}`,
    };
  },
  async checkHealth() {
    return { ok: true, version: "2026.6.8" };
  },
  async streamMessage(_sessionId: string, _payload: unknown, opts?: { onPartialText?: (payload: { text: string; delta?: string }) => void | Promise<void> }) {
    await opts?.onPartialText?.({ text: "reply", delta: "reply" });
    streamedPartials.push("reply");
    await opts?.onPartialText?.({ text: "reply-2", delta: "-2" });
    streamedPartials.push("reply-2");
    return {
      parts: [{ type: "text", text: "reply-2" }],
    };
  },
  async abort() {},
};

function makeParams(prompt: string): EmbeddedRunAttemptParams {
  return {
    prompt,
    sessionFile,
    sessionId: "openclaw-session-1",
    sessionKey: "agent:main:openclaw-session-1",
    workspaceDir: tempRoot,
    runId: `run-${prompt.replace(/\s+/g, "-")}`,
    provider: "opencode",
    modelId: "openrouter/deepseek/deepseek-v4-flash",
    model: {} as EmbeddedRunAttemptParams["model"],
    authStorage: {} as EmbeddedRunAttemptParams["authStorage"],
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {} as EmbeddedRunAttemptParams["modelRegistry"],
    thinkLevel: "medium",
    timeoutMs: 5_000,
    disableTools: true,
    abortSignal: new AbortController().signal,
  } as EmbeddedRunAttemptParams;
}

function makeStreamingParams(prompt: string): EmbeddedRunAttemptParams {
  return {
    ...makeParams(prompt),
    onPartialReply: (payload) => {
      streamedPartials.push(payload.text ?? "");
    },
  };
}

const opts = {
  pluginConfig: {
    server: {
      mode: "remote",
      baseUrl: "http://unused-for-smoke.test",
      minVersion: "2026.6.1",
    },
  },
  openCodeClient: fakeClient,
};

await clearSharedOpenCodeHarnessClientAndWait();
const managedClient = await createSharedOpenCodeHarnessClient({
  pluginConfig: {
    server: {
      mode: "managed",
      hostname: "127.0.0.1",
      port: 4096,
      timeoutMs: 1000,
    },
  },
  managedServerFactory: async () => {
    managedServerStarts += 1;
    return {
      url: "http://127.0.0.1:4096",
      close() {
        managedServerStops += 1;
      },
    };
  },
  sdkClientFactory: async (baseUrl: string) => {
    managedClientBaseUrls.push(baseUrl);
    return {
      health: async () => ({ ok: true, version: "2026.6.8" }),
      session: {
        create: fakeClient.createSession,
        prompt: async (options: { path: { id: string }; body: unknown }) =>
          fakeClient.message(options.path.id, options.body),
        abort: async (_options: { path: { id: string } }) => fakeClient.abort(),
      },
      event: {
        subscribe: async () => ({ stream: (async function* () {})() }),
      },
    };
  },
});
await managedClient.checkHealth();
if (managedServerStarts !== 1) {
  throw new Error(`expected one managed server start, saw ${managedServerStarts}`);
}
if (managedClientBaseUrls.join("|") !== "http://127.0.0.1:4096") {
  throw new Error(`expected managed client base URL http://127.0.0.1:4096, saw ${managedClientBaseUrls.join("|")}`);
}

const firstResult = await runOpenCodeHarnessAttempt(makeParams("first prompt"), opts);
const firstBinding = await readOpenCodeHarnessBinding(sessionFile);

if (createSessionCalls !== 1) {
  throw new Error(`expected one createSession call after first run, saw ${createSessionCalls}`);
}
if (firstBinding?.openCodeSessionId !== "open-code-session-1") {
  throw new Error(`expected first binding to persist open-code-session-1, saw ${firstBinding?.openCodeSessionId}`);
}
if (firstResult.assistantTexts.join("\n") !== "reply-1") {
  throw new Error(`expected first assistant text reply-1, saw ${firstResult.assistantTexts.join("\n")}`);
}

const secondResult = await runOpenCodeHarnessAttempt(makeParams("second prompt"), opts);
const secondBinding = await readOpenCodeHarnessBinding(sessionFile);

if (createSessionCalls !== 1) {
  throw new Error(`expected resumed run to reuse session, saw ${createSessionCalls} createSession calls`);
}
if (messageCalls.length !== 2) {
  throw new Error(`expected two message calls after two runs, saw ${messageCalls.length}`);
}
if (secondBinding?.openCodeSessionId !== "open-code-session-1") {
  throw new Error(`expected second binding to keep open-code-session-1, saw ${secondBinding?.openCodeSessionId}`);
}
if (secondResult.assistantTexts.join("\n") !== "reply-2") {
  throw new Error(`expected second assistant text reply-2, saw ${secondResult.assistantTexts.join("\n")}`);
}

streamedPartials.length = 0;
const streamedResult = await runOpenCodeHarnessAttempt(makeStreamingParams("streamed prompt"), opts);
if (streamedResult.assistantTexts.join("\n") !== "reply-2") {
  throw new Error(`expected streamed assistant text reply-2, saw ${streamedResult.assistantTexts.join("\n")}`);
}
if (streamedPartials.join("|") !== "reply|reply|reply-2|reply-2") {
  throw new Error(`expected streamed partial trace reply|reply|reply-2|reply-2, saw ${streamedPartials.join("|")}`);
}

await clearOpenCodeHarnessBinding(sessionFile);
const clearedBinding = await readOpenCodeHarnessBinding(sessionFile);
if (clearedBinding) {
  throw new Error("expected binding to be cleared after reset helper");
}

await clearSharedOpenCodeHarnessClientAndWait();
if (managedServerStops !== 1) {
  throw new Error(`expected one managed server stop after shared-client cleanup, saw ${managedServerStops}`);
}

console.log("opencode-agent-harness smoke OK");
