#!/usr/bin/env -S node --import tsx

import process from "node:process";

type ProbeOptions = {
  baseUrl: string;
  token: string;
  baselineModel: string;
  targetModel: string;
  timeoutSeconds: number;
  verbose: boolean;
  prompt: string;
};

type StreamChunk = {
  atMs: number;
  text: string;
};

type StreamProbeResult = {
  model: string;
  chunkCount: number;
  content: string;
  chunks: StreamChunk[];
  roleChunkCount: number;
  doneSeen: boolean;
  durationMs: number;
};

function printUsage(): void {
  console.log(`Usage: node --import tsx ./scripts/live-gateway-probe.ts [options]

Options:
  --base-url <url>         OpenClaw Gateway base URL
  --token <token>          OpenClaw Gateway bearer token
  --baseline-model <id>    Baseline model to compare against
  --target-model <id>      Target model to probe
  --timeout <seconds>      HTTP timeout in seconds
  --prompt <text>          Prompt used for both streaming requests
  --verbose                Print individual SSE content chunks with timing
  -h, --help               Show this help
`);
}

function parseArgs(argv: string[]): ProbeOptions {
  const options: ProbeOptions = {
    baseUrl: process.env.OPENCLAW_GATEWAY_BASE_URL?.trim() || "http://127.0.0.1:18789",
    token: process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || "",
    baselineModel: "openclaw/default",
    targetModel: "openclaw/opencode",
    timeoutSeconds: 180,
    verbose: false,
    prompt:
      "Write 8 short numbered lines about streaming. Keep each line brief so incremental SSE chunks are easy to observe.",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--base-url" && next) {
      options.baseUrl = next.trim().replace(/\/$/, "");
      index += 1;
      continue;
    }
    if (arg === "--token" && next) {
      options.token = next.trim();
      index += 1;
      continue;
    }
    if (arg === "--baseline-model" && next) {
      options.baselineModel = next.trim();
      index += 1;
      continue;
    }
    if (arg === "--target-model" && next) {
      options.targetModel = next.trim();
      index += 1;
      continue;
    }
    if (arg === "--timeout" && next) {
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --timeout value: ${next}`);
      }
      options.timeoutSeconds = parsed;
      index += 1;
      continue;
    }
    if (arg === "--prompt" && next) {
      options.prompt = next;
      index += 1;
      continue;
    }
    if (arg === "--verbose") {
      options.verbose = true;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${arg}`);
  }

  if (!options.token) {
    throw new Error("Missing gateway token. Set OPENCLAW_GATEWAY_TOKEN or pass --token.");
  }

  return options;
}

function summarizeText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "<empty>";
  }
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}

function printTicks(label: string, chunks: StreamChunk[]): void {
  console.log(`${label} chunks:`);
  if (chunks.length === 0) {
    console.log("  <none>");
    return;
  }
  chunks.forEach((chunk, index) => {
    console.log(`  [${index + 1}] +${chunk.atMs}ms ${JSON.stringify(chunk.text)}`);
  });
}

function resolveChunkText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as {
    choices?: Array<{
      delta?: {
        content?: unknown;
        role?: unknown;
      };
    }>;
  };
  const content = record.choices?.[0]?.delta?.content;
  return typeof content === "string" ? content : undefined;
}

function hasRoleChunk(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const record = payload as {
    choices?: Array<{
      delta?: {
        role?: unknown;
      };
    }>;
  };
  return typeof record.choices?.[0]?.delta?.role === "string";
}

async function probeModel(params: {
  baseUrl: string;
  token: string;
  model: string;
  prompt: string;
  timeoutSeconds: number;
}): Promise<StreamProbeResult> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort(new Error(`Timed out after ${params.timeoutSeconds}s`));
  }, params.timeoutSeconds * 1000);

  const startedAt = Date.now();
  try {
    const response = await fetch(`${params.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: params.model,
        messages: [{ role: "user", content: params.prompt }],
        stream: true,
        user: `live-gateway-probe-${params.model.replace(/[^a-zA-Z0-9_-]+/g, "-")}`,
      }),
      signal: abortController.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} ${response.statusText}\n${body}`.trim());
    }
    if (!response.body) {
      throw new Error("Response body was not streamable");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let doneSeen = false;
    let roleChunkCount = 0;
    const chunks: StreamChunk[] = [];
    let content = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const eventBreak = buffer.indexOf("\n\n");
        if (eventBreak < 0) {
          break;
        }
        const rawEvent = buffer.slice(0, eventBreak);
        buffer = buffer.slice(eventBreak + 2);
        const lines = rawEvent
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        for (const line of lines) {
          if (!line.startsWith("data: ")) {
            continue;
          }
          const data = line.slice(6);
          if (data === "[DONE]") {
            doneSeen = true;
            continue;
          }
          const payload = JSON.parse(data) as unknown;
          if (hasRoleChunk(payload)) {
            roleChunkCount += 1;
          }
          const text = resolveChunkText(payload);
          if (!text) {
            continue;
          }
          content += text;
          chunks.push({ atMs: Date.now() - startedAt, text });
        }
      }
    }

    return {
      model: params.model,
      chunkCount: chunks.length,
      content,
      chunks,
      roleChunkCount,
      doneSeen,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function toSummary(result: StreamProbeResult): Record<string, unknown> {
  return {
    model: result.model,
    chunkCount: result.chunkCount,
    roleChunkCount: result.roleChunkCount,
    doneSeen: result.doneSeen,
    durationMs: result.durationMs,
    firstChunkAtMs: result.chunks[0]?.atMs,
    lastChunkAtMs: result.chunks[result.chunks.length - 1]?.atMs,
    preview: summarizeText(result.content),
  };
}

const options = parseArgs(process.argv.slice(2));

console.log(`Gateway: ${options.baseUrl}`);
console.log(`Baseline model: ${options.baselineModel}`);
console.log(`Target model: ${options.targetModel}`);
console.log("");

const baseline = await probeModel({
  baseUrl: options.baseUrl,
  token: options.token,
  model: options.baselineModel,
  prompt: options.prompt,
  timeoutSeconds: options.timeoutSeconds,
});
const target = await probeModel({
  baseUrl: options.baseUrl,
  token: options.token,
  model: options.targetModel,
  prompt: options.prompt,
  timeoutSeconds: options.timeoutSeconds,
});

console.log("Baseline summary:");
console.log(JSON.stringify(toSummary(baseline), null, 2));
console.log("");
console.log("Target summary:");
console.log(JSON.stringify(toSummary(target), null, 2));

if (options.verbose) {
  console.log("");
  printTicks(`${baseline.model}`, baseline.chunks);
  console.log("");
  printTicks(`${target.model}`, target.chunks);
}

const result = {
  gateway: options.baseUrl,
  baselineModel: options.baselineModel,
  targetModel: options.targetModel,
  baselineChunkCount: baseline.chunkCount,
  targetChunkCount: target.chunkCount,
  baselineDoneSeen: baseline.doneSeen,
  targetDoneSeen: target.doneSeen,
  baselinePreview: summarizeText(baseline.content),
  targetPreview: summarizeText(target.content),
  targetStreamsIncrementally: target.chunkCount > 1,
  baselineOutstreamsTarget: baseline.chunkCount > target.chunkCount,
};

console.log("");
console.log("Probe result:");
console.log(JSON.stringify(result, null, 2));

if (baseline.chunkCount < 2) {
  throw new Error(
    `Baseline model ${baseline.model} did not stream incrementally; observed ${baseline.chunkCount} content chunk(s).`,
  );
}
if (target.chunkCount < 2) {
  throw new Error(
    `Target model ${target.model} did not stream incrementally; observed ${target.chunkCount} content chunk(s).`,
  );
}
