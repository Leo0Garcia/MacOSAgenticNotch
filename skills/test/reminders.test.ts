// The reminders skill passes Leo's time words straight to the bridge's remind tool,
// so its fixture is checked against the bridge's own parser (bridge/src/when.ts).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWhen } from "../../bridge/src/when.ts";

interface Example {
  request: string;
  text: string;
  when: string;
  expect: string;
}

const EXAMPLES = JSON.parse(readFileSync(join(import.meta.dir, "../reminders/examples.json"), "utf8")) as Example[];
const SKILL = readFileSync(join(import.meta.dir, "../reminders/SKILL.md"), "utf8");
// Sunday 11 October 2026, 14:00 BST.
const NOW = new Date("2026-10-11T13:00:00Z");

describe("examples", () => {
  test("each example's `when` is Leo's own words from the request, or ISO for a date", () => {
    for (const e of EXAMPLES) {
      if (/^\d{4}-\d{2}-\d{2}T/.test(e.when)) continue;
      expect(e.request.toLowerCase()).toContain(e.when.toLowerCase());
      expect(e.text[0]).toBe(e.text[0]!.toUpperCase());
      expect(e.text.endsWith(".")).toBe(false);
    }
  });

  test("the bridge parses every example to the expected instant", () => {
    for (const e of EXAMPLES) expect([e.when, parseWhen(e.when, NOW).at.toISOString()]).toEqual([e.when, e.expect]);
  });
});

test("the skill never schedules anything itself", () => {
  expect(SKILL).toContain("mcp__jarvis__remind");
  for (const line of SKILL.split("\n").filter((l) => /launchctl|\bat\b`|Reminders\.app|osascript/.test(l))) {
    expect(line).toMatch(/\bNever\b/);
  }
});
