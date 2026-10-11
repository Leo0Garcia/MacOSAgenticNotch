import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomationDenied, JXA, readCalendar, toOccurrences, type RawEvent } from "../calendar/apple.ts";
import { dayRange, formatOccurrences, loadTimetable, MissingKeyError, occurrences, parseIcs, type Deps } from "../calendar/ics.ts";

const ICS = readFileSync(join(import.meta.dir, "fixtures/calendar/uni.ics"), "utf8");
const APPLE = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/calendar/apple.json"), "utf8")) as RawEvent[];
const NOW = Date.parse("2026-10-11T13:00:00Z"); // Sunday, BST

describe("ics parse", () => {
  const events = parseIcs(ICS);

  test("reads every VEVENT, skipping VTIMEZONE and VALARM", () => {
    expect(events.map((e) => e.uid)).toEqual(["comp2211-lecture", "comp2211-lecture", "comp2212-lab", "reading-week", "one-off-utc"]);
  });

  test("unescapes text and unfolds lines", () => {
    expect(events[0]!.summary).toBe("COMP2211 Software Engineering Group Project, Lecture");
    expect(events[2]!.location).toBe("59/1257 (Zepler Lab)");
    expect(events[4]!.description).toBe("Bring a CV\nRoom may change");
  });

  test("maps the Windows zone name and DURATION", () => {
    expect(events[2]!.tz).toBe("Europe/London");
    expect(events[2]!.end - events[2]!.start).toBe(2 * 3600_000);
  });
});

describe("ics occurrences", () => {
  const events = parseIcs(ICS);

  test("a Monday: weekly lecture, all-day event and a UTC one-off", () => {
    const { from, to } = dayRange("monday", 1, NOW);
    const list = occurrences(events, from, to);
    expect(list.map((o) => [o.title, o.start])).toEqual([
      ["Reading week", "2026-10-11T23:00:00.000Z"],
      ["COMP2211 Software Engineering Group Project, Lecture", "2026-10-12T08:00:00.000Z"],
      ["Careers talk", "2026-10-12T12:00:00.000Z"],
    ]);
  });

  test("RECURRENCE-ID override replaces the moved occurrence", () => {
    const { from, to } = dayRange("2026-10-19", 1, NOW);
    expect(occurrences(events, from, to).map((o) => [o.title, o.start, o.location])).toEqual([
      ["COMP2211 Lecture (moved)", "2026-10-19T13:00:00.000Z", "2/1083"],
    ]);
  });

  test("keeps 9am after the clocks go back", () => {
    const { from, to } = dayRange("2026-10-26", 1, NOW);
    expect(occurrences(events, from, to)[0]!.start).toBe("2026-10-26T09:00:00.000Z");
  });

  test("EXDATE removes one week, COUNT ends the series", () => {
    const { from, to } = dayRange("2026-10-05", 120, NOW);
    const lectures = occurrences(events, from, to).filter((o) => o.title.startsWith("COMP2211 Software"));
    // 10 occurrences counted, one moved (override) and one excluded.
    expect(lectures.length).toBe(8);
    expect(lectures.map((o) => o.start)).not.toContain("2026-11-02T09:00:00.000Z");
    expect(lectures.at(-1)!.start).toBe("2026-12-07T09:00:00.000Z");
  });

  test("BYDAY and UNTIL", () => {
    const { from, to } = dayRange("2026-10-05", 60, NOW);
    const labs = occurrences(events, from, to).filter((o) => o.title.includes("Lab"));
    expect(labs.length).toBe(8); // Wed+Fri from 7 Oct to 30 Oct
    expect(labs.at(-1)!.start).toBe("2026-10-30T11:00:00.000Z");
  });

  test("formats for speech-friendly text", () => {
    const { from, to } = dayRange("monday", 1, NOW);
    expect(formatOccurrences(occurrences(events, from, to))).toBe(
      "Monday 2026-10-12\n  all day Reading week\n  09:00–10:00 COMP2211 Software Engineering Group Project, Lecture (32/1015)\n  13:00–14:00 Careers talk",
    );
  });
});

describe("timetable fetch and cache", () => {
  const URL = "webcal://timetable.example.ac.uk/feed/SECRET-TOKEN.ics";
  function deps(over: Partial<Deps> = {}): Deps & { fetched: string[] } {
    const fetched: string[] = [];
    return {
      readUrl: () => URL,
      fetchText: async (u) => {
        fetched.push(u);
        return ICS;
      },
      cachePath: join(mkdtempSync(join(tmpdir(), "ics-")), "cache", "uni.ics"),
      nowMs: Date.now(),
      fetched,
      ...over,
    };
  }

  test("fetches once, then serves the fresh cache", async () => {
    const d = deps();
    expect((await loadTimetable(d)).stale).toBe(false);
    await loadTimetable(d);
    expect(d.fetched.length).toBe(1);
    expect(readFileSync(d.cachePath, "utf8")).toBe(ICS);
  });

  test("refetches after an hour", async () => {
    const d = deps();
    await loadTimetable(d);
    const old = (Date.now() - 2 * 3600_000) / 1000;
    utimesSync(d.cachePath, old, old);
    await loadTimetable(d);
    expect(d.fetched.length).toBe(2);
  });

  test("missing Keychain item is its own error", async () => {
    await expect(loadTimetable(deps({ readUrl: () => null }))).rejects.toBeInstanceOf(MissingKeyError);
  });

  test("a failed fetch never leaks the URL, and falls back to a stale cache", async () => {
    const failing = deps({
      fetchText: async (u) => {
        throw new Error(`connect ECONNREFUSED ${u}`);
      },
    });
    const err = await loadTimetable(failing).catch((e: Error) => e.message);
    expect(err).toContain("I couldn't fetch your timetable");
    expect(err).not.toContain("SECRET-TOKEN");

    mkdirSync(join(failing.cachePath, ".."), { recursive: true });
    writeFileSync(failing.cachePath, ICS);
    const old = (Date.now() - 5 * 3600_000) / 1000;
    utimesSync(failing.cachePath, old, old);
    expect((await loadTimetable(failing)).stale).toBe(true);
  });

  test("cache-only never reads Keychain or the network", async () => {
    const d = deps({
      readUrl: () => {
        throw new Error("touched keychain");
      },
    });
    await expect(loadTimetable(d, { cacheOnly: true })).rejects.toThrow("No cached timetable yet.");
  });
});

describe("apple calendar", () => {
  const { from, to } = dayRange("monday", 1, NOW);

  test("merges one-offs, all-day and expanded repeating events", () => {
    const list = toOccurrences(APPLE, from, to);
    expect(list.map((o) => [o.title, o.start, o.source])).toEqual([
      ["Mum's birthday", "2026-10-11T23:00:00.000Z", "Family"],
      ["Dentist", "2026-10-12T14:30:00.000Z", "Personal"],
      ["Football", "2026-10-12T17:00:00.000Z", "Personal"],
    ]);
  });

  test("a repeating event keeps its wall-clock time after the clocks change", () => {
    const r = dayRange("2026-10-27", 1, NOW);
    expect(toOccurrences(APPLE, r.from, r.to).map((o) => [o.title, o.start])).toEqual([["Football", "2026-10-27T18:00:00.000Z"]]);
  });

  test("EventKit output (already expanded, no recurrence) reads the same way", () => {
    const ek = [{ calendar: "Personal", title: "Dentist", start: "2026-10-12T14:30:00.000Z", end: "2026-10-12T15:00:00.000Z", allDay: false, location: null, recurrence: null }];
    const list = readCalendar(() => ({ ok: true, stdout: JSON.stringify(ek), stderr: "" }), from, to);
    expect(list.map((o) => [o.title, o.source])).toEqual([["Dentist", "Personal"]]);
  });

  test("a denied EventKit read is a permission problem, a slow one says so", () => {
    expect(() => readCalendar(() => ({ ok: false, stdout: "", stderr: "DENIED: Calendars access is off for Jarvis." }), from, to)).toThrow(AutomationDenied);
    expect(() => readCalendar(() => ({ ok: false, stdout: "", stderr: "TIMEOUT: Apple Calendar took longer than 20 seconds to answer." }), from, to)).toThrow(
      "Apple Calendar took longer than 20 seconds to answer.",
    );
  });

  test("passes the range to osascript and parses its output", () => {
    let seen: [Date, Date] | null = null;
    const list = readCalendar(
      (a, b) => {
        seen = [a, b];
        return { ok: true, stdout: JSON.stringify(APPLE), stderr: "" };
      },
      from,
      to,
    );
    expect(seen![0].getTime()).toBe(from);
    expect(list.length).toBe(3);
  });

  test("Automation denial is its own error", () => {
    expect(() =>
      readCalendar(() => ({ ok: false, stdout: "", stderr: "execution error: Not authorized to send Apple events to Calendar. (-1743)" }), from, to),
    ).toThrow(AutomationDenied);
  });

  test("the JXA script only reads", () => {
    expect(JXA).not.toMatch(/\b(make|delete|save|close|duplicate|move|set)\s*\(/);
    expect(JXA).not.toMatch(/=\s*[^=]*\.(summary|startDate|location)\s*=/);
  });
});
