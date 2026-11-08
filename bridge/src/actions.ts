// ~/Jarvis/actions.sqlite: the action log the notch's hover view reads
// (phase 2). The bridge owns the schema; the launcher and reminders append
// through appendAction or `bun bridge/src/cli.ts log`.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { actionsDb } from "./config";
import { ACTION_KINDS, type ActionKind, type ActionRow } from "./protocol";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS actions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT    NOT NULL,              -- ISO 8601 UTC
  session_id TEXT,                          -- Claude Code session id, null outside a run
  kind       TEXT    NOT NULL,              -- run | action | note | guard | reminder
  summary    TEXT    NOT NULL,              -- one line, shown in the notch
  detail     TEXT,
  saved      INTEGER NOT NULL DEFAULT 0     -- 1 when the run was kept (row opens the session)
);
CREATE INDEX IF NOT EXISTS actions_ts ON actions (ts DESC);
`;

export interface NewAction {
  kind: ActionKind;
  summary: string;
  detail?: string | null;
  sessionId?: string | null;
  saved?: boolean;
  now?: Date;
}

function open(home: string): Database {
  const path = actionsDb(home);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA busy_timeout = 3000; PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}

export function appendAction(home: string, a: NewAction): ActionRow {
  if (!ACTION_KINDS.includes(a.kind)) throw new Error(`kind must be one of ${ACTION_KINDS.join(", ")}`);
  const summary = a.summary.trim().replace(/\s+/g, " ");
  if (!summary) throw new Error("summary is required");
  const db = open(home);
  try {
    const ts = (a.now ?? new Date()).toISOString();
    const res = db
      .query(
        "INSERT INTO actions (ts, session_id, kind, summary, detail, saved) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(ts, a.sessionId ?? null, a.kind, summary, a.detail ?? null, a.saved ? 1 : 0);
    return {
      id: Number(res.lastInsertRowid),
      ts,
      session_id: a.sessionId ?? null,
      kind: a.kind,
      summary,
      detail: a.detail ?? null,
      saved: !!a.saved,
    };
  } finally {
    db.close();
  }
}

export function recentActions(home: string, limit = 8): ActionRow[] {
  const db = open(home);
  try {
    const rows = db
      .query("SELECT id, ts, session_id, kind, summary, detail, saved FROM actions ORDER BY id DESC LIMIT ?")
      .all(limit) as (Omit<ActionRow, "saved"> & { saved: number })[];
    return rows.map((r) => ({ ...r, saved: r.saved === 1 }));
  } finally {
    db.close();
  }
}

/** Replaces a row's detail, e.g. a run's timing breakdown once its speech has finished. */
export function setActionDetail(home: string, id: number, detail: string | null): void {
  const db = open(home);
  try {
    db.query("UPDATE actions SET detail = ? WHERE id = ?").run(detail, id);
  } finally {
    db.close();
  }
}

/** Rows since a time (ISO 8601), oldest first: the evening wrap-up reads the day's. */
export function actionsSince(home: string, sinceIso: string, untilIso = "9999"): ActionRow[] {
  const db = open(home);
  try {
    const rows = db
      .query("SELECT id, ts, session_id, kind, summary, detail, saved FROM actions WHERE ts >= ? AND ts < ? ORDER BY id")
      .all(sinceIso, untilIso) as (Omit<ActionRow, "saved"> & { saved: number })[];
    return rows.map((r) => ({ ...r, saved: r.saved === 1 }));
  } finally {
    db.close();
  }
}
