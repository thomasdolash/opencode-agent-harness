import http from "node:http";

export type AgentHarnessToolDefinition = {
  name: string;
  description: string;
  parameters: unknown;
};

export type AgentHarnessNativeToolResult = {
  content: Array<{ type: string; text?: string; data?: unknown }>;
  details: unknown;
  isError: boolean;
  terminate?: boolean;
};

export type AgentHarnessNativeToolExecutor = (request: {
  callId: string;
  toolName: string;
  arguments: unknown;
  signal?: AbortSignal;
}) => Promise<AgentHarnessNativeToolResult>;

export type NativeToolAttemptBinding = {
  openCodeSessionId: string;
  nativeToolDefinitions?: AgentHarnessToolDefinition[];
  nativeToolExecutor?: AgentHarnessNativeToolExecutor;
  abortSignal?: AbortSignal;
};

const DEFAULT_CALLBACK_HOST = "127.0.0.1";
const DEFAULT_CALLBACK_PORT = 14796;

let activeBindings = new Map<string, NativeToolAttemptBinding>();
let httpServer: http.Server | undefined;
let serverUrl: string | undefined;

function parseJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) { resolve(undefined); return; }
      try { resolve(JSON.parse(raw)); } catch { resolve(undefined); }
    });
    req.on("error", () => resolve(undefined));
  });
}

function jsonResponse(res: http.ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

async function handleNativeTool(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    jsonResponse(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  const body = (await parseJsonBody(req)) as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    jsonResponse(res, 400, { ok: false, error: "Invalid JSON body" });
    return;
  }

  const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() !== "" ? body.sessionId.trim() : undefined;
  const callId = typeof body.callId === "string" && body.callId.trim() !== "" ? body.callId.trim() : undefined;
  const toolName = typeof body.toolName === "string" && body.toolName.trim() !== "" ? body.toolName.trim() : undefined;

  if (!sessionId || !callId || !toolName) {
    jsonResponse(res, 400, { ok: false, error: "Missing required fields: sessionId, callId, toolName" });
    return;
  }

  const binding = activeBindings.get(sessionId);
  if (!binding) {
    jsonResponse(res, 404, { ok: false, error: "No active harness attempt for this session" });
    return;
  }

  if (!binding.nativeToolDefinitions?.some((d) => d.name === toolName)) {
    jsonResponse(res, 404, { ok: false, error: `Native tool not available: ${toolName}` });
    return;
  }

  if (!binding.nativeToolExecutor) {
    jsonResponse(res, 503, { ok: false, error: "Native tool executor not available" });
    return;
  }

  const abortController = new AbortController();
  const onAbort = () => { abortController.abort(); };
  req.on("close", onAbort);

  try {
    const result = await binding.nativeToolExecutor({
      callId,
      toolName,
      arguments: body.arguments,
      signal: abortController.signal,
    });
    jsonResponse(res, 200, { ok: true, result });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    jsonResponse(res, 500, { ok: false, error: `Native tool execution failed: ${message}` });
  } finally {
    req.off("close", onAbort);
  }
}

export async function startNativeToolCallbackServer(host?: string, port?: number): Promise<string> {
  if (httpServer) {
    return serverUrl ?? `http://${host ?? DEFAULT_CALLBACK_HOST}:${port ?? DEFAULT_CALLBACK_PORT}`;
  }

  const listenHost = host ?? DEFAULT_CALLBACK_HOST;
  const listenPort = port ?? DEFAULT_CALLBACK_PORT;

  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? listenHost}`);
        if (url.pathname === "/native-tool") {
          void handleNativeTool(req, res);
        } else {
          jsonResponse(res, 404, { ok: false, error: "Not found" });
        }
      } catch {
        jsonResponse(res, 500, { ok: false, error: "Internal server error" });
      }
    });

    srv.on("error", (err: Error) => {
      reject(err);
    });

    srv.listen(listenPort, listenHost, () => {
      const addr = srv.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : listenPort;
      serverUrl = `http://${listenHost}:${actualPort}`;
      httpServer = srv;
      resolve(serverUrl);
    });
  });
}

export function stopNativeToolCallbackServer(): void {
  if (httpServer) {
    httpServer.close();
    httpServer = undefined;
    serverUrl = undefined;
  }
  activeBindings = new Map();
}

export function registerNativeToolAttempt(sessionId: string, binding: NativeToolAttemptBinding): void {
  if (activeBindings.has(sessionId)) {
    throw new Error(`Native tool attempt already registered for session ${sessionId}`);
  }
  activeBindings.set(sessionId, binding);
}

export function unregisterNativeToolAttempt(sessionId: string, binding: NativeToolAttemptBinding): void {
  const current = activeBindings.get(sessionId);
  if (current === binding) {
    activeBindings.delete(sessionId);
  }
}

export function getActiveBindingCount(): number {
  return activeBindings.size;
}