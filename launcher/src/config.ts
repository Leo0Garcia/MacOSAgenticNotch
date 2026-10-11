// Paths and external commands the launcher uses, all overridable through the
// environment so tests can point every one of them at a temp folder or stub.

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const MIN_CLAUDE_VERSION = "2.1.295"; // guard's onFailure: "block"
export const FOLLOWUP_WINDOW_MS = 2 * 60 * 1000;
export const BRIDGE_SERVER = "jarvis";

export interface Config {
  repo: string;
  home: string; // ~/Jarvis
  memory: string; // ~/Jarvis-Memory
  claudeBin: string;
  claudeConfigDir: string; // where Claude Code keeps projects/<dir>/<session>.jsonl
  bunBin: string;
  model?: string;
  launchctl: string;
  launchAgentsDir: string;
  env: Record<string, string | undefined>;
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): Config {
  const home = env.HOME ?? homedir();
  const repo = resolve(env.JARVIS_REPO ?? join(import.meta.dir, "..", ".."));
  return {
    repo,
    home: env.JARVIS_HOME ?? join(home, "Jarvis"),
    memory: env.JARVIS_MEMORY ?? join(home, "Jarvis-Memory"),
    claudeBin: env.JARVIS_CLAUDE_BIN ?? "claude",
    claudeConfigDir: env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"),
    bunBin: process.execPath,
    model: env.JARVIS_MODEL || undefined,
    launchctl: env.JARVIS_LAUNCHCTL ?? "launchctl",
    launchAgentsDir: env.JARVIS_LAUNCH_AGENTS ?? join(home, "Library", "LaunchAgents"),
    env,
  };
}

export const paths = (c: Config) => ({
  briefing: join(c.home, "briefing.md"),
  systemPrompt: join(c.home, "state", "system-prompt.md"),
  repoPrompt: join(c.repo, "launcher", "prompt.md"),
  runs: join(c.home, "runs"),
  runLog: (sessionId: string) => join(c.home, "runs", `${sessionId}.jsonl`),
  state: join(c.home, "state"),
  lastRun: join(c.home, "state", "last-run.json"),
  /** Per-run MCP config with the session id as a literal argument (DESIGN 8.1). */
  mcpConfig: (sessionId: string) => join(c.home, "runs", `${sessionId}.mcp.json`),
  versionCache: join(c.home, "state", "claude-version.json"),
  logs: join(c.home, "logs"),
  launcherLog: join(c.home, "logs", "launcher.log"),
  skillsDir: join(c.home, ".claude", "skills"),
  reminders: join(c.home, "reminders"),
  guardSettings: join(c.repo, "guard", "settings.json"),
  bridgeServer: join(c.repo, "bridge", "src", "server.ts"),
  bridgeCli: join(c.repo, "bridge", "src", "cli.ts"),
  librarianCli: join(c.repo, "librarian", "src", "cli.ts"),
  remindersCli: join(c.repo, "launcher", "src", "reminders.ts"),
  repoSkills: join(c.repo, "skills"),
});

// Environment for anything the launcher starts: guard and skills need
// JARVIS_REPO and bun on PATH, the bridge and librarian need JARVIS_HOME.
export function childEnv(c: Config, extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.env)) if (v !== undefined) out[k] = v;
  const bunDir = dirname(c.bunBin);
  const path = out.PATH ?? "/usr/bin:/bin";
  out.PATH = path.split(":").includes(bunDir) ? path : `${bunDir}:${path}`;
  out.JARVIS_REPO = c.repo;
  out.JARVIS_HOME = c.home;
  out.JARVIS_MEMORY = c.memory;
  return { ...out, ...extra };
}
