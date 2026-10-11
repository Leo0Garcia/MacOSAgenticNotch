#!/usr/bin/env bun
// Leo's personal calendar from Apple Calendar via osascript (JXA). Read only: the
// script only reads properties; it never makes, saves or deletes anything.
//
//   bun apple.ts [--day today|tomorrow|monday|YYYY-MM-DD] [--days N] [--json]
//
// Calendar's scripting `whose` filter only sees a repeating event's first date, so
// the script also returns repeating events that started before the range and this
// file expands their recurrence itself. Exit 4 = macOS permission missing.
//
// AppleScript answers at about 12 ms per event per field, so with a few thousand
// events it took minutes. The fast path is eventkit.swift, compiled on first use
// into ~/Jarvis/bin/jarvis-calendar; AppleScript is the fallback (no Swift
// compiler), capped at 20 seconds so a run never hangs on Calendar.
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fail, flag, now, parseArgs, TZ } from "../lib/env.ts";
import { expand, parseRule } from "../lib/rrule.ts";
import { formatOccurrences, dayRange, type Occurrence } from "./ics.ts";
import { fromWall } from "../lib/tz.ts";

export interface RawEvent {
  calendar: string;
  title: string;
  start: string; // ISO, absolute
  end: string;
  allDay: boolean;
  location: string | null;
  recurrence: string | null; // RRULE body, e.g. "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO"
}

// argv[0] = range start ISO, argv[1] = range end ISO. Bulk property reads keep it to a
// handful of Apple events per calendar.
export const JXA = `
function run(argv) {
  const from = new Date(argv[0]), to = new Date(argv[1]);
  const Cal = Application("Calendar");
  const out = [];
  for (const c of Cal.calendars()) {
    const spec = c.events.whose({ startDate: { _lessThan: to } });
    const n = spec.length;
    if (!n) continue;
    const starts = spec.startDate(), ends = spec.endDate(), titles = spec.summary(),
      allDay = spec.alldayEvent(), locs = spec.location(), recs = spec.recurrence();
    const cal = c.name();
    for (let i = 0; i < starts.length; i++) {
      const rec = recs[i] || null;
      if (!rec && !(ends[i] > from)) continue;
      out.push({ calendar: cal, title: titles[i] || "", start: starts[i].toISOString(), end: ends[i].toISOString(),
        allDay: !!allDay[i], location: locs[i] || null, recurrence: rec });
    }
  }
  return JSON.stringify(out);
}
`;

export class AutomationDenied extends Error {}

export type Runner = (from: Date, to: Date) => { ok: boolean; stdout: string; stderr: string };

export const OSASCRIPT_TIMEOUT_MS = 20_000;

export const osascriptRunner: Runner = (from, to) => {
  const r = Bun.spawnSync(["osascript", "-l", "JavaScript", "-e", JXA, from.toISOString(), to.toISOString()], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: OSASCRIPT_TIMEOUT_MS,
  });
  if (r.exitCode === null) {
    return { ok: false, stdout: "", stderr: "TIMEOUT: Apple Calendar took longer than 20 seconds to answer." };
  }
  return { ok: r.exitCode === 0, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
};

const HELPER_SRC = join(import.meta.dir, "eventkit.swift");
const HELPER_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.jarvis.calendar</string>
<key>CFBundleName</key><string>Jarvis Calendar</string>
<key>NSCalendarsFullAccessUsageDescription</key><string>Jarvis reads your calendar to answer questions about your day. It never changes events.</string>
</dict></plist>
`;

/** ~/Jarvis/bin/jarvis-calendar, (re)built when eventkit.swift is newer. Null if it can't be built. */
export function eventkitHelper(home = process.env.JARVIS_HOME ?? join(homedir(), "Jarvis")): string | null {
  const bin = join(home, "bin", "jarvis-calendar");
  try {
    if (existsSync(bin) && statSync(bin).mtimeMs >= statSync(HELPER_SRC).mtimeMs) return bin;
    mkdirSync(join(home, "bin"), { recursive: true });
    const plist = join(home, "bin", "jarvis-calendar.Info.plist");
    writeFileSync(plist, HELPER_PLIST);
    const r = Bun.spawnSync(
      ["xcrun", "swiftc", "-O", HELPER_SRC, "-o", bin, "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", plist],
      { stdout: "pipe", stderr: "pipe", timeout: 120_000 },
    );
    return r.exitCode === 0 && existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

/** EventKit: occurrences come back already expanded (recurrence null). */
export function eventkitRunner(bin: string): Runner {
  return (from, to) => {
    const r = Bun.spawnSync([bin, from.toISOString(), to.toISOString()], { stdout: "pipe", stderr: "pipe", timeout: 130_000 });
    if (r.exitCode === 4) return { ok: false, stdout: "", stderr: "DENIED: " + r.stderr.toString() };
    if (r.exitCode === null) return { ok: false, stdout: "", stderr: "TIMEOUT: Calendar didn't answer." };
    return { ok: r.exitCode === 0, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  };
}

export function toOccurrences(raw: RawEvent[], from: number, to: number): Occurrence[] {
  const out: (Occurrence & { ms: number })[] = [];
  for (const e of raw) {
    const start = Date.parse(e.start);
    const dur = Date.parse(e.end) - start;
    const starts = e.recurrence
      ? expand(start, dur, parseRule(e.recurrence, untilValue), TZ, from, to)
      : start < to && start + dur > from
        ? [start]
        : [];
    for (const s of starts) {
      out.push({
        ms: s,
        title: e.title,
        location: e.location ?? "",
        start: new Date(s).toISOString(),
        end: new Date(s + dur).toISOString(),
        allDay: e.allDay,
        source: e.calendar,
      });
    }
  }
  return out.sort((a, b) => a.ms - b.ms).map(({ ms: _ms, ...o }) => o);
}

function untilValue(v: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v);
  if (!m) return Infinity;
  const [, y, mo, d, h, mi, s, z] = m;
  if (z) return Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!);
  // A date-only UNTIL includes that whole day.
  return fromWall({ y: +y!, mo: +mo!, d: +d!, h: h ? +h : 23, mi: mi ? +mi : 59, s: s ? +s : 59 });
}

export function readCalendar(runner: Runner, from: number, to: number): Occurrence[] {
  const r = runner(new Date(from), new Date(to));
  if (!r.ok) {
    // -1743: "Not authorised to send Apple events" (Automation permission); DENIED: EventKit.
    if (/-1743|not authori[sz]ed|^DENIED:/i.test(r.stderr)) {
      throw new AutomationDenied("I'm not allowed to read Calendar.");
    }
    if (r.stderr.startsWith("TIMEOUT:")) throw new Error(r.stderr.slice(9).trim());
    throw new Error(`Calendar didn't answer: ${r.stderr.trim().split("\n").at(-1) ?? "unknown error"}`);
  }
  return toOccurrences(JSON.parse(r.stdout) as RawEvent[], from, to);
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const { from, to } = dayRange(flag(args, "day") ?? "today", Number(flag(args, "days") ?? 1), now().getTime());
    const helper = eventkitHelper();
    const list = readCalendar(helper ? eventkitRunner(helper) : osascriptRunner, from, to);
    console.log(flag(args, "json") ? JSON.stringify({ events: list }, null, 2) : formatOccurrences(list, "Nothing in your calendar."));
  } catch (e) {
    fail((e as Error).message, e instanceof AutomationDenied ? 4 : 1);
  }
}
