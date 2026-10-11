// Paths every skill script agrees on. Same variables and defaults as guard/.
import { homedir } from "node:os";
import { join } from "node:path";

export const TZ = "Europe/London";

export function jarvisHome(): string {
  return process.env.JARVIS_HOME ?? join(homedir(), "Jarvis");
}

export function jarvisMemory(): string {
  return process.env.JARVIS_MEMORY ?? join(homedir(), "Jarvis-Memory");
}

export function masterVault(): string {
  return process.env.JARVIS_MASTER_VAULT ?? "/Users/leogarcia/Documents/Obsidian Master Vault";
}

/** Fixed clock for tests and replays: JARVIS_NOW=2026-10-11T13:00:00Z. */
export function now(): Date {
  const fixed = process.env.JARVIS_NOW;
  return fixed ? new Date(fixed) : new Date();
}

/** Minimal flag parser: --key value, --flag, and positionals. Repeated keys collect into arrays. */
export function parseArgs(argv: string[]): { _: string[]; flags: Record<string, string[]> } {
  const out = { _: [] as string[], flags: {} as Record<string, string[]> };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const value = next !== undefined && !next.startsWith("--") ? (i++, next) : "true";
      (out.flags[key] ??= []).push(value);
    } else {
      out._.push(a);
    }
  }
  return out;
}

export function flag(args: { flags: Record<string, string[]> }, key: string): string | undefined {
  return args.flags[key]?.at(-1);
}

/** Print a one-line error for Claude to relay and exit non-zero. */
export function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}
