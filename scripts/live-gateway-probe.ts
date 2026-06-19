#!/usr/bin/env -S node --import tsx

import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import {
  readOpenCodeHarnessBinding,
  resolveOpenCodeHarnessBindingPath,
} from "../src/app-server/session-binding.js";

type ProbeOptions = {
  agent: string;
  cliPath: string;
  model?: string;
  sessionKey: string;
  thinking: string;
  timeoutSeconds: number;
  verbose: boolean;
  workspaceDir: string;
};

type StreamChunk = {
  atMs: number;
  text: string;
};

type CommandRunResult = {
  durationMs: number;
  exitCode: number;
  stderr: string;
  stderrChunks: StreamChunk[];
  stdout: string;
  stdoutChunks: StreamChunk[];
};

type AgentRunResult = CommandRunResult & {
  json?: unknown;
  sessionFile?: string;
  visibleText: string;
};

function printUsage(): void {
  console.log(`Usage: node --import tsx ./scripts/live-gateway-probe.ts [options]

Options:
  --agent <id>         OpenClaw agent id (defaults to opencode)
  --cli-path <path>    Path to openclaw.mjs
  --model <id>         Optional model override
  --session-key <key>  Explicit session key for both turns
  --thinking <level>   Thinking level passed to openclaw agent
  --timeout <seconds>  Agent timeout in seconds
  --verbose            Print individual stdout/stderr ticks with timing
  --workspace <path>   Workspace/cwd to run the live probe in
  -h, --help           Show this help
`);
}

function parseArgs(argv: string[]): ProbeOptions {
  const repoRoot = process.cwd();
  const defaultWorkspaceDir = repoRoot;
  const defaultCliPath = path.resolve(repoRoot, "node_modules/openclaw/openclaw.mjs");
  const defaultAgent = "opencode";
  const defaultSessionKey = `agent:${defaultAgent}:opencode-live-probe-${Date.now()}`;

  const options: ProbeOptions = {
    agent: defaultAgent,
    cliPath: defaultCliPath,
    sessionKey: defaultSessionKey,
    thinking: "off",
    timeoutSeconds: 180,
    verbose: false,
    workspaceDir: defaultWorkspaceDir,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--agent" && next) {
      options.agent = next;
      index += 1;
      continue;
    }
    if (arg === "--cli-path" && next) {
      options.cliPath = path.resolve(next);
      index += 1;
      continue;
    }
    if (arg === "--model" && next) {
      options.model = next;
      index += 1;
      continue;
    }
    if (arg === "--session-key" && next) {
      options.sessionKey = next;
      index += 1;
      continue;
    }
    if (arg === "--thinking" && next) {
      options.thinking = next;
      index += 1;
      continue;
    }
    if (arg === "--timeout" && next) {
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Invalid --timeout value: ${next}`);
      }
      options.timeoutSeconds = parsed;
      index += 1;
      continue;
    }
    if (arg === "--verbose") {
      options.verbose = true;
      continue;
    }
    if (arg === "--workspace" && next) {
      options.workspaceDir = path.resolve(next);
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${arg}`);
  }

  return options;
}

function formatCommand(cliPath: string, args: string[]): string {
  return [process.execPath, cliPath, ...args].map((part) => JSON.stringify(part)).join(" ");
}

function stripAnsi(text: string): string {
  return text.replace(/\[[0-9;]*m/g, "");
}

function summarizeTickText(text: string): string {
  const cleaned = stripAnsi(text).replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return "<whitespace>";
  }
  return cleaned.length > 160 ? `${cleaned.slice(0, 157)}...` : cleaned;
}

function printTicks(label: string, chunks: StreamChunk[]): void {
  console.log(`${label} ticks:`);
  if (chunks.length === 0) {
    console.log('  <none>');
    return;
  }
  chunks.forEach((chunk, index) => {
    console.log(`  [${index + 1}] +${chunk.atMs}ms ${JSON.stringify(summarizeTickText(chunk.text))}`);
  });
  console.log('');
}

function extractFirstJsonObject(text: string): unknown {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }
    if (char === "}") {
      if (depth === 0) {
        continue;
      }
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = text.slice(start, index + 1);
        try {
          return JSON.parse(candidate);
        } catch {}
        start = -1;
      }
    }
  }

  return undefined;
}

function spawnCommand(params: {
  args: string[];
  cliPath: string;
  cwd: string;
}): Promise<CommandRunResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [params.cliPath, ...params.args], {
      cwd: params.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const stdoutChunks: StreamChunk[] = [];
    const stderrChunks: StreamChunk[] = [];

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      stdoutChunks.push({ atMs: Date.now() - startedAt, text: chunk });
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      stderrChunks.push({ atMs: Date.now() - startedAt, text: chunk });
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        durationMs: Date.now() - startedAt,
        exitCode: code ?? 0,
        stderr,
        stderrChunks,
        stdout,
        stdoutChunks,
      });
    });
  });
}

function tryParseJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines[index];
    if (!(candidate.startsWith("{") || candidate.startsWith("["))) {
      continue;
    }
    try {
      return JSON.parse(candidate);
    } catch {}
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function collectTextValues(value: unknown, bucket: string[] = []): string[] {
  if (typeof value === "string") {
    if (value.trim() !== "") {
      bucket.push(value);
    }
    return bucket;
  }
  if (!value || typeof value !== "object") {
    return bucket;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectTextValues(entry, bucket);
    }
    return bucket;
  }

  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    if (
      (key === "text" || key === "message" || key === "assistant" || key === "output") &&
      typeof entry === "string" &&
      entry.trim() !== ""
    ) {
      bucket.push(entry);
      continue;
    }
    collectTextValues(entry, bucket);
  }
  return bucket;
}

function findFirstStringByKey(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findFirstStringByKey(entry, key);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const direct = record[key];
  if (typeof direct === "string" && direct.trim() !== "") {
    return direct;
  }
  for (const entry of Object.values(record)) {
    const found = findFirstStringByKey(entry, key);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function toVisibleText(rawStdout: string, json: unknown): string {
  const candidateTexts = collectTextValues(json);
  if (candidateTexts.length > 0) {
    return candidateTexts.join("\n").trim();
  }
  return stripAnsi(rawStdout).trim();
}

async function runAgentTurn(params: {
  cliPath: string;
  cwd: string;
  agent: string;
  jsonMode: boolean;
  model?: string;
  sessionKey: string;
  thinking: string;
  timeoutSeconds: number;
  message: string;
}): Promise<AgentRunResult> {
  const args = [
    "agent",
    ...(params.jsonMode ? ["--json"] : []),
    "--session-key",
    params.sessionKey,
    "--thinking",
    params.thinking,
    "--timeout",
    String(params.timeoutSeconds),
    "--message",
    params.message,
    "--agent",
    params.agent,
  ];

  if (params.model) {
    args.push("--model", params.model);
  }

  const commandResult = await spawnCommand({
    args,
    cliPath: params.cliPath,
    cwd: params.cwd,
  });
  const json = params.jsonMode ? tryParseJson(commandResult.stdout) : undefined;

  return {
    ...commandResult,
    json,
    sessionFile: findFirstStringByKey(json, "sessionFile"),
    visibleText: toVisibleText(commandResult.stdout, json),
  };
}

function requireSuccess(run: AgentRunResult, label: string): void {
  if (run.exitCode !== 0) {
    throw new Error(
      `${label} failed with exit code ${run.exitCode}
stdout:
${run.stdout}

stderr:
${run.stderr}`,
    );
  }
}

function requireContains(haystack: string, needle: string, label: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`${label} did not contain expected value ${JSON.stringify(needle)}.
Observed:
${haystack}`);
  }
}

function summarizeOutput(label: string, text: string): void {
  const compact = text.replace(/\s+/g, " ").trim();
  const preview = compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
  console.log(`${label}: ${preview}`);
}

function resolveStreamingEvidence(chunks: StreamChunk[]): {
  chunkCount: number;
  firstChunkAtMs?: number;
  lastChunkAtMs?: number;
  streamingObserved: boolean;
  streamingReason: string;
} {
  const meaningful = chunks.filter((chunk) => chunk.text.trim() !== "");
  const firstChunkAtMs = meaningful[0]?.atMs;
  const lastChunkAtMs = meaningful[meaningful.length - 1]?.atMs;
  const spreadMs =
    typeof firstChunkAtMs === "number" && typeof lastChunkAtMs === "number"
      ? lastChunkAtMs - firstChunkAtMs
      : undefined;
  const streamingObserved = meaningful.length >= 2 && typeof spreadMs === "number" && spreadMs >= 250;

  return {
    chunkCount: meaningful.length,
    firstChunkAtMs,
    lastChunkAtMs,
    streamingObserved,
    streamingReason: streamingObserved
      ? `observed ${meaningful.length} stdout chunks across ${spreadMs}ms`
      : meaningful.length === 0
        ? "no stdout chunks were observed"
        : meaningful.length === 1
          ? "only one stdout chunk was observed"
          : `multiple stdout chunks arrived too tightly grouped (${spreadMs ?? 0}ms spread)` ,
  };
}

const options = parseArgs(process.argv.slice(2));
const workspaceDir = path.resolve(options.workspaceDir);
const memoryToken = `memory-token-${randomUUID()}`;

const turnOnePrompt = [
  "This is a live OpenClaw -> OpenCode streaming probe.",
  "Do not call tools and do not inspect files.",
  `Remember this token for the next turn, but do not print it now: ${memoryToken}`,
  "Reply with exactly 14 numbered lines.",
  "Each line must be a full sentence about gateway streaming diagnostics.",
  "Do not use code fences, JSON, or markdown bullets.",
].join(" ");

const turnTwoPrompt = [
  "Live gateway probe follow-up.",
  "Do not call tools and do not inspect files.",
  `Reply with exactly one compact JSON object on a single line in this shape: {"memoryToken":"${memoryToken}"}`,
].join(" ");

console.log(`Workspace: ${workspaceDir}`);
console.log(`Agent: ${options.agent}`);
console.log(`Session key: ${options.sessionKey}`);
console.log(`CLI: ${options.cliPath}`);
console.log("");
console.log("Turn 1 command:");
console.log(
  formatCommand(options.cliPath, [
    "agent",
    "--session-key",
    options.sessionKey,
    "--thinking",
    options.thinking,
    "--timeout",
    String(options.timeoutSeconds),
    "--message",
    turnOnePrompt,
    "--agent",
    options.agent,
    ...(options.model ? ["--model", options.model] : []),
  ]),
);

const firstRun = await runAgentTurn({
  cliPath: options.cliPath,
  cwd: workspaceDir,
  agent: options.agent,
  jsonMode: false,
  model: options.model,
  sessionKey: options.sessionKey,
  thinking: options.thinking,
  timeoutSeconds: options.timeoutSeconds,
  message: turnOnePrompt,
});

requireSuccess(firstRun, "Turn 1");
summarizeOutput("Turn 1 visible text", firstRun.visibleText);
if (options.verbose) {
  printTicks("Turn 1 stdout", firstRun.stdoutChunks);
  printTicks("Turn 1 stderr", firstRun.stderrChunks);
}

const streamingEvidence = resolveStreamingEvidence(firstRun.stdoutChunks);
console.log(`Turn 1 streaming: ${streamingEvidence.streamingReason}`);

console.log("");
console.log("Turn 2 command:");
console.log(
  formatCommand(options.cliPath, [
    "agent",
    "--json",
    "--session-key",
    options.sessionKey,
    "--thinking",
    options.thinking,
    "--timeout",
    String(options.timeoutSeconds),
    "--message",
    turnTwoPrompt,
    "--agent",
    options.agent,
    ...(options.model ? ["--model", options.model] : []),
  ]),
);

const secondRun = await runAgentTurn({
  cliPath: options.cliPath,
  cwd: workspaceDir,
  agent: options.agent,
  jsonMode: true,
  model: options.model,
  sessionKey: options.sessionKey,
  thinking: options.thinking,
  timeoutSeconds: options.timeoutSeconds,
  message: turnTwoPrompt,
});

requireSuccess(secondRun, "Turn 2");
summarizeOutput("Turn 2 visible text", secondRun.visibleText);
if (options.verbose) {
  printTicks("Turn 2 stdout", secondRun.stdoutChunks);
  printTicks("Turn 2 stderr", secondRun.stderrChunks);
}
requireContains(secondRun.visibleText, memoryToken, "Turn 2 visible text");

let bindingSummary:
  | {
      bindingPath: string;
      openCodeSessionId: string;
      sessionFile: string;
    }
  | undefined;

if (secondRun.sessionFile) {
  const bindingPath = resolveOpenCodeHarnessBindingPath(secondRun.sessionFile);
  const binding = await readOpenCodeHarnessBinding(secondRun.sessionFile);
  if (binding) {
    bindingSummary = {
      bindingPath,
      openCodeSessionId: binding.openCodeSessionId,
      sessionFile: secondRun.sessionFile,
    };
  }
}

const turnTwoReply = extractFirstJsonObject(secondRun.visibleText) as { memoryToken?: string } | undefined;
const continuityConfirmed = turnTwoReply?.memoryToken === memoryToken || secondRun.visibleText.includes(memoryToken);
if (!continuityConfirmed) {
  throw new Error(`Turn 2 did not confirm the remembered token.\nObserved:
${secondRun.visibleText}`);
}

const result = {
  ok: streamingEvidence.streamingObserved,
  agent: options.agent,
  workspaceDir,
  sessionKey: options.sessionKey,
  evidence: {
    continuityConfirmed,
    stdoutChunkCount: streamingEvidence.chunkCount,
    firstChunkAtMs: streamingEvidence.firstChunkAtMs,
    lastChunkAtMs: streamingEvidence.lastChunkAtMs,
    streamingObserved: streamingEvidence.streamingObserved,
    streamingReason: streamingEvidence.streamingReason,
  },
  ...(bindingSummary ? bindingSummary : {}),
};

console.log("");
console.log(streamingEvidence.streamingObserved ? "Live gateway streaming probe OK" : "Live gateway streaming probe did not observe progressive stdout");
console.log(JSON.stringify(result, null, 2));

if (!streamingEvidence.streamingObserved) {
  process.exitCode = 1;
}
