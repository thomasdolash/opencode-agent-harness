import type {
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
  AgentMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  classifyAgentHarnessTerminalOutcome,
  emitAgentEvent,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenCodeHarnessLogger } from "../logger.js";
import { resolveHarnessPluginConfig } from "./shared-client.js";
import { createSharedOpenCodeHarnessClient } from "./shared-client.js";
import type {
  OpenCodeHarnessTurnResult,
  OpenCodeHarnessUsage,
} from "./shared-client.js";
import {
  readOpenCodeHarnessBinding,
  writeOpenCodeHarnessBinding,
} from "./session-binding.js";

function extractPromptText(params: AgentHarnessAttemptParams): string {
  if (typeof params.prompt === "string" && params.prompt.trim() !== "") {
    return params.prompt;
  }
  return "";
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(/[^0-9]+/).filter(Boolean).map(Number);
  const rightParts = right.split(/[^0-9]+/).filter(Boolean).map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }
  return 0;
}

function extractTextParts(parts: unknown): string[] {
  if (!Array.isArray(parts)) {
    return [];
  }
  return parts
    .flatMap((part) => {
      if (
        part &&
        typeof part === "object" &&
        (!("type" in part) || (part as { type?: unknown }).type === "text") &&
        "text" in part &&
        typeof (part as { text: unknown }).text === "string"
      ) {
        return [(part as { text: string }).text];
      }
      return [];
    })
    .filter((text) => text.trim() !== "");
}

function extractTypedTextParts(parts: unknown, expectedType: string): string[] {
  if (!Array.isArray(parts)) {
    return [];
  }
  return parts
    .flatMap((part) => {
      if (
        part &&
        typeof part === "object" &&
        "type" in part &&
        (part as { type: unknown }).type === expectedType &&
        "text" in part &&
        typeof (part as { text: unknown }).text === "string"
      ) {
        return [(part as { text: string }).text];
      }
      return [];
    })
    .filter((text) => text.trim() !== "");
}

function extractResponseText(response: unknown): string {
  if (typeof response === "string") {
    return response.trim();
  }
  if (!response || typeof response !== "object") {
    return "";
  }

  const record = response as Record<string, unknown>;
  const candidates = [
    record.text,
    record.output,
    record.message,
    record.assistant,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate.trim();
    }
  }

  const joinedParts = [
    ...extractTextParts(record.parts),
    ...extractTextParts((record.body as Record<string, unknown> | undefined)?.parts),
    ...extractTextParts((record.data as Record<string, unknown> | undefined)?.parts),
  ].join("\n");
  return joinedParts.trim();
}

function extractResponseReasoningText(response: unknown): string {
  if (!response || typeof response !== "object") {
    return "";
  }

  const record = response as Record<string, unknown>;
  return [
    ...extractTypedTextParts(record.parts, "reasoning"),
    ...extractTypedTextParts((record.body as Record<string, unknown> | undefined)?.parts, "reasoning"),
    ...extractTypedTextParts((record.data as Record<string, unknown> | undefined)?.parts, "reasoning"),
  ]
    .join("\n")
    .trim();
}

function readTurnEnvelope(response: unknown): OpenCodeHarnessTurnResult | undefined {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return undefined;
  }
  const record = response as Record<string, unknown>;
  if (!("response" in record)) {
    return undefined;
  }
  return response as OpenCodeHarnessTurnResult;
}

function buildUsageSnapshot(
  usage: OpenCodeHarnessUsage | undefined,
): NonNullable<AgentHarnessAttemptResult["lastAssistant"]>["usage"] | undefined {
  if (!usage) {
    return undefined;
  }
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const totalTokens =
    usage.total ?? input + output + cacheRead + cacheWrite + (usage.reasoningTokens ?? 0);

  const hasNonZero = [input, output, cacheRead, cacheWrite, totalTokens].some((value) => value > 0);
  if (!hasNonZero) {
    return undefined;
  }

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function emitHarnessAgentEvent(params: {
  runId: string;
  sessionKey?: string;
  event: {
    stream: "assistant" | "reasoning" | "tool" | "lifecycle" | string;
    data: Record<string, unknown>;
  };
  onAgentEvent?: (event: { stream: string; data: Record<string, unknown> }) => void | Promise<void>;
}): Promise<void> {
  try {
    emitAgentEvent({
      runId: params.runId,
      stream: params.event.stream,
      data: params.event.data,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    });
  } catch {
    // Best effort only: local harness runs should not fail just because the
    // global OpenClaw agent-event bus is unavailable.
  }
  return Promise.resolve(params.onAgentEvent?.(params.event)).then(() => undefined);
}

function buildAttemptResult(params: {
  sessionIdUsed: string;
  sessionFileUsed: string;
  provider: string;
  modelId?: string;
  promptText: string;
  finalText: string;
  reasoningText?: string;
  toolMetas?: AgentHarnessAttemptResult["toolMetas"];
  usage?: OpenCodeHarnessUsage;
}): AgentHarnessAttemptResult {
  const assistantTexts = params.finalText ? [params.finalText] : [];
  const usageSnapshot = buildUsageSnapshot(params.usage);
  const assistantMessage = params.finalText
    ? ({
        role: "assistant",
        content: [{ type: "text", text: params.finalText }],
        provider: params.provider,
        model: params.modelId,
        ...(usageSnapshot ? { usage: usageSnapshot } : {}),
        stopReason: "stop",
        timestamp: Date.now(),
      } as AgentHarnessAttemptResult["lastAssistant"])
    : undefined;
  const messagesSnapshot: AgentMessage[] = [
    {
      role: "user",
      content: params.promptText,
      timestamp: Date.now(),
    } as AgentMessage,
    ...(assistantMessage ? [assistantMessage as AgentMessage] : []),
  ];

  return {
    aborted: false,
    externalAbort: false,
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    timedOutDuringToolExecution: false,
    promptError: null,
    promptErrorSource: null,
    sessionIdUsed: params.sessionIdUsed,
    sessionFileUsed: params.sessionFileUsed,
    finalPromptText: params.promptText,
    messagesSnapshot,
    assistantTexts,
    toolMetas: params.toolMetas ?? [],
    acceptedSessionSpawns: [],
    lastAssistant: assistantMessage,
    currentAttemptAssistant: assistantMessage,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    ...(params.usage ? { attemptUsage: params.usage } : {}),
    ...(classifyAgentHarnessTerminalOutcome({
      assistantTexts,
      reasoningText: params.reasoningText,
      turnCompleted: true,
      promptError: null,
    })
      ? {
          agentHarnessResultClassification: classifyAgentHarnessTerminalOutcome({
            assistantTexts,
            reasoningText: params.reasoningText,
            turnCompleted: true,
            promptError: null,
          }),
        }
      : {}),
    replayMetadata: {} as AgentHarnessAttemptResult["replayMetadata"],
    itemLifecycle: {
      startedCount: 0,
      completedCount: 0,
      activeCount: 0,
    },
  };
}

export async function runOpenCodeHarnessAttempt(
  params: AgentHarnessAttemptParams,
  opts: {
    pluginConfig?: unknown;
    logger?: OpenCodeHarnessLogger;
    openCodeClient?: import("./shared-client.js").OpenCodeHarnessClient;
  },
): Promise<AgentHarnessAttemptResult> {
  const promptText = extractPromptText(params);
  const sessionFile = params.sessionFile;
  const requestContext = {
    directory: params.cwd ?? params.workspaceDir,
  };

  if (typeof sessionFile !== "string" || sessionFile.trim() === "") {
    throw new Error("OpenCode harness requires params.sessionFile for binding persistence");
  }

  const client = await createSharedOpenCodeHarnessClient(opts);
  const health = (await client.checkHealth()) as { version?: unknown } | undefined;
  const minVersion = resolveHarnessPluginConfig(opts.pluginConfig)?.server.minVersion;
  if (
    typeof minVersion === "string" &&
    minVersion.trim() !== "" &&
    typeof health?.version === "string" &&
    compareVersions(health.version, minVersion) < 0
  ) {
    throw new Error(
      `OpenCode server version ${health.version} is less than required ${minVersion}`,
    );
  }

  const binding = await readOpenCodeHarnessBinding(sessionFile);
  let openCodeSessionId = binding?.openCodeSessionId;
  if (!openCodeSessionId) {
    opts.logger?.debug?.("creating native OpenCode session", {
      directory: requestContext.directory,
      modelId: params.modelId,
      sessionFile,
    });
    const created = await client.createSession(undefined, requestContext);
    openCodeSessionId = created.id;
    await writeOpenCodeHarnessBinding(sessionFile, {
      openCodeSessionId,
      model: params.modelId,
      createdAt: new Date().toISOString(),
    });
  } else {
    opts.logger?.debug?.("resuming native OpenCode session", {
      modelId: params.modelId,
      openCodeSessionId,
      sessionFile,
    });
  }

  let abortListener: (() => void) | undefined;
  if (params.abortSignal && client.abort) {
    abortListener = () => {
      void client.abort?.(openCodeSessionId!);
    };
    if (params.abortSignal.aborted) {
      abortListener();
    } else {
      params.abortSignal.addEventListener("abort", abortListener, { once: true });
    }
  }

  try {
    const requestPayload = {
      parts: [{ type: "text", text: promptText }],
    };
    const streamMessage = client.streamMessage;
    const supportsStreaming = Boolean(
      streamMessage &&
        (params.onPartialReply ||
          params.onReasoningStream ||
          params.onReasoningEnd ||
          params.onAssistantMessageStart ||
          params.onAgentEvent ||
          params.onBlockReply ||
          params.onBlockReplyFlush),
    );
    opts.logger?.debug?.("starting native turn", {
      partialStreaming: supportsStreaming,
      promptLength: promptText.length,
      sessionFile,
    });
    const response =
      supportsStreaming
        ? await streamMessage!(openCodeSessionId, requestPayload, {
            abortSignal: params.abortSignal,
            timeoutMs: params.timeoutMs,
            reasoningLevel: params.reasoningLevel,
            logger: opts.logger,
            onAssistantMessageStart: async () => {
              await emitHarnessAgentEvent({
                runId: params.runId,
                sessionKey: params.sessionKey,
                event: {
                  stream: "assistant",
                  data: {
                    phase: "start",
                  },
                },
                onAgentEvent: params.onAgentEvent,
              });
              await params.onAssistantMessageStart?.();
            },
            onToolEvent: async (payload) => {
              await emitHarnessAgentEvent({
                runId: params.runId,
                sessionKey: params.sessionKey,
                event: {
                  stream: "tool",
                  data: {
                    phase: payload.phase,
                    name: payload.toolName,
                    ...(payload.toolCallId ? { toolCallId: payload.toolCallId } : {}),
                  },
                },
                onAgentEvent: params.onAgentEvent,
              });
            },
            onPartialText: (payload) =>
              Promise.all([
                params.onPartialReply?.({
                  text: payload.text,
                  ...(payload.delta ? { delta: payload.delta } : {}),
                }),
                emitHarnessAgentEvent({
                  runId: params.runId,
                  sessionKey: params.sessionKey,
                  event: {
                    stream: "assistant",
                    data: {
                      text: payload.text,
                      ...(payload.delta ? { delta: payload.delta } : {}),
                    },
                  },
                  onAgentEvent: params.onAgentEvent,
                }),
              ]).then(() => undefined),
            onReasoningStream: (payload) =>
              Promise.all([
                params.onReasoningStream?.({
                  text: payload.text,
                  ...(payload.delta ? { delta: payload.delta } : {}),
                }),
                emitHarnessAgentEvent({
                  runId: params.runId,
                  sessionKey: params.sessionKey,
                  event: {
                    stream: "reasoning",
                    data: {
                      text: payload.text,
                      ...(payload.delta ? { delta: payload.delta } : {}),
                    },
                  },
                  onAgentEvent: params.onAgentEvent,
                }),
              ]).then(() => undefined),
            onReasoningEnd: async () => {
              await params.onReasoningEnd?.();
              await emitHarnessAgentEvent({
                runId: params.runId,
                sessionKey: params.sessionKey,
                event: {
                  stream: "reasoning",
                  data: {
                    phase: "end",
                  },
                },
                onAgentEvent: params.onAgentEvent,
              });
            },
            onBlockReply: (payload) =>
              params.onBlockReply?.({
                text: payload.text,
                ...(payload.mediaUrls ? { mediaUrls: payload.mediaUrls } : {}),
              }),
            onBlockReplyFlush: async () => {
              await params.onBlockReplyFlush?.();
            },
          }, requestContext)
        : await client.message(openCodeSessionId, requestPayload, requestContext);
    const turnEnvelope = readTurnEnvelope(response);
    const responsePayload = turnEnvelope?.response ?? response;
    const finalText =
      typeof turnEnvelope?.finalText === "string" && turnEnvelope.finalText.trim() !== ""
        ? turnEnvelope.finalText.trim()
        : extractResponseText(responsePayload);
    const reasoningText =
      typeof turnEnvelope?.reasoningText === "string" && turnEnvelope.reasoningText.trim() !== ""
        ? turnEnvelope.reasoningText.trim()
        : extractResponseReasoningText(responsePayload);
    await writeOpenCodeHarnessBinding(sessionFile, {
      openCodeSessionId,
      model: params.modelId,
      createdAt: binding?.createdAt ?? new Date().toISOString(),
    });
    opts.logger?.debug?.("completed native OpenCode turn", {
      finalTextLength: finalText.length,
      hasReasoningText: reasoningText.trim() !== "",
      openCodeSessionId,
      sessionFile,
    });
    return buildAttemptResult({
      sessionIdUsed: openCodeSessionId,
      sessionFileUsed: sessionFile,
      provider: params.provider,
      modelId: params.modelId,
      promptText,
      finalText,
      reasoningText,
      toolMetas: turnEnvelope?.toolMetas as AgentHarnessAttemptResult["toolMetas"] | undefined,
      usage: turnEnvelope?.usage,
    });
  } catch (error) {
    opts.logger?.error?.("native OpenCode turn failed", {
      error: String((error as Error)?.message ?? error),
      openCodeSessionId,
      sessionFile,
    });
    throw new Error(`OpenCode harness turn failed: ${String((error as Error)?.message ?? error)}`);
  } finally {
    if (abortListener) {
      params.abortSignal?.removeEventListener("abort", abortListener);
    }
  }
}
