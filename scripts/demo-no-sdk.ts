#!/usr/bin/env -S node --import tsx
/**
 * Demo: bare-fetch OpenCode harness streaming via HTTP polling.
 *
 * Proves the SDK is unnecessary for our use case — and reveals a hard limit:
 * the REST API stores messages atomically, so polling `GET /session/{id}/message`
 * only sees completed text, NOT progressive deltas. The OpenCode server writes
 * the full text in one shot after generation finishes.
 *
 * Contrast: Codex harness gets incremental chunks because its WebSocket protocol
 * delivers per-delta notifications (`item/agentMessage/delta`) where text arrives
 * one chunk at a time. The OpenCode REST API does not expose partial/in-progress text.
 *
 * Usage:
 *   node --import tsx ./scripts/demo-no-sdk.ts \
 *     --base-url http://127.0.0.1:PORT \
 *     --prompt "Hello, write a sentence."
 */

import process from "node:process";

const POLL_INTERVAL_MS = 200;
const IDLE_TIMEOUT_MS = 60_000;

type SessionMessage = {
  info: {
    id: string;
    role: string;
    finish?: string;
  };
  parts: Array<{
    id: string;
    type: string;
    text?: string;
  }>;
};

function extractAssistantText(messages: SessionMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.info?.role === "assistant") {
      const textParts = (msg.parts ?? [])
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string);
      return textParts.join("");
    }
  }
  return "";
}

async function getSessionMessages(baseUrl: string, sessionId: string): Promise<SessionMessage[]> {
  const res = await api(`${baseUrl}/session/${sessionId}/message`) as SessionMessage[];
  return Array.isArray(res) ? res : [];
}

function printUsage(): void {
  console.log(`Usage: node --import tsx ./scripts/demo-no-sdk.ts [options]

Options:
  --base-url <url>         OpenCode server base URL (required)
  --prompt <text>          User prompt to send (default: "Write a short sentence about streaming.")
  --poll-ms <n>            Poll interval in ms (default: ${POLL_INTERVAL_MS})
  --timeout-ms <n>         Idle timeout in ms (default: ${IDLE_TIMEOUT_MS})
  -h, --help               Show this help
`);
}

function parseArgs(argv: string[]): {
  baseUrl: string;
  prompt: string;
  pollMs: number;
  timeoutMs: number;
} {
  const options = {
    baseUrl: process.env.OPENCODE_BASE_URL?.trim() ?? "",
    prompt: "Write a short sentence about streaming.",
    pollMs: POLL_INTERVAL_MS,
    timeoutMs: IDLE_TIMEOUT_MS,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "-h" || arg === "--help") { printUsage(); process.exit(0); }
    if (arg === "--base-url" && next) { options.baseUrl = next.replace(/\/+$/, ""); i++; continue; }
    if (arg === "--prompt" && next) { options.prompt = next; i++; continue; }
    if (arg === "--poll-ms" && next) { options.pollMs = Number(next); i++; continue; }
    if (arg === "--timeout-ms" && next) { options.timeoutMs = Number(next); i++; continue; }
    throw new Error(`Unknown arg: ${arg}`);
  }

  if (!options.baseUrl) throw new Error("--base-url is required");
  if (!Number.isFinite(options.pollMs) || options.pollMs < 50) throw new Error("--poll-ms must be >= 50");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000) throw new Error("--timeout-ms must be >= 1000");

  return options;
}

async function api(url: string, opts?: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...opts,
    headers: { "Content-Type": "application/json", ...opts?.headers },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
  }
  if (res.status === 204 || res.headers.get("content-length") === "0") return null;
  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  console.log(`Server: ${opts.baseUrl}`);
  console.log(`Prompt: ${opts.prompt}`);
  console.log(`Poll interval: ${opts.pollMs}ms`);
  console.log(`Idle timeout: ${opts.timeoutMs}ms`);
  console.log("");

  // 1. Check server health
  const health = await api(`${opts.baseUrl}/global/health`);
  console.log(`Health: ${JSON.stringify(health)}`);
  console.log("");

  // 2. Create a session
  const session = (await api(`${opts.baseUrl}/session`, {
    method: "POST",
    body: JSON.stringify({}),
  })) as Record<string, unknown>;
  const sessionId = String(session.id ?? session.sessionID ?? "");
  if (!sessionId) throw new Error(`No session ID from POST /session. Response: ${JSON.stringify(session)}`);
console.log(`Created session: ${sessionId}`);
  console.log("");

  // 3. Send user message + trigger generation via prompt_async
  const asyncResult = await api(`${opts.baseUrl}/session/${sessionId}/prompt_async`, {
    method: "POST",
    body: JSON.stringify({
      parts: [{ type: "text", text: opts.prompt }],
    }),
  });
  if (asyncResult !== null) {
    console.log(`Prompt async triggered: ${JSON.stringify(asyncResult).slice(0, 200)}`);
  } else {
    console.log("Prompt async triggered");
  }
  console.log("");

  // 5. Poll for text growth
  console.log("Polling for assistant response...");
  let lastText = "";
  let chunks = 0;
  const startedAt = Date.now();
  let idleSince = Date.now();

  while (Date.now() - idleSince < opts.timeoutMs) {
    await new Promise((r) => setTimeout(r, opts.pollMs));

    const messages = await getSessionMessages(opts.baseUrl, sessionId);
    const text = extractAssistantText(messages);
    const msgCount = messages.length;

    if (text.length > lastText.length) {
      const delta = text.slice(lastText.length);
      chunks++;
      const elapsed = Date.now() - startedAt;
      console.log(`  [chunk ${chunks}] +${elapsed}ms delta=${JSON.stringify(delta)} (total ${text.length} chars, ${msgCount} messages)`);
      lastText = text;
      idleSince = Date.now();
    }

    // Check if the latest assistant message is completed (has a finish reason)
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.info?.role === "assistant" && lastMsg.info.finish) {
      if (Date.now() - idleSince > 2000) break;
    }
  }

  const totalMs = Date.now() - startedAt;
  console.log("");
  console.log("=== Result ===");
  console.log(`Chunks received: ${chunks}`);
  console.log(`Total duration: ${totalMs}ms`);
  console.log(`Final text (${lastText.length} chars): ${lastText.slice(0, 500)}`);
  const messages = await getSessionMessages(opts.baseUrl, sessionId);
  console.log(`Session messages: ${messages.length}`);
  console.log(`Messages link: ${opts.baseUrl}/session/${sessionId}/message`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});