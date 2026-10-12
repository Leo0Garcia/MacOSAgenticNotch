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

test("quick asks get the fast model; research, writing and long requests the smart one", async () => {
  const { modelFor, needsSmartModel } = await import("../src/args");
  const cfg = configFromEnv({ HOME: "/h", JARVIS_REPO: "/r" });
  for (const q of ["what's the time", "what's the weather in Southampton", "add buy chalk to my Kanban", "remind me to call Sue at 5", "what's my first lecture tomorrow", "pay my tuition"])
    expect(modelFor(cfg, q)).toBe("sonnet");
  for (const q of ["start a research session on heat pumps", "write me a cover letter for the Arm internship", "plan my revision for next week", "think carefully about whether I should switch modules", "debug the failing test in my repo"])
    expect(needsSmartModel(q)).toBe(true);
  expect(needsSmartModel("a ".repeat(30) + "question")).toBe(true);
  expect(modelFor(cfg, "write a brief on the Amra launch")).toBeUndefined(); // Leo's default (Opus)
  expect(modelFor(configFromEnv({ HOME: "/h", JARVIS_MODEL: "opus" }), "what's the time")).toBe("opus"); // pinned
  expect(modelFor(configFromEnv({ HOME: "/h", JARVIS_FAST_MODEL: "" }), "what's the time")).toBeUndefined(); // routing off
});

test("opening a saved run in Desktop goes through a pty (claude --desktop refuses without one)", async () => {
  const { desktopOpenCommand } = await import("../src/cli");
  expect(desktopOpenCommand("claude", "abc")).toEqual(["/usr/bin/script", "-q", "/dev/null", "claude", "--desktop", "--resume", "abc"]);
});
