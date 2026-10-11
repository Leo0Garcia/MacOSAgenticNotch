/** Calendar helpers that work in Leo's time zone regardless of the machine's. */

export interface Wall {
  y: number;
  m: number; // 1-12
  d: number;
  hh: number;
  mm: number;
  ss: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function wallTime(date: Date, tz: string): Wall {
  const parts: Record<string, number> = {};
  for (const p of fmt(tz).formatToParts(date)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return { y: parts.year!, m: parts.month!, d: parts.day!, hh: parts.hour!, mm: parts.minute!, ss: parts.second! };
}

/** Offset of tz from UTC at the given instant, in ms. */
function offsetAt(ms: number, tz: string): number {
  const w = wallTime(new Date(ms), tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm, w.ss) - Math.floor(ms / 1000) * 1000;
}

/** The instant at which the clock in tz reads the given wall time. */
export function zonedToUtc(w: Wall, tz: string): Date {
  const guess = Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm, w.ss);
  let ms = guess - offsetAt(guess, tz);
  const second = guess - offsetAt(ms, tz);
  if (second !== ms) ms = second;
  return new Date(ms);
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function isoDate(date: Date, tz: string): string {
  const w = wallTime(date, tz);
  return `${w.y}-${pad(w.m)}-${pad(w.d)}`;
}

export function hhmm(date: Date, tz: string): string {
  const w = wallTime(date, tz);
  return `${pad(w.hh)}:${pad(w.mm)}`;
}

export function wallDateString(w: Pick<Wall, "y" | "m" | "d">): string {
  return `${w.y}-${pad(w.m)}-${pad(w.d)}`;
}

/** Adds days to a wall date (calendar arithmetic, DST-safe). */
export function addDays(w: Wall, days: number): Wall {
  const t = new Date(Date.UTC(w.y, w.m - 1, w.d + days));
  return { ...w, y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** 0 = Sunday. */
export function weekday(w: Pick<Wall, "y" | "m" | "d">): number {
  return new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay();
}
