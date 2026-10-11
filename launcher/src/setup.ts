// Cheap checks and fix-ups done before every run: Claude Code version, the
// skill symlinks in ~/Jarvis/.claude/skills, and the system prompt file.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Config, MIN_CLAUDE_VERSION, paths } from "./config";
import { writeFileAtomic } from "./store";

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/**
 * Returns an error message if claude is missing or too old. The answer is
 * cached against the binary's path and mtime so a run doesn't pay for an
 * extra `claude --version` every time.
 */
export function checkClaudeVersion(c: Config): string | undefined {
  const bin = Bun.which(c.claudeBin, { PATH: c.env.PATH ?? "" });
  if (!bin) return `I can't find the claude command. Install Claude Code (v${MIN_CLAUDE_VERSION} or later) and make sure it's on PATH.`;
  const mtime = statSync(bin).mtimeMs;
  const cacheFile = paths(c).versionCache;
  let version: string | undefined;
  try {
    const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
    if (cached.bin === bin && cached.mtime === mtime) version = cached.version;
  } catch {}
  if (!version) {
    const p = Bun.spawnSync([bin, "--version"], { env: c.env as Record<string, string>, stdout: "pipe", stderr: "pipe" });
    version = /(\d+\.\d+\.\d+)/.exec(p.stdout.toString())?.[1];
    if (!version) return `claude --version printed nothing I can read (exit ${p.exitCode}).`;
    writeFileAtomic(cacheFile, JSON.stringify({ bin, mtime, version }));
  }
  if (compareVersions(version, MIN_CLAUDE_VERSION) < 0)
    return `Claude Code ${version} is too old for Jarvis; it needs v${MIN_CLAUDE_VERSION} or later. Run claude update.`;
  return undefined;
}

/**
 * Makes ~/Jarvis/.claude/skills/<name> a symlink to <repo>/skills/<name> for
 * every skill folder in the repo, and removes links into the repo whose
 * target is gone. Never touches anything that isn't one of those links.
 */
export function linkSkills(c: Config): string[] {
  const p = paths(c);
  const repoSkills = resolve(p.repoSkills);
  mkdirSync(p.skillsDir, { recursive: true });
  const linked: string[] = [];
  const wanted = new Set<string>();
  if (existsSync(repoSkills)) {
    for (const name of readdirSync(repoSkills)) {
      const src = join(repoSkills, name);
      if (!existsSync(join(src, "SKILL.md"))) continue;
      wanted.add(name);
      const dst = join(p.skillsDir, name);
      let current: string | undefined;
      try {
        if (lstatSync(dst).isSymbolicLink()) current = readlinkSync(dst);
        else continue; // a real folder of Leo's: leave it alone
      } catch {}
      if (current === src) {
        linked.push(name);
        continue;
      }
      if (current !== undefined) rmSync(dst);
      symlinkSync(src, dst);
      linked.push(name);
    }
  }
  for (const name of readdirSync(p.skillsDir)) {
    const dst = join(p.skillsDir, name);
    try {
      if (!lstatSync(dst).isSymbolicLink()) continue;
      const target = resolve(p.skillsDir, readlinkSync(dst));
      if (target.startsWith(repoSkills + "/") && !wanted.has(name)) rmSync(dst);
    } catch {}
  }
  return linked;
}

/**
 * Builds the file passed to --append-system-prompt-file: Jarvis's standing
 * instructions (launcher/prompt.md) followed by the librarian's briefing.md.
 * A missing or stale briefing never stops a run (DESIGN 5).
 */
export function buildSystemPrompt(c: Config): string {
  const p = paths(c);
  const parts = [readFileSync(p.repoPrompt, "utf8").trim()];
  try {
    const b = readFileSync(p.briefing, "utf8").trim();
    if (b) parts.push(b);
  } catch {
    parts.push(`# Briefing\n\nThe librarian hasn't written a briefing yet. Read ${c.memory}/Me.md and ${c.memory}/Index.md if you need context about Leo or his projects.`);
  }
  writeFileAtomic(p.systemPrompt, parts.join("\n\n---\n\n") + "\n");
  return p.systemPrompt;
}
