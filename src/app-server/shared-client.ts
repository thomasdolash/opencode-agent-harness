import {
  parseOpenCodeAgentHarnessPluginConfig,
  type OpenCodeAgentHarnessPluginConfig,
} from "../config.js";

type OpenCodeManagedServer = {
  url: string;
  close: () => void;
};

export type OpenCodeHarnessClient = {
  createSession: (payload?: unknown) => Promise<{ id: string }>;
  message: (sessionId: string, payload: unknown) => Promise<unknown>;
  streamMessage?: (
    sessionId: string,
    payload: unknown,
    opts?: {
      abortSignal?: AbortSignal;
      onPartialText?: (payload: { text: string; delta?: string }) => void | Promise<void>;
    },
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

function unwrapSdkData<T = unknown>(value: T): unknown {
  const record = readRecord(value);
  if (record && "data" in record && record.data !== undefined) {
    return record.data;
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

function selectLatestAssistantMessage(messages: unknown, preferredMessageId?: string): unknown {
  if (!Array.isArray(messages)) {
    return undefined;
  }

  const assistantMessages = messages.filter((entry) => {
    const info = readRecord(readRecord(entry)?.info);
    return info?.role === "assistant";
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

export function resolveHarnessPluginConfig(
  pluginConfig: unknown,
): OpenCodeAgentHarnessPluginConfig | undefined {
  return pluginConfig ? parseOpenCodeAgentHarnessPluginConfig(pluginConfig) : undefined;
}

export async function createSharedOpenCodeHarnessClient(opts: {
  pluginConfig?: unknown;
  openCodeClient?: OpenCodeHarnessClient;
  managedServerFactory?: (config: OpenCodeAgentHarnessPluginConfig) => Promise<OpenCodeManagedServer>;
  sdkClientFactory?: (baseUrl: string) => Promise<unknown> | unknown;
}): Promise<OpenCodeHarnessClient> {
  if (opts.openCodeClient) {
    return opts.openCodeClient;
  }

  if (sharedClient) {
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
  const client = await createSdkClient(baseUrl, opts.sdkClientFactory);

  sharedClient = {
    async createSession(payload?: unknown) {
      const body = payload ?? {};
      if (typeof client?.createSession === "function") {
        const id = readSessionIdentifier(await client.createSession(body));
        if (typeof id === "string" && id.trim() !== "") {
          return { id };
        }
      }
      if (typeof client?.session?.create === "function") {
        const id = readSessionIdentifier(await client.session.create({
          body: body as Record<string, unknown>,
        }));
        if (typeof id === "string" && id.trim() !== "") {
          return { id };
        }
      }
      if (typeof client?.sessions?.create === "function") {
        const id = readSessionIdentifier(await client.sessions.create(body));
        if (typeof id === "string" && id.trim() !== "") {
          return { id };
        }
      }
      throw new Error("OpenCode SDK did not return a usable session id");
    },
    async message(sessionId: string, payload: unknown) {
      if (typeof client?.session?.prompt === "function") {
        return unwrapSdkData(await client.session.prompt({
          path: { id: sessionId },
          body: payload as Record<string, unknown>,
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
    async streamMessage(sessionId: string, payload: unknown, opts) {
      if (
        typeof client?.event?.subscribe !== "function" ||
        typeof client?.session?.promptAsync !== "function" ||
        typeof client?.session?.messages !== "function"
      ) {
        return this.message(sessionId, payload);
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
      let partialText = "";
      let sawPromptActivity = false;
      let sessionError: string | undefined;

      try {
        const subscription = await client.event.subscribe({
          signal: streamAbort.signal,
        });

        const consumeEvents = (async () => {
          for await (const event of subscription.stream) {
            const record = readRecord(event);
            if (!record) {
              continue;
            }

            const eventType = readString(record.type);
            const properties = readRecord(record.properties);
            if (!eventType || !properties) {
              continue;
            }

            if (eventType === "message.updated") {
              const info = readRecord(properties.info);
              if (info?.sessionID === sessionId && info.role === "assistant") {
                targetAssistantMessageId = readString(info.id) ?? targetAssistantMessageId;
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
              if (!targetAssistantMessageId && messageId && (partType === "text" || partType === "reasoning")) {
                targetAssistantMessageId = messageId;
              }
              if (!messageId || !targetAssistantMessageId || messageId !== targetAssistantMessageId) {
                continue;
              }

              sawPromptActivity = true;
              if (partType !== "text") {
                continue;
              }

              const delta = readString(properties.delta);
              const nextText = readString(part.text) ?? "";
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

            if (eventType === "session.error" && properties.sessionID === sessionId) {
              const errorMessage =
                readString(readRecord(properties.error)?.message) ??
                readString(readRecord(readRecord(properties.error)?.data)?.message) ??
                "unknown OpenCode session error";
              sessionError = errorMessage;
              sawPromptActivity = true;
              break;
            }

            if (
              sawPromptActivity &&
              ((eventType === "session.idle" && properties.sessionID === sessionId) ||
                (eventType === "session.status" &&
                  properties.sessionID === sessionId &&
                  readRecord(properties.status)?.type === "idle"))
            ) {
              break;
            }
          }
        })();

        await client.session.promptAsync({
          path: { id: sessionId },
          body: payload as Record<string, unknown>,
        });

        await consumeEvents;
        if (sessionError) {
          throw new Error(sessionError);
        }

        const messages = unwrapSdkData(await client.session.messages({
          path: { id: sessionId },
          query: { limit: 10 },
        }));
        return selectLatestAssistantMessage(messages, targetAssistantMessageId) ?? {
          parts: partialText ? [{ type: "text", text: partialText }] : [],
        };
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
