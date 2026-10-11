import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFromEnv } from "../src/config";
import { contextBlock, readContext, withContext } from "../src/context";

function cfg() {
  const home = mkdtempSync(join(tmpdir(), "jarvis-ctx-"));
  mkdirSync(join(home, "Jarvis", "state"), { recursive: true });
  return configFromEnv({ HOME: home, JARVIS_REPO: "/r" });
}

test("fresh context goes in front of the request as data", () => {
  const c = cfg();
  writeFileSync(join(c.home, "state", "context.json"), JSON.stringify({ frontmostApp: "Google Chrome", browserTab: { title: "COMP2312 Moodle", url: "https://moodle.ecs.soton.ac.uk/course/view.php?id=1" } }));
  const p = withContext(c, "summarise this");
  expect(p).toStartWith("<computer-context>");
  expect(p).toContain("Frontmost app: Google Chrome");
  expect(p).toContain("Browser tab: COMP2312 Moodle (https://moodle.ecs.soton.ac.uk/course/view.php?id=1)");
  expect(p).toEndWith("\n\nsummarise this");
});

test("stale or missing context is ignored", () => {
  const c = cfg();
  expect(withContext(c, "hi")).toBe("hi");
  const f = join(c.home, "state", "context.json");
  writeFileSync(f, JSON.stringify({ frontmostApp: "Finder" }));
  const old = (Date.now() - 5 * 60 * 1000) / 1000;
  utimesSync(f, old, old);
  expect(readContext(c)).toBeNull();
  expect(contextBlock({})).toBe("");
});
