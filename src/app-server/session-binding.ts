import fs from "node:fs/promises";
import { withFileLock } from "openclaw/plugin-sdk/file-lock";

const BINDING_LOCK_OPTIONS = {
  retries: { retries: 3, factor: 1, minTimeout: 200, maxTimeout: 200 },
  stale: 30_000,
};

export type OpenCodeHarnessBinding = {
  schemaVersion: 1;
  openCodeSessionId: string;
  sessionFile: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
  turnCount?: number;
};

export function resolveOpenCodeHarnessBindingPath(sessionFile: string): string {
  return `${sessionFile}.opencode-harness-binding.json`;
}

export async function readOpenCodeHarnessBinding(
  sessionFile: string,
): Promise<OpenCodeHarnessBinding | undefined> {
  const path = resolveOpenCodeHarnessBindingPath(sessionFile);
  try {
    const raw = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<OpenCodeHarnessBinding>;
    if (parsed.schemaVersion !== 1 || typeof parsed.openCodeSessionId !== "string") {
      return undefined;
    }
    return {
      schemaVersion: 1,
      openCodeSessionId: parsed.openCodeSessionId,
      sessionFile,
      model: typeof parsed.model === "string" ? parsed.model : undefined,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      turnCount: typeof parsed.turnCount === "number" && Number.isFinite(parsed.turnCount) ? Math.trunc(parsed.turnCount) : undefined,
    };
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function writeOpenCodeHarnessBinding(
  sessionFile: string,
  binding: Omit<OpenCodeHarnessBinding, "schemaVersion" | "sessionFile" | "updatedAt">,
): Promise<void> {
  const path = resolveOpenCodeHarnessBindingPath(sessionFile);
  await withFileLock(path, BINDING_LOCK_OPTIONS, async () => {
    const payload: OpenCodeHarnessBinding = {
      schemaVersion: 1,
      sessionFile,
      openCodeSessionId: binding.openCodeSessionId,
      model: binding.model,
      createdAt: binding.createdAt,
      updatedAt: new Date().toISOString(),
      turnCount: binding.turnCount,
    };
    await fs.writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  });
}

export async function clearOpenCodeHarnessBinding(sessionFile: string): Promise<void> {
  const path = resolveOpenCodeHarnessBindingPath(sessionFile);
  await withFileLock(path, BINDING_LOCK_OPTIONS, async () => {
    try {
      await fs.unlink(path);
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  });
}
