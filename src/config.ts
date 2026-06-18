import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";

export type OpenCodeAgentHarnessPluginConfig = {
  server: {
    mode?: "managed" | "remote";
    baseUrl?: string;
    hostname?: string;
    port?: number;
    timeoutMs?: number;
    minVersion?: string;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseOpenCodeAgentHarnessPluginConfig(
  pluginConfig: unknown,
): OpenCodeAgentHarnessPluginConfig {
  if (!isRecord(pluginConfig)) {
    throw new Error(
      "OpenCode harness config is required. Configure plugins.entries.opencode-agent-harness.config.server.baseUrl.",
    );
  }

  const server = isRecord(pluginConfig.server) ? pluginConfig.server : undefined;
  const mode = server?.mode === "remote" ? "remote" : "managed";
  const baseUrl =
    typeof server?.baseUrl === "string" && server.baseUrl.trim() !== ""
      ? server.baseUrl.trim()
      : undefined;
  if (mode === "remote" && !baseUrl) {
    throw new Error(
      "OpenCode remote mode requires plugins.entries.opencode-agent-harness.config.server.baseUrl.",
    );
  }

  const minVersion =
    typeof server?.minVersion === "string" && server.minVersion.trim() !== ""
      ? server.minVersion.trim()
      : undefined;
  const hostname =
    typeof server?.hostname === "string" && server.hostname.trim() !== ""
      ? server.hostname.trim()
      : undefined;
  const port =
    typeof server?.port === "number" && Number.isFinite(server.port) && server.port > 0
      ? Math.trunc(server.port)
      : undefined;
  const timeoutMs =
    typeof server?.timeoutMs === "number" && Number.isFinite(server.timeoutMs) && server.timeoutMs > 0
      ? Math.trunc(server.timeoutMs)
      : undefined;

  return {
    server: {
      mode,
      ...(baseUrl ? { baseUrl } : {}),
      ...(hostname ? { hostname } : {}),
      ...(port ? { port } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
      minVersion,
    },
  };
}

export function resolveLiveOpenCodeAgentHarnessPluginConfig(
  resolveCurrentConfig: (() => OpenClawConfig | undefined) | undefined,
  startupPluginConfig: unknown,
): OpenCodeAgentHarnessPluginConfig {
  const livePluginConfig = resolveLivePluginConfigObject(
    resolveCurrentConfig,
    "opencode-agent-harness",
    isRecord(startupPluginConfig) ? startupPluginConfig : undefined,
  );
  return parseOpenCodeAgentHarnessPluginConfig(livePluginConfig ?? startupPluginConfig);
}
