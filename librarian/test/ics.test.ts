import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { eventsOn } from "../src/ics";
import { hhmm } from "../src/time";
import { FIXTURES } from "./helpers";

const TZ = "Europe/London";
const ics = await readFile(join(FIXTURES, "timetable.ics"), "utf8");
const show = (day: string) =>
  eventsOn(ics, day, TZ).map((e) => `${e.allDay ? "all day" : hhmm(e.start, TZ)} ${e.summary}${e.location ? ` @ ${e.location}` : ""}`);

test("one day in BST: UTC times, folded escapes, all-day, weekly repeat; cancelled and after-midnight excluded", () => {
  expect(show("2026-10-12")).toEqual([
    "all day Reading week planning",
    "10:00 COMP2211 Lecture @ Building 32, Room 1015",
    "14:00 COMP2207 Lab @ Zepler",
  ]);
});

test("EXDATE removes one week; the event spilling past midnight lands on the next day", () => {
  expect(show("2026-10-19")).toEqual([]);
  expect(show("2026-10-13")).toEqual(["00:30 Late session"]);
});

test("weekly repeat keeps wall time across the clocks change and stops at UNTIL", () => {
  expect(show("2026-11-02")).toEqual(["14:00 COMP2207 Lab @ Zepler"]);
  expect(show("2026-12-14")).toEqual(["14:00 COMP2207 Lab @ Zepler"]);
  expect(show("2026-12-21")).toEqual([]);
});
