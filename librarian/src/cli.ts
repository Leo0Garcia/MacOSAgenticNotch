#!/usr/bin/env bun
/**
 * Librarian entry point.
 *
 *   bun librarian/src/cli.ts enqueue --stream-log ~/Jarvis/runs/<id>.jsonl [--request TEXT]
 *                                    [--session-id ID] [--keep true|false] [--summary TEXT] [--no-drain]
 *   bun librarian/src/cli.ts drain       # file queued jobs (enqueue starts this detached)
 *   bun librarian/src/cli.ts retry       # put failed jobs back in the queue and drain
 *   bun librarian/src/cli.ts briefing    # rebuild Index.md and ~/Jarvis/briefing.md only
 *   bun librarian/src/cli.ts init-vault  # copy vault-template/ into ~/Jarvis-Memory, never overwriting
 */
import { spawn } from "node:child_process";
import { loadConfig } from "./config";
import { defaultDeps, drain, enqueue, refresh, retryFailed } from "./queue";
import { initVault } from "./vault";

function flags(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out.set(a.slice(2), "true");
    else {
      out.set(a.slice(2), next);
      i++;
    }
  }
  return out;
}

function bool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  if (v === "true") return true;
  if (v === "false") return false;
  throw new Error(`expected true or false, got ${v}`);
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const f = flags(rest);
  const cfg = loadConfig();
  switch (cmd) {
    case "enqueue": {
      const streamLog = f.get("stream-log");
      if (!streamLog) {
        console.error("enqueue needs --stream-log <path>");
        return 2;
      }
      const keep = bool(f.get("keep"));
      const path = await enqueue(cfg, {
        streamLog,
        ...(f.has("request") ? { request: f.get("request")! } : {}),
        ...(f.has("session-id") ? { sessionId: f.get("session-id")! } : {}),
        ...(keep !== undefined ? { keep } : {}),
        ...(f.has("summary") ? { summary: f.get("summary")! } : {}),
      });
      if (!f.has("no-drain")) {
        const child = spawn(process.execPath, [import.meta.path, "drain"], { detached: true, stdio: "ignore", env: process.env });
        child.unref();
      }
      console.log(path);
      return 0;
    }
    case "drain":
      await drain(cfg);
      return 0;
    case "retry":
      console.log(`requeued ${await retryFailed(cfg)} job(s)`);
      await drain(cfg);
      return 0;
    case "briefing":
      await refresh(cfg, defaultDeps);
      return 0;
    case "init-vault": {
      const created = await initVault(cfg);
      console.log(created.length ? `created ${created.join(", ")}` : "vault already set up");
      return 0;
    }
    default:
      console.error("usage: cli.ts enqueue|drain|retry|briefing|init-vault");
      return 2;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`librarian: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
