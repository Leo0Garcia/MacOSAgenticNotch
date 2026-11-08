// Runs cut off by a restart: detection, claiming and the resume run, against the stub claude.

import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claimInterrupted, RESUME_PROMPT, resumeRun, takeClaimed } from "../src/resume";
import type { LauncherEvent } from "../src/run";
import { type ActiveRun, activeRuns, saveActiveRun } from "../src/store";
import { init, jsonl, result, structured, text } from "./fixtures";
import { makeWorld } from "./helpers";

const w = makeWorld();
afterAll(() => rmSync(w.root, { recursive: true, force: true }));
const state = join(w.home, "Jarvis", "state");
const projects = join(w.home, ".claude", "projects", "-Users-leogarcia-Jarvis");
const DEAD = 2 ** 22 + 12345;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

beforeEach(() => {
  rmSync(state, { recursive: true, force: true });
});

function interrupted(n: number, o: Partial<ActiveRun> = {}, transcript = true): ActiveRun {
  const r = { sessionId: id(n), pid: DEAD, request: `task ${n}`, startedAt: Date.now() - 60_000, ...o };
  saveActiveRun(w.config(), r);
  if (transcript) {
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, `${r.sessionId}.jsonl`), "{}\n");
  }
  return r;
}

test("a dead launcher's run moves to interrupted/ instead of being deleted", () => {
  const r = interrupted(1);
  expect(activeRuns(w.config())).toEqual([]);
  expect(JSON.parse(readFileSync(join(state, "interrupted", `${r.sessionId}.json`), "utf8"))).toEqual(r);
});

test("interrupted runs are claimed once; old and transcript-less ones are dropped and logged", () => {
  const c = w.config();
  const a = interrupted(2, { startedAt: Date.now() - 120_000 });
  const b = interrupted(3, { background: true });
  interrupted(4, { startedAt: Date.now() - 7 * 3600 * 1000 });
  interrupted(5, {}, false);
  saveActiveRun(c, { sessionId: id(6), pid: process.pid, request: "still going", startedAt: Date.now() });
  expect(claimInterrupted(c)).toEqual([a, b]);
  expect(claimInterrupted(c)).toEqual([]); // already claimed
  expect(readdirSync(join(state, "interrupted")).sort()).toEqual([`${a.sessionId}.claimed.json`, `${b.sessionId}.claimed.json`]);
  expect(existsSync(join(state, "active", `${id(6)}.json`))).toBe(true);
  const log = readFileSync(join(w.home, "Jarvis", "logs", "launcher.log"), "utf8");
  expect(log).toContain(`"sessionId":"${id(4)}","request":"task 4","why":"too old"`);
  expect(log).toContain(`"sessionId":"${id(5)}","request":"task 5","why":"no transcript"`);
  expect(takeClaimed(c, a.sessionId)).toEqual(a);
  expect(takeClaimed(c, a.sessionId)).toBeUndefined(); // resumed once
});

const kanban = jsonl([init(), text(["Done: your lectures are on the Kanban."]), structured(false, "Added lectures to the Kanban"), result({ structured: { keep: false, summary: "Added lectures to the Kanban" } })]);

async function resume(r: ActiveRun) {
  w.setFixture(kanban);
  const events: LauncherEvent[] = [];
  let recorded: ActiveRun | undefined;
  const out = await resumeRun(w.config(), r, {
    emit: (e) => {
      events.push(e);
      if (e.event === "state" && e.state === "working") recorded = JSON.parse(readFileSync(join(state, "active", `${r.sessionId}.json`), "utf8"));
    },
    finalize: async () => {},
    speechRunner: w.speechRunner,
  });
  return { out, events, recorded };
}

test("a resume run carries on the session, says what it picked up, and records itself as active again", async () => {
  const r = interrupted(7, { request: "add my lectures to the Kanban?" });
  const { out, events, recorded } = await resume(r);
  expect(out.exitCode).toBe(0);
  expect(w.lastCall().argv.slice(0, 4)).toEqual(["-p", RESUME_PROMPT, "--resume", r.sessionId]);
  expect(events.find((e) => e.event === "speak")).toEqual({ event: "speak", text: "Picking up where I left off: add my lectures to the Kanban.", opener: true });
  // Same request and start time, a live pid: a second restart picks it up again.
  expect(recorded).toMatchObject({ sessionId: r.sessionId, pid: process.pid, request: r.request, startedAt: r.startedAt });
  expect(existsSync(join(state, "active", `${r.sessionId}.json`))).toBe(false);
});

test("a background run resumes quietly", async () => {
  const r = interrupted(8, { request: "check Moodle deadlines", background: true });
  const { events, recorded } = await resume(r);
  expect(w.lastCall().argv.slice(0, 4)).toEqual(["-p", RESUME_PROMPT, "--resume", r.sessionId]);
  expect(events.filter((e) => e.event === "speak")).toEqual([]);
  expect(recorded?.background).toBe(true);
});
