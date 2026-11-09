import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFromEnv } from "../src/config";
import { withContext } from "../src/context";
import { openTasks, recordTask, tasksBlock } from "../src/tasks";

function cfg() {
  const home = mkdtempSync(join(tmpdir(), "jarvis-tasks-"));
  mkdirSync(join(home, "Jarvis", "state"), { recursive: true });
  return configFromEnv({ HOME: home, JARVIS_REPO: "/r" });
}
const t0 = Date.parse("2026-11-09T14:00:00Z");

test("an unfinished task stays open until a later run carries it on and finishes it", () => {
  const c = cfg();
  recordTask(c, { sessionId: "s1", request: "Apply to Oracle", summary: "Filled the form; needs Leo's answer on visa status", resolved: false, waiting: true }, t0);
  expect(openTasks(c, t0).map((t) => [t.id, t.status, t.title])).toEqual([["s1", "waiting", "Apply to Oracle"]]);
  // A follow-up that carries it on but isn't done yet: same tile, new progress.
  recordTask(c, { sessionId: "s2", request: "I'm not on a visa", summary: "Answered the visa question; one page left", resolved: false, continues: "s1", waiting: false }, t0 + 60_000);
  const [t] = openTasks(c, t0 + 60_000);
  expect(t).toMatchObject({ id: "s1", title: "Apply to Oracle", status: "paused", latest: "Answered the visa question; one page left", sessions: ["s1", "s2"] });
  expect(tasksBlock(c, t0 + 60_000)).toContain('[s1] "Apply to Oracle" (paused): Answered the visa question');
  expect(withContext(c, "carry on", t0 + 60_000)).toContain("<open-tasks>");
  // Finished: the tile goes.
  recordTask(c, { sessionId: "s3", request: "finish it", summary: "Submitted", resolved: true, continues: "s1", waiting: false }, t0 + 120_000);
  expect(openTasks(c, t0 + 120_000)).toEqual([]);
});

test("finished or unsaid runs leave nothing; old tasks expire after a week", () => {
  const c = cfg();
  recordTask(c, { sessionId: "a", request: "What's the weather", summary: "Told Leo", resolved: true, waiting: false }, t0);
  recordTask(c, { sessionId: "b", request: "Hi", summary: "Chatted", waiting: false }, t0);
  expect(openTasks(c, t0)).toEqual([]);
  recordTask(c, { sessionId: "c", request: "Draft the essay", summary: "Outline done", resolved: false, waiting: false }, t0);
  expect(openTasks(c, t0 + 8 * 86400_000)).toEqual([]);
  expect(tasksBlock(c, t0 + 8 * 86400_000)).toBe("");
});
