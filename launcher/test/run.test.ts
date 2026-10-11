// End to end against the stub claude binary: no model is ever called.

import { Database } from "bun:sqlite";
import type { FinalizeInput } from "../src/finalize";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { finalize } from "../src/finalize";
import { type LauncherEvent, run } from "../src/run";
import { GUARD_BANK, init, jsonl, result, runs, structured, toolResult, toolUse } from "./fixtures";
import { makeWorld } from "./helpers";

const w = makeWorld();
afterAll(() => rmSync(w.root, { recursive: true, force: true }));
const jarvis = join(w.home, "Jarvis");
const projects = join(w.home, ".claude", "projects", "-Users-leogarcia-Jarvis");

beforeEach(() => {
  rmSync(join(jarvis, "state", "last-run.json"), { force: true });
  w.said.length = 0;
});

async function go(request: string, fixture: string, extra: Record<string, string> = {}, now?: () => number) {
  w.setFixture(fixture);
  const events: LauncherEvent[] = [];
  const finals: FinalizeInput[] = [];
  w.said.length = 0;
  const out = await run(w.config(extra), request, {
    emit: (e) => events.push(e),
    finalize: async (f) => void finals.push(f),
    speechRunner: w.speechRunner,
    now,
  });
  return { out, events, finals, said: [...w.said] };
}

test("weather: runs claude with the design flags from ~/Jarvis, speaks, and finalizes as ephemeral", async () => {
  const { out, events, finals, said } = await go("what's the weather in Southampton", runs.weather());
  expect(out).toMatchObject({ exitCode: 0, keep: false, summary: "Told Leo the Southampton weather" });
  const call = w.lastCall();
  // macOS TMPDIR is a /var → /private/var symlink; the child reports the resolved path.
  expect(realpathSync(call.cwd)).toBe(realpathSync(jarvis));
  expect(call.argv.slice(0, 3)).toEqual(["-p", "what's the weather in Southampton", "--session-id"]);
  expect(call.argv[3]).toBe(out.sessionId);
  for (const f of ["--chrome", "--verbose", "--include-partial-messages"]) expect(call.argv).toContain(f);
  expect(call.argv).not.toContain("--name");
  expect(call.env).toMatchObject({ JARVIS_REPO: w.repo, JARVIS_HOME: jarvis, JARVIS_RUN_SESSION_ID: out.sessionId });
  expect(call.env.PATH.split(":")[0]).toBe(join(process.execPath, ".."));

  expect(said).toEqual(["It's 14 degrees and cloudy in Southampton.", "Light rain is likely after 6pm."]);
  const kinds = events.map((e) => (e.event === "state" ? `state:${e.state}` : e.event));
  expect(kinds).toEqual(["state:working", "speak", "speak", "done", "state:done"]);
  expect(finals).toEqual([
    { sessionId: out.sessionId!, keep: false, runLog: join(jarvis, "runs", `${out.sessionId}.jsonl`), request: "what's the weather in Southampton", summary: "Told Leo the Southampton weather" },
  ]);
  // The bridge entry for this run is written with the literal id, then removed.
  const mcpPath = call.argv[call.argv.indexOf("--mcp-config") + 1];
  expect(mcpPath).toBe(join(jarvis, "runs", `${out.sessionId}.mcp.json`));
  expect(call.mcp).toEqual({ mcpServers: { jarvis: { command: process.execPath, args: [join(w.repo, "bridge", "src", "server.ts"), "--session-id", out.sessionId], env: { JARVIS_REPO: w.repo, JARVIS_HOME: jarvis } } } });
  expect(existsSync(mcpPath)).toBe(false);
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

const actions = (sessionId: string) => {
  const db = new Database(join(jarvis, "actions.sqlite"));
  const rows = db.query("SELECT kind, summary, detail, saved FROM actions WHERE session_id = ? ORDER BY id").all(sessionId);
  db.close();
  return rows;
};

test("a saved run is named, kept, and logged as a saved run row in the bridge's action log", async () => {
  const { out, finals } = await go("start a research session on solid-state batteries", runs.research());
  expect(out.keep).toBe(true);
  const argv = w.lastCall().argv;
  expect(argv[argv.indexOf("--name") + 1]).toBe("Jarvis: Research: solid-state batteries");
  expect(finals[0].keep).toBe(true);
  expect(actions(out.sessionId!)).toEqual([{ kind: "run", summary: "Researched solid-state batteries", detail: null, saved: 1 }]);
});

test("an ephemeral run's row isn't saved", async () => {
  const { out } = await go("what's the weather", runs.weather());
  expect(actions(out.sessionId!)).toEqual([{ kind: "run", summary: "Told Leo the Southampton weather", detail: null, saved: 0 }]);
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
  expect(second.finals[0].runLog).toMatch(new RegExp(`${first.out.sessionId}\\.followup-\\d+\\.jsonl$`));
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
  expect(finals[0].keep).toBe(true);
  expect(readFileSync(join(jarvis, "logs", "launcher.log"), "utf8")).toContain("no valid structured_output");
});

test("guard denial: reported as an event and the run needs Leo", async () => {
  const { out, events } = await go("pay my credit card", runs.guardDenied());
  expect(events).toContainEqual({ event: "denied", tool: "mcp__claude-in-chrome__navigate", rule: "no-money", reason: GUARD_BANK });
  expect(events.at(-1)).toMatchObject({ event: "state", state: "needs-you" });
  expect(out.denials![0].rule).toBe("no-money");
  expect(actions(out.sessionId!)).toContainEqual({ kind: "guard", summary: GUARD_BANK, detail: "mcp__claude-in-chrome__navigate", saved: 0 });
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

/** A stand-in librarian CLI that records how it was called and what existed then. */
function librarian(body: string) {
  writeFileSync(join(w.repo, "librarian", "src", "cli.ts"), body);
}

test("finalize: the librarian enqueues the run before an ephemeral run is deleted", async () => {
  const { out } = await go("what's the weather", runs.weather());
  const sid = out.sessionId!;
  const runLog = join(jarvis, "runs", `${sid}.jsonl`);
  const seen = join(w.root, "librarian-saw.json");
  librarian(`import { existsSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), log: existsSync(${JSON.stringify(runLog)}), transcript: existsSync(${JSON.stringify(join(projects, sid + ".jsonl"))}), home: process.env.JARVIS_HOME }));`);
  await finalize(w.config(), { sessionId: sid, keep: false, runLog, request: "what's the weather", summary: "Told Leo" });
  expect(JSON.parse(readFileSync(seen, "utf8"))).toEqual({
    argv: ["enqueue", "--stream-log", runLog, "--request", "what's the weather", "--session-id", sid, "--keep", "false", "--summary", "Told Leo"],
    log: true,
    transcript: true,
    home: jarvis,
  });
  expect(existsSync(runLog)).toBe(false);
  expect(existsSync(join(projects, `${sid}.jsonl`))).toBe(false);
  expect(existsSync(join(projects, sid))).toBe(false);
});

test("finalize: a saved run keeps everything; a failing librarian is logged", async () => {
  const { out } = await go("start a research session on tides", runs.research());
  const runLog = join(jarvis, "runs", `${out.sessionId}.jsonl`);
  librarian(`console.error("boom"); process.exit(3);`);
  await finalize(w.config(), { sessionId: out.sessionId!, keep: true, runLog, request: "x", summary: "" });
  expect(existsSync(runLog)).toBe(true);
  expect(existsSync(join(projects, `${out.sessionId}.jsonl`))).toBe(true);
  expect(readFileSync(join(jarvis, "logs", "launcher.log"), "utf8")).toMatch(/"librarian enqueue failed".*"code":3.*boom/);
});

test("finalize: no librarian still deletes an ephemeral run", async () => {
  rmSync(join(w.repo, "librarian", "src", "cli.ts"), { force: true });
  const { out } = await go("hi", runs.weather());
  await finalize(w.config(), { sessionId: out.sessionId!, keep: false, runLog: join(jarvis, "runs", `${out.sessionId}.jsonl`), request: "hi", summary: "" });
  expect(existsSync(join(projects, `${out.sessionId}.jsonl`))).toBe(false);
});

test("finalize refuses paths that aren't a session's own files", async () => {
  const f = { keep: false, request: "", summary: "" };
  await expect(finalize(w.config(), { ...f, sessionId: "../../etc", runLog: join(jarvis, "runs", "x.jsonl") })).rejects.toThrow("not a session id");
  await expect(finalize(w.config(), { ...f, sessionId: "11111111-1111-4111-8111-111111111111", runLog: join(w.home, "notes.jsonl") })).rejects.toThrow("not a run file");
});

test("a run that ends without a spoken answer speaks its summary instead of going silent", async () => {
  const silent = jsonl([
    init(),
    ...toolUse("toolu_b", "Bash", { command: "curl wttr.in", description: "Fetch weather" }),
    toolResult("toolu_b", "15C overcast"),
    structured(false, "Checked the weather: 15 degrees and overcast"),
    result({ structured: { keep: false, summary: "Checked the weather: 15 degrees and overcast" } }),
  ]);
  const { out, said, events } = await go("what's the weather", silent);
  expect(said).toEqual(["Checked the weather: 15 degrees and overcast"]);
  expect(out.reply).toBe("Checked the weather: 15 degrees and overcast");
  expect(events.filter((e) => e.event === "status")).toEqual([{ event: "status", text: "Running a command", detail: "Fetch weather" }]);
});

test("a warm run starts claude before the request and sends it on stdin", async () => {
  w.setFixture(runs.weather());
  const events: LauncherEvent[] = [];
  let release!: (r: string | null) => void;
  const req = new Promise<string | null>((r) => (release = r));
  const outP = run(w.config(), "", {
    emit: (e) => {
      events.push(e);
      if (e.event === "ready") setTimeout(() => release("what's the weather in Southampton"), 20);
    },
    finalize: async () => {},
    speechRunner: w.speechRunner,
    awaitRequest: () => req,
  });
  const out = await outP;
  const lines = w.read("calls.jsonl").trim().split("\n").map((l) => JSON.parse(l));
  const start = lines.findLast((l) => l.argv)!;
  expect(start.argv.slice(0, 3)).toEqual(["-p", "--input-format", "stream-json"]);
  expect(start.argv).toContain("--session-id");
  const input = JSON.parse(lines.at(-1).stdin.trim());
  expect(input).toEqual({ type: "user", message: { role: "user", content: "what's the weather in Southampton" } });
  expect(events[0]).toEqual({ event: "ready", sessionId: out.sessionId });
  expect(events.map((e) => e.event)).toContain("done");
  expect(out.reply).toContain("14 degrees");
});

test("a warm run with no request (or a follow-up) cleans up and falls back", async () => {
  w.setFixture(runs.weather());
  const quiet = await run(w.config(), "", { emit: () => {}, finalize: async () => {}, speechRunner: w.speechRunner, awaitRequest: async () => null });
  expect(quiet.exitCode).toBe(0);
  expect(quiet.sessionId).toBeUndefined();
  // A saved intent can't be named after start: it runs cold instead.
  const saved = await run(w.config(), "", { emit: () => {}, finalize: async () => {}, speechRunner: w.speechRunner, awaitRequest: async () => "start a research session on heat pumps" });
  expect(w.lastCall().argv.slice(0, 2)).toEqual(["-p", "start a research session on heat pumps"]);
  expect(saved.exitCode).toBe(0);
});

test("stale per-run MCP configs from killed runs are swept", async () => {
  const { sweepStaleMcpConfigs } = await import("../src/run");
  const dir = join(jarvis, "runs");
  mkdirSync(dir, { recursive: true });
  const old = join(dir, "old.mcp.json"), fresh = join(dir, "fresh.mcp.json");
  writeFileSync(old, "{}");
  writeFileSync(fresh, "{}");
  const t = (Date.now() - 13 * 3600 * 1000) / 1000;
  utimesSync(old, t, t);
  sweepStaleMcpConfigs(dir);
  expect(existsSync(old)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
});
