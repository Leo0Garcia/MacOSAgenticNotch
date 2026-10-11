// After a run: hand the run log to the librarian, then delete everything an
// ephemeral run left behind. The librarian's `enqueue` is quick (no model
// call) and starts its own detached worker, so Leo never waits on filing.

import { existsSync, readdirSync, rmSync } from "node:fs";
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

/** Deletes a run's own files in ~/Jarvis/runs, refusing anything else. */
export function deleteRunFile(c: Config, file: string): void {
  const p = resolve(file);
  if (dirname(p) !== resolve(paths(c).runs) || !/\.jsonl?$/.test(p)) throw new Error(`not a run file: ${file}`);
  rmSync(p, { force: true });
}

export interface FinalizeInput {
  sessionId: string;
  keep: boolean;
  runLog: string;
  request: string;
  summary: string;
}

/**
 * `librarian/src/cli.ts enqueue` copies what it needs out of the run log
 * before it returns (DESIGN 5), so once it has exited an ephemeral run's
 * transcript and log can go. A missing or failing librarian is logged and
 * never keeps an ephemeral run on disk.
 */
export async function finalize(c: Config, f: FinalizeInput): Promise<void> {
  if (!UUID.test(f.sessionId)) throw new Error(`not a session id: ${f.sessionId}`);
  const p = paths(c);
  if (existsSync(p.librarianCli) && existsSync(f.runLog)) {
    const args = [p.librarianCli, "enqueue", "--stream-log", f.runLog, "--request", f.request, "--session-id", f.sessionId, "--keep", String(f.keep)];
    if (f.summary) args.push("--summary", f.summary);
    const proc = Bun.spawn([c.bunBin, ...args], { cwd: c.home, env: childEnv(c), stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) log(c, "librarian enqueue failed", { sessionId: f.sessionId, code, stderr: err.slice(-2000) });
  } else {
    log(c, "librarian skipped", { sessionId: f.sessionId, librarian: existsSync(p.librarianCli), runLog: existsSync(f.runLog) });
  }
  if (!f.keep) {
    const removed = deleteTranscript(c, f.sessionId);
    deleteRunFile(c, f.runLog);
    log(c, "deleted ephemeral run", { sessionId: f.sessionId, removed: removed.length });
  }
}
