// Wall-clock <-> UTC conversion for an IANA zone using only Intl (no deps).
import { TZ } from "./env.ts";

export interface Wall {
  y: number;
  mo: number; // 1-12
  d: number;
  h: number;
  mi: number;
  s: number;
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

export function isValidZone(tz: string): boolean {
  try {
    fmt(tz);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of an instant in a zone. */
export function toWall(ms: number, tz = TZ): Wall {
  const parts: Record<string, number> = {};
  for (const p of fmt(tz).formatToParts(new Date(ms))) if (p.type !== "literal") parts[p.type] = Number(p.value);
  return { y: parts.year!, mo: parts.month!, d: parts.day!, h: parts.hour! % 24, mi: parts.minute!, s: parts.second! };
}

function wallAsUtc(w: Wall): number {
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
}

/** Offset of the zone from UTC at an instant, in ms (BST = +3600000). */
export function offsetAt(ms: number, tz = TZ): number {
  return wallAsUtc(toWall(ms, tz)) - Math.floor(ms / 1000) * 1000;
}

/**
 * Instant for a wall-clock time in a zone. In the spring-forward gap the time is
 * moved forward by the gap; in the autumn overlap the earlier instant wins.
 */
export function fromWall(w: Wall, tz = TZ): number {
  const naive = wallAsUtc(w);
  const o1 = offsetAt(naive - 12 * 3600_000, tz);
  const o2 = offsetAt(naive + 12 * 3600_000, tz);
  const candidates = [naive - o1, naive - o2].filter((ms) => wallAsUtc(toWall(ms, tz)) === naive);
  if (candidates.length) return Math.min(...candidates);
  return naive - Math.min(o1, o2); // gap: shift forward
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

/** 2026-10-11T18:00:00+01:00 */
export function isoInZone(ms: number, tz = TZ): string {
  const w = toWall(ms, tz);
  const off = offsetAt(ms, tz) / 60000;
  const sign = off < 0 ? "-" : "+";
  const a = Math.abs(off);
  return `${w.y}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** YYYY-MM-DD of an instant in the zone. */
export function dateKey(ms: number, tz = TZ): string {
  const w = toWall(ms, tz);
  return `${w.y}-${pad(w.mo)}-${pad(w.d)}`;
}

/** 0 = Sunday … 6 = Saturday, for a calendar date. */
export function weekday(y: number, mo: number, d: number): number {
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

/** Add days to a calendar date (no zone involved). */
export function addDays(y: number, mo: number, d: number, n: number): { y: number; mo: number; d: number } {
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** Days since 1970-01-01 for a calendar date. */
export function dayNumber(y: number, mo: number, d: number): number {
  return Math.round(Date.UTC(y, mo - 1, d) / 86400_000);
}

/** "18:00", "6pm"-style labels in the zone. */
export function hhmm(ms: number, tz = TZ): string {
  const w = toWall(ms, tz);
  return `${pad(w.h)}:${pad(w.mi)}`;
}

export function spokenTime(ms: number, tz = TZ): string {
  const { h, mi } = toWall(ms, tz);
  if (h === 12 && mi === 0) return "noon";
  if (h === 0 && mi === 0) return "midnight";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${mi ? ":" + pad(mi) : ""}${h < 12 ? "am" : "pm"}`;
}

export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
