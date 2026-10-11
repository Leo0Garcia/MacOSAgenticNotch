/**
 * Live snapshot for the briefing: frontmost apps, running Claude sessions, today's Apple
 * Calendar events and today's timetable. Every probe is best-effort and reports why it
 * came back empty rather than leaving a silent gap.
 */
import { stat } from "node:fs/promises";
import { timetableCachePath, type Config } from "./config";
import { readIfExists } from "./fsutil";
import { eventsOn } from "./ics";
import { hhmm, isoDate } from "./time";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (cmd: string[], timeoutMs: number) => Promise<RunResult>;

export const defaultRunner: Runner = async (cmd, timeoutMs) => {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return { code, stdout, stderr };
  } catch (err) {
    return { code: 127, stdout: "", stderr: String(err) };
  }
};

export interface Snapshot {
  apps: string;
  sessions: string;
  calendar: string;
  timetable: string;
}

function firstLine(s: string): string {
  return s.trim().split("\n")[0]?.slice(0, 160) ?? "";
}

/** `lsappinfo` needs no Accessibility or Automation permission, unlike System Events. */
export async function frontmostApps(run: Runner): Promise<string> {
  const front = await run(["lsappinfo", "front"], 5_000);
  if (front.code !== 0) return `unavailable (lsappinfo: ${firstLine(front.stderr) || `exit ${front.code}`})`;
  const asn = front.stdout.trim();
  let frontName = "";
  if (asn) {
    const info = await run(["lsappinfo", "info", "-only", "name", asn], 5_000);
    frontName = /"(?:LSDisplayName|name)"\s*=\s*"([^"]+)"/i.exec(info.stdout)?.[1] ?? "";
  }
  const visible = await run(["lsappinfo", "visibleProcessList"], 5_000);
  const names = [...visible.stdout.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  const others = [...new Set(names)].filter((n) => n !== frontName).slice(0, 12);
  const parts: string[] = [];
  if (frontName) parts.push(`frontmost ${frontName}`);
  if (others.length) parts.push(`also open: ${others.join(", ")}`);
  return parts.length ? parts.join("; ") : "unavailable (lsappinfo returned nothing)";
}

/** `claude agents --json` prints active sessions as a JSON array (code.claude.com/docs/en/cli-reference). */
export async function claudeSessions(run: Runner, claudeBin: string): Promise<string> {
  const r = await run([claudeBin, "agents", "--json"], 15_000);
  if (r.code !== 0) return `unavailable (claude agents: ${firstLine(r.stderr) || `exit ${r.code}`})`;
  let list: unknown;
  try {
    list = JSON.parse(r.stdout);
  } catch {
    return "unavailable (claude agents --json printed something that isn't JSON)";
  }
  if (!Array.isArray(list)) return "unavailable (claude agents --json didn't return a list)";
  if (list.length === 0) return "none running";
  const rows = (list as Record<string, unknown>[]).slice(0, 8).map((s) => {
    const name = [s.name, s.title, s.summary, s.description, s.session_id, s.id].find((v) => typeof v === "string" && v);
    const state = [s.status, s.state].find((v) => typeof v === "string" && v);
    const cwd = typeof s.cwd === "string" ? ` in ${s.cwd}` : "";
    return `${String(name ?? "unnamed session")}${state ? ` (${String(state)})` : ""}${cwd}`;
  });
  const more = list.length > 8 ? `; and ${list.length - 8} more` : "";
  return rows.join("; ") + more;
}

/**
 * Today's Apple Calendar events, read-only through osascript. Needs Calendar access for the
 * process that runs the librarian; macOS asks Leo once. AppleScript's `whose` query does not
 * expand repeating events, so a repeating event shows only on the day it was first created.
 */
const CALENDAR_SCRIPT = `
set dayStart to current date
set time of dayStart to 0
set dayEnd to dayStart + (1 * days)
set out to ""
tell application "Calendar"
  repeat with c in calendars
    set evs to (every event of c whose start date ≥ dayStart and start date < dayEnd)
    repeat with e in evs
      set t to "all day"
      if not (allday event of e) then set t to text 1 thru 5 of (time string of (start date of e))
      set out to out & t & tab & (summary of e) & tab & (name of c) & linefeed
    end repeat
  end repeat
end tell
return out`;

export async function calendarToday(run: Runner): Promise<string> {
  const r = await run(["osascript", "-e", CALENDAR_SCRIPT], 30_000);
  if (r.code !== 0) {
    const err = firstLine(r.stderr);
    if (/-1743|not authori[sz]ed|not allowed/i.test(err)) return "unavailable (Calendar access not granted to Jarvis yet)";
    return `unavailable (osascript: ${err || `exit ${r.code}`})`;
  }
  const rows = r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [time, title, cal] = l.split("\t");
      return `${time} ${title}${cal ? ` (${cal})` : ""}`;
    })
    .sort();
  return rows.length ? rows.join("; ") : "nothing today";
}

const STALE_MS = 24 * 60 * 60 * 1000;

export async function timetableToday(cfg: Config): Promise<string> {
  const path = timetableCachePath(cfg);
  const ics = await readIfExists(path);
  if (ics === undefined) return "unavailable (no timetable cache yet; the calendar skill fills ~/Jarvis/cache/uni.ics)";
  const now = cfg.now();
  const events = eventsOn(ics, isoDate(now, cfg.tz), cfg.tz);
  const st = await stat(path);
  const stale = now.getTime() - st.mtimeMs > STALE_MS ? " (cache over a day old)" : "";
  if (events.length === 0) return `no classes today${stale}`;
  const rows = events.map((e) => {
    const when = e.allDay ? "all day" : `${hhmm(e.start, cfg.tz)}${e.end ? `-${hhmm(e.end, cfg.tz)}` : ""}`;
    return `${when} ${e.summary}${e.location ? ` @ ${e.location}` : ""}`;
  });
  return rows.join("; ") + stale;
}

export async function takeSnapshot(cfg: Config, run: Runner = defaultRunner): Promise<Snapshot> {
  const [apps, sessions, calendar, timetable] = await Promise.all([
    frontmostApps(run),
    claudeSessions(run, cfg.claudeBin),
    calendarToday(run),
    timetableToday(cfg),
  ]);
  return { apps, sessions, calendar, timetable };
}
