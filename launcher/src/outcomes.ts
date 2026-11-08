// How each Claude run ended, by kind of task, in ~/Jarvis/state/outcomes.jsonl
// (Leo, 2026-11-08). The librarian turns repeated failures, retries and
// corrections into lessons that later runs read in their briefing.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type Config, paths } from "./config";
import { log, recentRun } from "./store";

export interface OutcomeLine {
  at: string;
  sessionId: string;
  /** Absent on a correction line: the librarian takes it from the run's own line. */
  type?: string;
  outcome: "done" | "failed" | "retried" | "blocked" | "corrected";
  request?: string;
  summary?: string;
  problem?: string;
}

const clip = (s: string | undefined, n = 300) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s);

export function appendOutcome(c: Config, o: OutcomeLine): void {
  try {
    const p = paths(c).outcomes;
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify({ ...o, request: clip(o.request), summary: clip(o.summary), problem: clip(o.problem) }) + "\n");
  } catch (e) {
    log(c, "couldn't append outcome", { error: String(e) });
  }
}

/** A tool call as a name for taskType: a skill (by the Skill tool or its script) or the tool. */
export function usedName(name: string, input: Record<string, unknown> = {}): string {
  if (name === "Skill" && typeof input.skill === "string") return `skill:${input.skill}`;
  const script = name === "Bash" && typeof input.command === "string" ? /skills\/([\w-]+)\//.exec(input.command)?.[1] : undefined;
  return script ? `skill:${script}` : name;
}

// Order matters: the first kind any name matches wins.
const KINDS: [RegExp, string][] = [
  [/kanban/i, "kanban"],
  [/calendar|_events?$/i, "calendar"],
  [/moodle/i, "moodle"],
  [/obsidian|notes/i, "notes"],
  [/lights|homebridge/i, "lights"],
  [/remind/i, "reminders"],
  [/slack/i, "slack"],
  [/mail|draft/i, "email"],
  [/chrome|playwright|browser/i, "browser"],
  [/^Web(Search|Fetch)$/, "web research"],
  [/^(Edit|Write|MultiEdit|NotebookEdit)$|github/i, "code"],
];

/** What kind of task a run was, from what it used: skills first, then the main tools. */
export function taskType(used: string[]): string {
  const kind = (names: string[]) => KINDS.find(([re]) => names.some((n) => re.test(n)))?.[1];
  const skills = used.filter((u) => u.startsWith("skill:")).map((u) => u.slice(6));
  if (skills.length) return kind(skills) ?? skills[0]!.toLowerCase().slice(0, 30);
  return kind(used) ?? "other";
}

const CORRECTION =
  /^\s*(?:jarvis[,:]?\s+)?(?:no\b(?![\s,]+(?:worries|problem|thanks|need))|nope\b|actually\b|not that\b)|\b(?:that'?s (?:wrong|not (?:right|it|what i (?:asked|said|meant)))|wrong one|undo (?:that|it)|i said)\b/i;

export const isCorrection = (request: string) => CORRECTION.test(request);

/** Leo's request reads like "no, that's wrong" just after a run: that run was corrected. */
export function noteCorrection(c: Config, request: string, now = Date.now()): void {
  if (!isCorrection(request)) return;
  const last = recentRun(c, now);
  // "fast" is the instant, lights and quick-reply paths, which have no outcome line.
  if (!last || last.sessionId === "fast") return;
  appendOutcome(c, { at: new Date(now).toISOString(), sessionId: last.sessionId, outcome: "corrected", problem: `Leo then said: "${request}"` });
}
