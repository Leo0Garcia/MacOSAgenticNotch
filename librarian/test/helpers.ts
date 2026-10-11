import { mkdtemp, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Config } from "../src/config";
import type { Runner } from "../src/snapshot";

export const REPO = resolve(import.meta.dir, "../..");
export const FIXTURES = join(import.meta.dir, "fixtures");

/** Monday 12 October 2026, 14:05 in London (BST). */
export const NOW = new Date("2026-10-12T13:05:00Z");

export async function tempConfig(now = NOW): Promise<Config & { root: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "librarian-")));
  const memory = join(root, "Jarvis-Memory");
  const home = join(root, "Jarvis");
  await mkdir(memory, { recursive: true });
  await mkdir(home, { recursive: true });
  return {
    root,
    repo: REPO,
    home,
    memory,
    claudeBin: join(FIXTURES, "stub-claude.sh"),
    tz: "Europe/London",
    now: () => now,
  };
}

/** Runner that answers by command name and fails everything else like a missing binary. */
export function fakeRunner(answers: Record<string, { code?: number; stdout?: string; stderr?: string }>): Runner {
  return async (cmd) => {
    const key = cmd.slice(0, cmd[0] === "lsappinfo" ? 2 : cmd[1] === "agents" ? 2 : 1).join(" ").replace(/^.*stub-claude\.sh/, "claude");
    const a = answers[key];
    if (!a) return { code: 127, stdout: "", stderr: `${cmd[0]}: not found` };
    return { code: a.code ?? 0, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  };
}
