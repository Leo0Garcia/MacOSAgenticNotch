import { expect, test } from "bun:test";
import { siteName, toolStatus } from "../src/status";
import { RunMonitor } from "../src/stream";
import { jsonl, runs, toolResult, toolUse } from "./fixtures";

test("tool calls become plain status lines", () => {
  expect(toolStatus("WebSearch", { query: "southampton weather today" })).toEqual({ text: "Searching the web", detail: "southampton weather today" });
  expect(toolStatus("WebFetch", { url: "https://www.bbc.co.uk/weather/2637487" })).toEqual({ text: "Reading BBC", detail: "bbc.co.uk/weather/2637487" });
  expect(toolStatus("mcp__claude-in-chrome__navigate", { url: "https://moodle.ecs.soton.ac.uk/my/" })).toEqual({ text: "Opening Soton", detail: "moodle.ecs.soton.ac.uk/my" });
  expect(toolStatus("Skill", { skill: "kanban" })).toEqual({ text: "Using the kanban skill" });
  expect(toolStatus("mcp__jarvis__remind", { when: "5pm", text: "call Sue" })).toEqual({ text: "Setting a reminder", detail: "5pm" });
  expect(toolStatus("mcp__claude_ai_Slack__slack_read_channel", {})).toEqual({ text: "Using Slack", detail: "slack read channel" });
  expect(toolStatus("SomethingNew")).toEqual({ text: "Working" });
});

test("Jarvis's own plumbing is not a step", () => {
  for (const t of ["StructuredOutput", "mcp__jarvis__speak", "mcp__jarvis__ask", "mcp__jarvis__log"]) expect(toolStatus(t)).toBeNull();
});

test("site names read naturally", () => {
  expect(siteName("zoopla.co.uk")).toBe("Zoopla");
  expect(siteName("bbc.co.uk")).toBe("BBC");
  expect(siteName("metoffice.gov.uk")).toBe("Metoffice");
  expect(siteName("rightmove.co.uk")).toBe("Rightmove");
});

test("the monitor reports main-conversation tool calls only", () => {
  const seen: string[] = [];
  const m = new RunMonitor({ onTool: (name) => seen.push(name) });
  const stream = jsonl([...toolUse("toolu_ws", "WebSearch", { query: "x" }), toolResult("toolu_ws", "ok")]) + runs.weather();
  for (const l of stream.split("\n")) m.line(l.replaceAll("{{SID}}", "sid-1"));
  m.line(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "sub", name: "WebFetch", input: {} }] }, parent_tool_use_id: "toolu_task" }));
  expect(seen).toEqual(["WebSearch", "StructuredOutput"]);
});
