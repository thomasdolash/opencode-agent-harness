import type {
  AgentHarness,
  ContextEngineHostCapability,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenCodeHarnessLogger } from "./logger.js";

const OPENCODE_HARNESS_HOST_CAPABILITIES = [
  "bootstrap",
  "assemble-before-prompt",
  "after-turn",
  "maintain",
  "runtime-llm-complete",
  "thread-bootstrap-projection",
] as const satisfies readonly ContextEngineHostCapability[];

export function createOpenCodeAgentHarness(options?: {
  id?: string;
  label?: string;
  providerIds?: Iterable<string>;
  pluginConfig?: unknown;
  resolvePluginConfig?: () => unknown;
  logger?: OpenCodeHarnessLogger;
}): AgentHarness {
  const providerIds = new Set(
    [...(options?.providerIds ?? ["opencode"])]
      .map((id) => id.trim().toLowerCase())
      .filter(Boolean),
  );

  return {
    id: options?.id ?? "opencode",
    label: options?.label ?? "OpenCode native agent harness",
    contextEngineHostCapabilities: OPENCODE_HARNESS_HOST_CAPABILITIES,
    deliveryDefaults: {
      sourceVisibleReplies: "automatic",
    },
    nativeToolCapability: {
      tools: ["sessions_send"],
    },
    supports(ctx) {
      const requestedRuntime = (ctx.requestedRuntime ?? "").trim().toLowerCase();
      if (requestedRuntime === "opencode") {
        return { supported: true, priority: 200 };
      }

      const provider = (ctx.provider ?? "").trim().toLowerCase();
      if (providerIds.has(provider)) {
        return { supported: true, priority: 100 };
      }

      const supportedProviders = [...providerIds].toSorted();
      const providerReason = supportedProviders.length
        ? `provider is not one of: ${supportedProviders.join(", ")}`
        : "no provider ids are configured";

      return {
        supported: false,
        reason: `requested runtime is not opencode and ${providerReason}`,
      };
    },
    runAttempt: async (params) => {
      const { runOpenCodeHarnessAttempt } = await import("./app-server/run-attempt.js");
      return runOpenCodeHarnessAttempt(params, {
        logger: options?.logger,
        pluginConfig: options?.resolvePluginConfig?.() ?? options?.pluginConfig,
      });
    },
    reset: async (params) => {
      if (!params.sessionFile) {
        return;
      }

      const { clearOpenCodeHarnessBinding } = await import("./app-server/session-binding.js");
      await clearOpenCodeHarnessBinding(params.sessionFile);

      options?.logger?.debug?.("cleared native session binding", {
        sessionFile: params.sessionFile,
      });
    },
    dispose: async () => {
      const { clearSharedOpenCodeHarnessClientAndWait } = await import("./app-server/shared-client.js");
      await clearSharedOpenCodeHarnessClientAndWait();
      options?.logger?.debug?.("disposed shared native client");
    },
  };
}
