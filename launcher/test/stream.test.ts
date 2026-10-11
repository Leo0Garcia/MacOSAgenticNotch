import { expect, test } from "bun:test";
import { initProblem, RunMonitor } from "../src/stream";
import { GUARD_BANK, runs } from "./fixtures";

function play(fixture: string) {
  const said: string[] = [];
  const m = new RunMonitor({ onSentence: (s) => said.push(s) });
  for (const l of fixture.split("\n")) m.line(l.replaceAll("{{SID}}", "sid-1"));
  return { m, said, res: m.finish(0) };
}

test("weather: speaks sentences in order and reads keep=false", () => {
  const { res, said, m } = play(runs.weather());
  expect(said).toEqual(["It's 14 degrees and cloudy in Southampton.", "Light rain is likely after 6pm."]);
  expect(res).toMatchObject({ keep: false, summary: "Told Leo the Southampton weather", sessionId: "sid-1", isError: false, denials: [] });
  expect(res.reply).toBe("It's 14 degrees and cloudy in Southampton. Light rain is likely after 6pm.");
  expect(initProblem(m.init!)).toBeUndefined();
});

test("structured output tool input is never spoken", () => {
  const { said } = play(runs.research());
  expect(said.join(" ")).not.toContain("Researched solid-state");
});

test("no structured_output means keep, so nothing is lost silently", () => {
  const { res } = play(runs.noStructured());
  expect(res.keep).toBe(true);
  expect(res.isError).toBe(true);
  expect(res.problem).toContain("error_max_structured_output_retries");
});

test("a stream with no result keeps the run and reports it", () => {
  const m = new RunMonitor();
  m.line(runs.weather().split("\n")[0]);
  expect(m.finish(143)).toMatchObject({ keep: true, isError: true, problem: "the run ended without a result (exit 143)" });
});

test("guard denials are collected once with their rule and reason", () => {
  const { res } = play(runs.guardDenied());
  expect(res.denials).toEqual([{ tool: "mcp__claude-in-chrome__navigate", toolUseId: "toolu_nav", rule: "no-money", reason: GUARD_BANK }]);
});

test("subagent text isn't spoken or part of the reply", () => {
  const { said, res } = play(runs.subagent());
  expect(said).toEqual(["Here's the answer."]);
  expect(res.reply).toBe("Here's the answer.");
});

test("without partial messages the assistant text is still spoken", () => {
  const said: string[] = [];
  const m = new RunMonitor({ onSentence: (s) => said.push(s) });
  m.event({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "One. Two" }] } });
  expect(said).toEqual(["One.", "Two"]);
});

test("garbage lines are ignored", () => {
  const m = new RunMonitor();
  m.line("not json");
  m.line("");
  expect(m.finish(1).problem).toContain("without a result");
});

test("init is refused unless auto mode, the bridge and every MCP entry loaded", () => {
  const ok = { permissionMode: "auto", bridgeStatus: "connected", mcpServerErrors: [] };
  expect(initProblem(ok)).toBeUndefined();
  expect(initProblem({ ...ok, permissionMode: "default" })).toContain("auto mode isn't available");
  expect(initProblem({ ...ok, bridgeStatus: "failed" })).toContain("bridge didn't connect (status: failed)");
  expect(initProblem({ ...ok, bridgeStatus: undefined })).toContain("status: missing");
  expect(initProblem({ ...ok, mcpServerErrors: [{ name: "jarvis", type: "invalid_config" }] })).toContain("skipped");
});
