// End to end: the hook as Claude Code runs it, with JSON on stdin.

import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { makeWorld } from "./helpers";

const w = makeWorld();
afterAll(() => rmSync(w.root, { recursive: true, force: true }));
const repoRoot = join(import.meta.dir, "..", "..");

async function runHook(stdin: string, env: Record<string, string | undefined> = {}, viaSettingsCommand = false) {
  const base = { PATH: process.env.PATH, HOME: w.home, JARVIS_REPO: repoRoot, JARVIS_MASTER_VAULT: w.vault, TMPDIR: w.tmp, JARVIS_GUARD_TMPDIRS: w.tmp, ...env };
  const cmd = viaSettingsCommand ? ["sh", "-c", 'bun "$JARVIS_REPO/guard/hook.ts"'] : ["bun", join(repoRoot, "guard", "hook.ts")];
  const p = Bun.spawn(cmd, { stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe", env: base as Record<string, string> });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

const input = (tool_name: string, tool_input: object) =>
  JSON.stringify({ session_id: "s", transcript_path: "/x", cwd: join(w.home, "Jarvis"), permission_mode: "auto", hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "toolu_1" });

test("a blocked call prints a deny decision and exits 0", async () => {
  const { out, code } = await runHook(input("WebFetch", { url: "https://www.gov.uk/student-finance", prompt: "x" }));
  expect(code).toBe(0);
  const j = JSON.parse(out);
  expect(j.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  expect(j.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(j.hookSpecificOutput.permissionDecisionReason).toMatch(/^guard:no-real-consequences: .+ Safe alternative: .+\.$/);
});

test("an allowed call prints nothing, so normal permissions apply", async () => {
  const { out, code } = await runHook(input("WebFetch", { url: "https://wttr.in/Southampton", prompt: "x" }));
  expect(code).toBe(0);
  expect(out).toBe("");
});

test("works through the exact settings.json command", async () => {
  const { out, code } = await runHook(input("Bash", { command: "rm -rf ~/Documents/x" }), {}, true);
  expect(code).toBe(0);
  expect(JSON.parse(out).hookSpecificOutput.permissionDecisionReason).toStartWith("guard:no-harm: ");
});

test("garbage input fails closed with a deny", async () => {
  const { out, code } = await runHook("not json");
  expect(code).toBe(0);
  expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("deny");
});

test("without JARVIS_REPO the settings command fails, so onFailure: block stops the call", async () => {
  const { code } = await runHook(input("WebFetch", { url: "https://wttr.in" }), { JARVIS_REPO: undefined }, true);
  expect(code).not.toBe(0);
});

test("a call is checked quickly", async () => {
  const t = performance.now();
  await runHook(input("Bash", { command: "ls -la ~/Documents && git status" }));
  expect(performance.now() - t).toBeLessThan(1500);
});
