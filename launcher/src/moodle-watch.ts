// Moodle deadline watcher (Leo, 2026-10-16): once a day a quiet, read-only
// Claude run reads Moodle's upcoming deadlines and hands them to `save`, which
// keeps ~/Jarvis/state/deadlines.json (the day rundown reads it) and sets a
// reminder two days before each deadline it hasn't reminded about yet.

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Config } from "./config";
import { dailyPlist, installDaily } from "./daily";
import { addReminder, type Exec, realExec } from "./reminders/scheduler";
import { log, writeFileAtomic } from "./store";

export interface Deadline {
  title: string;
  course: string | null;
  due: string; // ISO 8601
}

interface State {
  updatedAt: string;
  deadlines: Deadline[];
  /** Keys of deadlines already given a reminder. */
  reminded: string[];
}

export const LABEL = "com.jarvis.moodle-watch";
const DAYS_BEFORE = 2;
const key = (d: Deadline) => `${d.course ?? ""}|${d.title}|${d.due}`;
const file = (c: Config) => join(c.home, "state", "deadlines.json");

export const WATCH_REQUEST = [
  "Scheduled Moodle deadline check. Nobody is listening, so don't speak, ask or notify; just do this, read only:",
  "1. Open https://moodle.ecs.soton.ac.uk/calendar/view.php?view=upcoming in a new tab with Claude in Chrome (moodle skill: start Chrome with the needs-access chrome script if it isn't connected) and read the page text.",
  '2. Save the text to "$TMPDIR/moodle-page.txt", then run: bun "$JARVIS_REPO/skills/moodle/page.ts" deadlines < "$TMPDIR/moodle-page.txt" | "$JARVIS_REPO/launcher/run.sh" moodle-watch save',
  '3. If the page is a login page, run "$JARVIS_REPO/launcher/run.sh" moodle-watch login-needed instead. Never type a username or password.',
  "4. Close the tab you opened, delete the temp file, and end with keep=false and a one-line summary of what save printed.",
].join("\n");

function load(c: Config): State {
  try {
    return JSON.parse(readFileSync(file(c), "utf8"));
  } catch {
    return { updatedAt: "", deadlines: [], reminded: [] };
  }
}

const when = (iso: string) => {
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-GB", { weekday: "long", timeZone: "Europe/London" });
  return `${day} at ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" })}`;
};

/** Stores the deadlines and sets the reminders that are due to be set. Returns what it did, for the run's summary. */
export function saveDeadlines(c: Config, input: unknown, now = Date.now(), add: typeof addReminder = addReminder): string {
  if (!Array.isArray(input)) throw new Error("expected a JSON array of {title, course, due}");
  const list: Deadline[] = input
    .filter((d) => d && typeof d.title === "string" && typeof d.due === "string" && !Number.isNaN(Date.parse(d.due)))
    .map((d) => ({ title: d.title.slice(0, 200), course: typeof d.course === "string" ? d.course.slice(0, 80) : null, due: d.due }));
  const s = load(c);
  const future = list.filter((d) => Date.parse(d.due) > now);
  const set: string[] = [];
  for (const d of future) {
    const at = Date.parse(d.due) - DAYS_BEFORE * 86400_000;
    if (at <= now || s.reminded.includes(key(d))) continue;
    add(c, { at: new Date(at).toISOString(), text: `${d.course ? `${d.course} ` : ""}${d.title} is due in two days, ${when(d.due)}` }, now);
    s.reminded.push(key(d));
    set.push(d.title);
  }
  // Forget reminders for deadlines that have passed, so the file stays small.
  const live = new Set(future.map(key));
  s.reminded = s.reminded.filter((k) => live.has(k));
  s.deadlines = future;
  s.updatedAt = new Date(now).toISOString();
  mkdirSync(join(c.home, "state"), { recursive: true });
  writeFileAtomic(file(c), JSON.stringify(s, null, 2));
  log(c, "moodle deadlines saved", { count: future.length, reminders: set.length });
  return `${future.length} upcoming deadline${future.length === 1 ? "" : "s"}; reminders set for ${set.length ? set.join(", ") : "none new"}.`;
}

/** The daily launchd agent: 08:30, or at the next wake if the Mac was asleep. */
export function watchPlist(c: Config): string {
  return dailyPlist(c, LABEL, ["moodle-watch"], 8, 30, "moodle-watch.log");
}

/** Installs (or refreshes) the daily agent. */
export function installWatch(c: Config, exec: Exec = realExec): void {
  installDaily(c, LABEL, watchPlist(c), exec);
}
