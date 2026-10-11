// Small pieces of launcher state under ~/Jarvis: the last run (for
// follow-ups), the runs table the notch reads, and the launcher log.

import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Config, FOLLOWUP_WINDOW_MS, paths } from "./config";
import type { Denial } from "./stream";

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

// ---- runs table in ~/Jarvis/actions.sqlite ----------------------------------

export interface RunRow {
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  request: string;
  name?: string;
  status: "running" | "done" | "needs-you" | "error";
  keep?: boolean;
  summary?: string;
  denials?: Denial[];
  resumedFrom?: string;
}

function db(c: Config): Database {
  const p = paths(c).db;
  mkdirSync(dirname(p), { recursive: true });
  const d = new Database(p, { create: true });
  d.exec("PRAGMA busy_timeout = 3000; PRAGMA journal_mode = WAL;");
  d.exec(`CREATE TABLE IF NOT EXISTS runs (
    session_id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    request TEXT NOT NULL,
    name TEXT,
    status TEXT NOT NULL,
    keep INTEGER,
    summary TEXT,
    denials TEXT,
    resumed_from TEXT
  )`);
  return d;
}

/** Writes a run row. Ephemeral rows keep only the summary, not the request. */
export function recordRun(c: Config, r: RunRow): void {
  try {
    const d = db(c);
    d.query(
      `INSERT INTO runs (session_id, started_at, ended_at, request, name, status, keep, summary, denials, resumed_from)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT(session_id) DO UPDATE SET ended_at = ?3, request = ?4, name = COALESCE(?5, name), status = ?6,
         keep = ?7, summary = ?8, denials = ?9`,
    ).run(
      r.sessionId,
      r.startedAt,
      r.endedAt ?? null,
      r.keep === false ? "" : r.request,
      r.name ?? null,
      r.status,
      r.keep === undefined ? null : r.keep ? 1 : 0,
      r.summary ?? null,
      r.denials?.length ? JSON.stringify(r.denials) : null,
      r.resumedFrom ?? null,
    );
    d.close();
  } catch (e) {
    log(c, "couldn't record run", { sessionId: r.sessionId, error: String(e) });
  }
}

export function ensureDirs(c: Config): void {
  const p = paths(c);
  for (const d of [c.home, p.runs, p.state, p.logs, p.reminders]) mkdirSync(d, { recursive: true });
}
