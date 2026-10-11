// Everything the guard needs to know about the machine, injectable for tests.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface GuardContext {
  home: string;
  /** ~/Jarvis: runtime folder. Deletes and overwrites allowed inside. */
  jarvisHome: string;
  /** ~/Jarvis-Memory: memory vault. Overwrites allowed inside, deletes not. */
  jarvisMemory: string;
  /** This repository. Deletes and overwrites allowed inside. */
  repo: string;
  /** Temp folders. Deletes and overwrites allowed inside. */
  tmpDirs: string[];
  /** Leo's master vault. Read-only except Kanban.md at its root. */
  masterVault: string;
  /** MCP server names (regex, whole name) that point at the master vault. */
  masterVaultMcpServers: RegExp;
  exists(p: string): boolean;
  isDir(p: string): boolean;
  realpath(p: string): string;
  readFile(p: string): string | null;
}

export const DEFAULT_MASTER_VAULT = "/Users/leogarcia/Documents/Obsidian Master Vault";

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function contextFromEnv(env: Record<string, string | undefined> = process.env): GuardContext {
  const home = env.HOME || homedir();
  const repo = env.JARVIS_REPO || dirname(dirname(import.meta.dir));
  // JARVIS_GUARD_TMPDIRS (colon-separated) replaces the default temp folders; tests use it.
  const tmp = env.JARVIS_GUARD_TMPDIRS
    ? env.JARVIS_GUARD_TMPDIRS.split(":").filter(Boolean)
    : [env.TMPDIR || tmpdir(), "/tmp", "/private/tmp"];
  return {
    home,
    jarvisHome: env.JARVIS_HOME || join(home, "Jarvis"),
    jarvisMemory: env.JARVIS_MEMORY || join(home, "Jarvis-Memory"),
    repo,
    tmpDirs: [...new Set(tmp)],
    masterVault: env.JARVIS_MASTER_VAULT || DEFAULT_MASTER_VAULT,
    masterVaultMcpServers: new RegExp(`^(?:${env.JARVIS_MASTER_VAULT_MCP || "obsidian"})$`, "i"),
    exists: (p) => existsSync(p),
    isDir: (p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    realpath: safeRealpath,
    readFile: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
  };
}
