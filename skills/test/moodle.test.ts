import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classify, deadlines, MOODLE_HOST, PAGES } from "../moodle/page.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures/moodle", name), "utf8");
const NOW = Date.parse("2026-10-11T13:00:00Z");

describe("classify", () => {
  test("Moodle login page", () => expect(classify(fixture("login.txt"))).toBe("login"));
  test("Microsoft SSO page", () => expect(classify(fixture("sso-login.txt"))).toBe("login"));
  test("a logged-in page", () => expect(classify(fixture("upcoming.txt"))).toBe("content"));
});

describe("deadlines", () => {
  test("parses the upcoming events page", () => {
    expect(deadlines(fixture("upcoming.txt"), NOW)).toEqual([
      { title: "Lab 3 worksheet", course: "COMP2212 Programming Language Concepts", due: "2026-10-12T09:00:00+01:00", dueText: "Tomorrow, 9:00 AM" },
      {
        title: "COMP2211 Group Report",
        course: "COMP2211 Software Engineering Group Project",
        due: "2026-10-16T16:00:00+01:00",
        dueText: "Thursday, 16 October, 4:00 PM",
      },
      { title: "Quiz 2 closes", course: "COMP2213 Interaction Design", due: "2027-01-02T23:59:00+00:00", dueText: "Friday, 2 January 2027, 23:59" },
    ]);
  });

  test("a date without a year in early January rolls into next year", () => {
    const text = "Essay\nMonday, 5 January, 12:00 PM\n";
    expect(deadlines(text, NOW)[0]!.due).toBe("2027-01-05T12:00:00+00:00");
  });

  test("nothing to parse gives an empty list", () => {
    expect(deadlines("No upcoming activities due", NOW)).toEqual([]);
  });
});

test("only ever points at the ECS Moodle host", () => {
  for (const url of Object.values(PAGES)) expect(new URL(url).host).toBe(MOODLE_HOST);
});
