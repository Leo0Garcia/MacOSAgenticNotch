// Turns "at 6pm", "in 20 minutes", "tomorrow at 9" into an instant.
// Clock times are in Europe/London (DESIGN 6). An hour with no am/pm means
// the next future occurrence of either reading ("at 5" at 14:00 is 17:00).

export class WhenError extends Error {}

interface Wall {
  y: number;
  mo: number; // 1-12
  d: number;
  h: number;
  mi: number;
}

function wallClock(t: number, tz: string): Wall {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour"), mi: get("minute") };
}

/** The instant a wall-clock time in tz happens. Skipped DST times move forward an hour. */
export function zonedTime(w: Wall, tz: string): number {
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
  let t = asUtc;
  for (let i = 0; i < 3; i++) {
    const seen = wallClock(t, tz);
    const diff = asUtc - Date.UTC(seen.y, seen.mo - 1, seen.d, seen.h, seen.mi);
    if (diff === 0) return t;
    t += diff;
  }
  return t;
}

function addDays(w: Wall, n: number): Wall {
  const d = new Date(Date.UTC(w.y, w.mo - 1, w.d + n));
  return { ...w, y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

const UNITS: Record<string, number> = { s: 1e3, sec: 1e3, second: 1e3, m: 6e4, min: 6e4, minute: 6e4, h: 36e5, hr: 36e5, hour: 36e5, d: 864e5, day: 864e5 };
const WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, "forty-five": 45, "half an": 0.5, "a couple of": 2, "a few": 3 };
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function parseWhen(input: string, now: number, tz = "Europe/London"): Date {
  const s = input.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!]$/, "");
  if (!s) throw new WhenError("no time given");

  // ISO timestamp from the model or the app.
  if (/^\d{4}-\d{2}-\d{2}t/.test(s)) {
    const t = Date.parse(input.trim());
    if (Number.isNaN(t)) throw new WhenError(`can't read ${input}`);
    return future(t, now, input);
  }

  // Durations: "in 20 minutes", "in an hour and a half", "in 1h30m".
  const dur = /^(?:in )?(.+)$/.exec(s)![1];
  if (/^in /.test(s) || /^\d+\s*(?:s|m|h|d)\b/.test(dur)) {
    const andAHalf = / and a half$/.test(dur);
    const rest = dur.replace(/ and a half$/, "");
    if (rest === "half an hour") return new Date(now + 30 * 6e4);
    const re = /(\d+(?:\.\d+)?|half an|a couple of|a few|forty-five|an|a|one|two|three|four|five|ten|fifteen|twenty|thirty|forty)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)(?![a-z])\s*(?:(?:and|,)\s*)?/g;
    let total = 0;
    let lastUnit = 0;
    let consumed = "";
    let m: RegExpExecArray | null;
    while ((m = re.exec(rest))) {
      const n = /^\d/.test(m[1]) ? Number(m[1]) : WORDS[m[1]];
      const unit = m[2].replace(/(?<=.)s$/, "").replace(/^(?:secs?|second)$/, "s").replace(/^(?:mins?|minute)$/, "m").replace(/^(?:hrs?|hour)$/, "h").replace(/^day$/, "d");
      lastUnit = UNITS[unit];
      if (!lastUnit) throw new WhenError(`can't read ${input}`);
      total += n * lastUnit;
      consumed += m[0];
    }
    if (total > 0 && consumed.replace(/\s/g, "") === rest.replace(/\s/g, "")) {
      return new Date(now + total + (andAHalf ? 0.5 * lastUnit : 0));
    }
    if (/^in /.test(s)) throw new WhenError(`can't read ${input}`);
  }

  // Clock times, with an optional day.
  const today = wallClock(now, tz);
  let day: Wall = today;
  let dayGiven = false;
  let rest = s;
  const dm = /^(today|tonight|tomorrow|this evening|this afternoon|on \w+|\w+day)\b,?\s*(?:at\s+)?/.exec(rest) ?? /\s*\b(today|tonight|tomorrow|on \w+|\w+day)$/.exec(rest);
  let pmHint = false;
  if (dm) {
    const word = dm[1].replace(/^on /, "");
    rest = rest.replace(dm[0], "").trim();
    dayGiven = true;
    if (word === "tomorrow") day = addDays(today, 1);
    else if (word === "tonight" || word === "this evening" || word === "this afternoon") pmHint = true;
    else if (word !== "today") {
      const idx = DAYS.indexOf(word);
      if (idx < 0) throw new WhenError(`can't read ${input}`);
      const todayIdx = new Date(Date.UTC(today.y, today.mo - 1, today.d)).getUTCDay();
      day = addDays(today, ((idx - todayIdx + 7) % 7) || 7);
    }
  }
  rest = rest.replace(/^at /, "").replace(/ at$/, "").trim();
  if (!rest && dayGiven) throw new WhenError(`what time ${dm![1]}?`);
  let h: number;
  let mi = 0;
  let meridiem: "am" | "pm" | undefined;
  if (rest === "noon" || rest === "midday") h = 12;
  else if (rest === "midnight") {
    h = 0;
    if (!dayGiven) day = addDays(today, 1);
  } else {
    const t = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m|p\.m|in the morning|in the afternoon|in the evening|at night)?$/.exec(rest) ?? /^(?:half past) (\d{1,2})()()$/.exec(rest);
    if (!t) throw new WhenError(`can't read ${input}`);
    h = Number(t[1]);
    mi = t[2] ? Number(t[2]) : /^half past/.test(rest) ? 30 : 0;
    const mer = t[3]?.replace(/\./g, "");
    if (mer === "am" || mer === "in the morning") meridiem = "am";
    else if (mer) meridiem = "pm";
    if (h > 23 || mi > 59 || (meridiem && (h < 1 || h > 12))) throw new WhenError(`${input} isn't a time`);
    if (meridiem === "pm" && h < 12) h += 12;
    if (meridiem === "am" && h === 12) h = 0;
    if (!meridiem && pmHint && h < 12) h += 12;
  }

  const at = (w: Wall, hour: number) => zonedTime({ ...w, h: hour, mi }, tz);
  const ambiguous = !meridiem && !pmHint && h >= 1 && h <= 12 && !/^\d{2}[:.]/.test(rest) && rest !== "noon" && rest !== "midday";
  const candidates = ambiguous ? [h % 12, (h % 12) + 12] : [h];
  if (dayGiven) {
    // "tomorrow at 5" with no am/pm: 5pm unless it's clearly early ("tomorrow at 9" is 9am).
    const hour = ambiguous ? (h >= 7 && h <= 11 ? h : (h % 12) + 12) : h;
    return future(at(day, hour), now, input);
  }
  for (let add = 0; add < 2; add++) {
    const options = candidates.map((hour) => at(addDays(day, add), hour)).filter((t) => t > now).sort((a, b) => a - b);
    if (options.length) return new Date(options[0]);
  }
  throw new WhenError(`can't read ${input}`);
}

function future(t: number, now: number, input: string): Date {
  if (t <= now) throw new WhenError(`${input} is in the past`);
  return new Date(t);
}
