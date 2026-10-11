#!/usr/bin/env bun
// Claude in Chrome needs Google Chrome running with the extension. When it
// isn't connected because Chrome is simply closed, open Chrome in the
// background (no focus taken) and wait for it, instead of asking Leo.
//
//   bun chrome.ts        → "running" | "started" | "not-installed"; exit 0, or 3 if Chrome isn't installed
//
// After "started", wait a few seconds and call list_connected_browsers again.

export type Spawn = (cmd: string[]) => { code: number; stdout: string };

const realSpawn: Spawn = (cmd) => {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore" });
  return { code: r.exitCode ?? 1, stdout: r.stdout.toString() };
};

export async function ensureChrome(spawn: Spawn = realSpawn, sleep = (ms: number) => Bun.sleep(ms), waitMs = 8000): Promise<"running" | "started" | "not-installed"> {
  if (spawn(["pgrep", "-x", "Google Chrome"]).code === 0) return "running";
  // -g: don't bring it to the front; Leo keeps working where he is.
  if (spawn(["open", "-g", "-a", "Google Chrome"]).code !== 0) return "not-installed";
  for (let waited = 0; waited < waitMs; waited += 250) {
    if (spawn(["pgrep", "-x", "Google Chrome"]).code === 0) {
      await sleep(2500); // the extension connects a moment after Chrome starts
      return "started";
    }
    await sleep(250);
  }
  return "started";
}

if (import.meta.main) {
  const r = await ensureChrome();
  console.log(r);
  process.exit(r === "not-installed" ? 3 : 0);
}
