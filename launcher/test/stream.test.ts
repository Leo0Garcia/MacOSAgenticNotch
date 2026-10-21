import { expect, test } from "bun:test";
import { initProblem, RunMonitor } from "../src/stream";
import { GUARD_BANK, init, jsonl, result, runs, structured, text, toolResult, toolUse } from "./fixtures";

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

test("a run that ends with only structured output is flagged as silent", () => {
  const silent = jsonl([init(), ...toolUse("toolu_b", "Bash", { command: "curl wttr.in" }), toolResult("toolu_b", "15C"), structured(false, "Checked the weather: 15°C"), result({ structured: { keep: false, summary: "Checked the weather: 15°C" } })]);
  expect(play(silent).res.endedSilently).toBe(true);
  // A progress line before the last tool doesn't count as the answer.
  const progress = jsonl([init(), text(["Still researching."]), ...toolUse("toolu_w", "Write", { file_path: "/x.md" }), toolResult("toolu_w", "ok"), structured(true, "Saved the notes"), result({ structured: { keep: true, summary: "Saved the notes" } })]);
  expect(play(progress).res.endedSilently).toBe(true);
  expect(play(runs.weather()).res.endedSilently).toBe(false);
});

test("only the opening line and the final answer are spoken", () => {
  const said: [string, string][] = [];
  const m = new RunMonitor({ onSentence: (s, k) => said.push([k, s]) });
  // As Claude streams it: one API message with a text block and then a tool_use block.
  let n = 0;
  const se = (event: object) => ({ type: "stream_event", event, parent_tool_use_id: null, session_id: "sid-1", uuid: `q${n++}` });
  const msg = (textBody: string, tool?: string) => [
    se({ type: "message_start", message: { id: `m${n}`, role: "assistant", content: [] } }),
    se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: textBody } }),
    se({ type: "content_block_stop", index: 0 }),
    ...(tool ? [se({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: `t${n}`, name: tool, input: {} } }), se({ type: "content_block_stop", index: 1 })] : []),
    se({ type: "message_stop" }),
  ];
  const stream = [
    init(),
    ...msg("Adding that to your Kanban. Let me find the board.", "Bash"),
    toolResult("t1", "ok"),
    ...msg("Checking it went in.", "Bash"),
    toolResult("t2", "ok"),
    ...msg("Done, buy chalk is on your board.", "StructuredOutput"),
    result({ structured: { keep: false, summary: "Added buy chalk" } }),
  ];
  for (const e of stream) m.line(JSON.stringify(e));
  m.finish(0);
  expect(said).toEqual([["opener", "Adding that to your Kanban."], ["reply", "Done, buy chalk is on your board."]]);
});

test("a long answer is spoken for two sentences; the whole reply stays in the result", () => {
  const { said, res } = play(jsonl([init(), text(["One. Two. Three. Four."]), structured(false, "x"), result({ structured: { keep: false, summary: "x" } })]));
  expect(said).toEqual(["One.", "Two."]);
  expect(res.reply).toBe("One. Two. Three. Four.");
});

test("a tool call with no opening line gets one", () => {
  const { said } = play(jsonl([init(), toolUse("t", "Bash", { command: "ls" }), toolResult("t", "ok"), text(["Done."]), structured(false, "x"), result({ structured: { keep: false, summary: "x" } })]));
  expect(said).toEqual(["On it.", "Done."]);
});

test("hitting the usage limit is said plainly, not logged as a saved task", () => {
  const limit = { ...result(), is_error: true, api_error_status: 429, api_error: "usage_limit_reached", result: "You've hit your session limit · resets 5:10pm (Europe/London)" };
  const synthetic = { type: "assistant", message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: limit.result }] }, parent_tool_use_id: null, session_id: "{{SID}}" };
  const { said, res } = play(jsonl([init(), synthetic, limit]));
  expect(said).toEqual([]);
  expect(res).toMatchObject({ limited: true, keep: false, summary: "Hit the Claude usage limit", reply: "I've hit my Claude usage limit. It resets at 5:10pm." });
});

test("an expired Claude sign-in is said plainly, with the fix", () => {
  const err = { ...result(), is_error: true, terminal_reason: "api_error", api_error_status: null, result: "Failed to authenticate: OAuth session expired and could not be refreshed" };
  const synthetic = { type: "assistant", message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: err.result }] }, parent_tool_use_id: null, session_id: "{{SID}}" };
  const { said, res } = play(jsonl([init(), synthetic, err]));
  expect(said).toEqual([]);
  expect(res).toMatchObject({ limited: true, keep: false, summary: "Claude sign-in expired" });
  expect(res.reply).toContain("type /login");
});
