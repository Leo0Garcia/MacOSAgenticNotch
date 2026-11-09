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

test("a request soon after an open task's run carries on in that task's session", async () => {
  const { planRun } = await import("../src/run");
  const { routeTask } = await import("../src/tasks");
  const c = cfg();
  recordTask(c, { sessionId: "11111111-1111-4111-8111-111111111111", request: "Make the lecture 17 notes", summary: "Drafted; waiting for approval", resolved: false, waiting: true }, t0);
  const sid = "11111111-1111-4111-8111-111111111111";
  // No transcript to resume (an older, deleted run): a fresh session as before.
  expect(planRun(c, "show me the draft", t0 + 60_000).resume).toBeUndefined();
  mkdirSync(join(c.claudeConfigDir, "projects", "p"), { recursive: true });
  await Bun.write(join(c.claudeConfigDir, "projects", "p", `${sid}.jsonl`), "{}\n");
  const plan = planRun(c, "show me the draft", t0 + 60_000);
  expect(plan.resume).toBe(sid);
  expect(plan.prompt).toContain('set `continues` to "' + sid + '"');
  // Background runs, a busy session, or a task left alone too long start fresh.
  expect(planRun(c, "show me the draft", t0 + 60_000, false).resume).toBeUndefined();
  expect(routeTask(c, [sid], t0 + 60_000)).toBeUndefined();
  expect(planRun(c, "show me the draft", t0 + 16 * 60_000).resume).toBeUndefined();
});

test("closing a task reports it, with which sessions were saved", () => {
  const c = cfg();
  recordTask(c, { sessionId: "s1", request: "Notes", summary: "Drafted", resolved: false, waiting: true, keep: true }, t0);
  recordTask(c, { sessionId: "s2", request: "show it", summary: "Shown", resolved: false, continues: "s1", waiting: true }, t0 + 1);
  recordTask(c, { sessionId: "s2", request: "again", summary: "Shown again", resolved: false, continues: "s1", waiting: true }, t0 + 2);
  expect(openTasks(c, t0 + 2)[0]!.sessions).toEqual(["s1", "s2"]);
  const closed = recordTask(c, { sessionId: "s2", request: "approve", summary: "Written", resolved: true, continues: "s1", waiting: false }, t0 + 3);
  expect(closed).toMatchObject({ id: "s1", sessions: ["s1", "s2"], kept: ["s1"] });
  expect(openTasks(c, t0 + 3)).toEqual([]);
});
