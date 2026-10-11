/** Log/YYYY-MM-DD.md: one entry per run, appended by the script, never by the model directly. */
import { join } from "node:path";
import type { Config } from "./config";
import { atomicWrite, readIfExists } from "./fsutil";
import { looksSecret } from "./ops";
import { hhmm, isoDate } from "./time";
import { noteName } from "./vault";

export interface LogEntry {
  endedAt: Date;
  kept: boolean;
  summary: string;
  sessionId?: string;
  lines: string[];
  touched: string[];
  problem?: string;
}

export function logPath(cfg: Config, at: Date): string {
  return join(cfg.memory, "Log", `${isoDate(at, cfg.tz)}.md`);
}

export function formatEntry(cfg: Config, e: LogEntry): string {
  const kind = e.kept ? "saved" : "ephemeral";
  const session = e.kept && e.sessionId ? ` (session \`${e.sessionId}\`)` : "";
  const summary = e.summary.replace(/\s+/g, " ").trim() || "(no summary)";
  const out = [`- ${hhmm(e.endedAt, cfg.tz)} ${kind}: ${summary}${session}`];
  for (const l of e.lines.slice(0, 8)) {
    if (looksSecret(l)) continue;
    out.push(`  - ${l.replace(/^[-*]\s+/, "")}`);
  }
  if (e.touched.length) out.push(`  - Notes: ${e.touched.map((r) => `[[${noteName(r)}]]`).join(", ")}`);
  if (e.problem) out.push(`  - Librarian problem: ${e.problem}`);
  return out.join("\n");
}

export async function appendLog(cfg: Config, e: LogEntry): Promise<string> {
  const path = logPath(cfg, e.endedAt);
  const day = isoDate(e.endedAt, cfg.tz);
  const current = (await readIfExists(path)) ?? `# ${day}\n\n`;
  const sep = current.endsWith("\n") ? "" : "\n";
  await atomicWrite(path, `${current}${sep}${formatEntry(cfg, e)}\n`);
  return `Log/${day}.md`;
}
