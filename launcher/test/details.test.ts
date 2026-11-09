import { expect, test } from "bun:test";
import { isSecret, MAX_DETAIL_BYTES, Timeline, toolInput } from "../src/details";

const base = { request: "q", reply: "", route: "claude" as const, outcome: "done" as const, saved: false };

test("the JSON is capped by dropping the oldest outputs first, then inputs", () => {
  let t = 0;
  const tl = new Timeline(0, () => (t += 10));
  for (let i = 0; i < 100; i++) {
    tl.step("Running a command", undefined, `s${i}`, { tool: "Bash", input: `cmd ${i}` });
    tl.stepDone(`s${i}`, false, `${i} `.repeat(400));
  }
  const d = tl.finish(base);
  expect(JSON.stringify(d).length).toBeLessThanOrEqual(MAX_DETAIL_BYTES);
  expect(d.steps[0].output).toBeUndefined();
  expect(d.steps.at(-1)!.output).toStartWith("99 ");
  expect(d.steps[0].input).toBe("cmd 0");
  // The timeline's own steps are untouched, so a later finish() still has them.
  expect(tl.steps[0].output).toBeDefined();
});

test("the chat starts with Leo's request, and falls back to the reply when nothing streamed", () => {
  let t = 0;
  const tl = new Timeline(0, () => (t += 5));
  tl.mark("result");
  tl.say("checker", "Checked: looks right");
  expect(tl.finish({ ...base, reply: "Lights off." }).chat!.map((l) => l.who)).toEqual(["leo", "jarvis", "checker"]);
});

test("tool inputs read as the command, path or query; credential calls are secret", () => {
  expect(toolInput({ command: "ls", description: "List" })).toBe("ls");
  expect(toolInput({ query: "weather" })).toBe("weather");
  expect(toolInput({ a: 1 })).toBe('{"a":1}');
  expect(isSecret("Bash", { command: "security find-generic-password -s jarvis/hue -w" })).toBe(true);
  expect(isSecret("Read", { file_path: "/Users/x/.ssh/id_ed25519" }, { HOME: "/Users/x" })).toBe(true);
  expect(isSecret("Bash", { command: "cat ~/.aws/credentials" }, { HOME: "/Users/x" })).toBe(true);
  expect(isSecret("Bash", { command: "ls ~/Documents" }, { HOME: "/Users/x" })).toBe(false);
});
