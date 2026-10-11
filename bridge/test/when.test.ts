import { describe, expect, test } from "bun:test";
import { parseWhen, WhenError } from "../src/when";

// Sunday 11 Oct 2026, 14:40 in London (BST, UTC+1).
const NOW = new Date("2026-10-11T13:40:00Z");
const at = (when: string, now = NOW) => parseWhen(when, now).at.toISOString();
const label = (when: string, now = NOW) => parseWhen(when, now).label;

describe("relative", () => {
  test.each([
    ["in 20 minutes", "2026-10-11T14:00:00.000Z"],
    ["in 20 mins", "2026-10-11T14:00:00.000Z"],
    ["in twenty minutes", "2026-10-11T14:00:00.000Z"],
    ["in a minute", "2026-10-11T13:41:00.000Z"],
    ["in half an hour", "2026-10-11T14:10:00.000Z"],
    ["in an hour", "2026-10-11T14:40:00.000Z"],
    ["in an hour and a half", "2026-10-11T15:10:00.000Z"],
    ["in 1 hour and 30 minutes", "2026-10-11T15:10:00.000Z"],
    ["in 1h30m", "2026-10-11T15:10:00.000Z"],
    ["in 2 days", "2026-10-13T13:40:00.000Z"],
    ["In 45 seconds.", "2026-10-11T13:40:45.000Z"],
  ])("%s", (when, iso) => expect(at(when)).toBe(iso));

  test("rejects zero", () => expect(() => at("in 0 minutes")).toThrow(WhenError));
  test("rejects unknown units", () => expect(() => at("in 3 fortnights")).toThrow(WhenError));
});

describe("clock times today or next", () => {
  test.each([
    ["at 6pm", "2026-10-11T17:00:00.000Z"],
    ["6 p.m.", "2026-10-11T17:00:00.000Z"],
    ["6:30pm", "2026-10-11T17:30:00.000Z"],
    ["at six pm", "2026-10-11T17:00:00.000Z"],
    ["18:00", "2026-10-11T17:00:00.000Z"],
    ["1830", "2026-10-11T17:30:00.000Z"],
    // Ambiguous hour: next future occurrence of h:00 or (h+12):00
    ["at 5", "2026-10-11T16:00:00.000Z"],
    ["at 3", "2026-10-11T14:00:00.000Z"],
    ["at 5 o'clock", "2026-10-11T16:00:00.000Z"],
    ["at 2", "2026-10-12T01:00:00.000Z"],
    // Past today rolls to tomorrow
    ["at 9am", "2026-10-12T08:00:00.000Z"],
    ["08:00", "2026-10-12T07:00:00.000Z"],
    ["noon", "2026-10-12T11:00:00.000Z"],
    ["midnight", "2026-10-11T23:00:00.000Z"],
    ["tonight at 8", "2026-10-11T19:00:00.000Z"],
    ["at 7 in the evening", "2026-10-11T18:00:00.000Z"],
    ["at 11 at night", "2026-10-11T22:00:00.000Z"],
  ])("%s", (when, iso) => expect(at(when)).toBe(iso));

  test("today at a passed time is an error, not tomorrow", () => {
    expect(() => at("today at 9am")).toThrow(/already passed/);
  });
});

describe("other days", () => {
  test.each([
    ["tomorrow at 9am", "2026-10-12T08:00:00.000Z"],
    ["tomorrow 9", "2026-10-12T08:00:00.000Z"],
    ["tomorrow at 5", "2026-10-12T16:00:00.000Z"],
    ["tomorrow morning at 7", "2026-10-12T06:00:00.000Z"],
    ["tomorrow at noon", "2026-10-12T11:00:00.000Z"],
    ["monday at 14:30", "2026-10-12T13:30:00.000Z"],
    ["on friday at 10am", "2026-10-16T09:00:00.000Z"],
    // Today is Sunday: a later time today stays today, a passed one is next week
    ["sunday at 6pm", "2026-10-11T17:00:00.000Z"],
    ["sunday at 9am", "2026-10-18T08:00:00.000Z"],
  ])("%s", (when, iso) => expect(at(when)).toBe(iso));
});

describe("ISO 8601", () => {
  test("local time without offset is London", () => expect(at("2026-10-11T18:00")).toBe("2026-10-11T17:00:00.000Z"));
  test("with Z", () => expect(at("2026-10-11T18:00:00Z")).toBe("2026-10-11T18:00:00.000Z"));
  test("with offset", () => expect(at("2026-10-11T18:00:00+02:00")).toBe("2026-10-11T16:00:00.000Z"));
  test("past is rejected", () => expect(() => at("2026-10-11T10:00")).toThrow(/already passed/));
  test("date only is rejected", () => expect(() => at("2026-10-12")).toThrow(/no time/));
  test("more than a year ahead is rejected", () => expect(() => at("2028-01-01T09:00")).toThrow(/a year/));
});

describe("time zones", () => {
  test("GMT in winter", () => {
    expect(at("at 6pm", new Date("2026-12-01T10:00:00Z"))).toBe("2026-12-01T18:00:00.000Z");
  });
  test("across the clocks going back (25 Oct 2026)", () => {
    const sat = new Date("2026-10-24T12:00:00Z"); // 13:00 BST
    expect(at("tomorrow at 9am", sat)).toBe("2026-10-25T09:00:00.000Z");
    expect(at("in 24 hours", sat)).toBe("2026-10-25T12:00:00.000Z");
  });
  test("across the clocks going forward (28 Mar 2027)", () => {
    const sat = new Date("2027-03-27T12:00:00Z"); // 12:00 GMT
    expect(at("tomorrow at 9am", sat)).toBe("2027-03-28T08:00:00.000Z");
  });
});

describe("labels and errors", () => {
  test("labels", () => {
    expect(label("at 6pm")).toBe("today at 18:00");
    expect(label("tomorrow at 9am")).toBe("tomorrow at 09:00");
    expect(label("on friday at 10am")).toBe("Fri 16 Oct at 10:00");
  });
  test.each(["whenever", "later", "at 25", "6:75pm", "13pm", ""])("rejects %p", (when) => {
    expect(() => at(when)).toThrow(WhenError);
  });
});
