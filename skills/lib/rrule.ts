// Enough RFC 5545 recurrence to expand a university timetable and Apple Calendar repeats:
// FREQ=DAILY|WEEKLY|MONTHLY (by month day) with INTERVAL, COUNT, UNTIL, BYDAY (weekly), plus EXDATE.
// Occurrences keep their wall-clock time in the event's zone, so 9am stays 9am across BST changes.
import { addDays, dayNumber, fromWall, toWall, weekday, type Wall } from "./tz.ts";

export interface Rule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | string;
  interval: number;
  count?: number;
  until?: number; // ms
  byDay?: number[]; // 0 = Sunday
}

const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** Parse "FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261212T235959Z". `untilParser` handles UNTIL's date forms. */
export function parseRule(text: string, untilParser: (v: string) => number): Rule {
  const kv = new Map<string, string>();
  for (const part of text.replace(/^RRULE:/i, "").split(";")) {
    const [k, v] = part.split("=");
    if (k && v) kv.set(k.toUpperCase(), v);
  }
  const rule: Rule = { freq: (kv.get("FREQ") ?? "").toUpperCase(), interval: Math.max(1, Number(kv.get("INTERVAL") ?? 1)) };
  if (kv.has("COUNT")) rule.count = Number(kv.get("COUNT"));
  if (kv.has("UNTIL")) rule.until = untilParser(kv.get("UNTIL")!);
  if (kv.has("BYDAY")) {
    rule.byDay = kv
      .get("BYDAY")!
      .split(",")
      .map((d) => DAY_CODES.indexOf(d.trim().slice(-2).toUpperCase()))
      .filter((d) => d >= 0);
  }
  return rule;
}

export function isSupported(rule: Rule): boolean {
  return rule.freq === "DAILY" || rule.freq === "WEEKLY" || rule.freq === "MONTHLY";
}

/** Monday-start week index of a date (WKST=MO, the RFC default). */
function weekIndex(y: number, mo: number, d: number): number {
  const n = dayNumber(y, mo, d);
  return Math.floor((n + 3) / 7); // 1970-01-01 was a Thursday
}

/**
 * Start instants of every occurrence that begins before `rangeEnd` and whose end
 * (start + duration) is after `rangeStart`. `exdates` are excluded start instants.
 */
export function expand(
  start: number,
  durationMs: number,
  rule: Rule,
  tz: string,
  rangeStart: number,
  rangeEnd: number,
  exdates: Set<number> = new Set(),
): number[] {
  const maxDays = Math.min(20 * 366, Math.ceil((rangeEnd - start) / 86400_000) + 2);
  if (!isSupported(rule)) return start < rangeEnd && start + durationMs > rangeStart ? [start] : [];
  const w = toWall(start, tz);
  const byDay = rule.freq === "WEEKLY" ? (rule.byDay?.length ? rule.byDay : [weekday(w.y, w.mo, w.d)]) : null;
  const startWeek = weekIndex(w.y, w.mo, w.d);
  const startMonth = w.y * 12 + w.mo;
  const out: number[] = [];
  let produced = 0;
  for (let i = 0; i < maxDays; i++) {
    const dd = addDays(w.y, w.mo, w.d, i);
    let match = false;
    if (rule.freq === "DAILY") match = i % rule.interval === 0;
    else if (rule.freq === "WEEKLY")
      match = byDay!.includes(weekday(dd.y, dd.mo, dd.d)) && (weekIndex(dd.y, dd.mo, dd.d) - startWeek) % rule.interval === 0;
    else if (rule.freq === "MONTHLY") match = dd.d === w.d && (dd.y * 12 + dd.mo - startMonth) % rule.interval === 0;
    if (!match) continue;
    const occ = fromWall({ ...dd, h: w.h, mi: w.mi, s: w.s } as Wall, tz);
    if (rule.until !== undefined && occ > rule.until) break;
    if (occ >= rangeEnd) break;
    produced++; // COUNT counts EXDATE'd occurrences too (RFC 5545 3.8.5.1)
    if (!exdates.has(occ) && occ + durationMs > rangeStart) out.push(occ);
    if (rule.count !== undefined && produced >= rule.count) break;
  }
  return out;
}
