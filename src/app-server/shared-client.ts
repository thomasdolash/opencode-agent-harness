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
      let partialText = "";
      let reasoningText = "";
      let lastReasoningText = "";
      let sawPromptActivity = false;
      let sessionError: string | undefined;
      let assistantStarted = false;
      let turnFinished = false;
      const reasoningEnabled = opts?.reasoningLevel !== "off";
      const toolMetas = new Map<string, OpenCodeHarnessTurnToolMeta>();
      let usage: OpenCodeHarnessUsage | undefined;
      const query = resolveQueryContext(context);
      const turnStartedAt = Date.now();
      const turnWaitTimeoutMs = resolveTurnWaitTimeoutMs(opts?.timeoutMs);
      let lastEventAt = turnStartedAt;

      try {
        const subscription = await client.event.subscribe({
          signal: streamAbort.signal,
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

            if (eventType === "message.updated") {
              const info = readRecord(properties.info);
              if (info?.sessionID === sessionId && info.role === "assistant") {
                const assistantMessageId = readString(info.id);
                if (assistantMessageId) {
                  knownAssistantMessageIds.add(assistantMessageId);
                  targetAssistantMessageId = assistantMessageId;
                }
                sawPromptActivity = true;
              }
              continue;
            }

            if (eventType === "message.part.updated") {
              const part = readRecord(properties.part);
              if (!part || part.sessionID !== sessionId) {
                continue;
              }

              const messageId = readString(part.messageID);
              const partType = readString(part.type);
              if (!messageId || !knownAssistantMessageIds.has(messageId)) {
                continue;
              }
              if (!targetAssistantMessageId) {
                targetAssistantMessageId = messageId;
              }
              if (messageId !== targetAssistantMessageId) {
                continue;
              }

              sawPromptActivity = true;
              const nextText = readString(part.text) ?? "";
              if (partType === "reasoning") {
                reasoningText = nextText;
                if (reasoningEnabled) {
                  const delta =
                    lastReasoningText && nextText.startsWith(lastReasoningText)
                      ? nextText.slice(lastReasoningText.length)
                      : nextText;
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

              const delta = readString(properties.delta);
              if (!nextText) {
                continue;
              }

              partialText = nextText;
              await opts?.onPartialText?.({
                text: partialText,
                ...(delta ? { delta } : {}),
              });
              continue;
            }

            if (eventType === "message.part.delta" && properties.sessionID === sessionId) {
              const field = readString(properties.field);
              const messageId = readString(properties.messageID);
              const delta = readString(properties.delta);
              if (field !== "text" || !messageId || !delta) {
                continue;
              }

              if (!knownAssistantMessageIds.has(messageId)) {
                if (knownAssistantMessageIds.size > 0) {
                  continue;
                }
                knownAssistantMessageIds.add(messageId);
              }
              if (!targetAssistantMessageId) {
                targetAssistantMessageId = messageId;
              }
              if (messageId !== targetAssistantMessageId) {
                continue;
              }

              sawPromptActivity = true;
              if (!assistantStarted) {
                assistantStarted = true;
                await opts?.onAssistantMessageStart?.();
              }
              partialText += delta;
              await opts?.onPartialText?.({
                text: partialText,
                delta,
              });
              continue;
            }

            if (eventType === "session.next.text.started" && properties.sessionID === sessionId) {
              targetAssistantMessageId =
                readString(properties.assistantMessageID) ?? targetAssistantMessageId;
              sawPromptActivity = true;
              if (!assistantStarted) {
                assistantStarted = true;
                await opts?.onAssistantMessageStart?.();
              }
              continue;
            }

            if (eventType === "session.next.text.delta" && properties.sessionID === sessionId) {
              targetAssistantMessageId =
                readString(properties.assistantMessageID) ?? targetAssistantMessageId;
              sawPromptActivity = true;
              const delta = readString(properties.delta);
              if (!delta) {
                continue;
              }
              partialText += delta;
              await opts?.onPartialText?.({
                text: partialText,
                delta,
              });
              continue;
            }

            if (eventType === "session.next.text.ended" && properties.sessionID === sessionId) {
              targetAssistantMessageId =
                readString(properties.assistantMessageID) ?? targetAssistantMessageId;
              sawPromptActivity = true;
              const text = readString(properties.text);
              if (!text) {
                continue;
              }
              partialText = text;
              await opts?.onPartialText?.({
                text: partialText,
              });
              continue;
            }

            if (eventType === "session.next.reasoning.delta" && properties.sessionID === sessionId) {
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

            if (eventType === "session.next.reasoning.ended" && properties.sessionID === sessionId) {
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

            if (eventType === "session.next.tool.called" && properties.sessionID === sessionId) {
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

            if (eventType === "session.next.tool.progress" && properties.sessionID === sessionId) {
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

            if (eventType === "session.next.tool.success" && properties.sessionID === sessionId) {
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

            if (eventType === "session.next.tool.failed" && properties.sessionID === sessionId) {
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

            if (eventType === "session.next.step.ended" && properties.sessionID === sessionId) {
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

            if (eventType === "session.error" && properties.sessionID === sessionId) {
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
              ((eventType === "session.idle" && properties.sessionID === sessionId) ||
                (eventType === "session.status" &&
                  properties.sessionID === sessionId &&
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
          void consumeEvents.catch(() => undefined);
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
