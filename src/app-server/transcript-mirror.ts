import crypto from "node:crypto";
import fs from "node:fs/promises";
import {
  acquireSessionWriteLock,
  appendSessionTranscriptMessage,
  emitSessionTranscriptUpdate,
  resolveSessionWriteLockOptions,
  runAgentHarnessBeforeMessageWriteHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenCodeHarnessLogger } from "../logger.js";

function getContentFingerprint(message: AgentMessage): string {
  let forHash: unknown;
  if (message.role === "user" || message.role === "assistant" || message.role === "toolResult" || message.role === "custom") {
    forHash = message.content;
  } else if (message.role === "bashExecution") {
    forHash = message.command + "\n" + message.output;
  } else if (message.role === "branchSummary" || message.role === "compactionSummary") {
    forHash = message.summary;
  } else {
    forHash = "";
  }
  const payload = JSON.stringify({ role: message.role, content: forHash });
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

type OpenCodeTranscriptMirrorState = {
  idempotencyKeys: Set<string>;
  messageCount: number;
};

async function readTranscriptMirrorState(sessionFile: string): Promise<OpenCodeTranscriptMirrorState> {
  const idempotencyKeys = new Set<string>();
  let messageCount = 0;
  let raw: string;
  try {
    raw = await fs.readFile(sessionFile, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { idempotencyKeys, messageCount };
    }
    throw error;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "message") messageCount += 1;
      if (typeof parsed.message?.idempotencyKey === "string") {
        idempotencyKeys.add(parsed.message.idempotencyKey);
      }
    } catch {
      continue;
    }
  }
  return { idempotencyKeys, messageCount };
}

export function buildOpenCodeUserPromptMessage(
  promptText: string,
  timestamp: number,
  sessionId?: string,
): AgentMessage {
  const msg: Record<string, unknown> = {
    role: "user",
    content: promptText,
    timestamp,
  };
  if (sessionId) {
    msg.sessionId = sessionId;
  }
  return msg as unknown as AgentMessage;
}

export function buildOpenCodeAssistantResponseMessage(
  finalText: string,
  provider: string,
  modelId: string | undefined,
  timestamp: number,
  reasoningText?: string,
  reasoningLevel?: string,
): AgentMessage {
  const content: Array<{ type: string; text?: string; thinking?: string }> = [{ type: "text", text: finalText }];
  if (reasoningText && reasoningLevel !== "off") {
    content.push({ type: "thinking", thinking: reasoningText });
  }
  const msg: Record<string, unknown> = {
    role: "assistant",
    content,
    provider,
    stopReason: "stop",
    timestamp,
  };
  if (modelId) {
    msg.model = modelId;
  }
  return msg as unknown as AgentMessage;
}

export type MirrorOpenCodeAttemptParams = {
  sessionFile: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  cwd?: string;
  config?: unknown;
  turnCount: number;
  messages: AgentMessage[];
  logger?: OpenCodeHarnessLogger;
};

export async function mirrorOpenCodeAttemptToTranscript(
  params: MirrorOpenCodeAttemptParams,
): Promise<void> {
  const messages = params.messages.filter(
    (m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
  );
  if (messages.length === 0) return;

  let lock: { release: () => Promise<void> } | undefined;
  try {
    const lockOpts = resolveSessionWriteLockOptions();
    lock = await acquireSessionWriteLock({
      sessionFile: params.sessionFile,
      timeoutMs: lockOpts.timeoutMs,
      staleMs: lockOpts.staleMs,
      maxHoldMs: lockOpts.maxHoldMs,
    });

    const mirrorState = await readTranscriptMirrorState(params.sessionFile);
    const appendedUpdates: Array<{ messageId: string; message: AgentMessage; messageSeq: number }> = [];
    let nextMessageSeq = mirrorState.messageCount;

    for (const [offset, message] of messages.entries()) {
      const dedupeIdentity = `opencode:${params.turnCount}:${offset}:${message.role}:${getContentFingerprint(message)}`;
      if (mirrorState.idempotencyKeys.has(dedupeIdentity)) continue;

      const messageToAppend: Record<string, unknown> = { ...(message as unknown as Record<string, unknown>), idempotencyKey: dedupeIdentity };

      const filteredMessage = runAgentHarnessBeforeMessageWriteHook({
        message: messageToAppend as unknown as AgentMessage,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
      });
      if (!filteredMessage) continue;

      const result = await appendSessionTranscriptMessage({
        transcriptPath: params.sessionFile,
        message: { ...(filteredMessage as unknown as Record<string, unknown>), idempotencyKey: dedupeIdentity } as unknown as AgentMessage,
        idempotencyLookup: "caller-checked",
        sessionId: params.sessionId,
        cwd: params.cwd,
        config: params.config as OpenClawConfig | undefined,
      });

      if (!result) continue;

      nextMessageSeq += 1;
      appendedUpdates.push({ messageId: result.messageId, message: result.message, messageSeq: nextMessageSeq });
      mirrorState.idempotencyKeys.add(dedupeIdentity);
    }

    if (lock) {
      await lock.release();
      lock = undefined;
    }

    for (const update of appendedUpdates) {
      emitSessionTranscriptUpdate({
        sessionFile: params.sessionFile,
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        ...(params.agentId ? { agentId: params.agentId } : {}),
        message: update.message,
        messageId: update.messageId,
        messageSeq: update.messageSeq,
      });
    }
  } catch (error) {
    params.logger?.warn?.("failed to mirror OpenCode turn into OpenClaw transcript", {
      error: String((error as Error)?.message ?? error),
      sessionFile: params.sessionFile,
    });
  } finally {
    if (lock) {
      try {
        await lock.release();
      } catch {
      }
    }
  }
}