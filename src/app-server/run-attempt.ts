import type {
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { classifyAgentHarnessTerminalOutcome } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveHarnessPluginConfig } from "./shared-client.js";
import { createSharedOpenCodeHarnessClient } from "./shared-client.js";
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

function buildAttemptResult(params: {
  sessionIdUsed: string;
  sessionFileUsed: string;
  promptText: string;
  finalText: string;
  reasoningText?: string;
}): AgentHarnessAttemptResult {
  const assistantTexts = params.finalText ? [params.finalText] : [];
  const assistantMessage = params.finalText
    ? ({
        role: "assistant",
        content: [{ type: "text", text: params.finalText }],
      } as AgentHarnessAttemptResult["lastAssistant"])
    : undefined;

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
    messagesSnapshot: [],
    assistantTexts,
    toolMetas: [],
    acceptedSessionSpawns: [],
    lastAssistant: assistantMessage,
    currentAttemptAssistant: assistantMessage,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
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
  opts: { pluginConfig?: unknown; openCodeClient?: import("./shared-client.js").OpenCodeHarnessClient },
): Promise<AgentHarnessAttemptResult> {
  const promptText = extractPromptText(params);
  const sessionFile = params.sessionFile;

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
    const created = await client.createSession();
    openCodeSessionId = created.id;
    await writeOpenCodeHarnessBinding(sessionFile, {
      openCodeSessionId,
      model: params.modelId,
      createdAt: new Date().toISOString(),
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
    const response =
      params.onPartialReply && client.streamMessage
        ? await client.streamMessage(openCodeSessionId, requestPayload, {
            abortSignal: params.abortSignal,
            onPartialText: (payload) =>
              params.onPartialReply?.({
                text: payload.text,
                ...(payload.delta ? { delta: payload.delta } : {}),
              }),
          })
        : await client.message(openCodeSessionId, requestPayload);
    const finalText = extractResponseText(response);
    const reasoningText = extractResponseReasoningText(response);
    await writeOpenCodeHarnessBinding(sessionFile, {
      openCodeSessionId,
      model: params.modelId,
      createdAt: binding?.createdAt ?? new Date().toISOString(),
    });
    return buildAttemptResult({
      sessionIdUsed: openCodeSessionId,
      sessionFileUsed: sessionFile,
      promptText,
      finalText,
      reasoningText,
    });
  } catch (error) {
    throw new Error(`OpenCode harness turn failed: ${String((error as Error)?.message ?? error)}`);
  } finally {
    if (abortListener) {
      params.abortSignal?.removeEventListener("abort", abortListener);
    }
  }
}
