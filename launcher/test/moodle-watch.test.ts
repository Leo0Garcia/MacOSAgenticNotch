import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFromEnv } from "../src/config";
import { saveDeadlines, watchPlist } from "../src/moodle-watch";

const cfg = () => configFromEnv({ HOME: mkdtempSync(join(tmpdir(), "jarvis-mw-")), JARVIS_REPO: "/r" });
const now = Date.parse("2026-10-16T08:30:00Z");

test("deadlines are saved and each gets one reminder two days before", () => {
  const c = cfg();
  const added: { at: string; text: string }[] = [];
  const add = ((_c: unknown, r: { at: string; text: string }) => (added.push(r), r)) as any;
  const list = [
    { title: "Group report", course: "COMP2211", due: "2026-10-23T15:00:00Z", dueText: "x" },
    { title: "Quiz", course: null, due: "2026-10-17T10:00:00Z" }, // under two days away: no reminder
    { title: "Old", course: null, due: "2026-10-01T10:00:00Z" }, // past: dropped
    { nonsense: true },
  ];
  expect(saveDeadlines(c, list, now, add)).toBe("2 upcoming deadlines; reminders set for Group report.");
  expect(added).toEqual([{ at: "2026-10-21T15:00:00.000Z", text: "COMP2211 Group report is due in two days, Friday at 16:00" }]);
  const saved = JSON.parse(readFileSync(join(c.home, "state", "deadlines.json"), "utf8"));
  expect(saved.deadlines.map((d: { title: string }) => d.title)).toEqual(["Group report", "Quiz"]);
  // The next day's check doesn't remind twice.
  expect(saveDeadlines(c, list, now + 86400_000, add)).toBe("2 upcoming deadlines; reminders set for none new.");
  expect(added).toHaveLength(1);
  expect(() => saveDeadlines(c, { not: "a list" }, now, add)).toThrow(/JSON array/);
});

test("the daily agent runs the check at 08:30 through run.sh", () => {
  const p = watchPlist(cfg());
  expect(p).toContain("<string>com.jarvis.moodle-watch</string>");
  expect(p).toContain("<string>/r/launcher/run.sh</string>\n\t\t<string>moodle-watch</string>");
  expect(p).toMatch(/<key>Hour<\/key>\s*<integer>8<\/integer>\s*<key>Minute<\/key>\s*<integer>30<\/integer>/);
});
