#!/usr/bin/env bun
// Leo's university timetable from the iCal subscription in Keychain (jarvis/uni-ical).
// Fetched directly, cached for an hour at ~/Jarvis/cache/uni.ics. The URL is a secret:
// it is never printed, logged or put in an error message.
//
//   bun ics.ts [--day today|tomorrow|monday|YYYY-MM-DD] [--days N] [--json] [--cache-only]
//
// Exit 3 = the Keychain item is missing (hand to needs-access). --cache-only never
// touches the network or Keychain (the librarian uses it for briefing.md).
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../lib/atomic.ts";
import { fail, flag, jarvisHome, now, parseArgs, TZ } from "../lib/env.ts";
import { expand, parseRule, type Rule } from "../lib/rrule.ts";
import { addDays, dateKey, fromWall, hhmm, isValidZone, toWall, weekday, WEEKDAYS } from "../lib/tz.ts";

export const KEYCHAIN_SERVICE = "jarvis/uni-ical";
export const CACHE_MAX_AGE_MS = 3600_000;

export interface VEvent {
  uid: string;
  summary: string;
  location: string;
  description: string;
  start: number;
  end: number;
  allDay: boolean;
  tz: string;
  rule?: Rule;
  exdates: Set<number>;
  recurrenceId?: number;
}

export interface Occurrence {
  title: string;
  location: string;
  start: string; // ISO
  end: string;
  allDay: boolean;
  source: string;
}

// Exchange/Outlook-generated feeds use Windows zone names.
const WINDOWS_ZONES: Record<string, string> = {
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Etc/GMT",
  "W. Europe Standard Time": "Europe/Berlin",
  "Romance Standard Time": "Europe/Paris",
  UTC: "UTC",
};

function zoneOf(tzid: string | undefined): string {
  if (!tzid) return TZ;
  const clean = tzid.replace(/^"|"$/g, "");
  if (WINDOWS_ZONES[clean]) return WINDOWS_ZONES[clean]!;
  return isValidZone(clean) ? clean : TZ;
}

function unescapeText(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

/** DTSTART-style value -> instant. Floating times are Europe/London. */
export function parseDateValue(value: string, params: Record<string, string>): { ms: number; allDay: boolean; tz: string } {
  const tz = zoneOf(params.TZID);
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (date || params.VALUE === "DATE") {
    const [, y, mo, d] = /^(\d{4})(\d{2})(\d{2})/.exec(value)!;
    return { ms: fromWall({ y: +y!, mo: +mo!, d: +d!, h: 0, mi: 0, s: 0 }, tz), allDay: true, tz };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!m) throw new Error(`unreadable date ${value}`);
  const [, y, mo, d, h, mi, s, z] = m;
  if (z) return { ms: Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!), allDay: false, tz };
  return { ms: fromWall({ y: +y!, mo: +mo!, d: +d!, h: +h!, mi: +mi!, s: +s! }, tz), allDay: false, tz };
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

function parseLine(line: string): Prop | null {
  // NAME;PARAM=a;PARAM="b:c":value  (colons may appear inside quoted params)
  let i = 0;
  let inQuote = false;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ":" && !inQuote) break;
  }
  if (i >= line.length) return null;
  const [name, ...rawParams] = line.slice(0, i).split(";");
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  return { name: name!.toUpperCase(), params, value: line.slice(i + 1) };
}

export function parseIcs(text: string): VEvent[] {
  // Unfold continuation lines (RFC 5545 3.1).
  const lines = text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const events: VEvent[] = [];
  let cur: Partial<VEvent> & { rawRule?: string; durationMs?: number } | null = null;
  let depth = 0; // skip nested VALARM etc.
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      cur = { exdates: new Set(), summary: "", location: "", description: "", uid: "" };
      depth = 0;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("BEGIN:")) {
      depth++;
      continue;
    }
    if (line.startsWith("END:") && depth > 0) {
      depth--;
      continue;
    }
    if (line === "END:VEVENT") {
      if (cur.start !== undefined) {
        if (cur.end === undefined) {
          cur.end = cur.durationMs !== undefined ? cur.start + cur.durationMs : cur.start + (cur.allDay ? 86400_000 : 0);
        }
        if (cur.rawRule) cur.rule = parseRule(cur.rawRule, (v) => parseDateValue(v, { TZID: cur!.tz ?? TZ }).ms);
        delete cur.rawRule;
        delete cur.durationMs;
        events.push(cur as VEvent);
      }
      cur = null;
      continue;
    }
    if (depth > 0) continue;
    const p = parseLine(line);
    if (!p) continue;
    switch (p.name) {
      case "UID":
        cur.uid = p.value;
        break;
      case "SUMMARY":
        cur.summary = unescapeText(p.value);
        break;
      case "LOCATION":
        cur.location = unescapeText(p.value);
        break;
      case "DESCRIPTION":
        cur.description = unescapeText(p.value);
        break;
      case "DTSTART": {
        const d = parseDateValue(p.value, p.params);
        cur.start = d.ms;
        cur.allDay = d.allDay;
        cur.tz = d.tz;
        break;
      }
      case "DTEND":
        cur.end = parseDateValue(p.value, p.params).ms;
        break;
      case "DURATION":
        cur.durationMs = parseDuration(p.value);
        break;
      case "RRULE":
        cur.rawRule = p.value;
        break;
      case "EXDATE":
        for (const v of p.value.split(",")) cur.exdates!.add(parseDateValue(v, p.params).ms);
        break;
      case "RECURRENCE-ID":
        cur.recurrenceId = parseDateValue(p.value, p.params).ms;
        break;
    }
  }
  return events;
}

function parseDuration(v: string): number {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v);
  if (!m) return 0;
  const [, sign, w, d, h, mi, s] = m;
  const ms = ((+(w ?? 0) * 7 + +(d ?? 0)) * 86400 + +(h ?? 0) * 3600 + +(mi ?? 0) * 60 + +(s ?? 0)) * 1000;
  return sign === "-" ? -ms : ms;
}

/** Every occurrence overlapping [from, to), with RECURRENCE-ID overrides applied, sorted by start. */
export function occurrences(events: VEvent[], from: number, to: number, source = "timetable"): Occurrence[] {
  const overrides = new Map<string, VEvent>();
  for (const e of events) if (e.recurrenceId !== undefined) overrides.set(`${e.uid}@${e.recurrenceId}`, e);
  const out: { e: VEvent; start: number; end: number }[] = [];
  for (const e of events) {
    if (e.recurrenceId !== undefined) {
      if (e.start < to && e.end > from) out.push({ e, start: e.start, end: e.end });
      continue;
    }
    const dur = e.end - e.start;
    const starts = e.rule ? expand(e.start, dur, e.rule, e.tz, from, to, e.exdates) : e.start < to && e.end > from ? [e.start] : [];
    for (const s of starts) if (!overrides.has(`${e.uid}@${s}`)) out.push({ e, start: s, end: s + dur });
  }
  return out
    .sort((a, b) => a.start - b.start || a.e.summary.localeCompare(b.e.summary))
    .map(({ e, start, end }) => ({
      title: e.summary,
      location: e.location,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      allDay: e.allDay,
      source,
    }));
}

/** today | tomorrow | monday… | YYYY-MM-DD -> local midnight range covering `days` days. */
export function dayRange(spec: string, days: number, nowMs: number): { from: number; to: number } {
  const t = toWall(nowMs);
  let base = { y: t.y, mo: t.mo, d: t.d };
  const s = spec.toLowerCase();
  if (s === "tomorrow") base = addDays(base.y, base.mo, base.d, 1);
  else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, mo, d] = s.split("-").map(Number);
    base = { y: y!, mo: mo!, d: d! };
  } else if (WEEKDAYS.includes(s)) {
    const diff = (WEEKDAYS.indexOf(s) - weekday(base.y, base.mo, base.d) + 7) % 7;
    base = addDays(base.y, base.mo, base.d, diff);
  } else if (s !== "today") throw new Error(`I don't know which day "${spec}" is.`);
  const end = addDays(base.y, base.mo, base.d, days);
  return { from: fromWall({ ...base, h: 0, mi: 0, s: 0 }), to: fromWall({ ...end, h: 0, mi: 0, s: 0 }) };
}

export function formatOccurrences(list: Occurrence[], emptyLabel = "Nothing on the timetable."): string {
  if (!list.length) return emptyLabel;
  let lastDay = "";
  const lines: string[] = [];
  for (const o of list) {
    const s = Date.parse(o.start);
    const day = dateKey(s);
    if (day !== lastDay) {
      const w = toWall(s);
      const name = WEEKDAYS[weekday(w.y, w.mo, w.d)]!;
      lines.push(`${name[0]!.toUpperCase()}${name.slice(1)} ${day}`);
      lastDay = day;
    }
    const time = o.allDay ? "all day" : `${hhmm(s)}–${hhmm(Date.parse(o.end))}`;
    lines.push(`  ${time} ${o.title}${o.location ? ` (${o.location})` : ""}`);
  }
  return lines.join("\n");
}

// ---- fetching -------------------------------------------------------------

export class MissingKeyError extends Error {}

export interface Deps {
  readUrl: () => string | null;
  fetchText: (url: string) => Promise<string>;
  cachePath: string;
  nowMs: number;
}

export function keychainUrl(): string | null {
  const r = Bun.spawnSync(["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) return null;
  const v = r.stdout.toString().trim();
  return v || null;
}

export function normaliseUrl(url: string): string {
  return url.replace(/^webcals?:\/\//i, "https://");
}

async function defaultFetch(url: string): Promise<string> {
  const res = await fetch(normaliseUrl(url), { redirect: "follow" });
  // Status only: the URL stays out of every message.
  if (!res.ok) throw new Error(`the timetable server answered ${res.status}`);
  const text = await res.text();
  if (!text.includes("BEGIN:VCALENDAR")) throw new Error("the timetable link didn't return a calendar");
  return text;
}

export function defaultDeps(): Deps {
  return { readUrl: keychainUrl, fetchText: defaultFetch, cachePath: join(jarvisHome(), "cache", "uni.ics"), nowMs: now().getTime() };
}

/** Cached text if fresh, else fetch and cache; stale cache is the fallback when the fetch fails. */
export async function loadTimetable(deps: Deps, opts: { cacheOnly?: boolean } = {}): Promise<{ text: string; stale: boolean }> {
  const cached = existsSync(deps.cachePath) ? { text: readFileSync(deps.cachePath, "utf8"), age: deps.nowMs - statSync(deps.cachePath).mtimeMs } : null;
  if (cached && (opts.cacheOnly || cached.age < CACHE_MAX_AGE_MS)) return { text: cached.text, stale: cached.age >= CACHE_MAX_AGE_MS };
  if (opts.cacheOnly) throw new Error("No cached timetable yet.");
  const url = deps.readUrl();
  if (!url) throw new MissingKeyError(`There's no timetable link in Keychain (${KEYCHAIN_SERVICE}).`);
  try {
    const text = await deps.fetchText(url);
    writeAtomic(deps.cachePath, text);
    return { text, stale: false };
  } catch (e) {
    const why = String((e as Error).message ?? e).replaceAll(url, "<timetable link>").replaceAll(normaliseUrl(url), "<timetable link>");
    if (cached) return { text: cached.text, stale: true };
    throw new Error(`I couldn't fetch your timetable: ${why}`);
  }
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const deps = defaultDeps();
  try {
    const { text, stale } = await loadTimetable(deps, { cacheOnly: flag(args, "cache-only") === "true" });
    const { from, to } = dayRange(flag(args, "day") ?? "today", Number(flag(args, "days") ?? 1), deps.nowMs);
    const list = occurrences(parseIcs(text), from, to);
    if (flag(args, "json")) console.log(JSON.stringify({ stale, events: list }, null, 2));
    else console.log((stale ? "(timetable cache is over an hour old; the live fetch failed)\n" : "") + formatOccurrences(list));
  } catch (e) {
    fail((e as Error).message, e instanceof MissingKeyError ? 3 : 1);
  }
}

if (import.meta.main) await main(process.argv.slice(2));
