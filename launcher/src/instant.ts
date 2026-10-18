// Instant commands: reminders, timers, "what's next", Kanban adds, volume and
// opening apps, done without a Claude run (Leo, 2026-10-16: under a second
// instead of ~10 s, like the lights). The whole request has to match; anything
// else, or any failure here, goes to Claude as usual.

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { scheduleReminder } from "../../bridge/src/remind";
import type { Runner } from "../../bridge/src/system";
import { parseWhen, WhenError } from "../../bridge/src/when";
import { checkBash, MONEY_APPS } from "../../guard/src/bash";
import { contextFromEnv } from "../../guard/src/context";
import { loadBlocklist } from "../../guard/src/domains";
import { childEnv, type Config } from "./config";

export type Instant =
  | { kind: "remind"; when: string; text: string }
  | { kind: "timer"; amount: number; unit: "second" | "minute" | "hour" }
  | { kind: "next" }
  /** `date` (YYYY-MM-DD, London) for another day than today: "overview of tomorrow", "what's Monday look like". */
  | { kind: "day"; date?: string }
  | { kind: "kanban"; text: string }
  | { kind: "volume"; to?: number; by?: number; mute?: boolean }
  | { kind: "open"; app: string };

const NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, "forty-five": 45, sixty: 60, ninety: 90 };
const WHEN = String.raw`(?:in (?:a|an|one|\d+|[a-z-]+) (?:seconds?|minutes?|mins?|hours?|hrs?)(?: and a half)?|at [\w: .]+|tomorrow(?: (?:morning|afternoon|evening|at [\w: .]+))?|tonight(?: at [\w: .]+)?|(?:on )?(?:mon|tues|wednes|thurs|fri|satur|sun)day(?: at [\w: .]+)?|noon|midnight|this (?:afternoon|evening))`;

/** The request with "Jarvis," and "please" trimmed, and no end punctuation. */
function clean(request: string): string {
  return request
    .trim()
    .replace(/^(?:hey |ok |okay )?jarvis[,:]?\s+/i, "")
    .replace(/[.!?]+$/, "")
    .replace(/,?\s*(?:please|jarvis|thanks)$/i, "")
    .replace(/^(?:please|can you|could you|would you)\s+/i, "")
    .trim();
}

const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const DAY_WORD = /\b(today|tonight|tomorrow|tomorow|tommorow|tmrw|tmr|tomoz|(?:mon|tues|wednes|thurs|fri|satur|sun)day)\b/;
// What's left once the day word is taken out: "give me an overview of", "what's on", "what does look like"…
const OVERVIEW =
  /^(?:(?:what'?s|what is|whats|how'?s|how is) (?:my day(?: look(?:ing)? like)?|on|happening|planned|(?:it )?look(?:ing)?(?: like)?)|what does (?:my day )?look like|what (?:have i got|do i have|ve i got|'ve i got)(?: on)?|(?:give me |can i have |can i get )?(?:an |my |a )?(?:overview|rundown|run down|briefing|summary)(?: of my day)?|brief me(?: on)?|morning briefing|give me my day|my day|run me through(?: my day)?)$/;

const londonDate = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Europe/London" }); // YYYY-MM-DD
const weekday = (d: Date) => d.toLocaleDateString("en-GB", { weekday: "long", timeZone: "Europe/London" }).toLowerCase();

/** A day overview request, with the date when it isn't today. */
export function parseDay(low: string, now = new Date()): Instant | null {
  const word = DAY_WORD.exec(low)?.[1];
  const rest = low.replace(DAY_WORD, " ").replace(/\s+/g, " ").trim().replace(/ (?:of|for|the day)$/, "");
  if (!OVERVIEW.test(rest)) return null;
  if (!word || word === "today" || word === "tonight" || word === weekday(now)) return { kind: "day" };
  if (/^(?:tom|tmr)/.test(word)) return { kind: "day", date: londonDate(new Date(now.getTime() + 86400_000)) };
  for (let i = 1; i < 7; i++) {
    const d = new Date(now.getTime() + i * 86400_000);
    if (weekday(d) === word) return { kind: "day", date: londonDate(d) };
  }
  return null;
}

export function parseInstant(request: string, now = new Date()): Instant | null {
  const r = clean(request);
  const low = r.toLowerCase();
  let m: RegExpExecArray | null;

  // "remind me to call Mum at 6pm" / "remind me in 20 minutes to take the pizza out"
  const lead = new RegExp(`^remind me (${WHEN}) to (.+)$`, "i").exec(r);
  const tail = lead ? null : new RegExp(`^remind me (?:to )?(.+?) (${WHEN})$`, "i").exec(r);
  if (lead || tail) {
    const [when, text] = lead ? [lead[1]!, lead[2]!] : [tail![2]!, tail![1]!];
    try {
      parseWhen(when);
    } catch (e) {
      if (e instanceof WhenError) return null;
      throw e;
    }
    return { kind: "remind", when, text: sentenceCase(text) };
  }

  // "set a timer for 10 minutes", "10 minute timer", "start a five minute timer"
  if ((m = /^(?:set|start)? ?(?:a |an )?timer for (\w+(?:-\w+)?) (second|minute|min|hour)s?$/.exec(low)) || (m = /^(?:set |start )?(?:a |an )?(\w+(?:-\w+)?)[ -](second|minute|min|hour)s?? timer$/.exec(low))) {
    const amount = /^\d+$/.test(m[1]!) ? Number(m[1]) : NUM[m[1]!];
    if (!amount || amount > 600) return null;
    return { kind: "timer", amount, unit: m[2] === "min" ? "minute" : (m[2] as "second" | "minute" | "hour") };
  }

  // "what's my day", "brief me", "give me an overview of tomorrow", "what's Monday look like"
  const day = parseDay(low, now);
  if (day) return day;

  // "what's next", "what's next today", "what's my next lecture"
  if (/^(?:what'?s|what is|whats) (?:next|up next|my next (?:lecture|class|event|thing))(?: today| on today)?$/.test(low)) return { kind: "next" };

  // "add buy chalk to my Kanban"
  if ((m = /^(?:add|put) (.+?) (?:to|on|onto) (?:my |the )?kanban(?: board)?$/i.exec(r))) return { kind: "kanban", text: m[1]!.replace(/^["']|["']$/g, "") };

  // Volume.
  if (/^(?:mute|mute (?:the )?(?:sound|volume|audio))$/.test(low)) return { kind: "volume", mute: true };
  if (/^unmute(?: (?:the )?(?:sound|volume|audio))?$/.test(low)) return { kind: "volume", mute: false };
  if ((m = /^(?:turn |put )?(?:the )?(?:volume|sound) (up|down)(?: a bit)?$|^turn (?:it|the volume|the sound) (up|down)(?: a bit)?$/.exec(low))) return { kind: "volume", by: (m[1] ?? m[2]) === "up" ? 15 : -15 };
  if ((m = /^(?:set |turn |put )?(?:the )?(?:volume|sound) (?:to |at )?(\d{1,3})(?: ?%| percent)?$/.exec(low)) && Number(m[1]) <= 100) return { kind: "volume", to: Number(m[1]) };

  // "open Spotify", "launch Obsidian"
  if ((m = /^(?:open|launch|start|open up) (?:the )?([a-z0-9][a-z0-9 .+&'-]{0,40}?)(?: app)?$/i.exec(r)) && !/\b(?:my|this|that|it|file|folder|tab|link|website|page|note|notes)\b/i.test(m[1]!))
    return { kind: "open", app: m[1]! };

  return null;
}

/** An installed app whose name matches (case-insensitive), as its path. */
export function findApp(name: string, dirs = ["/Applications", "/System/Applications", "/System/Applications/Utilities", join(homedir(), "Applications")]): string | null {
  const want = name.toLowerCase().replace(/\.app$/, "");
  for (const d of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      continue;
    }
    const hit = entries.find((e) => e.toLowerCase() === `${want}.app`);
    if (hit) return join(d, hit);
  }
  return null;
}

const unitWord = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

export interface CalEvent {
  title: string;
  location?: string | null;
  start: string;
  end: string;
  allDay?: boolean;
  source?: string;
}

export interface Deadline {
  title: string;
  course: string | null;
  due: string;
}

/** A day's timetable plus Apple Calendar; null when the timetable can't be read. */
async function today(c: Config, run: Runner, day = "today"): Promise<CalEvent[] | null> {
  // Both at once: the timetable can take a second when its cache refreshes.
  const [r, a] = await Promise.all([
    run([c.bunBin, join(c.repo, "skills", "calendar", "ics.ts"), "--day", day, "--json"]),
    run([c.bunBin, join(c.repo, "skills", "calendar", "apple.ts"), "--day", day, "--json"]),
  ]);
  if (r.code !== 0) return null;
  let events: CalEvent[];
  try {
    events = JSON.parse(r.stdout).events ?? [];
  } catch {
    return null;
  }
  if (a.code === 0) {
    try {
      events.push(...(JSON.parse(a.stdout).events ?? []));
    } catch {}
  }
  return events;
}

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
const dayName = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { weekday: "long", timeZone: "Europe/London" });
/** "COMP2311 L3 - Theory of Computing" → "Theory of Computing" */
const shortTitle = (t: string) => /^[A-Z]{2,5}\d{4}\S*(?: \S+)? ?- ?(.+)$/.exec(t)?.[1] ?? t;
/** Kanban card text as Leo would say it: link labels, no dates or tags. */
const cardText = (t: string) => t.replace(/\[\[[^\]|]*\|([^\]]+)\]\]/g, "$1").replace(/\[\[([^\]]+)\]\]/g, "$1").replace(/@\{[^}]*\}/g, "").replace(/#[\w/-]+/g, "").replace(/\s+/g, " ").trim();
/** First words of a long card, so the rundown stays short. */
const clip = (t: string, n = 60) => (t.length <= n ? t : t.slice(0, t.lastIndexOf(" ", n)).replace(/[,;:]$/, "").replace(/(?: (?:the|a|an|to|and|of|for|in|on|with|into|related))+$/i, ""));
const list = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/**
 * About twenty seconds of "your day": what's left on the calendar, what's due
 * on the Kanban and Moodle. With `date`, the same for that day ("Tomorrow…").
 */
export function dayBriefing(now: Date, events: CalEvent[], cards: string[], deadlines: Deadline[], date?: string): string {
  const h = Number(now.toLocaleTimeString("en-GB", { hour: "2-digit", hour12: false, timeZone: "Europe/London" }));
  const tomorrow = date === londonDate(new Date(now.getTime() + 86400_000));
  const when = !date ? "today" : tomorrow ? "tomorrow" : `on ${new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "Europe/London" })}`;
  const out = date ? [] : [h < 12 ? "Good morning." : h < 18 ? "Good afternoon." : "Good evening."];
  const left = events.filter((e) => !e.allDay && Date.parse(e.end) > now.getTime()).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const lectures = left.filter((e) => e.source === "timetable");
  const other = left.filter((e) => e.source !== "timetable");
  const items = (es: CalEvent[]) => es.slice(0, 4).map((e) => `${shortTitle(e.title)} at ${hhmm(e.start)}`);
  const count = lectures.length === 1 ? "one lecture" : `${lectures.length} lectures`;
  if (lectures.length) out.push(date ? `${when.replace(/^on /, "").replace(/^./, (x) => x.toUpperCase())} you've got ${count}: ${list(items(lectures))}.` : `You've got ${count} left today: ${list(items(lectures))}.`);
  else out.push(date ? `No lectures ${when}.` : "No more lectures today.");
  if (other.length) out.push(`On your calendar: ${list(items(other))}.`);
  const byDay = date ?? londonDate(now);
  const due = cards.filter((t) => (/@\{(\d{4}-\d{2}-\d{2})\}/.exec(t)?.[1] ?? "9999") <= byDay).map((t) => clip(cardText(t)));
  if (due.length) out.push(`Due on your Kanban${date ? " by then" : ""}: ${list(due.slice(0, 3))}${due.length > 3 ? `, and ${due.length - 3} more` : ""}.`);
  else if (cards.length) out.push(`Nothing's due on your Kanban, with ${cards.length} cards to do.`);
  const from = date ? Date.parse(`${date}T00:00:00Z`) : now.getTime();
  const soon = deadlines.filter((d) => Date.parse(d.due) > now.getTime() && Date.parse(d.due) - from < 7 * 86400_000).sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
  if (soon.length) out.push(`Coming up on Moodle: ${list(soon.slice(0, 3).map((d) => `${d.title}${d.course ? ` for ${d.course}` : ""}, ${dayName(d.due)} at ${hhmm(d.due)}`))}.`);
  return out.join(" ");
}

export interface InstantResult {
  reply: string;
  summary: string;
}

/** Does it. Null means "let Claude handle it" (not available, failed, or not allowed). */
export async function runInstant(c: Config, i: Instant, now = new Date()): Promise<InstantResult | null> {
  const env = childEnv(c);
  const run: Runner = async (cmd, opts = {}) => {
    const p = Bun.spawn(cmd, { cwd: c.home, env, stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, stdout, stderr };
  };
  switch (i.kind) {
    case "remind":
    case "timer": {
      const when = i.kind === "remind" ? i.when : `in ${i.amount} ${i.unit}s`;
      const text = i.kind === "remind" ? i.text : `Your ${unitWord(i.amount, i.unit)} timer is done`;
      const r = await scheduleReminder({ when, text, repo: c.repo, sessionId: null, run, now, env: c.env }).catch(() => null);
      if (!r) return null;
      if (i.kind === "timer") return { reply: `Timer set for ${unitWord(i.amount, i.unit)}.`, summary: `Timer: ${unitWord(i.amount, i.unit)}` };
      return { reply: `I'll remind you to ${i.text.charAt(0).toLowerCase()}${i.text.slice(1)} ${r.label}.`, summary: `Reminder set for ${r.label}: ${i.text}` };
    }
    case "day": {
      const events = await today(c, run, i.date);
      if (!events) return null;
      const r = await run([c.bunBin, join(c.repo, "skills", "kanban", "kanban.ts"), "list", "--json"]);
      let cards: string[] = [];
      try {
        if (r.code === 0) cards = (JSON.parse(r.stdout) as { complete?: boolean; cards: string[] }[]).filter((l) => !l.complete).flatMap((l) => l.cards);
      } catch {}
      let deadlines: Deadline[] = [];
      try {
        deadlines = JSON.parse(readFileSync(join(c.home, "state", "deadlines.json"), "utf8")).deadlines ?? [];
      } catch {}
      return { reply: dayBriefing(now, events, cards, deadlines, i.date), summary: `Gave Leo the rundown of ${i.date ?? "his day"}` };
    }
    case "next": {
      const events = await today(c, run);
      if (!events) return null;
      const next = events.filter((e) => !e.allDay && Date.parse(e.end) > now.getTime()).sort((x, y) => Date.parse(x.start) - Date.parse(y.start))[0];
      if (!next) return { reply: "Nothing else on today.", summary: "Checked what's next today: nothing" };
      const at = new Date(next.start).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
      // "COMP2311 L3 - Theory of Computing" → "Theory of Computing"
      const title = /^[A-Z]{2,5}\d{4}\S*(?: \S+)? ?- ?(.+)$/.exec(next.title)?.[1] ?? next.title;
      const where = next.location ? `, in ${next.location.replace(/\s*\(.*\)$/, "")}` : "";
      const now_ = Date.parse(next.start) <= now.getTime();
      return {
        reply: now_ ? `You're in ${title} now, until ${new Date(next.end).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" })}${where}.` : `Next is ${title} at ${at}${where}.`,
        summary: `Checked what's next today: ${next.title} at ${at}`,
      };
    }
    case "kanban": {
      const r = await run([c.bunBin, join(c.repo, "skills", "kanban", "kanban.ts"), "add", i.text]);
      if (r.code !== 0) return null;
      return { reply: `Added ${i.text} to your Kanban.`, summary: `Added "${i.text}" to Kanban` };
    }
    case "volume": {
      const script =
        i.mute !== undefined
          ? `set volume output muted ${i.mute}`
          : i.to !== undefined
            ? `set volume output volume ${i.to} without output muted`
            : `set volume output volume ((output volume of (get volume settings)) + ${i.by}) without output muted`;
      const r = await run(["osascript", "-e", script, "-e", "output volume of (get volume settings)"]);
      if (r.code !== 0) return null;
      const level = r.stdout.trim();
      const reply = i.mute === true ? "Muted." : i.mute === false ? `Unmuted, volume at ${level} percent.` : `Volume at ${level} percent.`;
      return { reply, summary: `Volume: ${i.mute === true ? "muted" : `${level}%`}` };
    }
    case "open": {
      if (MONEY_APPS.test(i.app)) return null; // Claude says which rule and offers the safe version
      const path = findApp(i.app);
      if (!path) return null;
      const cmd = `open -a ${JSON.stringify(path)}`;
      const denied = checkBash(cmd, c.home, { ctx: contextFromEnv(env), domains: loadBlocklist(join(c.repo, "guard")), depth: 0 });
      if (denied) return null;
      const r = await run(["open", "-a", path]);
      if (r.code !== 0) return null;
      const name = path.split("/").pop()!.replace(/\.app$/, "");
      return { reply: `Opening ${name}.`, summary: `Opened ${name}` };
    }
  }
}
