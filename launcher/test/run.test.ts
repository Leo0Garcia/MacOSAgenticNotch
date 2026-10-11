// End to end against the stub claude binary: no model is ever called.

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { finalize } from "../src/finalize";
import { type LauncherEvent, run } from "../src/run";
import { GUARD_BANK, runs } from "./fixtures";
import { makeWorld } from "./helpers";

const w = makeWorld();
afterAll(() => rmSync(w.root, { recursive: true, force: true }));
const jarvis = join(w.home, "Jarvis");
const projects = join(w.home, ".claude", "projects", "-Users-leogarcia-Jarvis");

beforeEach(() => {
  rmSync(join(jarvis, "state", "last-run.json"), { force: true });
  rmSync(join(w.root, "said.txt"), { force: true });
});

async function go(request: string, fixture: string, extra: Record<string, string> = {}, now?: () => number) {
  w.setFixture(fixture);
  const events: LauncherEvent[] = [];
  const finals: [string, boolean, string][] = [];
  const out = await run(w.config(extra), request, { emit: (e) => events.push(e), finalize: (...a) => finals.push(a), now });
  return { out, events, finals, said: w.read("said.txt").trim().split("\n").filter(Boolean) };
}

test("weather: runs claude with the design flags from ~/Jarvis, speaks, and finalizes as ephemeral", async () => {
  const { out, events, finals, said } = await go("what's the weather in Southampton", runs.weather());
  expect(out).toMatchObject({ exitCode: 0, keep: false, summary: "Told Leo the Southampton weather" });
  const call = w.lastCall();
  expect(call.cwd).toBe(jarvis);
  expect(call.argv.slice(0, 3)).toEqual(["-p", "what's the weather in Southampton", "--session-id"]);
  expect(call.argv[3]).toBe(out.sessionId);
  for (const f of ["--chrome", "--verbose", "--include-partial-messages"]) expect(call.argv).toContain(f);
  expect(call.argv).not.toContain("--name");
  expect(call.env).toMatchObject({ JARVIS_REPO: w.repo, JARVIS_HOME: jarvis, JARVIS_RUN_SESSION_ID: out.sessionId });
  expect(call.env.PATH.split(":")[0]).toBe(join(process.execPath, ".."));

  expect(said).toEqual(["It's 14 degrees and cloudy in Southampton.", "Light rain is likely after 6pm."]);
  const kinds = events.map((e) => (e.event === "state" ? `state:${e.state}` : e.event));
  expect(kinds).toEqual(["state:working", "speak", "speak", "done", "state:done"]);
  expect(finals).toEqual([[out.sessionId!, false, join(jarvis, "runs", `${out.sessionId}.jsonl`)]]);
  // The raw stream is on disk for the librarian.
  expect(readFileSync(join(jarvis, "runs", `${out.sessionId}.jsonl`), "utf8")).toContain('"structured_output"');
  // Instructions plus a briefing placeholder, since the librarian hasn't run.
  const sp = readFileSync(join(jarvis, "state", "system-prompt.md"), "utf8");
  expect(sp).toContain("# You are Jarvis");
  expect(sp).toContain("hasn't written a briefing yet");
});

test("the librarian's briefing.md is appended after the standing instructions", async () => {
  writeFileSync(join(jarvis, "briefing.md"), "# Briefing\nLeo is in Southampton.\n");
  await go("hi", runs.weather());
  const sp = readFileSync(join(jarvis, "state", "system-prompt.md"), "utf8");
  expect(sp.indexOf("# You are Jarvis")).toBeLessThan(sp.indexOf("Leo is in Southampton."));
  rmSync(join(jarvis, "briefing.md"));
});

test("skills are symlinked into ~/Jarvis/.claude/skills; stale links into the repo are removed", async () => {
  await go("hi", runs.weather());
  const link = join(jarvis, ".claude", "skills", "kanban");
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readlinkSync(link)).toBe(join(w.repo, "skills", "kanban"));
  expect(existsSync(join(jarvis, ".claude", "skills", "not-a-skill"))).toBe(false);
  rmSync(join(w.repo, "skills", "kanban"), { recursive: true });
  await go("hi", runs.weather());
  expect(existsSync(link)).toBe(false);
});

test("a saved run is named and kept; the runs table shows it", async () => {
  const { out, finals } = await go("start a research session on solid-state batteries", runs.research());
  expect(out.keep).toBe(true);
  const argv = w.lastCall().argv;
  expect(argv[argv.indexOf("--name") + 1]).toBe("Jarvis: Research: solid-state batteries");
  expect(finals[0][1]).toBe(true);
  const db = new Database(join(jarvis, "actions.sqlite"));
  const row = db.query("SELECT * FROM runs WHERE session_id = ?").get(out.sessionId!) as any;
  expect(row).toMatchObject({ status: "done", keep: 1, summary: "Researched solid-state batteries", name: "Jarvis: Research: solid-state batteries" });
  expect(row.request).toBe("start a research session on solid-state batteries");
  db.close();
});

test("an ephemeral run's row keeps the summary but not the request", async () => {
  const { out } = await go("what's my bank balance pin", runs.weather());
  const db = new Database(join(jarvis, "actions.sqlite"));
  const row = db.query("SELECT request, summary, keep FROM runs WHERE session_id = ?").get(out.sessionId!) as any;
  expect(row).toEqual({ request: "", summary: "Told Leo the Southampton weather", keep: 0 });
  db.close();
});

test("'and also' within 2 minutes of a saved run resumes it and can't discard it", async () => {
  let t = Date.parse("2026-10-11T14:00:00Z");
  const first = await go("start a research session on heat pumps", runs.research(), {}, () => t);
  t += 90_000;
  const second = await go("and also look at costs in the UK", runs.weather(), {}, () => t);
  const argv = w.lastCall().argv;
  expect(argv.slice(0, 4)).toEqual(["-p", "and also look at costs in the UK", "--resume", first.out.sessionId]);
  expect(argv).not.toContain("--session-id");
  expect(second.out.keep).toBe(true); // fixture said false
  expect(second.finals[0][2]).toMatch(new RegExp(`${first.out.sessionId}\\.followup-\\d+\\.jsonl$`));
});

test("'and also' after an ephemeral run starts a new run with the last exchange as context", async () => {
  let t = Date.parse("2026-10-11T15:00:00Z");
  const first = await go("what's the weather in Southampton", runs.weather(), {}, () => t);
  t += 60_000;
  const second = await go("Jarvis, and also tomorrow?", runs.weather(), {}, () => t);
  const argv = w.lastCall().argv;
  expect(argv[argv.indexOf("--session-id") + 1]).not.toBe(first.out.sessionId);
  expect(argv[1]).toBe(
    "This follows on from Leo's previous request a moment ago.\nLeo: what's the weather in Southampton\nJarvis: It's 14 degrees and cloudy in Southampton. Light rain is likely after 6pm.\n\nLeo now says: Jarvis, and also tomorrow?",
  );
  expect(second.out.exitCode).toBe(0);
});

test("after 2 minutes 'and also' is a fresh request and the old exchange is dropped from disk", async () => {
  let t = Date.parse("2026-10-11T16:00:00Z");
  await go("what's the weather", runs.weather(), {}, () => t);
  t += 121_000;
  await go("and also tomorrow?", runs.weather(), {}, () => t);
  expect(w.lastCall().argv[1]).toBe("and also tomorrow?");
});

test("not in auto mode: the run is stopped at init, said aloud, and leaves nothing behind", async () => {
  const { out, events, finals, said } = await go("delete my downloads", runs.notAuto(), { STUB_HANG: "1" });
  expect(out.exitCode).toBe(1);
  expect(out.error).toContain("auto mode isn't available (the run started in default mode)");
  expect(said[0]).toStartWith("I can't start: auto mode isn't available");
  expect(said.join(" ")).not.toContain("never be read");
  expect(events.at(-1)).toEqual({ event: "state", state: "error", sessionId: out.sessionId });
  expect(finals).toEqual([]);
  expect(existsSync(join(projects, `${out.sessionId}.jsonl`))).toBe(false);
  expect(existsSync(join(jarvis, "runs", `${out.sessionId}.jsonl`))).toBe(false);
});

test("bridge not connected: fails loudly", async () => {
  const { out } = await go("hi", runs.noBridge());
  expect(out.error).toContain("the Jarvis bridge didn't connect (status: failed)");
});

test("no structured_output: kept, so nothing is lost", async () => {
  const { out, finals } = await go("hi", runs.noStructured());
  expect(out.keep).toBe(true);
  expect(finals[0][1]).toBe(true);
  expect(readFileSync(join(jarvis, "logs", "launcher.log"), "utf8")).toContain("no valid structured_output");
});

test("guard denial: reported as an event and the run needs Leo", async () => {
  const { out, events } = await go("pay my credit card", runs.guardDenied());
  expect(events).toContainEqual({ event: "denied", tool: "mcp__claude-in-chrome__navigate", rule: "no-money", reason: GUARD_BANK });
  expect(events.at(-1)).toMatchObject({ event: "state", state: "needs-you" });
  expect(out.denials![0].rule).toBe("no-money");
});

test("Chrome not connected is a warning, not a failure", async () => {
  const { events, out } = await go("hi", runs.weather().replace('"claude-in-chrome","status":"connected"', '"claude-in-chrome","status":"failed"'));
  expect(out.exitCode).toBe(0);
  expect(events).toContainEqual({ event: "warning", message: "Claude in Chrome isn't connected (status: failed)" });
});

test("too old a Claude Code refuses before running anything", async () => {
  rmSync(join(jarvis, "state", "claude-version.json"), { force: true });
  const before = w.read("calls.jsonl");
  const { out } = await go("hi", runs.weather(), { STUB_VERSION: "2.1.280" });
  expect(out.error).toContain("Claude Code 2.1.280 is too old for Jarvis; it needs v2.1.295 or later");
  expect(w.read("calls.jsonl")).toBe(before);
  rmSync(join(jarvis, "state", "claude-version.json"), { force: true });
});

test("without guard/ there is no run at all", async () => {
  const s = join(w.repo, "guard", "settings.json");
  rmSync(s);
  const before = w.read("calls.jsonl");
  const { out, said } = await go("hi", runs.weather());
  writeFileSync(s, "{}\n");
  expect(out.error).toContain("guard isn't installed");
  expect(said[0]).toContain("guard");
  expect(w.read("calls.jsonl")).toBe(before);
});

test("empty request", async () => {
  expect((await go("   ", runs.weather())).out.error).toBe("empty request");
});

// ---- finalize -----------------------------------------------------------------

function librarian(script: string) {
  const p = join(w.repo, "librarian", "run.sh");
  writeFileSync(p, `#!/bin/sh\n${script}\n`);
  chmodSync(p, 0o755);
  return p;
}

test("finalize: the librarian reads the run before an ephemeral run is deleted", async () => {
  const { out } = await go("what's the weather", runs.weather());
  const sid = out.sessionId!;
  const runLog = join(jarvis, "runs", `${sid}.jsonl`);
  const seen = join(w.root, "librarian-saw.txt");
  librarian(`echo "$@" > "${seen}"; test -f "${runLog}" && test -f "${join(projects, sid + ".jsonl")}" && echo both-present >> "${seen}"; echo "skip=$CLAUDE_CODE_SKIP_PROMPT_HISTORY" >> "${seen}"`);
  await finalize(w.config(), sid, false, runLog);
  expect(readFileSync(seen, "utf8")).toBe(`--run-log ${runLog} --session-id ${sid} --keep false\nboth-present\nskip=1\n`);
  expect(existsSync(runLog)).toBe(false);
  expect(existsSync(join(projects, `${sid}.jsonl`))).toBe(false);
  expect(existsSync(join(projects, sid))).toBe(false);
});

test("finalize: a saved run keeps everything; a failing librarian is logged", async () => {
  const { out } = await go("start a research session on tides", runs.research());
  const runLog = join(jarvis, "runs", `${out.sessionId}.jsonl`);
  librarian("echo boom >&2; exit 3");
  await finalize(w.config(), out.sessionId!, true, runLog);
  expect(existsSync(runLog)).toBe(true);
  expect(existsSync(join(projects, `${out.sessionId}.jsonl`))).toBe(true);
  expect(readFileSync(join(jarvis, "logs", "launcher.log"), "utf8")).toMatch(/"librarian failed".*"code":3.*boom/);
});

test("finalize: no librarian yet still deletes an ephemeral run", async () => {
  rmSync(join(w.repo, "librarian", "run.sh"), { force: true });
  const { out } = await go("hi", runs.weather());
  await finalize(w.config(), out.sessionId!, false, join(jarvis, "runs", `${out.sessionId}.jsonl`));
  expect(existsSync(join(projects, `${out.sessionId}.jsonl`))).toBe(false);
});

test("finalize refuses paths that aren't a session's own files", async () => {
  await expect(finalize(w.config(), "../../etc", false, join(jarvis, "runs", "x.jsonl"))).rejects.toThrow("not a session id");
  await expect(finalize(w.config(), "11111111-1111-4111-8111-111111111111", false, join(w.home, "notes.jsonl"))).rejects.toThrow("not a run log");
});
