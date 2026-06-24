import crypto from "node:crypto";

const CALLBACK_URL_KEY = "OPENCODE_NATIVE_TOOL_CALLBACK_URL";
const ALLOWED_TOOLS = ["sessions_send"];

async function server(_input: unknown, _options?: Record<string, unknown>) {
  const callbackUrl = process.env[CALLBACK_URL_KEY];
  if (!callbackUrl) {
    throw new Error(`OpenCode native tool bridge: ${CALLBACK_URL_KEY} is not set`);
  }

  return {
    tool: {
      sessions_send: {
        description:
          "Send a progress update, question, or final result to the current OpenClaw parent session. Use the parent session key supplied in your system context.",
        args: {
          sessionKey: { type: "string", description: "Target OpenClaw session key" },
          message: { type: "string", description: "Plain text message content" },
          timeoutSeconds: { type: "integer", description: "Optional timeout in seconds (minimum 0)", optional: true, minimum: 0 },
        },
        async execute(args: Record<string, unknown>, context: Record<string, unknown>) {
          const callId = crypto.randomUUID();
          const sessionId = typeof context.sessionID === "string" ? context.sessionID : "";
          const sessionKey = typeof args.sessionKey === "string" ? args.sessionKey : "";
          const message = typeof args.message === "string" ? args.message : "";
          const timeoutSeconds = typeof args.timeoutSeconds === "number" ? args.timeoutSeconds : undefined;

          if (!sessionId || !sessionKey || !message) {
            return JSON.stringify({ title: "sessions_send (error)", output: "Missing required arguments: sessionKey, message" });
          }

          const body = {
            sessionId,
            callId,
            toolName: "sessions_send",
            arguments: {
              sessionKey,
              message,
              ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
            },
          };

          let response: Response;
          try {
            const signal: AbortSignal | undefined =
              typeof context.abort !== "undefined"
                ? (context as { abort: AbortSignal }).abort
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
            return JSON.stringify({ title: "sessions_send (error)", output: abortMsg });
          }

          let responseBody: { ok: boolean; result?: { content: Array<{ type: string; text?: string }>; isError: boolean; details?: unknown }; error?: string };
          try {
            responseBody = await response.json() as typeof responseBody;
          } catch {
            return JSON.stringify({ title: "sessions_send (error)", output: "Invalid response from native tool bridge" });
          }

          if (!responseBody.ok || !responseBody.result) {
            return JSON.stringify({ title: "sessions_send (error)", output: responseBody.error ?? "Native tool call failed" });
          }

          const result = responseBody.result;
          const textParts = (result.content ?? [])
            .filter((item) => item.type === "text" && typeof item.text === "string")
            .map((item) => item.text as string);

          const output = textParts.length > 0 ? textParts.join("\n") : "Native tool completed without textual output.";

          if (result.isError) {
            return JSON.stringify({ title: "sessions_send (error)", output });
          }

          return JSON.stringify({ title: "sessions_send", output });
        },
      },
    },
  };
}

export default { id: "opencode-native-tool-bridge", server };
