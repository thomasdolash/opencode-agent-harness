#!/usr/bin/env -S node --import tsx
import process from "node:process";

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_BASE_URL?.trim() || "http://127.0.0.1:18789";
const TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || "";
const UNIQUE_MARKER = `PARENT_CHILD_FINAL_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

if (!TOKEN) throw new Error("OPENCLAW_GATEWAY_TOKEN required");

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const url = `${GATEWAY_URL}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 1000)}`);
  return text ? JSON.parse(text) : null;
}

async function chatCompletions(model: string, prompt: string, opts?: { stream?: boolean; maxTokens?: number }): Promise<{
  content: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  sessionKey?: string;
}> {
  const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: opts?.stream ?? false,
      max_tokens: opts?.maxTokens ?? 4000,
      user: `e2e-parent-spawn-${Date.now()}`,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 1000)}`);
  }
  const data = JSON.parse(await res.text()) as Record<string, unknown>;
  const choice = (data.choices as Array<Record<string, unknown>>)?.[0];
  const msg = choice?.message as Record<string, unknown> | undefined;
  const content = (msg?.content as string) ?? "";
  const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rawCalls = msg?.tool_calls as Array<Record<string, unknown>> | undefined;
  if (rawCalls) {
    for (const tc of rawCalls) {
      const fn = tc.function as Record<string, unknown> | undefined;
      if (fn) {
        toolCalls.push({
          name: fn.name as string,
          args: JSON.parse(fn.arguments as string) as Record<string, unknown>,
        });
      }
    }
  }
  // session key comes from the `user` field echoed back in usage/response metadata
  const id = (choice as Record<string, unknown>)?.session_id ?? (data as Record<string, unknown>)?.session_id;
  return { content, toolCalls, sessionKey: typeof id === "string" ? id : undefined };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log("=== E2E: Spawned Child sessions_send ===");
  console.log(`Gateway: ${GATEWAY_URL}`);
  console.log(`Marker:  ${UNIQUE_MARKER}`);
  console.log("");

  // Step 1: Parent (default agent, has sessions_spawn) spawns an opencode child
  console.log("Step 1: Parent spawns opencode child child...");
  const parentPrompt = `You are the PARENT agent. Your task has TWO PARTS.

PART 1: Call sessions_spawn to spawn a child subagent.

Use these exact parameters:
- agentId: "opencode"
- mode: "run"
- task: "Call sessions_send exactly once to send the exact message '${UNIQUE_MARKER}' to your parent session. After calling sessions_send successfully, reply only: CHILD_DONE. If sessions_send is unavailable, reply only: TOOL_UNAVAILABLE."
- label: "e2e-child-test"
- cleanup: "delete"

PART 2: After spawning, report what happened.

IMPORTANT: You MUST call sessions_spawn first. Do not skip the spawn step.`;

  const parentResult = await chatCompletions("openclaw/default", parentPrompt, { maxTokens: 6000 });
  console.log(`Parent content: ${parentResult.content.slice(0, 800)}`);
  console.log(`Parent tool calls: ${JSON.stringify(parentResult.toolCalls, null, 2)}`);

  if (parentResult.content.includes(UNIQUE_MARKER)) {
    console.log("\n✓ CHILD SUCCESSFULLY DELIVERED MARKER TO PARENT");
    return;
  }

  // Step 2: The spawn might return a child session key. Let's check.
  const spawnCall = parentResult.toolCalls.find((tc) => tc.name === "sessions_spawn");
  if (spawnCall) {
    console.log("\nsessions_spawn was called with args:", JSON.stringify(spawnCall.args, null, 2));
  }

  // Step 3: Wait and poll for child's message
  console.log("\nWaiting for child delivery...");
  const childSessionKey = spawnCall?.args?.childSessionKey;
  if (typeof childSessionKey === "string") {
    console.log(`Child session key from args: ${childSessionKey}`);
  }

  // Give the child time to execute
  await sleep(30000);

  // Step 4: Send a follow-up to the parent asking what happened
  const followUpPrompt = `Did the child subagent call sessions_send to deliver the marker '${UNIQUE_MARKER}'? Check your session messages and report what you received.`;
  const followUpResult = await chatCompletions("openclaw/default", followUpPrompt, { maxTokens: 4000 });
  console.log(`\nFollow-up content: ${followUpResult.content.slice(0, 800)}`);
  console.log(`Follow-up tool calls: ${JSON.stringify(followUpResult.toolCalls, null, 2)}`);

  if (followUpResult.content.includes(UNIQUE_MARKER)) {
    console.log("\n✓ CHILD SUCCESSFULLY DELIVERED MARKER TO PARENT");
  } else {
    console.log("\n✗ MARKER NOT FOUND IN PARENT RESPONSE");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});