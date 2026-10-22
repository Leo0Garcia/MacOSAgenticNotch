// The morning sign-in check (Leo, 2026-10-22): find out Claude is signed out
// before a request fails. `claude auth status` only reads local state, and an
// expired session still shows as signed in there, so a tiny no-tools request
// confirms it. The result goes in state/claude-auth.json, which the morning
// rundown reads, and a signed-out Mac gets a notification.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Runner } from "../../bridge/src/system";
import { type Config, paths } from "./config";
import { log, writeFileAtomic } from "./store";

export interface AuthState {
  checkedAt: string;
  ok: boolean;
  /** signed-out, or an API error that isn't about the sign-in. */
  problem?: "signed-out" | "error";
  detail?: string;
}

export const SIGNED_OUT_LINE = "I'm signed out of Claude, so only quick commands like lights and reminders work. Open Terminal, run claude, and type /login.";
const AUTH_ERROR = /authenticat|oauth|log ?in|401|credential|signed out/i;

const file = (c: Config) => join(paths(c).state, "claude-auth.json");

/** The probe: one short answer, no tools, no MCP servers, nothing saved. */
export function probeArgs(c: Config): string[] {
  return [
    c.claudeBin, "-p", "Reply with the word OK.",
    "--model", "haiku",
    "--tools", "",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--settings", paths(c).guardSettings,
    "--no-session-persistence",
    "--output-format", "json",
  ];
}

export async function checkAuth(c: Config, run: Runner, now = new Date()): Promise<AuthState> {
  const at = now.toISOString();
  const status = await run([c.claudeBin, "auth", "status"]);
  if (status.code !== 0) return { checkedAt: at, ok: false, problem: "signed-out", detail: "claude auth status says signed out" };
  const r = await run(probeArgs(c));
  let out: { is_error?: boolean; result?: string } = {};
  try {
    out = JSON.parse(r.stdout);
  } catch {}
  const why = String(out.result ?? r.stderr ?? "").trim();
  if (r.code === 0 && !out.is_error) return { checkedAt: at, ok: true };
  if (AUTH_ERROR.test(why)) return { checkedAt: at, ok: false, problem: "signed-out", detail: why.slice(0, 200) };
  // Out of usage or a Claude outage isn't a sign-in problem; note it, don't warn.
  return { checkedAt: at, ok: true, problem: "error", detail: why.slice(0, 200) || `exit ${r.code}` };
}

export function saveAuth(c: Config, s: AuthState): void {
  writeFileAtomic(file(c), JSON.stringify(s, null, 2));
  log(c, "claude sign-in check", { ok: s.ok, problem: s.problem });
}

/** The last check, if it was within a day. */
export function lastAuth(c: Config, now = new Date()): AuthState | null {
  try {
    const s = JSON.parse(readFileSync(file(c), "utf8")) as AuthState;
    return now.getTime() - Date.parse(s.checkedAt) < 24 * 3600 * 1000 ? s : null;
  } catch {
    return null;
  }
}
