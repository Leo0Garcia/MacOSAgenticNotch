// Variables a command sets for itself (Leo, 2026-11-09: "lighten the guard").
// A plain `D=/path` at the start is resolved, so `cp x "$D/y"` is judged on
// the real path instead of refused; anything that could change it unseen isn't.

import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { makeWorld, run } from "./helpers";

const w = makeWorld();
afterAll(() => rmSync(w.root, { recursive: true, force: true }));
const bash = (command: string) => run(w, { tool_name: "Bash", tool_input: { command }, cwd: "$HOME/Jarvis" });
const ok = (r: ReturnType<typeof bash>) => r === null;

test("a variable set at the start resolves, and the real path is still checked", async () => {
  expect(ok(await bash('V="$VAULT/.obsidian"; D=$HOME/Jarvis/cache/x; mkdir -p $D && cp "$V/snippets/done.css" $D/done.css'))).toBe(true);
  expect(ok(await bash('export D="$HOME/Jarvis/cache"; cp ~/Jarvis/briefing.md "${D}/b.md"'))).toBe(true);
  // Resolved into somewhere protected: the usual rules apply.
  expect(ok(await bash("D=$HOME/Documents; cp ~/Jarvis/briefing.md $D/essay.md"))).toBe(false);
  expect(ok(await bash("D=$HOME/.ssh; cp ~/Jarvis/briefing.md $D/id_rsa"))).toBe(false);
  expect(ok(await bash("D=$HOME/Documents; rm -rf $D"))).toBe(false);
});

test("a variable that could change unseen is not trusted", async () => {
  for (const c of [
    "D=$HOME/Jarvis/x; for D in $HOME/Documents; do rm -rf $D; done",
    "D=$HOME/Jarvis/x; D=$HOME/Documents; rm -rf $D",
    "D=$HOME/Jarvis/x; read D; rm -rf $D",
    "(D=$HOME/Jarvis/x); rm -rf $D/",
    "echo hi | D=$HOME/Jarvis/x; rm -rf $D/",
    "D=$(pwd)/x; rm -rf $D",
    "true && D=$HOME/Jarvis/x; rm -rf $D/",
  ]) expect([c, ok(await bash(c))]).toEqual([c, false]);
});
