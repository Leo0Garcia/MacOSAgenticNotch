// Paths and run identity the bridge needs. Everything lives under ~/Jarvis
// (JARVIS_HOME) and this repo (JARVIS_REPO); nothing else is touched.

import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface BridgeConfig {
  home: string;
  repo: string;
  sessionId: string | null;
}

export function loadConfig(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const home = env.JARVIS_HOME || join(homedir(), "Jarvis");
  const repo = env.JARVIS_REPO || resolve(import.meta.dir, "../..");
  return { home, repo, sessionId: argValue(argv, "--session-id") ?? (env.JARVIS_SESSION_ID || null) };
}

export function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(flag + "="));
  return eq?.slice(flag.length + 1);
}

export const notchFile = (home: string) => join(home, "notch.json");
export const actionsDb = (home: string) => join(home, "actions.sqlite");
export const speechLock = (home: string) => join(home, "run", "speech.lock");
