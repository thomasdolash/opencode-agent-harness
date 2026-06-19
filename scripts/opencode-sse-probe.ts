#!/usr/bin/env -S node --import tsx

import { spawn } from "node:child_process";
import process from "node:process";

const DEFAULT_DIRECTORY = process.env.OPENCODE_DIRECTORY ?? "/app";
const DEFAULT_READ_MS = Number.parseInt(process.env.OPENCODE_READ_MS ?? "18000", 10);
const DEFAULT_PORT = 4096;
const POLL_MS = 200;

type ProbeOpts = {
  baseUrl: string;
  directory: string;
  readMs: number;
};

type SSEEvent = {
  event: string;
  data: Record<string, unknown>;
};

async function* readSSE(url: string, signal: AbortSignal): AsyncGenerator<SSEEvent> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`SSE ${res.status} ${res.statusText}`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    while (true) {
      const nl = buf.indexOf("\n");
      if (nl < 0) break;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.startsWith("data: ")) {
        try {
          const data = JSON.parse(line.slice(6)) as Record<string, unknown>;
          yield { event: String(data.type ?? "data"), data };
        } catch {
          // skip parse failures
        }
      }
    }
  }
}

function parseArgs(argv: string[]): ProbeOpts & { port?: number } {
  const opts: ProbeOpts & { port?: number } = {
    baseUrl: "",
    directory: DEFAULT_DIRECTORY,
    readMs: DEFAULT_READ_MS,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--base-url" && next) { opts.baseUrl = next.replace(/\/+$/, ""); i++; }
    else if (arg === "--directory" && next) { opts.directory = next; i++; }
    else if (arg === "--read-ms" && next) { opts.readMs = Number.parseInt(next, 10); i++; }
    else if (arg === "--port" && next) { opts.port = Number.parseInt(next, 10); i++; }
    else if (arg === "-h" || arg === "--help") {
      const portDesc = `opencode server port (default: ${DEFAULT_PORT})`;
      console.log(`Usage: node --import tsx scripts/opencode-sse-probe.ts [options]
  --base-url <url>       OpenCode server URL (omit to spawn one)
  --port <n>             ${portDesc}
  --directory <path>     Project directory (default: ${DEFAULT_DIRECTORY})
  --read-ms <n>          Read duration in ms (default: ${DEFAULT_READ_MS})
  -h, --help             Show this help`);
      process.exit(0);
    }
  }
  return opts;
}

async function api(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 500)}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function waitForHealthy(url: string, signal: AbortSignal, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted && Date.now() < deadline) {
    try {
      const h = (await api(`${url}/global/health`)) as Record<string, unknown>;
      if (h.healthy) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server at ${url} did not become healthy within ${timeoutMs}ms`);
}

async function startServer(port: number): Promise<{ kill: () => void }> {
  const proc = spawn("opencode", ["serve", "--port", String(port), "--print-logs"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  proc.stderr?.on("data", () => {}); // drain
  const kill = () => { try { proc.kill(); } catch {} };
  process.on("exit", kill);
  return { kill };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const port = parsed.port ?? DEFAULT_PORT;
  const baseUrl = parsed.baseUrl || `http://127.0.0.1:${port}`;
  const opts: ProbeOpts = { baseUrl, directory: parsed.directory, readMs: parsed.readMs };

  let serverKill: (() => void) | undefined;
  if (!parsed.baseUrl) {
    console.log(`Starting opencode serve on port ${port}...`);
    const server = await startServer(port);
    serverKill = server.kill;
    await waitForHealthy(baseUrl, new AbortController().signal);
    console.log("Server is healthy");
  }
  console.log(`base-url:  ${opts.baseUrl}`);
  console.log(`directory: ${opts.directory}`);
  console.log(`read-ms:   ${opts.readMs}`);
  console.log("");

  try {
    // 1. Unscoped /global/event baseline
    console.log("=== Unscoped /global/event (5s) ===");
    const unscopedAbort = new AbortController();
    const unscopedTimer = setTimeout(() => unscopedAbort.abort(), 5000);
    const unscopedTypes: Record<string, number> = {};
    try {
      for await (const ev of readSSE(`${opts.baseUrl}/global/event`, unscopedAbort.signal)) {
        unscopedTypes[ev.event] = (unscopedTypes[ev.event] ?? 0) + 1;
        if (Object.keys(unscopedTypes).length <= 5) {
          console.log(`  ${ev.event}: ${JSON.stringify(ev.data).slice(0, 200)}`);
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") console.error("  Error:", (e as Error).message);
    }
    clearTimeout(unscopedTimer);
    console.log(`  Total: ${Object.values(unscopedTypes).reduce((a, b) => a + b, 0)} events`);
    console.log(`  Types: ${JSON.stringify(unscopedTypes)}`);
    console.log("");

    // 2. Create scoped session
    console.log("=== Creating scoped session ===");
    const session = (await api(`${opts.baseUrl}/session?directory=${encodeURIComponent(opts.directory)}`, {
      method: "POST",
      body: JSON.stringify({}),
    })) as Record<string, string>;
    const sessionId = session.id ?? session.sessionID ?? "";
    if (!sessionId) throw new Error(`No session id from POST /session`);
    console.log(`  sessionId: ${sessionId}`);
    console.log("");

    // 3. Listen on scoped /event while sending a prompt
    const prompt = "Write a short sentence about streaming.";
    console.log(`=== Scoped /event?directory=... (${opts.readMs}ms) ===`);
    console.log(`  prompt: ${prompt}`);
    console.log("");

    const scopedAbort = new AbortController();
    const scopedTimer = setTimeout(() => scopedAbort.abort(), opts.readMs);
    const scopedTypes: Record<string, number> = {};
    let assistantDeltaChunks = 0;
    let assistantText = "";

    const consumeSSE = (async () => {
      for await (const ev of readSSE(
        `${opts.baseUrl}/event?directory=${encodeURIComponent(opts.directory)}`,
        scopedAbort.signal,
      )) {
        scopedTypes[ev.event] = (scopedTypes[ev.event] ?? 0) + 1;
        if (scopedTypes[ev.event] === 1) {
          console.log(`  [first] ${ev.event}: ${JSON.stringify(ev.data).slice(0, 250)}`);
        }
        const props = ((ev.data as Record<string, unknown>).properties ?? {}) as Record<string, unknown>;
        if (ev.event === "message.part.delta" && typeof props.delta === "string") {
          assistantDeltaChunks++;
          assistantText += props.delta;
        }
      }
    })();

    // 4. Send prompt
    await new Promise((r) => setTimeout(r, 500));
    await api(
      `${opts.baseUrl}/session/${sessionId}/prompt_async?directory=${encodeURIComponent(opts.directory)}`,
      {
        method: "POST",
        body: JSON.stringify({ parts: [{ type: "text", text: prompt }] }),
      },
    );
    console.log("  prompt_async: accepted");
    console.log("");

    // 5. Poll messages for comparison
    let polledText = "";
    const pollInterval = setInterval(async () => {
      try {
        const messages = (await api(
          `${opts.baseUrl}/session/${sessionId}/message?directory=${encodeURIComponent(opts.directory)}`,
        )) as Array<Record<string, unknown>>;
        if (!Array.isArray(messages)) return;
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          const info = msg.info as Record<string, unknown> | undefined;
          if (info?.role === "assistant") {
            const parts = (msg.parts as Array<Record<string, unknown>>) ?? [];
            const text = parts
              .filter((p) => p.type === "text" && typeof p.text === "string")
              .map((p) => p.text as string)
              .join("");
            if (text.length > polledText.length) polledText = text;
          }
        }
      } catch {
        // best effort
      }
    }, POLL_MS);

    try {
      await consumeSSE;
    } catch (e) {
      if ((e as Error).name !== "AbortError") throw e;
    }
    clearTimeout(scopedTimer);
    clearInterval(pollInterval);

    // 6. Results
    const totalScoped = Object.values(scopedTypes).reduce((a, b) => a + b, 0);
    console.log("=== Results ===");
    console.log(`  Scoped SSE total events: ${totalScoped}`);
    console.log(`  Scoped SSE types: ${JSON.stringify(scopedTypes)}`);
    console.log(`  Assistant delta chunks: ${assistantDeltaChunks}`);
    console.log(`  SSE text (${assistantText.length} chars): ${assistantText.slice(0, 500)}`);
    console.log(`  Polled text (${polledText.length} chars): ${polledText.slice(0, 500)}`);
    console.log(`  Messages: ${opts.baseUrl}/session/${sessionId}/message`);
  } finally {
    serverKill?.();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});