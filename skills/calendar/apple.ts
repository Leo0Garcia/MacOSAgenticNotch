#!/usr/bin/env bun
// Leo's personal calendar from Apple Calendar. Reads, and adds events through the
// notch app; it never edits or deletes one.
//
//   bun apple.ts [--day today|tomorrow|monday|YYYY-MM-DD] [--days N] [--json]
//   bun apple.ts add --title T --start YYYY-MM-DDTHH:MM (--end YYYY-MM-DDTHH:MM | --minutes N)
//                    [--all-day] [--location L] [--calendar NAME] [--repeat daily|weekly|monthly|yearly] [--until YYYY-MM-DD]
//
// Times without a zone are Europe/London wall time. Adding needs the notch app running
// (exit 5 otherwise): it is the process holding the Calendars permission.
//
// Calendar's scripting `whose` filter only sees a repeating event's first date, so
// the script also returns repeating events that started before the range and this
// file expands their recurrence itself. Exit 4 = macOS permission missing.
//
// AppleScript answers at about 12 ms per event per field, so with a few thousand
// events it took minutes. The fast path asks the notch app over its socket: the
// app holds the Calendars permission and reads through EventKit. Without the app,
// eventkit.swift (compiled on first use into ~/Jarvis/bin/jarvis-calendar), then
// AppleScript, capped at 20 seconds so a run never hangs on Calendar.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

/**
 * Sends one request to the notch app, which holds the Calendars permission, over its
 * socket (DESIGN 8.2) and resolves with its `<type>_result` reply. Null when the app
 * isn't running or doesn't answer.
 */
export async function askApp(request: { type: string } & Record<string, unknown>, home = process.env.JARVIS_HOME ?? join(homedir(), "Jarvis"), timeoutMs = 60_000): Promise<any | null> {
  let f: { port: number; token: string; pid: number };
  try {
    f = JSON.parse(readFileSync(join(home, "notch.json"), "utf8"));
    process.kill(f.pid, 0);
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: any | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const ws = new WebSocket(`ws://127.0.0.1:${f.port}/`);
    const id = `cal-${process.pid}-${Date.now()}`;
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", protocol: 1, token: f.token, client: "cli", pid: process.pid, session_id: null }));
    ws.onmessage = (ev) => {
      let m: any;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.type === "welcome") ws.send(JSON.stringify({ ...request, id }));
      else if (m.type === `${request.type}_result` && m.id === id) finish(m);
      else if (m.type === "error" && !m.id) finish(null);
    };
    ws.onerror = () => finish(null);
    ws.onclose = () => finish(null);
  });
}

/** Events in a range from the app (`calendar_events`). Null means fall back to the helper or AppleScript. */
export async function appCalendar(from: Date, to: Date, home?: string, timeoutMs?: number): Promise<RunResult | null> {
  const m = await askApp({ type: "calendar_events", from: from.toISOString(), to: to.toISOString() }, home, timeoutMs);
  if (!m) return null;
  if (m.error?.code === "denied") return { ok: false, stdout: "", stderr: "DENIED: " + m.error.message };
  if (m.error) return null;
  return { ok: true, stdout: JSON.stringify(m.events ?? []), stderr: "" };
}

export class AppNotRunning extends Error {}

export interface NewEvent {
  title: string;
  start: string;
  end: string;
  allDay?: boolean;
  location?: string;
  calendar?: string;
  repeat?: "daily" | "weekly" | "monthly" | "yearly";
  until?: string;
}

/** "2026-10-20T11:00" (London wall time), "2026-10-20" (midnight) or a full ISO with zone → epoch ms. */
export function parseWhen(v: string): number {
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(v)) {
    const ms = Date.parse(v);
    if (Number.isNaN(ms)) throw new Error(`I couldn't read the time "${v}".`);
    return ms;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?$/.exec(v);
  if (!m) throw new Error(`I couldn't read the time "${v}". Use YYYY-MM-DDTHH:MM.`);
  const [, y, mo, d, h, mi] = m;
  return fromWall({ y: +y!, mo: +mo!, d: +d!, h: h ? +h : 0, mi: mi ? +mi : 0, s: 0 });
}

/** Builds the `calendar_add` request from CLI flags. Throws a speakable message on bad input. */
export function newEventFromArgs(args: { flags: Record<string, string[]> }): NewEvent {
  const title = flag(args, "title");
  const startArg = flag(args, "start");
  if (!title || !startArg) throw new Error("Adding an event needs --title and --start.");
  const allDay = flag(args, "all-day") === "true";
  const start = parseWhen(startArg);
  const endArg = flag(args, "end");
  const minutes = flag(args, "minutes");
  const end = endArg ? parseWhen(endArg) : allDay && !minutes ? start + 86_400_000 : start + Number(minutes ?? 60) * 60_000;
  if (!(end > start)) throw new Error("The event has to end after it starts.");
  const repeat = flag(args, "repeat");
  if (repeat && !["daily", "weekly", "monthly", "yearly"].includes(repeat)) throw new Error("--repeat must be daily, weekly, monthly or yearly.");
  const untilArg = flag(args, "until");
  if (untilArg && !repeat) throw new Error("--until only makes sense with --repeat.");
  // A date-only --until includes that whole day.
  const until = untilArg ? (/T/.test(untilArg) ? parseWhen(untilArg) : parseWhen(untilArg) + 86_399_000) : undefined;
  const ev: NewEvent = { title, start: new Date(start).toISOString(), end: new Date(end).toISOString() };
  if (allDay) ev.allDay = true;
  const location = flag(args, "location");
  if (location) ev.location = location;
  const calendar = flag(args, "calendar");
  if (calendar) ev.calendar = calendar;
  if (repeat) ev.repeat = repeat as NewEvent["repeat"];
  if (until !== undefined) ev.until = new Date(until).toISOString();
  return ev;
}

/** Adds an event through the app; resolves with the calendar it went into. */
export async function addEvent(ev: NewEvent, home?: string, timeoutMs?: number): Promise<string> {
  const m = await askApp({ type: "calendar_add", ...ev }, home, timeoutMs);
  if (!m) throw new AppNotRunning("I can only add events while the Jarvis notch app is running.");
  if (m.error?.code === "denied") throw new AutomationDenied(m.error.message);
  if (m.error) throw new Error(m.error.message);
  return m.calendar ?? "your calendar";
}

type RunResult = { ok: boolean; stdout: string; stderr: string };

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
    if (args._[0] === "add") {
      const ev = newEventFromArgs(args);
      const cal = await addEvent(ev);
      const when = formatOccurrences([{ title: ev.title, location: ev.location ?? "", start: ev.start, end: ev.end, allDay: !!ev.allDay, source: cal }], "");
      console.log(`Added to ${cal}${ev.repeat ? `, repeating ${ev.repeat}${ev.until ? ` until ${ev.until.slice(0, 10)}` : ""}` : ""}:\n${when}`);
      process.exit(0);
    }
    const { from, to } = dayRange(flag(args, "day") ?? "today", Number(flag(args, "days") ?? 1), now().getTime());
    // 1. the notch app (holds the Calendars permission); 2. the EventKit helper; 3. AppleScript.
    const viaApp = await appCalendar(new Date(from), new Date(to));
    const helper = viaApp ? null : eventkitHelper();
    const runner: Runner = viaApp ? () => viaApp : helper ? eventkitRunner(helper) : osascriptRunner;
    const list = readCalendar(runner, from, to);
    console.log(flag(args, "json") ? JSON.stringify({ events: list }, null, 2) : formatOccurrences(list, "Nothing in your calendar."));
  } catch (e) {
    fail((e as Error).message, e instanceof AutomationDenied ? 4 : e instanceof AppNotRunning ? 5 : 1);
  }
}
