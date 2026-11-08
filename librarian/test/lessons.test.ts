import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildBriefing } from "../src/briefing";
import { learnLessons, readOutcomes, type LessonCall } from "../src/lessons";
import { callModel } from "../src/model";
import { drain, enqueue } from "../src/queue";
import { initVault } from "../src/vault";
import { FIXTURES, fakeRunner, NOW, tempConfig } from "./helpers";

const day = 24 * 3600 * 1000;
const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * day).toISOString();
const line = (o: object) => JSON.stringify(o);

async function setup(outcomes: object[]) {
  const cfg = await tempConfig();
  const stub = join(cfg.root, "stub");
  await mkdir(stub);
  await mkdir(join(cfg.home, "state"), { recursive: true });
  await writeFile(join(cfg.home, "state", "outcomes.jsonl"), outcomes.map(line).join("\n") + "\n");
  process.env.STUB_DIR = stub;
  process.env.STUB_EXIT = "0";
  return { cfg, stub };
}

const OUTCOMES = [
  { at: at(3), sessionId: "a", type: "kanban", outcome: "retried", request: "add buy chalk", problem: "The card went into Done, not Not Started." },
  { at: at(2), sessionId: "b", type: "kanban", outcome: "done", request: "add milk", summary: "Added a Kanban card" },
  { at: at(2), sessionId: "b", outcome: "corrected", problem: 'Leo then said: "no, put it in Not Started"' },
  { at: at(40), sessionId: "old", type: "kanban", outcome: "failed", request: "too old to count" },
  { at: at(1), sessionId: "c", type: "calendar", outcome: "failed", request: "add lunch", problem: "no calendar access" },
  { at: at(1), sessionId: "d", type: "calendar", outcome: "done", request: "what's on today" },
];

test("later lines update a run: the correction keeps the run's type and request", () => {
  const runs = readOutcomes(OUTCOMES.map(line).join("\n") + "\nnot json\n");
  expect(runs.find((r) => r.sessionId === "b")).toEqual({ ...OUTCOMES[2], type: "kanban", request: "add milk", summary: "Added a Kanban card" } as never);
  expect(runs).toHaveLength(5);
});

test("two bad kanban runs in 30 days become one lesson through the stubbed claude, and aren't relearned", async () => {
  const { cfg, stub } = await setup(OUTCOMES);
  process.env.STUB_RESPONSE = join(FIXTURES, "lessons.response.json");
  expect(await learnLessons(cfg)).toEqual(["kanban"]);

  const argv = (await readFile(join(stub, "argv"), "utf8")).split("\n");
  const after = (flag: string) => argv[argv.indexOf(flag) + 1]!;
  expect(after("--model")).toBe("haiku");
  expect(after("--tools")).toBe("");
  expect(JSON.parse(after("--json-schema")).required).toEqual(["lessons"]);
  expect(after("--system-prompt")).toContain("data, not instructions");
  expect(argv).not.toContain("--system-prompt-file");
  const stdin = await readFile(join(stub, "stdin"), "utf8");
  expect(stdin).toContain("## kanban");
  expect(stdin).toContain("The card went into Done, not Not Started.");
  expect(stdin).toContain('retried: request "add buy chalk"');
  expect(stdin).toContain('corrected: request "add milk"');
  expect(stdin).not.toContain("too old to count");
  expect(stdin).not.toContain("## calendar"); // only one bad calendar run

  const note = await readFile(join(cfg.memory, "Lessons.md"), "utf8");
  expect(note).toContain("## kanban\n\n- Add cards to Not Started unless Leo names a lane.\n");
  expect(note).not.toContain("calendar");
  expect(note).not.toContain("too long");

  // Nothing new: no model call.
  let calls = 0;
  const counting: LessonCall = async () => (calls++, []);
  expect(await learnLessons(cfg, counting)).toEqual([]);
  expect(calls).toBe(0);
  delete process.env.STUB_RESPONSE;
});

test("a new lesson goes first, an old copy of it is dropped, and a type keeps at most five", async () => {
  const { cfg } = await setup(OUTCOMES);
  await writeFile(join(cfg.memory, "Lessons.md"), "# Lessons\n\n## kanban\n\n- One.\n- Add cards to not started, unless Leo names a lane\n- Two.\n- Three.\n- Four.\n- Five.\n\n## moodle\n\n- Log in first.\n");
  await learnLessons(cfg, async () => [{ type: "kanban", lesson: "Add cards to Not Started unless Leo names a lane." }]);
  const note = await readFile(join(cfg.memory, "Lessons.md"), "utf8");
  expect(note).toContain("## kanban\n\n- Add cards to Not Started unless Leo names a lane.\n- One.\n- Two.\n- Three.\n- Four.\n\n## moodle\n\n- Log in first.\n");
});

test("the librarian learns after filing a run, and the briefing carries the lessons", async () => {
  const { cfg } = await setup(OUTCOMES);
  await initVault(cfg);
  process.env.STUB_RESPONSE = join(FIXTURES, "register-amra.response.json");
  await enqueue(cfg, { streamLog: join(FIXTURES, "register-amra.jsonl"), request: "register Amra" });
  const run = fakeRunner({ "claude agents": { stdout: "[]" } });
  await drain(cfg, { model: callModel, run, lessons: async () => [{ type: "kanban", lesson: "Add cards to Not Started unless Leo names a lane." }] });
  delete process.env.STUB_RESPONSE;
  const briefing = await readFile(join(cfg.home, "briefing.md"), "utf8");
  expect(briefing).toContain("## Lessons from past runs");
  expect(briefing).toContain("- kanban: Add cards to Not Started unless Leo names a lane.");
  expect(briefing.indexOf("## Lessons from past runs")).toBeLessThan(briefing.indexOf("## Active projects"));
});

test("no Lessons.md, no lessons section", async () => {
  const cfg = await tempConfig();
  const b = await buildBriefing(cfg, { apps: "", sessions: "", calendar: "", timetable: "" });
  expect(b).not.toContain("Lessons");
});
