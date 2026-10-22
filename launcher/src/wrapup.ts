// "Wrap up my day" (Leo, 2026-10-22): what got done, what moved on the
// Kanban, and what's first tomorrow, without a Claude run. A day runs 5am to
// 5am, so asking just after midnight wraps up the day that has just ended.
// What moved on the Kanban comes from a snapshot of the board taken the first
// time each day the rundown, the morning check or the wrap-up reads it.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionRow } from "../../bridge/src/protocol";
import { type Config, paths } from "./config";
import { writeFileAtomic } from "./store";

export interface KanbanSnapshot {
  done: string[];
  todo: string[];
}

const DAY_START_HOUR = 5;
const londonDate = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Europe/London" });

/** The day a time belongs to (YYYY-MM-DD): before 5am counts as the day before. */
export const jarvisDay = (d: Date) => londonDate(new Date(d.getTime() - DAY_START_HOUR * 3600_000));
export const nextDay = (day: string) => new Date(Date.parse(`${day}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10);

const snapFile = (c: Config) => join(paths(c).state, "kanban-days.json");

function loadSnaps(c: Config): Record<string, KanbanSnapshot> {
  try {
    return JSON.parse(readFileSync(snapFile(c), "utf8"));
  } catch {
    return {};
  }
}

/** Saves the board as the day's starting point, unless the day has one. Keeps a week. */
export function snapshotKanban(c: Config, board: KanbanSnapshot, now = new Date()): void {
  const day = jarvisDay(now);
  const all = loadSnaps(c);
  if (all[day]) return;
  all[day] = board;
  const keep = Object.keys(all).sort().slice(-7);
  writeFileAtomic(snapFile(c), JSON.stringify(Object.fromEntries(keep.map((k) => [k, all[k]])), null, 2));
}

/** The board as it was at the start of `day`, or the closest earlier day. */
export function baseline(c: Config, day: string): KanbanSnapshot | null {
  const all = loadSnaps(c);
  const k = Object.keys(all).filter((d) => d <= day).sort().at(-1);
  return k ? all[k]! : null;
}

/** Kanban list --all --json, split into finished and still-to-do cards. */
export function boardFromLanes(lanes: { complete: boolean; cards: string[] }[]): KanbanSnapshot {
  return { done: lanes.filter((l) => l.complete).flatMap((l) => l.cards), todo: lanes.filter((l) => !l.complete).flatMap((l) => l.cards) };
}

// Requests that aren't worth recounting at night.
const ROUTINE = /^(?:gave leo the rundown|checked what's next|volume:|checked the lights|lights:|wrapped up|noted:|timer:|opened |told leo the time|hit the claude usage limit|claude sign-in expired|claude api error|couldn't start)/i;

export interface WrapInput {
  now: Date;
  day: string;
  actions: ActionRow[];
  board: KanbanSnapshot | null;
  start: KanbanSnapshot | null;
  /** Tomorrow's events, already sorted. */
  tomorrow: { title: string; start: string; allDay?: boolean }[];
  deadlines: { title: string; course: string | null; due: string }[];
}

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
const dayName = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { weekday: "long", timeZone: "Europe/London" });
const list = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const shortTitle = (t: string) => /^[A-Z]{2,5}\d{4}\S*(?: \S+)? ?- ?(.+)$/.exec(t)?.[1] ?? t;
const cardText = (t: string) => t.replace(/\[\[[^\]|]*\|([^\]]+)\]\]/g, "$1").replace(/\[\[([^\]]+)\]\]/g, "$1").replace(/@\{[^}]*\}/g, "").replace(/#[\w/-]+/g, "").replace(/\s+/g, " ").trim();
/** A log line as said to Leo: "Told Leo the weather" → "told you the weather". */
const spoken = (s: string) => {
  const t = s.replace(/\.$/, "").replace(/\bLeo's\b/g, "your").replace(/\bLeo\b/g, "you");
  return t.charAt(0).toLowerCase() + t.slice(1);
};

/** About fifteen seconds of "here's how today went". */
export function wrapUp(i: WrapInput): string {
  const out: string[] = [];
  const asks = i.actions.filter((a) => (a.kind === "run" || a.kind === "action") && !ROUTINE.test(a.summary));
  if (asks.length) {
    // Saved work first: it's what Leo will come back to.
    const top = [...asks].sort((a, b) => Number(b.saved) - Number(a.saved) || Number(b.kind === "run") - Number(a.kind === "run")).slice(0, 3);
    out.push(`You had me on ${asks.length === 1 ? "one thing" : `${asks.length} things`} today${asks.length > 1 ? `, mainly: ${list(top.map((a) => spoken(a.summary)))}` : `: ${spoken(asks[0]!.summary)}`}.`);
  } else {
    out.push("Quiet day: you didn't need me for much.");
  }
  if (i.board && i.start) {
    const was = new Set([...i.start.done, ...i.start.todo]);
    const finished = i.board.done.filter((c) => !i.start!.done.includes(c)).map(cardText);
    const added = i.board.todo.filter((c) => !was.has(c)).map(cardText);
    const parts: string[] = [];
    if (finished.length) parts.push(`you finished ${list(finished.slice(0, 3))}${finished.length > 3 ? ` and ${finished.length - 3} more` : ""}`);
    if (added.length) parts.push(`${added.length === 1 ? "one card was" : `${added.length} cards were`} added`);
    if (parts.length) out.push(`On the Kanban, ${parts.join(", and ")}.`);
    else out.push(`Nothing moved on the Kanban; ${i.board.todo.length} cards to do.`);
  } else if (i.board) {
    out.push(`${i.board.todo.length} cards left on the Kanban.`);
  }
  const first = i.tomorrow.find((e) => !e.allDay);
  out.push(first ? `Tomorrow starts with ${shortTitle(first.title)} at ${hhmm(first.start)}.` : "Nothing on your calendar tomorrow.");
  const from = Date.parse(`${nextDay(i.day)}T00:00:00Z`);
  const soon = i.deadlines.filter((d) => Date.parse(d.due) > i.now.getTime() && Date.parse(d.due) - from < 3 * 86400_000).sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
  if (soon.length) out.push(`Due soon on Moodle: ${list(soon.slice(0, 2).map((d) => `${d.title}, ${dayName(d.due)} at ${hhmm(d.due)}`))}.`);
  return out.join(" ");
}

/** "note that the essay needs a conclusion" → the master vault's Inbox.md. Returns the line added. */
export function addNote(vault: string, text: string, now = new Date()): string {
  const file = join(vault, "Inbox.md");
  const stamp = now.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }).replace(",", "");
  const line = `- ${text} (${stamp})`;
  if (!existsSync(file)) writeFileSync(file, "# Inbox\n\nQuick notes from Jarvis.\n\n");
  else if (!readFileSync(file, "utf8").endsWith("\n")) appendFileSync(file, "\n");
  appendFileSync(file, `${line}\n`);
  return line;
}
