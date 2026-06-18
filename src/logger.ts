import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

export type OpenCodeHarnessLogger = {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  error?: (message: string, meta?: Record<string, unknown>) => void;
};

function formatMessage(message: string, meta?: Record<string, unknown>): string {
  if (!meta || Object.keys(meta).length === 0) {
    return `[opencode-agent-harness] ${message}`;
  }

  try {
    return `[opencode-agent-harness] ${message} ${JSON.stringify(meta)}`;
  } catch {
    return `[opencode-agent-harness] ${message}`;
  }
}

export function createOpenCodeHarnessLogger(logger: PluginLogger | undefined): OpenCodeHarnessLogger {
  return {
    debug: logger?.debug
      ? (message, meta) => logger.debug?.(formatMessage(message, meta))
      : undefined,
    info: logger?.info
      ? (message, meta) => logger.info(formatMessage(message, meta))
      : undefined,
    warn: logger?.warn
      ? (message, meta) => logger.warn(formatMessage(message, meta))
      : undefined,
    error: logger?.error
      ? (message, meta) => logger.error(formatMessage(message, meta))
      : undefined,
  };
}
