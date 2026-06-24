import { run } from "node:test";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { Writable } from "node:stream";

function collectFiles(root: string): string[] {
  const result: string[] = [];
  try {
    for (const entry of readdirSync(root)) {
      const full = resolve(root, entry);
      if (entry.endsWith(".test.ts")) {
        result.push(full);
      } else if (statSync(full).isDirectory()) {
        result.push(...collectFiles(full));
      }
    }
  } catch {}
  return result;
}

const args = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
});

const patterns = args.positionals.length > 0
  ? args.positionals
  : ["tests"];

const files = patterns.flatMap((p) => {
  const resolved = resolve(p);
  try {
    if (statSync(resolved).isDirectory()) {
      return collectFiles(resolved);
    }
  } catch {}
  if (p.endsWith(".test.ts") || p.endsWith(".ts")) {
    return [resolved];
  }
  return [];
});

if (files.length === 0) {
  process.stdout.write("No test files found\n");
  process.exit(0);
}

const testStream = run({
  files,
  concurrency: 1,
  timeout: 30000,
});

testStream.on("test:fail", () => {
  process.exitCode = 1;
});

const tap = new Writable({
  objectMode: true,
  write(event: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    if (event && typeof event === "object" && "type" in event) {
      const ev = event as Record<string, unknown>;
      if (ev.type === "test:pass" || ev.type === "test:fail") {
        const data = ev.data as Record<string, unknown> | undefined;
        const icon = ev.type === "test:pass" ? "✔" : "✖";
        process.stdout.write(`${icon} ${(data?.name as string) ?? ev.type}\n`);
      }
    }
    callback();
  },
});

testStream.pipe(tap);