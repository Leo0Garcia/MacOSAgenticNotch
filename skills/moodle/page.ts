#!/usr/bin/env bun
// Helpers for text read from Moodle pages in Chrome. Read only: this never talks to Moodle.
//
//   bun page.ts classify  < page.txt   ->  {"state":"login"|"content"}
//   bun page.ts deadlines < page.txt   ->  [{"title","course","due","dueText"}]  (Upcoming events / Timeline text)
import { now, fail, TZ } from "../lib/env.ts";
import { addDays, fromWall, isoInZone, toWall } from "../lib/tz.ts";

export const MOODLE_HOST = "moodle.ecs.soton.ac.uk";
export const PAGES = {
  dashboard: `https://${MOODLE_HOST}/my/`,
  courses: `https://${MOODLE_HOST}/my/courses.php`,
  upcoming: `https://${MOODLE_HOST}/calendar/view.php?view=upcoming`,
} as const;

// Moodle's own login form, and the Microsoft sign-in Southampton's SSO redirects to.
const LOGIN_MARKERS = [
  /\blog in to the site\b/i,
  /\bforgotten your username or password\b/i,
  /\/login\/index\.php/i,
  /\bsign in to your account\b/i,
  /\bpick an account\b/i,
  /\benter password\b/i,
  /\byou are not logged in\b/i,
];

export function classify(text: string): "login" | "content" {
  if (/\byou are logged in as\b/i.test(text)) return "content";
  return LOGIN_MARKERS.some((re) => re.test(text)) ? "login" : "content";
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

// "Tuesday, 14 October, 4:00 PM" / "Tuesday, 14 October 2026, 16:00" / "Today, 23:59" / "Tomorrow, 9:00 AM"
const DUE =
  /^(?:(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday),\s*(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?|(today|tomorrow))\s*,\s*(\d{1,2}):(\d{2})\s*([ap]m)?\b/i;

const NOISE = /^(add event|new event|go to activity|add submission|view|upcoming events|timeline|calendar|course|event|due|opens|closes|sort by|next 7 days|next 30 days|overdue|all|dates|show more|show more activities|activity|assignment is due|\d+ items?)$/i;

export interface Deadline {
  title: string;
  course: string | null;
  due: string; // ISO with Europe/London offset
  dueText: string;
}

function dueInstant(m: RegExpExecArray, nowMs: number): number {
  const t = toWall(nowMs, TZ);
  let y: number, mo: number, d: number;
  if (m[4]) {
    ({ y, mo, d } = addDays(t.y, t.mo, t.d, m[4].toLowerCase() === "tomorrow" ? 1 : 0));
  } else {
    d = Number(m[1]);
    mo = MONTHS.findIndex((x) => x.startsWith(m[2]!.toLowerCase().slice(0, 3))) + 1;
    y = m[3] ? Number(m[3]) : t.y;
    // No year: pick the year that puts it nearest after "a month ago" (lists show upcoming and overdue).
    if (!m[3] && Date.UTC(y, mo - 1, d) < Date.UTC(t.y, t.mo - 1, t.d) - 31 * 86400_000) y++;
  }
  let h = Number(m[5]);
  const mi = Number(m[6]);
  const ap = m[7]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  return fromWall({ y, mo, d, h, mi, s: 0 }, TZ);
}

/** Pull deadlines out of the Upcoming events or Timeline text. Title = nearest meaningful line above the date. */
export function deadlines(text: string, nowMs: number = now().getTime()): Deadline[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out: Deadline[] = [];
  let lastDateIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = DUE.exec(lines[i]!);
    if (!m) continue;
    let title: string | null = null;
    for (let j = i - 1; j > lastDateIdx; j--) {
      const l = lines[j]!;
      if (NOISE.test(l) || DUE.test(l)) continue;
      if (/^course\s*[:\-]/i.test(l)) continue;
      title = l.replace(/\s+is due$/i, "").replace(/^assignment:\s*/i, "");
      break;
    }
    let course: string | null = null;
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
      const l = lines[j]!;
      if (DUE.test(l)) break;
      const c = /^course\s*[:\-]?\s*(.+)$/i.exec(l) ?? /^([A-Z]{4}\d{4}.*)$/.exec(l);
      if (c) {
        course = c[1]!.trim();
        break;
      }
    }
    if (!course && title) {
      const code = /\b([A-Z]{4}\d{4})\b/.exec(title);
      if (code) course = code[1]!;
    }
    lastDateIdx = i;
    if (!title) continue;
    const ms = dueInstant(m, nowMs);
    out.push({ title, course, due: isoInZone(ms, TZ), dueText: lines[i]! });
  }
  return out.sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
}

if (import.meta.main) {
  const cmd = process.argv[2];
  const text = await Bun.stdin.text();
  if (cmd === "classify") console.log(JSON.stringify({ state: classify(text) }));
  else if (cmd === "deadlines") console.log(JSON.stringify(deadlines(text), null, 2));
  else fail("usage: page.ts classify|deadlines < page.txt", 64);
}
