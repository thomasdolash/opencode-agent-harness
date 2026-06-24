import crypto from "node:crypto";
import type { AgentHarnessNativeToolResult } from "./callback-server.js";

const CALLBACK_URL_KEY = "OPENCODE_NATIVE_TOOL_CALLBACK_URL";
type OpenCodeArgSchema = { type: string; description: string; optional?: boolean; minimum?: number };
type OpenCodeTool = { description: string; args: Record<string, OpenCodeArgSchema>; execute: (args: Record<string, unknown>, context: Record<string, unknown>) => Promise<string> };

export type NativeToolCatalogEntry = {
  name: string;
  description: string;
  args: Record<string, OpenCodeArgSchema>;
  toNativeArguments?: (args: Record<string, unknown>) => Record<string, unknown>;
  renderResult?: (result: AgentHarnessNativeToolResult) => { title: string; output: string; metadata?: Record<string, unknown> };
};

function defaultRenderResult(result: AgentHarnessNativeToolResult, title: string): { title: string; output: string; metadata?: Record<string, unknown> } {
  const textParts = (result.content ?? [])
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string);
  const output = textParts.length > 0 ? textParts.join("\n") : "Native tool completed without textual output.";
  if (result.isError) {
    return { title: `${title} (error)`, output };
  }
  return { title, output };
}

export async function invokeNativeToolViaCallback(params: {
  toolName: string;
  nativeArgs: Record<string, unknown>;
  context: Record<string, unknown>;
  renderTitle: string;
  renderResult?: (result: AgentHarnessNativeToolResult) => { title: string; output: string; metadata?: Record<string, unknown> };
}): Promise<string> {
  const callbackUrl = process.env[CALLBACK_URL_KEY];
  if (!callbackUrl) {
    throw new Error(`OpenCode native tool bridge: ${CALLBACK_URL_KEY} is not set`);
  }

  const callId = crypto.randomUUID();
  const sessionId = typeof params.context.sessionID === "string" ? params.context.sessionID : "";

  if (!sessionId) {
    return JSON.stringify({ title: `${params.renderTitle} (error)`, output: "Missing session ID in context" });
  }

  const body = {
    sessionId,
    callId,
    toolName: params.toolName,
    arguments: params.nativeArgs,
  };

  let response: Response;
  try {
    const signal: AbortSignal | undefined =
      typeof params.context.abort !== "undefined"
        ? (params.context as { abort: AbortSignal }).abort
        : undefined;

    response = await fetch(callbackUrl + "/native-tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error: unknown) {
    const abortMsg = error instanceof Error && error.name === "AbortError"
      ? "Request was aborted"
      : `Callback request failed: ${error instanceof Error ? error.message : String(error)}`;
    return JSON.stringify({ title: `${params.renderTitle} (error)`, output: abortMsg });
  }

  let responseBody: { ok: boolean; result?: AgentHarnessNativeToolResult; error?: string };
  try {
    responseBody = await response.json() as typeof responseBody;
  } catch {
    return JSON.stringify({ title: `${params.renderTitle} (error)`, output: "Invalid response from native tool bridge" });
  }

  if (!responseBody.ok || !responseBody.result) {
    return JSON.stringify({ title: `${params.renderTitle} (error)`, output: responseBody.error ?? "Native tool call failed" });
  }

  const renderFn = params.renderResult ?? ((r: AgentHarnessNativeToolResult) => defaultRenderResult(r, params.renderTitle));
  const rendered = renderFn(responseBody.result);
  return JSON.stringify(rendered);
}

function buildOpenCodeTool(entry: NativeToolCatalogEntry): OpenCodeTool {
  return {
    description: entry.description,
    args: entry.args,
    async execute(args: Record<string, unknown>, context: Record<string, unknown>) {
      const nativeArgs = entry.toNativeArguments ? entry.toNativeArguments(args) : { ...args };
      const renderTitle = entry.name;
      return invokeNativeToolViaCallback({
        toolName: entry.name,
        nativeArgs,
        context,
        renderTitle,
        renderResult: entry.renderResult,
      });
    },
  };
}

export function buildCatalogEntryMap(entries: NativeToolCatalogEntry[]): Record<string, OpenCodeTool> {
  const map: Record<string, OpenCodeTool> = {};
  for (const entry of entries) {
    map[entry.name] = buildOpenCodeTool(entry);
  }
  return map;
}

const sessionsSendArgs = {
  sessionKey: { type: "string", description: "Target OpenClaw session key" },
  message: { type: "string", description: "Plain text message content" },
  timeoutSeconds: { type: "integer", description: "Optional timeout in seconds (minimum 0)", optional: true, minimum: 0 },
} as const;

const sessionsListArgs = {
  kinds: { type: "array", description: "Filter by session kinds: main, group, cron, hook, node, other", optional: true },
  limit: { type: "integer", description: "Maximum number of sessions to return", optional: true },
  activeMinutes: { type: "integer", description: "Only sessions active within this many minutes", optional: true },
  label: { type: "string", description: "Filter by label", optional: true },
  agentId: { type: "string", description: "Filter by agent ID", optional: true },
  search: { type: "string", description: "Search sessions by text", optional: true },
  includeDerivedTitles: { type: "boolean", description: "Include auto-generated titles", optional: true },
  includeLastMessage: { type: "boolean", description: "Include last message preview", optional: true },
} as const;

const sessionsHistoryArgs = {
  sessionKey: { type: "string", description: "Target OpenClaw session key" },
  limit: { type: "integer", description: "Maximum number of messages to fetch", optional: true },
  includeTools: { type: "boolean", description: "Include tool call/result messages in the output", optional: true },
} as const;

function formatSessionsListNativeOutput(result: AgentHarnessNativeToolResult): string {
  const joined = (result.content ?? [])
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");

  if (!joined) {
    return "No sessions found.";
  }

  let sessions: unknown[];
  try {
    const parsed = JSON.parse(joined);
    if (Array.isArray(parsed)) {
      sessions = parsed;
    } else if (typeof parsed === "object" && parsed !== null) {
      const arr = (parsed as Record<string, unknown>).sessions;
      if (Array.isArray(arr)) {
        sessions = arr;
      } else {
        return joined;
      }
    } else {
      return joined;
    }
  } catch {
    return joined;
  }

  if (sessions.length === 0) {
    return "No sessions found.";
  }

  const lines: string[] = [];
  for (const session of sessions) {
    if (typeof session !== "object" || session === null) continue;
    const s = session as Record<string, unknown>;
    const key = typeof s.key === "string" ? s.key : "?";
    const agentId = typeof s.agentId === "string" ? s.agentId : "";
    const kind = typeof s.kind === "string" ? s.kind : "";
    const label = typeof s.label === "string" && s.label ? s.label : "";
    const derivedTitle = typeof s.derivedTitle === "string" && s.derivedTitle ? s.derivedTitle : "";
    const lastMsg = typeof s.lastMessagePreview === "string" && s.lastMessagePreview ? s.lastMessagePreview.slice(0, 120) : "";
    const status = typeof s.spawnedBy === "string" ? "spawned" : "main";
    const parts = [key];
    if (agentId) parts.push(`agent=${agentId}`);
    if (kind) parts.push(`kind=${kind}`);
    if (label) parts.push(`label=${label}`);
    if (derivedTitle) parts.push(`title=${derivedTitle}`);
    if (status) parts.push(status);
    lines.push(`- ${parts.join(" | ")}`);
    if (lastMsg) {
      lines.push(`  last: ${lastMsg}`);
    }
  }

  return lines.join("\n");
}

function formatSessionsHistoryNativeOutput(result: AgentHarnessNativeToolResult): string {
  const joined = (result.content ?? [])
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");

  if (!joined) {
    return "No history available.";
  }

  let messageData: unknown[];
  try {
    const parsed = JSON.parse(joined);
    if (Array.isArray(parsed)) {
      messageData = parsed;
    } else if (typeof parsed === "object" && parsed !== null) {
      const msgs = (parsed as Record<string, unknown>).messages;
      if (Array.isArray(msgs)) {
        messageData = msgs;
      } else {
        return joined;
      }
    } else {
      return joined;
    }
  } catch {
    return joined;
  }

  if (messageData.length === 0) {
    return "Session has no messages.";
  }

  const lines: string[] = [];
  for (const entry of messageData) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const role = typeof e.role === "string" ? e.role : "?";
    const content = typeof e.content === "string" ? e.content
      : Array.isArray(e.content) ? (e.content as Array<Record<string, unknown>>)
          .filter((p) => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text as string)
          .join("\n")
      : "";

    const isTool = role === "toolResult" || role === "toolCall";
    if (isTool) {
      lines.push(`[${role}]: ${content.slice(0, 300)}`);
    } else {
      const preview = content.length > 500 ? content.slice(0, 497) + "..." : content;
      lines.push(`${role}: ${preview}`);
    }
  }

  return lines.join("\n");
}

export const CATALOG_ENTRIES: NativeToolCatalogEntry[] = [
  {
    name: "sessions_send",
    description:
      "Send a progress update, question, or final result to the current OpenClaw parent session. Use the parent session key supplied in your system context.",
    args: sessionsSendArgs as Record<string, OpenCodeArgSchema>,
    toNativeArguments: (args) => {
      const native: Record<string, unknown> = {
        sessionKey: args.sessionKey,
        message: args.message,
      };
      if (args.timeoutSeconds !== undefined) {
        native.timeoutSeconds = args.timeoutSeconds;
      }
      return native;
    },
  },
  {
    name: "sessions_list",
    description: "List visible sessions; filter by kind, label, agentId, search, activity. Use before sessions_history or sessions_send target selection.",
    args: sessionsListArgs as Record<string, OpenCodeArgSchema>,
    toNativeArguments: (args) => {
      const native: Record<string, unknown> = {};
      for (const key of ["kinds", "limit", "activeMinutes", "label", "agentId", "search", "includeDerivedTitles", "includeLastMessage"] as const) {
        if (args[key] !== undefined) {
          native[key] = args[key];
        }
      }
      return native;
    },
    renderResult: (result) => {
      const output = formatSessionsListNativeOutput(result);
      if (result.isError) {
        return { title: "sessions_list (error)", output };
      }
      return { title: "sessions_list", output };
    },
  },
  {
    name: "sessions_history",
    description: "Fetch sanitized history for a visible session. Use before replying, debugging, resuming; supports limits and tool message inclusion.",
    args: sessionsHistoryArgs as Record<string, OpenCodeArgSchema>,
    toNativeArguments: (args) => {
      const native: Record<string, unknown> = { sessionKey: args.sessionKey };
      if (args.limit !== undefined) {
        native.limit = args.limit;
      }
      if (args.includeTools !== undefined) {
        native.includeTools = args.includeTools;
      }
      return native;
    },
    renderResult: (result) => {
      const output = formatSessionsHistoryNativeOutput(result);
      if (result.isError) {
        return { title: "sessions_history (error)", output };
      }
      return { title: "sessions_history", output };
    },
  },
];