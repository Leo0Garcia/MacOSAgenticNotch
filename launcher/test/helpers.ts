import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, configFromEnv } from "../src/config";

export const launcherDir = join(import.meta.dir, "..");

/** A throwaway $HOME, Jarvis repo, ~/.claude and stub binaries. */
export function makeWorld() {
  const root = mkdtempSync(join(tmpdir(), "jarvis-launcher-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  for (const d of [home, bin, join(repo, "guard"), join(repo, "launcher", "src"), join(repo, "skills", "kanban"), join(repo, "skills", "not-a-skill"), join(repo, "librarian", "src"), join(repo, "bridge", "src")])
    mkdirSync(d, { recursive: true });
  writeFileSync(join(repo, "guard", "settings.json"), "{}\n");
  writeFileSync(join(repo, "bridge", "src", "server.ts"), "// stand-in: the stub claude never starts it\n");
  copyFileSync(join(launcherDir, "prompt.md"), join(repo, "launcher", "prompt.md"));
  writeFileSync(join(repo, "skills", "kanban", "SKILL.md"), "---\nname: kanban\n---\n");

  const exe = (name: string, body: string) => {
    const p = join(bin, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  const claude = exe("claude", `exec "${process.execPath}" "${join(launcherDir, "test", "stub-claude.ts")}" "$@"`);
  const launchctl = exe("launchctl", `printf '%s\\n' "$*" >> "${join(root, "launchctl.txt")}"; exit \${STUB_LAUNCHCTL_EXIT:-0}`);
  const fixture = join(root, "fixture.jsonl");
  const calls = join(root, "calls.jsonl");

  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    JARVIS_REPO: repo,
    JARVIS_CLAUDE_BIN: "claude",
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    JARVIS_LAUNCHCTL: launchctl,
    STUB_FIXTURE: fixture,
    STUB_CALLS: calls,
  };
  // The stub reads STUB_* from the environment the launcher passes on.
  const config = (extra: Record<string, string> = {}): Config => configFromEnv({ ...env, ...extra });
  const read = (name: string) => {
    try {
      return readFileSync(join(root, name), "utf8");
    } catch {
      return "";
    }
  };
  const lastCall = () => JSON.parse(read("calls.jsonl").trim().split("\n").at(-1)!);
  // Records what the shared Speaker would have said, instead of running `say`.
  const said: string[] = [];
  const speechRunner = async (cmd: string[], opts?: { stdin?: string }) => {
    said.push(opts?.stdin ?? cmd.join(" "));
    return { code: 0, stdout: "", stderr: "" };
  };
  return { said, speechRunner, root, home, repo, bin, env, config, fixture, calls, read, lastCall, setFixture: (s: string) => writeFileSync(fixture, s) };
}
