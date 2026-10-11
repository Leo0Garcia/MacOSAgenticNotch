/**
 * Minimal iCalendar reader for the timetable cache (~/Jarvis/cache/uni.ics, filled by the
 * calendar skill). Lists events on a given day in Leo's time zone. Handles UTC, TZID and
 * floating times, all-day events, and DAILY/WEEKLY RRULEs with INTERVAL, COUNT, UNTIL,
 * BYDAY and EXDATE, which covers university timetable feeds.
 */
import { addDays, isoDate, wallDateString, weekday, zonedToUtc, type Wall } from "./time";

export interface IcsEvent {
  summary: string;
  location?: string;
  start: Date;
  end?: Date;
  allDay: boolean;
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

function unfold(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

function parseProp(line: string): Prop | undefined {
  const colon = line.indexOf(":");
  if (colon < 0) return undefined;
  const [name, ...paramParts] = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const p of paramParts) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name!.toUpperCase(), params, value: line.slice(colon + 1) };
}

function unescape(v: string): string {
  return v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
}

interface ParsedTime {
  wall: Wall;
  utc: boolean;
  tz?: string;
  allDay: boolean;
}

function parseTime(value: string, params: Record<string, string>): ParsedTime | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return undefined;
  const wall: Wall = { y: +m[1]!, m: +m[2]!, d: +m[3]!, hh: m[4] ? +m[4] : 0, mm: m[5] ? +m[5] : 0, ss: m[6] ? +m[6] : 0 };
  return { wall, utc: !!m[7], tz: params.TZID, allDay: !m[4] || params.VALUE === "DATE" };
}

function toInstant(t: ParsedTime, defaultTz: string): Date {
  const w = t.wall;
  if (t.utc) return new Date(Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm, w.ss));
  let tz = t.tz ?? defaultTz;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
  } catch {
    tz = defaultTz; // Windows-style or unknown TZID names
  }
  return zonedToUtc(w, tz);
}

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

interface Rule {
  freq: "DAILY" | "WEEKLY";
  interval: number;
  count?: number;
  until?: Date;
  byday?: number[];
}

function parseRule(value: string, defaultTz: string): Rule | undefined {
  const parts = Object.fromEntries(
    value.split(";").map((p) => {
      const [k, v] = p.split("=");
      return [k!.toUpperCase(), v ?? ""];
    }),
  );
  if (parts.FREQ !== "DAILY" && parts.FREQ !== "WEEKLY") return undefined;
  const rule: Rule = { freq: parts.FREQ, interval: Math.max(1, Number(parts.INTERVAL ?? 1) || 1) };
  if (parts.COUNT) rule.count = Number(parts.COUNT);
  if (parts.UNTIL) {
    const t = parseTime(parts.UNTIL, {});
    if (t) rule.until = toInstant(t.allDay ? { ...t, wall: { ...t.wall, hh: 23, mm: 59, ss: 59 } } : t, defaultTz);
  }
  if (parts.BYDAY) {
    rule.byday = parts.BYDAY.split(",")
      .map((d: string) => DAYS.indexOf(d.slice(-2).toUpperCase()))
      .filter((i: number) => i >= 0);
  }
  return rule;
}

/** Events that start on `day` (YYYY-MM-DD in tz), sorted by start time. */
export function eventsOn(ics: string, day: string, tz: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  let props: Prop[] | undefined;
  for (const line of unfold(ics)) {
    if (line === "BEGIN:VEVENT") props = [];
    else if (line === "END:VEVENT") {
      if (props) events.push(...expand(props, day, tz));
      props = undefined;
    } else if (props) {
      const p = parseProp(line);
      if (p) props.push(p);
    }
  }
  return events.sort((a, b) => a.start.getTime() - b.start.getTime());
}

function expand(props: Prop[], day: string, tz: string): IcsEvent[] {
  const get = (n: string) => props.find((p) => p.name === n);
  const startProp = get("DTSTART");
  if (!startProp) return [];
  if (get("STATUS")?.value.toUpperCase() === "CANCELLED") return [];
  const start = parseTime(startProp.value, startProp.params);
  if (!start) return [];
  const endProp = get("DTEND");
  const end = endProp ? parseTime(endProp.value, endProp.params) : undefined;
  const summary = unescape(get("SUMMARY")?.value ?? "(no title)");
  const locationRaw = get("LOCATION")?.value;
  const location = locationRaw ? unescape(locationRaw) : undefined;

  const durationMs = end ? toInstant(end, tz).getTime() - toInstant(start, tz).getTime() : undefined;
  const make = (wall: Wall): IcsEvent => {
    const s = toInstant({ ...start, wall }, tz);
    return {
      summary,
      ...(location ? { location } : {}),
      start: s,
      ...(durationMs !== undefined ? { end: new Date(s.getTime() + durationMs) } : {}),
      allDay: start.allDay,
    };
  };
  const onDay = (ev: IcsEvent) => (ev.allDay ? wallDateString(start.wall) === day : isoDate(ev.start, tz) === day);

  const rruleProp = get("RRULE");
  if (!rruleProp) {
    const ev = make(start.wall);
    if (ev.allDay) return wallDateString(start.wall) === day ? [ev] : [];
    return onDay(ev) ? [ev] : [];
  }

  const rule = parseRule(rruleProp.value, tz);
  if (!rule) {
    // Unsupported frequency: show the first occurrence only, labelled.
    const ev = make(start.wall);
    return onDay(ev) ? [{ ...ev, summary: `${ev.summary} (repeats; pattern not expanded)` }] : [];
  }
  const exdates = new Set(
    props
      .filter((p) => p.name === "EXDATE")
      .flatMap((p) => p.value.split(",").map((v) => parseTime(v, p.params)))
      .filter((t): t is ParsedTime => !!t)
      .map((t) => toInstant(t, tz).getTime()),
  );

  const results: IcsEvent[] = [];
  let produced = 0;
  const days = rule.freq === "WEEKLY" && rule.byday?.length ? rule.byday : undefined;
  // Walk day by day from DTSTART; cheap enough for a timetable and avoids BYDAY edge cases.
  for (let i = 0; i < 3700; i++) {
    const wall = addDays(start.wall, i);
    const date = wallDateString(wall);
    if (date > day) break;
    let matches: boolean;
    if (rule.freq === "DAILY") matches = i % rule.interval === 0;
    else {
      // Weeks are counted from the DTSTART week (Monday-start, as most feeds use WKST=MO).
      const startDow = (weekday(start.wall) + 6) % 7;
      const weekIndex = Math.floor((i + startDow) / 7);
      matches = weekIndex % rule.interval === 0 && (days ? days.includes(weekday(wall)) : i % 7 === 0);
    }
    if (!matches) continue;
    const ev = make(wall);
    if (rule.until && ev.start.getTime() > rule.until.getTime()) break;
    if (exdates.has(ev.start.getTime())) {
      produced++;
      if (rule.count !== undefined && produced >= rule.count) break;
      continue;
    }
    produced++;
    if (date === day) results.push(ev);
    if (rule.count !== undefined && produced >= rule.count) break;
  }
  return results;
}
