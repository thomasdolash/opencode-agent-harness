#!/usr/bin/env -S node --import tsx

// This smoke suite validates local harness seams and event projection behavior.
// It does not prove end-to-end Gateway SSE chunking. The real HTTP comparison
// still needs the live OpenClaw Gateway surface with
// `gateway.http.endpoints.chatCompletions.enabled = true`.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  onAgentEvent,
  resetAgentEventsForTest,
} from "openclaw/plugin-sdk/agent-harness-runtime";
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
const streamedBlocks: string[] = [];
let streamedBlockFlushes = 0;
const streamedAssistantEvents: string[] = [];
const streamedReasoningEvents: string[] = [];
const streamedToolPhases: string[] = [];
const streamedTimeouts: number[] = [];
let managedServerStarts = 0;
let managedServerStops = 0;
const managedClientBaseUrls: string[] = [];
const globalAssistantEventTexts: string[] = [];

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
      timeoutMs?: number;
      reasoningLevel?: string;
      onPartialText?: (payload: { text: string; delta?: string }) => void | Promise<void>;
      onReasoningStream?: (payload: { text: string; delta?: string }) => void | Promise<void>;
      onReasoningEnd?: () => void | Promise<void>;
      onBlockReply?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
      onBlockReplyFlush?: () => void | Promise<void>;
      onAssistantMessageStart?: () => void | Promise<void>;
      onToolEvent?: (payload: {
        phase: "started" | "progress" | "completed" | "failed";
        toolName: string;
        toolCallId?: string;
      }) => void | Promise<void>;
    },
  ) {
    streamedTimeouts.push(opts?.timeoutMs ?? -1);
    await opts?.onAssistantMessageStart?.();
    await opts?.onReasoningStream?.({ text: "internal reasoning", delta: "internal reasoning" });
    await opts?.onToolEvent?.({ phase: "started", toolName: "read_file", toolCallId: "tool-1" });
    streamedToolPhases.push("started:read_file");
    await opts?.onPartialText?.({ text: "reply", delta: "reply" });
    await opts?.onBlockReply?.({ text: "reply" });
    streamedPartials.push("reply");
    streamedBlocks.push("reply");
    await opts?.onToolEvent?.({ phase: "completed", toolName: "read_file", toolCallId: "tool-1" });
    await opts?.onBlockReplyFlush?.();
    streamedBlockFlushes += 1;
    streamedToolPhases.push("completed:read_file");
    await opts?.onReasoningStream?.({
      text: "internal reasoning should stay hidden",
      delta: " should stay hidden",
    });
    await opts?.onReasoningEnd?.();
    await opts?.onPartialText?.({ text: "reply-2", delta: "-2" });
    await opts?.onBlockReply?.({ text: "reply-2" });
    streamedPartials.push("reply-2");
    streamedBlocks.push("reply-2");
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
    reasoningLevel: "stream",
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
    onAgentEvent: (evt) => {
      if (evt.stream === "reasoning") {
        const data = evt.data as { text?: string; delta?: string; phase?: string } | undefined;
        streamedReasoningEvents.push(
          [data?.phase ?? "", data?.text ?? data?.delta ?? ""].filter(Boolean).join(":"),
        );
        return;
      }
      if (evt.stream !== "assistant") {
        return;
      }
      const data = evt.data as { text?: string; delta?: string; phase?: string } | undefined;
      streamedAssistantEvents.push(
        [data?.phase ?? "", data?.text ?? data?.delta ?? ""].filter(Boolean).join(":"),
      );
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
streamedBlocks.length = 0;
streamedBlockFlushes = 0;
streamedAssistantEvents.length = 0;
streamedReasoningEvents.length = 0;
streamedToolPhases.length = 0;
globalAssistantEventTexts.length = 0;
resetAgentEventsForTest();
const stopGlobalEventCapture = onAgentEvent((evt) => {
  if (evt.runId !== "run-streamed-prompt" || evt.stream !== "assistant") {
    return;
  }
  const data = evt.data as { text?: string; delta?: string; phase?: string } | undefined;
  globalAssistantEventTexts.push(
    [data?.phase ?? "", data?.delta ?? data?.text ?? ""].filter(Boolean).join(":")
  );
});
const streamedResult = await runOpenCodeHarnessAttempt(makeStreamingParams("streamed prompt"), opts);
stopGlobalEventCapture();
if (streamedResult.assistantTexts.join("\n") !== "reply-2") {
  throw new Error(`expected streamed assistant text reply-2, saw ${streamedResult.assistantTexts.join("\n")}`);
}
if (streamedPartials.join("|") !== "reply|reply|reply-2|reply-2") {
  throw new Error(`expected streamed partial trace reply|reply|reply-2|reply-2, saw ${streamedPartials.join("|")}`);
}
if (streamedBlocks.join("|") !== "reply|reply-2") {
  throw new Error(`expected streamed block trace reply|reply-2, saw ${streamedBlocks.join("|")}`);
}
if (streamedAssistantEvents.join("|") !== "start|reply|reply-2") {
  throw new Error(
    `expected streamed assistant events start|reply|reply-2, saw ${streamedAssistantEvents.join("|")}`,
  );
}
if (globalAssistantEventTexts.join("|") !== "start|reply|-2") {
  throw new Error(
    `expected global assistant event trace start|reply|-2, saw ${globalAssistantEventTexts.join("|")}`,
  );
}
if (
  streamedReasoningEvents.join("|") !==
  "internal reasoning|internal reasoning should stay hidden|end"
) {
  throw new Error(
    `expected streamed reasoning events internal reasoning|internal reasoning should stay hidden|end, saw ${streamedReasoningEvents.join("|")}`,
  );
}
if (streamedBlockFlushes !== 1) {
  throw new Error(`expected streamed block flush count 1, saw ${streamedBlockFlushes}`);
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
if (streamedTimeouts[0] !== 5_000) {
  throw new Error(`expected streamed timeout passthrough 5000, saw ${streamedTimeouts[0]}`);
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
      subscribe: async ({ signal }: { signal?: AbortSignal }) => ({
        stream: (async function* () {
          while (!signal?.aborted) {
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
      subscribe: async ({ signal }: { signal?: AbortSignal }) => ({
        stream: (async function* () {
          while (!signal?.aborted) {
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

await clearSharedOpenCodeHarnessClientAndWait();
const deltaStreamPartials: string[] = [];
let deltaStreamAssistantStarts = 0;
const deltaStreamClient = await createSharedOpenCodeHarnessClient({
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
            id: "assistant-delta",
            role: "assistant",
            time: { created: Date.now() },
          },
          parts: [{ type: "text", text: "hello world" }],
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
              type: "message.part.delta",
              properties: {
                sessionID: "open-code-session-delta",
                messageID: "assistant-delta",
                partID: "part-1",
                field: "text",
                delta: "hello",
              },
            },
          };
          yield {
            directory: tempRoot,
            payload: {
              type: "message.part.delta",
              properties: {
                sessionID: "open-code-session-delta",
                messageID: "assistant-delta",
                partID: "part-1",
                field: "text",
                delta: " world",
              },
            },
          };
          yield {
            directory: tempRoot,
            payload: {
              type: "session.idle",
              properties: {
                sessionID: "open-code-session-delta",
              },
            },
          };
        })(),
      }),
    },
  }),
});
const deltaStreamResult = await deltaStreamClient.streamMessage?.(
  "open-code-session-delta",
  { parts: [{ type: "text", text: "stream from deltas" }] },
  {
    onAssistantMessageStart: async () => {
      deltaStreamAssistantStarts += 1;
    },
    onPartialText: async (payload) => {
      deltaStreamPartials.push(payload.text);
    },
  },
  { directory: tempRoot },
);
if (!deltaStreamResult || typeof deltaStreamResult !== "object") {
  throw new Error("expected delta stream client result");
}
if ((deltaStreamResult as { finalText?: string }).finalText !== "hello world") {
  throw new Error(
    `expected delta stream final text hello world, saw ${(deltaStreamResult as { finalText?: string }).finalText}`,
  );
}
if (deltaStreamAssistantStarts !== 1) {
  throw new Error(`expected one delta-stream assistant start, saw ${deltaStreamAssistantStarts}`);
}
if (deltaStreamPartials.join("|") !== "hello|hello world") {
  throw new Error(`expected delta stream partials hello|hello world, saw ${deltaStreamPartials.join("|")}`);
}

await clearSharedOpenCodeHarnessClientAndWait();
const orderedEventPartials: string[] = [];
const orderedEventClient = await createSharedOpenCodeHarnessClient({
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
            id: "user-ordered",
            role: "user",
            time: { created: Date.now() },
          },
          parts: [{ type: "text", text: "Say hello in five words." }],
        },
        {
          info: {
            id: "assistant-ordered",
            role: "assistant",
            time: { created: Date.now() + 1 },
          },
          parts: [{ type: "text", text: "hello world" }],
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
              type: "message.updated",
              properties: {
                info: {
                  id: "user-ordered",
                  role: "user",
                  sessionID: "open-code-session-ordered",
                },
              },
            },
          };
          yield {
            directory: tempRoot,
            payload: {
              type: "message.part.updated",
              properties: {
                part: {
                  messageID: "user-ordered",
                  type: "text",
                  text: "Say hello in five words.",
                  sessionID: "open-code-session-ordered",
                },
              },
            },
          };
          yield {
            directory: tempRoot,
            payload: {
              type: "message.updated",
              properties: {
                info: {
                  id: "assistant-ordered",
                  role: "assistant",
                  sessionID: "open-code-session-ordered",
                },
              },
            },
          };
          yield {
            directory: tempRoot,
            payload: {
              type: "message.part.updated",
              properties: {
                part: {
                  messageID: "assistant-ordered",
                  type: "text",
                  text: "",
                  sessionID: "open-code-session-ordered",
                },
              },
            },
          };
          yield {
            directory: tempRoot,
            payload: {
              type: "message.part.delta",
              properties: {
                sessionID: "open-code-session-ordered",
                messageID: "assistant-ordered",
                partID: "part-ordered",
                field: "text",
                delta: "hello",
              },
            },
          };
          yield {
            directory: tempRoot,
            payload: {
              type: "message.part.delta",
              properties: {
                sessionID: "open-code-session-ordered",
                messageID: "assistant-ordered",
                partID: "part-ordered",
                field: "text",
                delta: " world",
              },
            },
          };
          yield {
            directory: tempRoot,
            payload: {
              type: "session.idle",
              properties: {
                sessionID: "open-code-session-ordered",
              },
            },
          };
        })(),
      }),
    },
  }),
});
const orderedEventResult = await orderedEventClient.streamMessage?.(
  "open-code-session-ordered",
  { parts: [{ type: "text", text: "stream only assistant text" }] },
  {
    onPartialText: async (payload) => {
      orderedEventPartials.push(payload.text);
    },
  },
  { directory: tempRoot },
);
if (!orderedEventResult || typeof orderedEventResult !== "object") {
  throw new Error("expected ordered-event stream client result");
}
if ((orderedEventResult as { finalText?: string }).finalText !== "hello world") {
  throw new Error(
    `expected ordered-event final text hello world, saw ${(orderedEventResult as { finalText?: string }).finalText}`,
  );
}
if (orderedEventPartials.join("|") !== "hello|hello world") {
  throw new Error(
    `expected ordered-event partials hello|hello world, saw ${orderedEventPartials.join("|")}`,
  );
}

await clearSharedOpenCodeHarnessClientAndWait();
const updatedDeltaPartials: string[] = [];
const updatedDeltaClient = await createSharedOpenCodeHarnessClient({
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
            id: "assistant-updated-delta",
            role: "assistant",
            time: { created: Date.now() },
          },
          parts: [{ type: "text", text: "hello world" }],
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
              type: "message.updated",
              properties: {
                info: {
                  id: "assistant-updated-delta",
                  role: "assistant",
                  sessionID: "open-code-session-updated-delta",
                },
              },
            },
          };
          yield {
            directory: tempRoot,
            payload: {
              type: "message.part.updated",
              properties: {
                part: {
                  messageID: "assistant-updated-delta",
                  type: "text",
                  text: "hello",
                  sessionID: "open-code-session-updated-delta",
                },
                delta: "hello",
              },
            },
          };
          yield {
            directory: tempRoot,
            payload: {
              type: "message.part.updated",
              properties: {
                part: {
                  messageID: "assistant-updated-delta",
                  type: "text",
                  text: "hello world",
                  sessionID: "open-code-session-updated-delta",
                },
                delta: " world",
              },
            },
          };
          yield {
            directory: tempRoot,
            payload: {
              type: "message.part.updated",
              properties: {
                part: {
                  messageID: "assistant-updated-delta",
                  type: "text",
                  text: "hello world",
                  sessionID: "open-code-session-updated-delta",
                },
              },
            },
          };
          yield {
            directory: tempRoot,
            payload: {
              type: "session.idle",
              properties: {
                sessionID: "open-code-session-updated-delta",
              },
            },
          };
        })(),
      }),
    },
  }),
});
const updatedDeltaResult = await updatedDeltaClient.streamMessage?.(
  "open-code-session-updated-delta",
  { parts: [{ type: "text", text: "prefer updated deltas" }] },
  {
    onPartialText: async (payload) => {
      updatedDeltaPartials.push(payload.text);
    },
  },
  { directory: tempRoot },
);
if (!updatedDeltaResult || typeof updatedDeltaResult !== "object") {
  throw new Error("expected updated-delta stream client result");
}
if ((updatedDeltaResult as { finalText?: string }).finalText !== "hello world") {
  throw new Error(
    `expected updated-delta final text hello world, saw ${(updatedDeltaResult as { finalText?: string }).finalText}`,
  );
}
if (updatedDeltaPartials.join("|") !== "hello|hello world") {
  throw new Error(
    `expected updated-delta partials hello|hello world, saw ${updatedDeltaPartials.join("|")}`,
  );
}

console.log("opencode-agent-harness smoke OK");
