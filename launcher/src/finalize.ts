// After a run: hand the run log to the librarian, then delete everything an
// ephemeral run left behind. Runs detached so Leo never waits for it.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { childEnv, type Config, paths } from "./config";
import { log } from "./store";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Deletes Claude Code's transcript for a session: projects/<dir>/<id>.jsonl
 * and the projects/<dir>/<id>/ folder beside it (subagent and tool output).
 * Searches every project folder, since the folder name is derived from the
 * working directory. Only ever removes entries named exactly after the id.
 */
export function deleteTranscript(c: Config, sessionId: string): string[] {
  if (!UUID.test(sessionId)) throw new Error(`not a session id: ${sessionId}`);
  const root = join(c.claudeConfigDir, "projects");
  const removed: string[] = [];
  if (!existsSync(root)) return removed;
  for (const dir of readdirSync(root)) {
    for (const name of [`${sessionId}.jsonl`, sessionId]) {
      const p = join(root, dir, name);
      if (existsSync(p)) {
        rmSync(p, { recursive: true, force: true });
        removed.push(p);
      }
    }
  }
  return removed;
}

/** Deletes a run log, refusing anything outside ~/Jarvis/runs. */
export function deleteRunLog(c: Config, runLog: string): void {
  const p = resolve(runLog);
  if (dirname(p) !== resolve(paths(c).runs) || !p.endsWith(".jsonl")) throw new Error(`not a run log: ${runLog}`);
  rmSync(p, { force: true });
}

const LOCK_STALE_MS = 15 * 60 * 1000;

/** One librarian at a time (DESIGN 5): a mkdir lock, broken when stale. */
async function withLibrarianLock<T>(c: Config, fn: () => Promise<T>, waitMs = LOCK_STALE_MS): Promise<T> {
  const lock = paths(c).librarianLock;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
      } catch {}
      if (Date.now() > deadline) throw new Error("timed out waiting for the librarian lock");
      await Bun.sleep(500);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * Runs the librarian on a finished run, waits for it, then deletes the
 * transcript and run log if the run was ephemeral. A missing or failing
 * librarian is logged, and never stops the delete.
 */
export async function finalize(c: Config, sessionId: string, keep: boolean, runLog: string): Promise<void> {
  const p = paths(c);
  if (existsSync(p.librarian) && existsSync(runLog)) {
    try {
      await withLibrarianLock(c, async () => {
        const proc = Bun.spawn([p.librarian, "--run-log", runLog, "--session-id", sessionId, "--keep", String(keep)], {
          cwd: c.home,
          env: childEnv(c, { CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1" }),
          stdout: "ignore",
          stderr: "pipe",
        });
        const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
        if (code !== 0) log(c, "librarian failed", { sessionId, code, stderr: err.slice(-2000) });
      });
    } catch (e) {
      log(c, "librarian didn't run", { sessionId, error: String(e) });
    }
  } else {
    log(c, "librarian skipped", { sessionId, librarian: existsSync(p.librarian), runLog: existsSync(runLog) });
  }
  if (!keep) {
    const removed = deleteTranscript(c, sessionId);
    deleteRunLog(c, runLog);
    log(c, "deleted ephemeral run", { sessionId, removed: removed.length });
  }
}

/** Starts `cli.ts finalize` in the background and returns at once. */
export function startFinalize(c: Config, sessionId: string, keep: boolean, runLog: string): void {
  const p = paths(c);
  mkdirSync(p.logs, { recursive: true });
  const child = spawn(c.bunBin, [p.cli, "finalize", "--session", sessionId, "--keep", String(keep), "--run-log", runLog], {
    cwd: c.home,
    env: childEnv(c),
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
