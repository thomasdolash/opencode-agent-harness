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
const createSessionContexts: Array<{ directory?: string; workspace?: string } | undefined> = [];
const messageCalls: Array<{
  sessionId: string;
  payload: unknown;
  context?: { directory?: string; workspace?: string };
}> = [];
const streamedPartials: string[] = [];
const streamedToolPhases: string[] = [];
let managedServerStarts = 0;
let managedServerStops = 0;
const managedClientBaseUrls: string[] = [];

const fakeClient = {
  async createSession(_payload?: unknown, context?: { directory?: string; workspace?: string }) {
    createSessionCalls += 1;
    createSessionContexts.push(context);
    return { id: "open-code-session-1" };
  },
  async message(sessionId: string, payload: unknown, context?: { directory?: string; workspace?: string }) {
    messageCalls.push({ sessionId, payload, context });
    if (messageCalls.length === 1) {
      return {
        parts: [
          { type: "reasoning", text: "internal reasoning should stay hidden" },
          { type: "text", text: "reply-1" },
        ],
      };
    }
    return {
      text: `reply-${messageCalls.length}`,
    };
  },
  async checkHealth() {
    return { ok: true, version: "2026.6.8" };
  },
  async streamMessage(
    _sessionId: string,
    _payload: unknown,
    opts?: {
      onPartialText?: (payload: { text: string; delta?: string }) => void | Promise<void>;
      onAssistantMessageStart?: () => void | Promise<void>;
      onToolEvent?: (payload: {
        phase: "started" | "progress" | "completed" | "failed";
        toolName: string;
        toolCallId?: string;
      }) => void | Promise<void>;
    },
  ) {
    await opts?.onAssistantMessageStart?.();
    await opts?.onToolEvent?.({ phase: "started", toolName: "read_file", toolCallId: "tool-1" });
    streamedToolPhases.push("started:read_file");
    await opts?.onPartialText?.({ text: "reply", delta: "reply" });
    streamedPartials.push("reply");
    await opts?.onToolEvent?.({ phase: "completed", toolName: "read_file", toolCallId: "tool-1" });
    streamedToolPhases.push("completed:read_file");
    await opts?.onPartialText?.({ text: "reply-2", delta: "-2" });
    streamedPartials.push("reply-2");
    return {
      response: {
        parts: [{ type: "text", text: "reply-2" }],
      },
      finalText: "reply-2",
      reasoningText: "stream reasoning stays separate",
      toolMetas: [{ toolName: "read_file" }],
      usage: {
        input: 12,
        output: 4,
        reasoningTokens: 2,
        total: 18,
      },
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
if (createSessionContexts[0]?.directory !== tempRoot) {
  throw new Error(`expected first createSession directory ${tempRoot}, saw ${createSessionContexts[0]?.directory}`);
}
if (firstBinding?.openCodeSessionId !== "open-code-session-1") {
  throw new Error(`expected first binding to persist open-code-session-1, saw ${firstBinding?.openCodeSessionId}`);
}
if (firstResult.assistantTexts.join("\n") !== "reply-1") {
  throw new Error(`expected first assistant text reply-1, saw ${firstResult.assistantTexts.join("\n")}`);
}
if ((firstResult.messagesSnapshot[0] as { role?: string }).role !== "user") {
  throw new Error("expected first messagesSnapshot entry to mirror the user prompt");
}

const secondResult = await runOpenCodeHarnessAttempt(makeParams("second prompt"), opts);
const secondBinding = await readOpenCodeHarnessBinding(sessionFile);

if (createSessionCalls !== 1) {
  throw new Error(`expected resumed run to reuse session, saw ${createSessionCalls} createSession calls`);
}
if (messageCalls.length !== 2) {
  throw new Error(`expected two message calls after two runs, saw ${messageCalls.length}`);
}
if (messageCalls.some((call) => call.context?.directory !== tempRoot)) {
  throw new Error(`expected all message calls to use directory ${tempRoot}`);
}
if (secondBinding?.openCodeSessionId !== "open-code-session-1") {
  throw new Error(`expected second binding to keep open-code-session-1, saw ${secondBinding?.openCodeSessionId}`);
}
if (secondResult.assistantTexts.join("\n") !== "reply-2") {
  throw new Error(`expected second assistant text reply-2, saw ${secondResult.assistantTexts.join("\n")}`);
}

streamedPartials.length = 0;
streamedToolPhases.length = 0;
const streamedResult = await runOpenCodeHarnessAttempt(makeStreamingParams("streamed prompt"), opts);
if (streamedResult.assistantTexts.join("\n") !== "reply-2") {
  throw new Error(`expected streamed assistant text reply-2, saw ${streamedResult.assistantTexts.join("\n")}`);
}
if (streamedPartials.join("|") !== "reply|reply|reply-2|reply-2") {
  throw new Error(`expected streamed partial trace reply|reply|reply-2|reply-2, saw ${streamedPartials.join("|")}`);
}
if (streamedToolPhases.join("|") !== "started:read_file|completed:read_file") {
  throw new Error(`expected streamed tool phases started:read_file|completed:read_file, saw ${streamedToolPhases.join("|")}`);
}
if (streamedResult.toolMetas[0]?.toolName !== "read_file") {
  throw new Error(`expected streamed tool meta read_file, saw ${streamedResult.toolMetas[0]?.toolName}`);
}
if (streamedResult.attemptUsage?.total !== 18) {
  throw new Error(`expected streamed attempt usage total 18, saw ${streamedResult.attemptUsage?.total}`);
}
if (streamedResult.lastAssistant?.usage?.totalTokens !== 18) {
  throw new Error(`expected streamed lastAssistant totalTokens 18, saw ${streamedResult.lastAssistant?.usage?.totalTokens}`);
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

await clearSharedOpenCodeHarnessClientAndWait();
let streamPromptAsyncCalls = 0;
let streamMessagePolls = 0;
const streamedSessionId = "open-code-session-stream";
const streamedClient = await createSharedOpenCodeHarnessClient({
  pluginConfig: {
    server: {
      mode: "remote",
      baseUrl: "http://unused-for-smoke.test",
    },
  },
  sdkClientFactory: async () => ({
    health: async () => ({ ok: true, version: "2026.6.8" }),
    session: {
      create: fakeClient.createSession,
      promptAsync: async (options: { path: { id: string }; body: unknown; query?: { directory?: string; workspace?: string } }) => {
        streamPromptAsyncCalls += 1;
        if (options.path.id !== streamedSessionId) {
          throw new Error(`unexpected stream session id ${options.path.id}`);
        }
        if (options.query?.directory !== tempRoot) {
          throw new Error(`expected streaming directory ${tempRoot}, saw ${options.query?.directory}`);
        }
      },
      messages: async (options: { path: { id: string }; query?: { directory?: string; workspace?: string; limit?: number } }) => {
        streamMessagePolls += 1;
        if (options.path.id !== streamedSessionId) {
          throw new Error(`unexpected streamed messages session id ${options.path.id}`);
        }
        return [
          {
            info: {
              id: "assistant-stream-1",
              role: "assistant",
              time: { created: Date.now() },
            },
            parts: [{ type: "text", text: "stream reply" }],
          },
        ];
      },
      abort: async () => fakeClient.abort(),
    },
    event: {
      subscribe: async () => ({ stream: (async function* () {})() }),
    },
  }),
});
const streamedClientResult = await streamedClient.streamMessage?.(
  streamedSessionId,
  { parts: [{ type: "text", text: "stream please" }] },
  {
    onPartialText: async () => {},
  },
  { directory: tempRoot },
);
if (!streamedClientResult || typeof streamedClientResult !== "object") {
  throw new Error("expected streamed client result");
}
if (streamPromptAsyncCalls !== 1) {
  throw new Error(`expected one promptAsync call, saw ${streamPromptAsyncCalls}`);
}
if (streamMessagePolls < 1) {
  throw new Error(`expected at least one message poll, saw ${streamMessagePolls}`);
}
if ((streamedClientResult as { finalText?: string }).finalText !== "stream reply") {
  throw new Error(`expected streamed final text stream reply, saw ${(streamedClientResult as { finalText?: string }).finalText}`);
}

await clearSharedOpenCodeHarnessClientAndWait();
let hangingStreamPromptAsyncCalls = 0;
let hangingStreamMessagePolls = 0;
const hangingClient = await createSharedOpenCodeHarnessClient({
  pluginConfig: {
    server: {
      mode: "remote",
      baseUrl: "http://unused-for-smoke.test",
    },
  },
  sdkClientFactory: async () => ({
    health: async () => ({ ok: true, version: "2026.6.8" }),
    session: {
      create: fakeClient.createSession,
      promptAsync: async () => {
        hangingStreamPromptAsyncCalls += 1;
      },
      messages: async () => {
        hangingStreamMessagePolls += 1;
        return [
          {
            info: {
              id: "assistant-stream-hanging",
              role: "assistant",
              time: { created: Date.now() },
            },
            parts: [{ type: "text", text: "reply from hanging stream" }],
          },
        ];
      },
      abort: async () => fakeClient.abort(),
    },
    event: {
      subscribe: async () => ({
        stream: (async function* () {
          while (true) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        })(),
      }),
    },
  }),
});
const hangingStreamStart = Date.now();
const hangingStreamResult = await hangingClient.streamMessage?.(
  "open-code-session-hanging",
  { parts: [{ type: "text", text: "stream please" }] },
  {
    onPartialText: async () => {},
  },
  { directory: tempRoot },
);
const hangingStreamElapsedMs = Date.now() - hangingStreamStart;
if (!hangingStreamResult || typeof hangingStreamResult !== "object") {
  throw new Error("expected hanging streamed client result");
}
if (hangingStreamPromptAsyncCalls !== 1) {
  throw new Error(`expected one hanging promptAsync call, saw ${hangingStreamPromptAsyncCalls}`);
}
if (hangingStreamMessagePolls < 1) {
  throw new Error(`expected at least one hanging stream message poll, saw ${hangingStreamMessagePolls}`);
}
if ((hangingStreamResult as { finalText?: string }).finalText !== "reply from hanging stream") {
  throw new Error(
    `expected hanging streamed final text reply from hanging stream, saw ${(hangingStreamResult as { finalText?: string }).finalText}`,
  );
}
if (hangingStreamElapsedMs > 2_000) {
  throw new Error(`expected hanging stream fallback to complete promptly, saw ${hangingStreamElapsedMs}ms`);
}

await clearSharedOpenCodeHarnessClientAndWait();
let wrappedEventPartialText = "";
const wrappedEventClient = await createSharedOpenCodeHarnessClient({
  pluginConfig: {
    server: {
      mode: "remote",
      baseUrl: "http://unused-for-smoke.test",
    },
  },
  sdkClientFactory: async () => ({
    health: async () => ({ ok: true, version: "2026.6.8" }),
    session: {
      create: fakeClient.createSession,
      promptAsync: async () => {},
      messages: async () => [
        {
          info: {
            id: "assistant-old",
            role: "assistant",
            time: { created: Date.now() - 60_000 },
          },
          parts: [],
        },
        {
          info: {
            id: "assistant-new",
            role: "assistant",
            time: { created: Date.now() + 5 },
          },
          parts: [{ type: "text", text: "fresh reply" }],
        },
      ],
      abort: async () => fakeClient.abort(),
    },
    event: {
      subscribe: async () => ({
        stream: (async function* () {
          yield {
            directory: tempRoot,
            payload: {
              type: "session.next.text.started",
              properties: {
                sessionID: "open-code-session-wrapped",
                assistantMessageID: "assistant-new",
              },
            },
          };
          yield {
            directory: tempRoot,
            payload: {
              type: "session.next.text.delta",
              properties: {
                sessionID: "open-code-session-wrapped",
                assistantMessageID: "assistant-new",
                delta: "fresh",
              },
            },
          };
          yield {
            directory: tempRoot,
            payload: {
              type: "session.idle",
              properties: {
                sessionID: "open-code-session-wrapped",
              },
            },
          };
        })(),
      }),
    },
  }),
});
const wrappedEventResult = await wrappedEventClient.streamMessage?.(
  "open-code-session-wrapped",
  { parts: [{ type: "text", text: "use wrapped events" }] },
  {
    onPartialText: async (payload) => {
      wrappedEventPartialText = payload.text;
    },
  },
  { directory: tempRoot },
);
if (!wrappedEventResult || typeof wrappedEventResult !== "object") {
  throw new Error("expected wrapped event client result");
}
if ((wrappedEventResult as { finalText?: string }).finalText !== "fresh reply") {
  throw new Error(
    `expected wrapped-event final text fresh reply, saw ${(wrappedEventResult as { finalText?: string }).finalText}`,
  );
}
if (wrappedEventPartialText !== "fresh") {
  throw new Error(`expected wrapped-event partial text fresh, saw ${wrappedEventPartialText}`);
}

await clearSharedOpenCodeHarnessClientAndWait();
let delayedMessagePolls = 0;
const delayedAssistantClient = await createSharedOpenCodeHarnessClient({
  pluginConfig: {
    server: {
      mode: "remote",
      baseUrl: "http://unused-for-smoke.test",
    },
  },
  sdkClientFactory: async () => ({
    health: async () => ({ ok: true, version: "2026.6.8" }),
    session: {
      create: fakeClient.createSession,
      promptAsync: async () => {},
      messages: async () => {
        delayedMessagePolls += 1;
        if (delayedMessagePolls < 3) {
          return [
            {
              info: {
                id: "assistant-placeholder",
                role: "assistant",
                time: { created: Date.now() },
              },
              parts: [],
            },
          ];
        }
        return [
          {
            info: {
              id: "assistant-placeholder",
              role: "assistant",
              time: { created: Date.now() },
            },
            parts: [],
          },
          {
            info: {
              id: "assistant-visible",
              role: "assistant",
              time: { created: Date.now() + 1 },
            },
            parts: [{ type: "text", text: "visible reply" }],
          },
        ];
      },
      abort: async () => fakeClient.abort(),
    },
    event: {
      subscribe: async () => ({
        stream: (async function* () {
          while (true) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        })(),
      }),
    },
  }),
});
const delayedAssistantResult = await delayedAssistantClient.streamMessage?.(
  "open-code-session-delayed",
  { parts: [{ type: "text", text: "wait for visible text" }] },
  {
    onPartialText: async () => {},
  },
  { directory: tempRoot },
);
if (!delayedAssistantResult || typeof delayedAssistantResult !== "object") {
  throw new Error("expected delayed assistant client result");
}
if ((delayedAssistantResult as { finalText?: string }).finalText !== "visible reply") {
  throw new Error(
    `expected delayed assistant final text visible reply, saw ${(delayedAssistantResult as { finalText?: string }).finalText}`,
  );
}
if (delayedMessagePolls < 3) {
  throw new Error(`expected delayed assistant polling to continue past placeholder, saw ${delayedMessagePolls} polls`);
}

console.log("opencode-agent-harness smoke OK");
