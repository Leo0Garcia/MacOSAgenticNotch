// Small pieces of launcher state under ~/Jarvis: the last run (for
// follow-ups) and the launcher log. The action log belongs to the bridge.

import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Config, FOLLOWUP_WINDOW_MS, paths } from "./config";

export function writeFileAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

export function log(c: Config, msg: string, fields: Record<string, unknown> = {}): void {
  try {
    const p = paths(c).launcherLog;
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify({ at: new Date().toISOString(), msg, ...fields }) + "\n");
  } catch {
    // Logging must never break a run.
  }
}

// ---- last run, for "Jarvis, and also…" -------------------------------------

export interface LastRun {
  sessionId: string;
  keep: boolean;
  endedAt: number;
  /** Only for ephemeral runs, dropped once the follow-up window closes. */
  request?: string;
  reply?: string;
}

export function saveLastRun(c: Config, r: LastRun): void {
  const keepText = !r.keep;
  writeFileAtomic(paths(c).lastRun, JSON.stringify({ ...r, request: keepText ? r.request : undefined, reply: keepText ? r.reply : undefined }));
}

/** The last run if it ended within the follow-up window. Drops stale exchange text. */
export function recentRun(c: Config, now = Date.now()): LastRun | undefined {
  const p = paths(c).lastRun;
  let r: LastRun;
  try {
    r = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
  if (now - r.endedAt <= FOLLOWUP_WINDOW_MS) return r;
  if (r.request !== undefined || r.reply !== undefined) rmSync(p, { force: true });
  return undefined;
}

export function ensureDirs(c: Config): void {
  const p = paths(c);
  for (const d of [c.home, p.runs, p.state, p.logs, p.reminders]) mkdirSync(d, { recursive: true });
}

// ---- runs in progress, so a request mid-task knows what "it" is -----------

export interface ActiveRun {
  sessionId: string;
  pid: number;
  request: string;
  startedAt: number;
  /** The run's opening line, then its latest step. */
  doing?: string;
}

export function saveActiveRun(c: Config, r: ActiveRun): void {
  writeFileAtomic(`${paths(c).active}/${r.sessionId}.json`, JSON.stringify(r));
}

export function clearActiveRun(c: Config, sessionId: string): void {
  rmSync(`${paths(c).active}/${sessionId}.json`, { force: true });
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Runs still working, oldest first. Files left by a launcher that died are removed. */
export function activeRuns(c: Config, except?: string): ActiveRun[] {
  const dir = paths(c).active;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: ActiveRun[] = [];
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as ActiveRun;
      if (!alive(r.pid)) rmSync(`${dir}/${f}`, { force: true });
      else if (r.sessionId !== except) out.push(r);
    } catch {}
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}
