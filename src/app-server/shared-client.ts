import {
  parseOpenCodeAgentHarnessPluginConfig,
  type OpenCodeAgentHarnessPluginConfig,
} from "../config.js";
import type { OpenCodeHarnessLogger } from "../logger.js";

type OpenCodeManagedServer = {
  url: string;
  close: () => void;
};

export type OpenCodeHarnessRequestContext = {
  directory?: string;
  workspace?: string;
};

export type OpenCodeHarnessTurnToolMeta = {
  toolName: string;
  meta?: string;
};

export type OpenCodeHarnessUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoningTokens?: number;
  total?: number;
};

export type OpenCodeHarnessTurnResult = {
  response: unknown;
  assistantMessageId?: string;
  finalText?: string;
  reasoningText?: string;
  toolMetas?: OpenCodeHarnessTurnToolMeta[];
  usage?: OpenCodeHarnessUsage;
};

export type OpenCodeHarnessClient = {
  createSession: (payload?: unknown, context?: OpenCodeHarnessRequestContext) => Promise<{ id: string }>;
  message: (
    sessionId: string,
    payload: unknown,
    context?: OpenCodeHarnessRequestContext,
  ) => Promise<unknown>;
  streamMessage?: (
    sessionId: string,
    payload: unknown,
    opts?: {
      abortSignal?: AbortSignal;
      timeoutMs?: number;
      reasoningLevel?: "off" | "on" | "stream" | string;
      logger?: OpenCodeHarnessLogger;
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
    context?: OpenCodeHarnessRequestContext,
  ) => Promise<unknown>;
  checkHealth: () => Promise<unknown>;
  abort?: (sessionId: string) => Promise<void>;
  close?: () => Promise<void> | void;
};

let sharedClient: OpenCodeHarnessClient | undefined;
let sharedManagedServer: OpenCodeManagedServer | undefined;

function resolveBaseUrl(opts: { pluginConfig?: unknown }): string {
  const pluginConfig = opts.pluginConfig
    ? parseOpenCodeAgentHarnessPluginConfig(opts.pluginConfig)
    : undefined;
  if (pluginConfig?.server.mode === "remote") {
    return pluginConfig.server.baseUrl!;
  }
  const baseUrl = process.env.OPENCODE_SERVER_BASE_URL?.trim() ?? "";
  if (!baseUrl) {
    throw new Error(
      "OpenCode server baseUrl is required for remote mode. Configure plugins.entries.opencode-agent-harness.config.server.baseUrl.",
    );
  }
  return baseUrl;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readSessionId(value: unknown): string | undefined {
  const record = readRecord(value);
  return readString(record?.sessionID) ?? readString(record?.sessionId) ?? readString(record?.session_id);
}

function readMessageId(value: unknown): string | undefined {
  const record = readRecord(value);
  return readString(record?.messageID) ?? readString(record?.messageId) ?? readString(record?.message_id) ?? readString(record?.id);
}

function readAssistantMessageId(value: unknown): string | undefined {
  const record = readRecord(value);
  return readString(record?.assistantMessageID) ?? readString(record?.assistantMessageId) ?? readString(record?.assistant_message_id);
}

function resolvePartialDelta(previousText: string, nextText: string, explicitDelta: string | undefined): string | undefined {
  if (explicitDelta) {
    return explicitDelta;
  }
  if (previousText && nextText.startsWith(previousText)) {
    return nextText.slice(previousText.length) || undefined;
  }
  return undefined;
}

function resolveNextPartialText(previousText: string, nextText: string, explicitDelta: string | undefined): string | undefined {
  if (!nextText) {
    if (!explicitDelta) {
      return undefined;
    }
    return `${previousText}${explicitDelta}`;
  }
  if (nextText === previousText) {
    return undefined;
  }
  return nextText;
}

function resolveQueryContext(
  context: OpenCodeHarnessRequestContext | undefined,
): Record<string, string> | undefined {
  const directory = readString(context?.directory);
  const workspace = readString(context?.workspace);
  if (!directory && !workspace) {
    return undefined;
  }
  return {
    ...(directory ? { directory } : {}),
    ...(workspace ? { workspace } : {}),
  };
}

async function subscribeToOpenCodeEvents(
  client: any,
  params: {
    signal: AbortSignal;
    query?: Record<string, string>;
  },
): Promise<{ stream: AsyncIterable<unknown> }> {
  const subscribe = client?.event?.subscribe;
  if (typeof subscribe === "function") {
    const urlParams = params.query
      ? { directory: params.query.directory, workspace: params.query.workspace }
      : undefined;
    return await subscribe.call(client.event, urlParams ? { query: urlParams, signal: params.signal } : { signal: params.signal });
  }

  const globalEvent = client?.global?.event;
  if (typeof globalEvent === "function") {
    return await globalEvent.call(client.global, {
      signal: params.signal,
    });
  }

  throw new Error("OpenCode SDK does not expose a supported event subscription method");
}

function unwrapSdkData<T = unknown>(value: T): unknown {
  const record = readRecord(value);
  if (record && "data" in record && record.data !== undefined) {
    return record.data;
  }
  return value;
}

function unwrapSdkEvent(value: unknown): unknown {
  const record = readRecord(value);
  if (record && "payload" in record && record.payload !== undefined) {
    return record.payload;
  }
  return value;
}

function readSessionIdentifier(value: unknown): string | undefined {
  const record = readRecord(unwrapSdkData(value));
  return readString(record?.id) ?? readString(record?.sessionId) ?? readString(readRecord(record?.session)?.id);
}

function readCreatedTimestamp(entry: unknown): number {
  const created = readRecord(readRecord(entry)?.info)?.time;
  const raw = readRecord(created)?.created;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

function selectLatestAssistantMessage(
  messages: unknown,
  preferredMessageId?: string,
  earliestCreatedAt?: number,
): unknown {
  if (!Array.isArray(messages)) {
    return undefined;
  }

  const assistantMessages = messages.filter((entry) => {
    const info = readRecord(readRecord(entry)?.info);
    if (info?.role !== "assistant") {
      return false;
    }
    if (typeof earliestCreatedAt === "number" && earliestCreatedAt > 0) {
      return readCreatedTimestamp(entry) >= earliestCreatedAt;
    }
    return true;
  });
  if (assistantMessages.length === 0) {
    return undefined;
  }

  if (preferredMessageId) {
    const exact = assistantMessages.find((entry) => readRecord(readRecord(entry)?.info)?.id === preferredMessageId);
    if (exact) {
      return exact;
    }
  }

  return assistantMessages
    .slice()
    .sort((left, right) => {
      return readCreatedTimestamp(right) - readCreatedTimestamp(left);
    })[0];
}

function extractAssistantText(response: unknown): string {
  if (typeof response === "string") {
    return response.trim();
  }
  if (!response || typeof response !== "object") {
    return "";
  }

  const record = response as Record<string, unknown>;
  const candidates = [record.text, record.output, record.message, record.assistant];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate.trim();
    }
  }

  const parts = [
    ...(Array.isArray(record.parts) ? record.parts : []),
    ...(Array.isArray((record.body as Record<string, unknown> | undefined)?.parts)
      ? ((record.body as Record<string, unknown> | undefined)?.parts as unknown[])
      : []),
    ...(Array.isArray((record.data as Record<string, unknown> | undefined)?.parts)
      ? ((record.data as Record<string, unknown> | undefined)?.parts as unknown[])
      : []),
  ];
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
    .join("\n")
    .trim();
}

function hasCompletedAssistantState(message: unknown): boolean {
  const info = readRecord(readRecord(message)?.info);
  const time = readRecord(info?.time);
  return Boolean(
    readNumber(time?.completed) ||
      readString(info?.finish) ||
      readRecord(info?.error),
  );
}

function resolveTurnWaitTimeoutMs(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return 60_000;
  }
  return timeoutMs;
}

function isStreamDebugEnabled(): boolean {
  const level = process.env.OPENCLAW_LOG_LEVEL?.trim().toLowerCase();
  return level === "debug" || level === "trace";
}

function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { name?: unknown; code?: unknown; message?: unknown };
  const name = typeof record.name === "string" ? record.name : "";
  const code = typeof record.code === "string" ? record.code : "";
  const message = typeof record.message === "string" ? record.message : "";
  return (
    name === "AbortError" ||
    code === "ABORT_ERR" ||
    message.includes("aborted") ||
    message.includes("AbortError")
  );
}

async function waitForAssistantMessage(params: {
  fetchMessages: () => Promise<unknown>;
  preferredMessageId?: string;
  partialText?: string;
  earliestCreatedAt?: number;
  isTurnFinished?: () => boolean;
  timeoutMs?: number;
}): Promise<unknown> {
  const timeoutMs = params.timeoutMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  let lastMessages: unknown;
  let lastAssistant: unknown;
  while (Date.now() < deadline) {
    lastMessages = await params.fetchMessages();
    const latest = selectLatestAssistantMessage(
      lastMessages,
      params.preferredMessageId,
      params.earliestCreatedAt,
    );
    if (latest) {
      lastAssistant = latest;
    }
    if (latest && extractAssistantText(latest) !== "") {
      return latest;
    }
    if (latest && params.isTurnFinished?.()) {
      return latest;
    }
    if (params.partialText && params.partialText.trim() !== "" && params.isTurnFinished?.()) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const fallbackAssistant =
    lastAssistant ??
    selectLatestAssistantMessage(lastMessages, params.preferredMessageId, params.earliestCreatedAt);
  if (fallbackAssistant && hasCompletedAssistantState(fallbackAssistant)) {
    return fallbackAssistant;
  }
  return fallbackAssistant ?? {
    parts: params.partialText ? [{ type: "text", text: params.partialText }] : [],
  };
}

async function waitForTurnStreamToSettle(params: {
  isTurnFinished: () => boolean;
  getLastEventAt: () => number;
  quietWindowMs?: number;
  timeoutMs?: number;
}): Promise<void> {
  const quietWindowMs = params.quietWindowMs ?? 150;
  const timeoutMs = params.timeoutMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (params.isTurnFinished()) {
      return;
    }
    if (Date.now() - params.getLastEventAt() >= quietWindowMs) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export function resolveHarnessPluginConfig(
  pluginConfig: unknown,
): OpenCodeAgentHarnessPluginConfig | undefined {
  return pluginConfig ? parseOpenCodeAgentHarnessPluginConfig(pluginConfig) : undefined;
}

export async function createSharedOpenCodeHarnessClient(opts: {
  pluginConfig?: unknown;
  openCodeClient?: OpenCodeHarnessClient;
  logger?: OpenCodeHarnessLogger;
  managedServerFactory?: (config: OpenCodeAgentHarnessPluginConfig) => Promise<OpenCodeManagedServer>;
  sdkClientFactory?: (baseUrl: string) => Promise<unknown> | unknown;
}): Promise<OpenCodeHarnessClient> {
  if (opts.openCodeClient) {
    return opts.openCodeClient;
  }

  if (sharedClient) {
    opts.logger?.debug?.("reusing shared OpenCode client");
    return sharedClient;
  }

  const pluginConfig = resolveHarnessPluginConfig(opts.pluginConfig) ?? {
    server: {
      mode: "managed" as const,
    },
  };
  const baseUrl =
    pluginConfig.server.mode === "managed"
      ? await ensureManagedOpenCodeServer(pluginConfig, opts.managedServerFactory)
      : resolveBaseUrl({ pluginConfig });
  opts.logger?.debug?.("initializing OpenCode client", {
    mode: pluginConfig.server.mode,
    baseUrl,
  });
  const client = await createSdkClient(baseUrl, opts.sdkClientFactory);

  sharedClient = {
    async createSession(payload?: unknown, context?: OpenCodeHarnessRequestContext) {
      const body = payload ?? {};
      const query = resolveQueryContext(context);
      if (typeof client?.createSession === "function") {
        const id = readSessionIdentifier(await client.createSession(body));
        if (typeof id === "string" && id.trim() !== "") {
          return { id };
        }
      }
      if (typeof client?.session?.create === "function") {
        const id = readSessionIdentifier(await client.session.create({
          body: body as Record<string, unknown>,
          ...(query ? { query } : {}),
        }));
        if (typeof id === "string" && id.trim() !== "") {
          return { id };
        }
      }
      if (typeof client?.sessions?.create === "function") {
        const id = readSessionIdentifier(await client.sessions.create(body, query));
        if (typeof id === "string" && id.trim() !== "") {
          return { id };
        }
      }
      throw new Error("OpenCode SDK did not return a usable session id");
    },
    async message(sessionId: string, payload: unknown, context?: OpenCodeHarnessRequestContext) {
      const query = resolveQueryContext(context);
      if (typeof client?.session?.prompt === "function") {
        return unwrapSdkData(await client.session.prompt({
          path: { id: sessionId },
          body: payload as Record<string, unknown>,
          ...(query ? { query } : {}),
        }));
      }
      if (typeof client?.sendMessage === "function") {
        return unwrapSdkData(await client.sendMessage(sessionId, payload));
      }
      if (typeof client?.sessions?.message === "function") {
        return unwrapSdkData(await client.sessions.message(sessionId, payload));
      }
      if (typeof client?.session?.message === "function") {
        return unwrapSdkData(await client.session.message(sessionId, payload));
      }
      if (typeof client?.message === "function") {
        return unwrapSdkData(await client.message({ sessionId, ...(payload as Record<string, unknown>) }));
      }
      throw new Error("OpenCode SDK does not expose a supported message method");
    },
    async streamMessage(
      sessionId: string,
      payload: unknown,
      opts,
      context?: OpenCodeHarnessRequestContext,
    ) {
      if (
        typeof client?.event?.subscribe !== "function" ||
        typeof client?.session?.promptAsync !== "function" ||
        typeof client?.session?.messages !== "function"
      ) {
        return this.message(sessionId, payload, context);
      }

      const streamAbort = new AbortController();
      const externalAbort = opts?.abortSignal;
      const onExternalAbort = () => {
        streamAbort.abort(externalAbort?.reason);
      };
      if (externalAbort) {
        if (externalAbort.aborted) {
          onExternalAbort();
        } else {
          externalAbort.addEventListener("abort", onExternalAbort, { once: true });
        }
      }

      let targetAssistantMessageId: string | undefined;
      const knownAssistantMessageIds = new Set<string>();
      const knownUserMessageIds = new Set<string>();
      let partialText = "";
      let reasoningText = "";
      const streamDebug = isStreamDebugEnabled();

      const debugStreamEvent = (message: string, meta?: Record<string, unknown>) => {
        if (!streamDebug) {
          return;
        }
        opts?.logger?.debug?.(message, {
          sessionId,
          ...(meta ?? {}),
        });
      };

      const noteAssistantMessageId = (messageId: string | undefined): string | undefined => {
        if (!messageId) {
          return undefined;
        }
        knownAssistantMessageIds.add(messageId);
        const previousTarget = targetAssistantMessageId;
        targetAssistantMessageId ??= messageId;
        debugStreamEvent('observed assistant message id', {
          messageId,
          previousTargetAssistantMessageId: previousTarget,
          targetAssistantMessageId,
          knownAssistantMessageCount: knownAssistantMessageIds.size,
        });
        return messageId;
      };

      const emitAssistantStart = () => {
        if (assistantStarted) {
          debugStreamEvent('skipping assistant start', {
            reason: 'already-started',
          });
          return;
        }
        assistantStarted = true;
        debugStreamEvent('emitting assistant start', {
          targetAssistantMessageId,
        });
        opts?.onAssistantMessageStart?.();
      };

      const emitAssistantPartial = (nextText: string, explicitDelta?: string) => {
        const previousText = partialText;
        const resolvedText = resolveNextPartialText(partialText, nextText, explicitDelta);
        if (!resolvedText) {
          debugStreamEvent('skipping assistant partial', {
            reason: 'no-resolved-text',
            previousLength: previousText.length,
            nextLength: nextText.length,
            explicitDeltaLength: explicitDelta?.length ?? 0,
          });
          return;
        }
        if (previousText && resolvedText.length < previousText.length) {
          debugStreamEvent('skipping regression', {
            reason: 'text-shrunk',
            previousLength: previousText.length,
            resolvedLength: resolvedText.length,
          });
          return;
        }
        const resolvedDelta = resolvePartialDelta(partialText, resolvedText, explicitDelta);
        partialText = resolvedText;
        debugStreamEvent('emitting assistant partial', {
          previousLength: previousText.length,
          nextLength: nextText.length,
          resolvedLength: resolvedText.length,
          explicitDeltaLength: explicitDelta?.length ?? 0,
          resolvedDeltaLength: resolvedDelta?.length ?? 0,
          targetAssistantMessageId,
        });
        if (!assistantStarted) {
          assistantStarted = true;
          opts?.onAssistantMessageStart?.();
        }
        opts?.onPartialText?.({
          text: partialText,
          ...(resolvedDelta ? { delta: resolvedDelta } : {}),
        });
      };
      let lastReasoningText = "";
      let sawPromptActivity = false;
      let sessionError: string | undefined;
      let assistantStarted = false;
      let turnFinished = false;
      const reasoningEnabled = opts?.reasoningLevel !== "off";
      const toolMetas = new Map<string, OpenCodeHarnessTurnToolMeta>();
      let usage: OpenCodeHarnessUsage | undefined;
      const query = resolveQueryContext(context);
      debugStreamEvent('event subscription location', { query });
      const turnStartedAt = Date.now();
      const turnWaitTimeoutMs = resolveTurnWaitTimeoutMs(opts?.timeoutMs);
      let lastEventAt = turnStartedAt;

      try {
        const subscription = await subscribeToOpenCodeEvents(client, {
          signal: streamAbort.signal,
          query,
        });

        const consumeEvents = (async () => {
          for await (const event of subscription.stream) {
            const record = readRecord(unwrapSdkEvent(event));
            if (!record) {
              continue;
            }

            const eventType = readString(record.type);
            const properties = readRecord(record.properties);
            if (!eventType || !properties) {
              continue;
            }
            lastEventAt = Date.now();
            debugStreamEvent('received OpenCode event', {
              eventType,
            });

            if (eventType === "message.updated") {
              const info = readRecord(properties.info);
              if (readSessionId(info) !== sessionId) {
                continue;
              }
              if (info?.role === "assistant") {
                noteAssistantMessageId(readMessageId(info));
                sawPromptActivity = true;
              } else {
                const messageId = readMessageId(info);
                if (messageId) {
                  knownUserMessageIds.add(messageId);
                }
              }
              continue;
            }

            if (eventType === "message.part.updated") {
              const part = readRecord(properties.part);
              if (!part || readSessionId(part) !== sessionId) {
                continue;
              }

              const messageId = readMessageId(part);
              const partType = readString(part.type);
              if (!messageId) {
                debugStreamEvent('skipping message.part.updated', {
                  reason: 'missing-message-id',
                  partType,
                });
                continue;
              }
              if (knownUserMessageIds.has(messageId)) {
                debugStreamEvent('skipping user message.part.updated', {
                  messageId,
                  partType,
                });
                continue;
              }
              if (!knownAssistantMessageIds.has(messageId)) {
                if (knownAssistantMessageIds.size > 0) {
                  debugStreamEvent('skipping message.part.updated', {
                    reason: 'unknown-assistant-message-id',
                    messageId,
                    partType,
                    knownAssistantMessageCount: knownAssistantMessageIds.size,
                  });
                  continue;
                }
                noteAssistantMessageId(messageId);
              }
              targetAssistantMessageId ??= messageId;
              if (messageId !== targetAssistantMessageId) {
                debugStreamEvent('skipping message.part.updated', {
                  reason: 'non-target-assistant-message-id',
                  messageId,
                  targetAssistantMessageId,
                  partType,
                });
                continue;
              }

              sawPromptActivity = true;
              const nextText = readString(part.text) ?? "";
              if (partType === "reasoning") {
                reasoningText = nextText;
                if (reasoningEnabled) {
                  const delta = resolvePartialDelta(lastReasoningText, nextText, readString(properties.delta));
                  lastReasoningText = nextText;
                  await opts?.onReasoningStream?.({
                    text: reasoningText,
                    ...(delta ? { delta } : {}),
                  });
                }
                continue;
              }
              if (partType !== "text") {
                continue;
              }

              emitAssistantPartial(nextText, readString(properties.delta));
              continue;
            }

            if (eventType === "message.part.delta" && readSessionId(properties) === sessionId) {
              const field = readString(properties.field);
              const messageId = readMessageId(properties);
              const delta = readString(properties.delta);
              if (field !== "text" || !messageId || !delta) {
                continue;
              }

              if (!knownAssistantMessageIds.has(messageId)) {
                if (knownAssistantMessageIds.size > 0) {
                  debugStreamEvent('skipping message.part.delta', {
                    reason: 'unknown-assistant-message-id',
                    messageId,
                    targetAssistantMessageId,
                    knownAssistantMessageCount: knownAssistantMessageIds.size,
                  });
                  continue;
                }
                noteAssistantMessageId(messageId);
              }
              if (messageId !== targetAssistantMessageId) {
                debugStreamEvent('skipping message.part.delta', {
                  reason: 'non-target-assistant-message-id',
                  messageId,
                  targetAssistantMessageId,
                });
                continue;
              }

              sawPromptActivity = true;
              debugStreamEvent('accepting message.part.delta', {
                messageId,
                deltaLength: delta.length,
                partialLengthBefore: partialText.length,
              });
              emitAssistantPartial(`${partialText}${delta}`, delta);
              continue;
            }

            if (eventType === "session.next.text.started" && readSessionId(properties) === sessionId) {
              noteAssistantMessageId(readAssistantMessageId(properties));
              sawPromptActivity = true;
              emitAssistantStart();
              continue;
            }

            if (eventType === "session.next.text.delta" && readSessionId(properties) === sessionId) {
              noteAssistantMessageId(readAssistantMessageId(properties));
              sawPromptActivity = true;
              const delta = readString(properties.delta);
              if (!delta) {
                debugStreamEvent('skipping session.next.text.delta', {
                  reason: 'missing-delta',
                });
                continue;
              }
              debugStreamEvent('accepting session.next.text.delta', {
                deltaLength: delta.length,
                partialLengthBefore: partialText.length,
              });
              emitAssistantPartial(`${partialText}${delta}`, delta);
              continue;
            }

            if (eventType === "session.next.text.ended" && readSessionId(properties) === sessionId) {
              noteAssistantMessageId(readAssistantMessageId(properties));
              sawPromptActivity = true;
              const text = readString(properties.text);
              if (!text) {
                debugStreamEvent('skipping session.next.text.ended', {
                  reason: 'missing-text',
                });
                continue;
              }
              debugStreamEvent('accepting session.next.text.ended', {
                textLength: text.length,
              });
              emitAssistantPartial(text);
              continue;
            }

            if (eventType === "session.next.reasoning.delta" && readSessionId(properties) === sessionId) {
              const delta = readString(properties.delta);
              if (!delta) {
                continue;
              }
              sawPromptActivity = true;
              reasoningText += delta;
              if (reasoningEnabled) {
                await opts?.onReasoningStream?.({
                  text: reasoningText,
                  delta,
                });
              }
              continue;
            }

            if (eventType === "session.next.reasoning.ended" && readSessionId(properties) === sessionId) {
              const text = readString(properties.text);
              if (!text) {
                continue;
              }
              sawPromptActivity = true;
              reasoningText = text;
              if (reasoningEnabled) {
                lastReasoningText = text;
                await opts?.onReasoningStream?.({
                  text: reasoningText,
                });
                await opts?.onReasoningEnd?.();
              }
              continue;
            }

            if (eventType === "session.next.tool.called" && readSessionId(properties) === sessionId) {
              const toolCallId = readString(properties.callID) ?? "";
              const toolName = readString(properties.tool);
              if (!toolName) {
                continue;
              }
              sawPromptActivity = true;
              await opts?.onBlockReplyFlush?.();
              toolMetas.set(toolCallId, { toolName });
              await opts?.onToolEvent?.({
                phase: "started",
                toolName,
                ...(toolCallId ? { toolCallId } : {}),
              });
              continue;
            }

            if (eventType === "session.next.tool.progress" && readSessionId(properties) === sessionId) {
              const toolCallId = readString(properties.callID) ?? "";
              const toolName = toolMetas.get(toolCallId)?.toolName;
              if (!toolName) {
                continue;
              }
              sawPromptActivity = true;
              await opts?.onToolEvent?.({
                phase: "progress",
                toolName,
                ...(toolCallId ? { toolCallId } : {}),
              });
              continue;
            }

            if (eventType === "session.next.tool.success" && readSessionId(properties) === sessionId) {
              const toolCallId = readString(properties.callID) ?? "";
              const toolName = toolMetas.get(toolCallId)?.toolName;
              if (!toolName) {
                continue;
              }
              sawPromptActivity = true;
              await opts?.onToolEvent?.({
                phase: "completed",
                toolName,
                ...(toolCallId ? { toolCallId } : {}),
              });
              continue;
            }

            if (eventType === "session.next.tool.failed" && readSessionId(properties) === sessionId) {
              const toolCallId = readString(properties.callID) ?? "";
              const toolName = toolMetas.get(toolCallId)?.toolName;
              if (!toolName) {
                continue;
              }
              sawPromptActivity = true;
              await opts?.onToolEvent?.({
                phase: "failed",
                toolName,
                ...(toolCallId ? { toolCallId } : {}),
              });
              continue;
            }

            if (eventType === "session.next.step.ended" && readSessionId(properties) === sessionId) {
              const tokens = readRecord(properties.tokens);
              if (tokens) {
                usage = {
                  input: readNumber(tokens.input),
                  output: readNumber(tokens.output),
                  reasoningTokens: readNumber(tokens.reasoning),
                  cacheRead: readNumber(readRecord(tokens.cache)?.read),
                  cacheWrite: readNumber(readRecord(tokens.cache)?.write),
                  total:
                    (readNumber(tokens.input) ?? 0) +
                    (readNumber(tokens.output) ?? 0) +
                  (readNumber(tokens.reasoning) ?? 0),
                };
              }
              sawPromptActivity = true;
              await opts?.onBlockReplyFlush?.();
              turnFinished = true;
              break;
            }

            if (eventType === "session.error" && readSessionId(properties) === sessionId) {
              const errorMessage =
                readString(readRecord(properties.error)?.message) ??
                readString(readRecord(readRecord(properties.error)?.data)?.message) ??
                "unknown OpenCode session error";
              sessionError = errorMessage;
              sawPromptActivity = true;
              await opts?.onBlockReplyFlush?.();
              turnFinished = true;
              break;
            }

            if (
              sawPromptActivity &&
              ((eventType === "session.idle" && readSessionId(properties) === sessionId) ||
                (eventType === "session.status" &&
                  readSessionId(properties) === sessionId &&
                  readRecord(properties.status)?.type === "idle"))
            ) {
              await opts?.onBlockReplyFlush?.();
              turnFinished = true;
              break;
            }
          }
        })();

        await client.session.promptAsync({
          path: { id: sessionId },
          body: payload as Record<string, unknown>,
          ...(query ? { query } : {}),
        });

        const pollForTextGrowth = (async () => {
          const pollIntervalMs = 200;
          let lastPolledText = "";
          while (!turnFinished && !streamAbort.signal.aborted) {
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
            if (turnFinished) break;
            try {
              const messages = unwrapSdkData(await client.session.messages({
                path: { id: sessionId },
                query: {
                  limit: 5,
                  ...(query ?? {}),
                },
              }));
              const latest = selectLatestAssistantMessage(messages, targetAssistantMessageId, turnStartedAt);
              const latestText = extractAssistantText(latest);
              if (latestText && latestText.length > lastPolledText.length) {
                lastPolledText = latestText;
                emitAssistantPartial(latestText);
              }
            } catch {
              // best-effort polling, ignore errors
            }
          }
        })();

        const response = await waitForAssistantMessage({
          fetchMessages: async () =>
            unwrapSdkData(await client.session.messages({
              path: { id: sessionId },
              query: {
                limit: 10,
                ...(query ?? {}),
              },
            })),
          preferredMessageId: targetAssistantMessageId,
          partialText,
          earliestCreatedAt: turnStartedAt,
          isTurnFinished: () => turnFinished,
          timeoutMs: turnWaitTimeoutMs,
        });

        if (!turnFinished) {
          await waitForTurnStreamToSettle({
            isTurnFinished: () => turnFinished,
            getLastEventAt: () => lastEventAt,
          });
          streamAbort.abort();
          void consumeEvents.catch((err) => {
            opts?.logger?.error?.("stream consume error after turn finished", {
              error: String(err),
            });
          });
          void pollForTextGrowth.catch(() => undefined);
        } else {
          try {
            await consumeEvents;
          } catch (error) {
            if (!isAbortLikeError(error) && !streamAbort.signal.aborted) {
              throw error;
            }
          }
        }

        if (sessionError) {
          throw new Error(sessionError);
        }

        const finalText = extractAssistantText(response) || partialText;
        return {
          response,
          ...(targetAssistantMessageId ? { assistantMessageId: targetAssistantMessageId } : {}),
          ...(finalText ? { finalText } : {}),
          ...(reasoningText ? { reasoningText } : {}),
          ...(toolMetas.size > 0 ? { toolMetas: [...toolMetas.values()] } : {}),
          ...(usage ? { usage } : {}),
        } satisfies OpenCodeHarnessTurnResult;
      } finally {
        streamAbort.abort();
        externalAbort?.removeEventListener("abort", onExternalAbort);
      }
    },
    async checkHealth() {
      if (typeof client?.health === "function") {
        return unwrapSdkData(await client.health());
      }
      if (typeof client?.global?.health === "function") {
        return unwrapSdkData(await client.global.health());
      }
      const response = await fetch(new URL("/global/health", baseUrl).toString());
      if (!response.ok) {
        throw new Error(`OpenCode health check failed: ${response.status} ${response.statusText}`);
      }
      return response.json().catch(() => ({ ok: true }));
    },
    async abort(sessionId: string) {
      if (typeof client?.sessions?.abort === "function") {
        await client.sessions.abort(sessionId);
        return;
      }
      if (typeof client?.session?.abort === "function") {
        await client.session.abort(sessionId);
      }
    },
    async close() {
      if (typeof client?.close === "function") {
        await client.close();
      }
    },
  };

  return sharedClient;
}

async function createSdkClient(
  baseUrl: string,
  sdkClientFactory?: (baseUrl: string) => Promise<unknown> | unknown,
): Promise<any> {
  if (sdkClientFactory) {
    return await sdkClientFactory(baseUrl);
  }
  const sdk = (await import("@opencode-ai/sdk")) as any;
  const factory = sdk.createOpencodeClient ?? sdk.createClient ?? sdk.default ?? sdk;
  return typeof factory === "function" ? factory({ baseUrl, responseStyle: "data" }) : factory;
}

export async function clearSharedOpenCodeHarnessClientAndWait(): Promise<void> {
  try {
    await sharedClient?.close?.();
    sharedManagedServer?.close();
  } finally {
    sharedClient = undefined;
    sharedManagedServer = undefined;
  }
}

async function ensureManagedOpenCodeServer(
  pluginConfig: OpenCodeAgentHarnessPluginConfig,
  managedServerFactory?: (config: OpenCodeAgentHarnessPluginConfig) => Promise<OpenCodeManagedServer>,
): Promise<string> {
  if (sharedManagedServer) {
    return sharedManagedServer.url;
  }

  const createManagedServer =
    managedServerFactory ??
    (async (config: OpenCodeAgentHarnessPluginConfig) => {
      const sdk = await import("@opencode-ai/sdk/server");
      return sdk.createOpencodeServer({
        ...(config.server.hostname ? { hostname: config.server.hostname } : {}),
        ...(config.server.port ? { port: config.server.port } : {}),
        ...(config.server.timeoutMs ? { timeout: config.server.timeoutMs } : {}),
      });
    });

  sharedManagedServer = await createManagedServer(pluginConfig);
  return sharedManagedServer.url;
}
