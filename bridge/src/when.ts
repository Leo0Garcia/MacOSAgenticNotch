// Turns the `when` of remind(when, text) into an absolute time, in
// Europe/London. Accepts ISO 8601, relative times ("in 20 minutes", "in an
// hour and a half") and clock times with an optional day ("6pm", "at 5",
// "tomorrow at 9am", "monday 14:30", "tonight at 8", "noon").
//
// Ambiguous hours (1 to 12 with no am/pm) follow DESIGN.md section 6: the next
// future occurrence of h:00 or (h+12):00. On an explicit later day there is no
// "next", so 1 to 6 mean pm, 7 to 11 mean am, and 12 means noon.

export const TZ = "Europe/London";
const MAX_AHEAD_MS = 366 * 24 * 3600_000;

export class WhenError extends Error {}

export interface When {
  at: Date;
  /** How to say it back: "today at 18:00", "tomorrow at 09:00", "Mon 13 Oct at 09:00". */
  label: string;
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, "twenty-five": 25, thirty: 30, forty: 40, "forty-five": 45, fifty: 50, sixty: 60, ninety: 90,
};

const UNIT_MS: [RegExp, number][] = [
  [/^(s|secs?|seconds?)$/, 1000],
  [/^(m|mins?|minutes?)$/, 60_000],
  [/^(h|hrs?|hours?)$/, 3600_000],
  [/^(d|days?)$/, 86400_000],
  [/^(w|weeks?)$/, 7 * 86400_000],
];

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

interface LocalDate {
  y: number;
  mo: number; // 1-12
  d: number;
}

interface LocalParts extends LocalDate {
  h: number;
  mi: number;
  wd: number; // 0 = Sunday
}

const partsFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  hourCycle: "h23",
  weekday: "long",
});

export function londonParts(t: Date): LocalParts {
  const p: Record<string, string> = {};
  for (const { type, value } of partsFmt.formatToParts(t)) p[type] = value;
  return {
    y: Number(p.year),
    mo: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour) % 24,
    mi: Number(p.minute),
    wd: WEEKDAYS.indexOf(p.weekday!.toLowerCase()),
  };
}

/** UTC instant for a London wall-clock time. */
export function londonTime(date: LocalDate, h: number, mi: number): Date {
  const wall = Date.UTC(date.y, date.mo - 1, date.d, h, mi);
  const offsetAt = (t: number) => {
    const p = londonParts(new Date(t));
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(t / 60_000) * 60_000;
  };
  let t = wall - offsetAt(wall);
  const second = wall - offsetAt(t);
  if (second !== t) t = second;
  return new Date(t);
}

function addDays(date: LocalDate, n: number): LocalDate {
  const t = new Date(Date.UTC(date.y, date.mo - 1, date.d + n));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

const labelFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });

export function labelFor(at: Date, now: Date): string {
  const a = londonParts(at);
  const n = londonParts(now);
  const hhmm = `${String(a.h).padStart(2, "0")}:${String(a.mi).padStart(2, "0")}`;
  const sameDay = (x: LocalDate, y: LocalDate) => x.y === y.y && x.mo === y.mo && x.d === y.d;
  if (sameDay(a, n)) return `today at ${hhmm}`;
  if (sameDay(a, addDays(n, 1))) return `tomorrow at ${hhmm}`;
  return `${labelFmt.format(at).replace(",", "")} at ${hhmm}`;
}

function normalise(input: string): string {
  return input
    .toLowerCase()
    .replace(/\b([ap])\.m\.?/g, "$1m")
    .replace(/o'?clock/g, "")
    .replace(/[,!?]+/g, " ")
    .replace(/\.$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function wordsToDigits(s: string): string {
  return s.replace(/\b[a-z]+(-[a-z]+)?\b/g, (w) => (w in NUMBER_WORDS ? String(NUMBER_WORDS[w]) : w));
}

export function parseWhen(input: string, now: Date = new Date()): When {
  const raw = input.trim();
  if (!raw) throw new WhenError("when is empty");
  const at = parseIso(raw) ?? parseRelative(normalise(raw), now) ?? parseClock(normalise(raw), now);
  if (!at) {
    throw new WhenError(
      `Couldn't read "${raw}" as a time. Use ISO 8601 (2026-10-11T18:00), "in 20 minutes", "at 6pm" or "tomorrow at 9am".`,
    );
  }
  if (at.getTime() <= now.getTime()) throw new WhenError(`${labelFor(at, now)} has already passed.`);
  if (at.getTime() - now.getTime() > MAX_AHEAD_MS) throw new WhenError("Reminders can be at most a year ahead.");
  return { at, label: labelFor(at, now) };
}

function parseIso(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(z|[+-]\d{2}:?\d{2})?$/i.exec(s);
  if (!m) return null;
  if (m[4] === undefined) throw new WhenError(`"${s}" has a date but no time.`);
  if (m[7]) {
    const d = new Date(s.replace(" ", "T"));
    if (isNaN(d.getTime())) throw new WhenError(`"${s}" isn't a valid date and time.`);
    return d;
  }
  const date = { y: +m[1]!, mo: +m[2]!, d: +m[3]! };
  const h = +m[4]!;
  const mi = +m[5]!;
  if (date.mo < 1 || date.mo > 12 || date.d < 1 || date.d > 31 || h > 23 || mi > 59) {
    throw new WhenError(`"${s}" isn't a valid date and time.`);
  }
  return londonTime(date, h, mi);
}

function parseRelative(s: string, now: Date): Date | null {
  if (!s.startsWith("in ")) return null;
  let rest = wordsToDigits(
    s
      .slice(3)
      .replace(/\bhalf an? hour\b|\ba half hour\b/g, "30 minutes")
      .replace(/\b(a )?quarter of an hour\b|\ba quarter hour\b/g, "15 minutes")
      .replace(/\b(an?|one) hour and a half\b/g, "90 minutes"),
  )
    .replace(/\b(\d+) (hours?|hrs?) and a half\b/g, (_, n) => `${Number(n) * 60 + 30} minutes`)
    .replace(/(\d)([a-z])/g, "$1 $2");
  let ms = 0;
  let matched = false;
  rest = rest.replace(/(\d+(?:\.\d+)?) ?([a-z]+)/g, (whole, n: string, unit: string) => {
    const u = UNIT_MS.find(([re]) => re.test(unit));
    if (!u) return whole;
    ms += Number(n) * u[1];
    matched = true;
    return " ";
  });
  if (!matched || rest.replace(/\band\b/g, "").trim()) return null;
  if (ms < 1000) throw new WhenError(`"in ${s.slice(3)}" is now; give a time in the future.`);
  return new Date(now.getTime() + Math.round(ms));
}

type Period = "am" | "pm";

function parseClock(s: string, now: Date): Date | null {
  let rest = ` ${wordsToDigits(s).replace(/(\d)(am|pm)\b/g, "$1 $2")} `;
  const take = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(rest);
    if (m) rest = rest.replace(m[0], " ");
    return m;
  };

  const today: LocalDate = londonParts(now);
  let day: { date: LocalDate; explicit: "today" | "later" } | { weekday: number } | null = null;
  let period: Period | undefined;

  if (take(/ tonight /)) {
    day = { date: today, explicit: "today" };
    period = "pm";
  }
  if (take(/ today /)) day = { date: today, explicit: "today" };
  if (take(/ tomorrow /)) day = { date: addDays(today, 1), explicit: "later" };
  const wd = take(/ (?:on |next |this )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday) /);
  if (wd) day = { weekday: WEEKDAYS.indexOf(wd[1]!) };

  const pm = take(/ (pm|(?:in the |this )?(?:afternoon|evening)|at night) /);
  const am = take(/ (am|(?:in the |this )?morning) /);
  if (pm && am) return null;
  if (pm) period = "pm";
  if (am) period = "am";

  let h: number;
  let mi = 0;
  let exact = false; // 24-hour form or noon/midnight: no am/pm guessing
  let midnight = false;
  if (take(/ (?:at )?(noon|midday) /)) {
    h = 12;
    exact = true;
  } else if (take(/ (?:at )?midnight /)) {
    h = 0;
    exact = true;
    midnight = true;
  } else {
    const t = take(/ (?:at |by |for )?(\d{1,2})(?:[:.](\d{2}))? /) ?? take(/ (?:at )?(\d{2})(\d{2}) /);
    if (!t) return null;
    h = Number(t[1]);
    mi = t[2] ? Number(t[2]) : 0;
    if (h > 23 || mi > 59) return null;
    exact = h === 0 || h > 12 || t[1]!.startsWith("0");
    if (period && (h > 12 || h === 0)) return null;
    if (!exact && period === "pm" && h < 12) h += 12;
    if (!exact && period === "am" && h === 12) h = 0;
    if (period) exact = true;
  }
  if (rest.trim().replace(/^(at|on)$/, "")) return null;

  const at = (date: LocalDate, hour: number) => londonTime(date, hour, mi);
  const future = (t: Date) => t.getTime() > now.getTime();
  // Ambiguous hour on a known day: pick by the day-time rule in the header.
  const hourOnLaterDay = exact ? h : h === 12 ? 12 : h <= 6 ? h + 12 : h;

  if (day && "weekday" in day) {
    let offset = (day.weekday - londonParts(now).wd + 7) % 7;
    if (offset === 0) {
      const todayAt = exact ? at(today, h) : [at(today, h), at(today, h === 12 ? 12 : h + 12)].find(future);
      if (todayAt && future(todayAt)) return todayAt;
      offset = 7;
    }
    return at(addDays(today, offset), hourOnLaterDay);
  }
  if (day && day.explicit === "later") {
    return at(midnight ? addDays(day.date, 1) : day.date, hourOnLaterDay);
  }
  if (day && day.explicit === "today") {
    if (midnight) return at(addDays(today, 1), 0);
    const options = exact ? [at(today, h)] : [at(today, h), at(today, h === 12 ? 12 : h + 12)];
    const t = options.find(future);
    if (!t) throw new WhenError(`${labelFor(options[options.length - 1]!, now)} has already passed.`);
    return t;
  }
  // No day: the next time the clock shows it.
  const options = exact
    ? [at(today, h), at(addDays(today, 1), h)]
    : [at(today, h), at(today, h === 12 ? 12 : h + 12), at(addDays(today, 1), h)];
  return options.filter(future).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
}
