// Outcome lines in ~/Jarvis/state/outcomes.jsonl, against the stub claude.

import { afterAll, beforeEach, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isCorrection, taskType, usedName } from "../src/outcomes";
import { run } from "../src/run";
import { init, jsonl, result, runs, structured, text, toolResult, toolUse } from "./fixtures";
import { makeWorld } from "./helpers";

const w = makeWorld();
afterAll(() => rmSync(w.root, { recursive: true, force: true }));
const file = join(w.home, "Jarvis", "state", "outcomes.jsonl");
const lines = () => readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));

beforeEach(() => {
  rmSync(file, { force: true });
  rmSync(join(w.home, "Jarvis", "state", "last-run.json"), { force: true });
});

const go = (request: string, fixture: string) => {
  w.setFixture(fixture);
  return run(w.config({ JARVIS_FAST: "0" }), request, { emit: () => {}, finalize: async () => {}, speechRunner: w.speechRunner });
};

const kanban = jsonl([
  init(),
  toolUse("toolu_k", "Bash", { command: "bun /Users/leogarcia/Jarvis/.claude/skills/kanban/kanban.ts add 'Buy chalk'" }),
  toolResult("toolu_k", "added"),
  text(["Added buy chalk to your Kanban."]),
  structured(false, "Added a Kanban card"),
  result({ structured: { keep: false, summary: "Added a Kanban card" } }),
]);

test("a run that worked is logged as done, with its task type", async () => {
  const out = await go("add buy chalk to my kanban", kanban);
  expect(lines()).toEqual([
    { at: expect.any(String), sessionId: out.sessionId, type: "kanban", outcome: "done", request: "add buy chalk to my kanban", summary: "Added a Kanban card" },
  ]);
});

test("a run that errored is logged as failed, with the problem", async () => {
  await go("what's the weather", runs.noStructured());
  const [l] = lines();
  expect(l).toMatchObject({ type: "other", outcome: "failed" });
  expect(l.problem).toBeTruthy();
});

test("a guard denial is logged as blocked", async () => {
  await go("open barclays", runs.guardDenied());
  expect(lines()[0]).toMatchObject({ type: "browser", outcome: "blocked" });
});

test("Leo correcting a run just after it ends appends a corrected line for that run", async () => {
  const first = await go("add buy chalk to my kanban", kanban);
  const second = await go("no, I said put it in Not Started", kanban);
  const [a, b, c] = lines();
  expect(a).toMatchObject({ sessionId: first.sessionId, outcome: "done" });
  expect(b).toEqual({ at: expect.any(String), sessionId: first.sessionId, outcome: "corrected", problem: 'Leo then said: "no, I said put it in Not Started"' });
  expect(c).toMatchObject({ sessionId: second.sessionId, outcome: "done" });
  // A request that isn't a correction leaves the last run alone.
  await go("add milk to my kanban", kanban);
  expect(lines().filter((l) => l.outcome === "corrected")).toHaveLength(1);
});

test("task type: skills first, then the main tools, else other", () => {
  expect(taskType([usedName("Skill", { skill: "calendar" }), "WebSearch"])).toBe("calendar");
  expect(taskType([usedName("Skill", { skill: "slack-digest" })])).toBe("slack");
  expect(taskType([usedName("Skill", { skill: "needs-access" })])).toBe("needs-access");
  expect(taskType(["WebSearch", "WebFetch"])).toBe("web research");
  expect(taskType(["mcp__claude-in-chrome__navigate", "WebSearch"])).toBe("browser");
  expect(taskType(["mcp__obsidian-jarvis__write_note"])).toBe("notes");
  expect(taskType(["mcp__jarvis__remind"])).toBe("reminders");
  expect(taskType(["mcp__claude_ai_Gmail__create_draft"])).toBe("email");
  expect(taskType(["Read", "Edit"])).toBe("code");
  expect(taskType(["Bash", "StructuredOutput"])).toBe("other");
  expect(taskType([])).toBe("other");
});

test("corrections are recognised, ordinary requests aren't", () => {
  for (const s of ["no, the other one", "Jarvis, no", "that's wrong", "not that, the blue one", "I said Tuesday", "actually make it 3", "wrong one", "undo that"]) expect(isCorrection(s)).toBe(true);
  for (const s of ["no worries", "what's on my calendar", "add a card to Not Started", "now the lights", "notes on today"]) expect(isCorrection(s)).toBe(false);
});
