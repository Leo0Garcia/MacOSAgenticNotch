import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface Config {
  /** Repo root (MacOSAgenticNotch). */
  repo: string;
  /** Runtime folder, ~/Jarvis. */
  home: string;
  /** Memory vault, ~/Jarvis-Memory. */
  memory: string;
  /** claude binary. Tests point this at a stub. */
  claudeBin: string;
  /** Leo's time zone. Dates in the vault and briefing use it. */
  tz: string;
  now: () => Date;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const home = env.HOME ?? homedir();
  return {
    repo: env.JARVIS_REPO ?? resolve(import.meta.dir, "../.."),
    home: env.JARVIS_HOME ?? join(home, "Jarvis"),
    memory: env.JARVIS_MEMORY ?? join(home, "Jarvis-Memory"),
    claudeBin: env.JARVIS_CLAUDE_BIN ?? "claude",
    tz: env.JARVIS_TZ ?? "Europe/London",
    now: () => new Date(),
  };
}

export function librarianDir(cfg: Config): string {
  return join(cfg.home, "librarian");
}

export function briefingPath(cfg: Config): string {
  return join(cfg.home, "briefing.md");
}

export function timetableCachePath(cfg: Config): string {
  return join(cfg.home, "cache", "uni.ics");
}
