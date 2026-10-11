import { expect, test } from "bun:test";
import { claudeArgs, RESULT_SCHEMA, savedRunName } from "../src/args";
import { configFromEnv } from "../src/config";

const c = configFromEnv({ HOME: "/Users/leo", JARVIS_REPO: "/repo", PATH: "/usr/bin" });

test("a new run uses the DESIGN 4.2 flags with a launcher-chosen session id", () => {
  const a = claudeArgs(c, { prompt: "weather?", sessionId: "11111111-1111-4111-8111-111111111111" });
  expect(a).toEqual([
    "-p", "weather?",
    "--session-id", "11111111-1111-4111-8111-111111111111",
    "--settings", "/repo/guard/settings.json",
    "--mcp-config", "/Users/leo/Jarvis/runs/11111111-1111-4111-8111-111111111111.mcp.json",
    "--append-system-prompt-file", "/Users/leo/Jarvis/state/system-prompt.md",
    "--permission-mode", "auto",
    "--permission-prompts", "none",
    "--chrome",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--json-schema", JSON.stringify(RESULT_SCHEMA),
  ]);
  expect(a).not.toContain("--bare");
  expect(a).not.toContain("--strict-mcp-config");
});

test("a follow-up resumes instead of choosing a new id, and names are passed through", () => {
  const a = claudeArgs(configFromEnv({ HOME: "/h", JARVIS_REPO: "/r", JARVIS_MODEL: "sonnet" }), { prompt: "x", resume: "abc", name: "Jarvis: X" });
  expect(a.slice(0, 8)).toEqual(["-p", "x", "--resume", "abc", "--name", "Jarvis: X", "--model", "sonnet"]);
  expect(a).not.toContain("--session-id");
});

test("the schema requires keep and summary", () => {
  expect(RESULT_SCHEMA.required).toEqual(["keep", "summary"]);
});

test("only explicit saved intents get a name", () => {
  expect(savedRunName("Start a research session on solid-state batteries.")).toBe("Jarvis: Research: solid-state batteries");
  expect(savedRunName("Jarvis, write me a brief on the Amra launch")).toBe("Jarvis: Brief: the Amra launch");
  expect(savedRunName("start a saved session about the thesis")).toBe("Jarvis: the thesis");
  expect(savedRunName("what's the weather in Southampton")).toBeUndefined();
  expect(savedRunName("research the best headphones")).toBeUndefined();
  expect(savedRunName(`start a research session on ${"x".repeat(100)}`)!.length).toBeLessThanOrEqual(68);
});
