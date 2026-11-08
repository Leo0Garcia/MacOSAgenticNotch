// The morning check (08:00) and the midnight wrap-up prompt (00:00), both run
// by launchd through `run.sh` (Leo, 2026-10-22).

import { osNotify, NotchLink } from "../../bridge/src/notch";
import { runCommand, type Runner } from "../../bridge/src/system";
import { checkAuth, saveAuth, SIGNED_OUT_LINE } from "./auth";
import type { Config } from "./config";
import { dailyPlist, installDaily, londonHour } from "./daily";
import { homeRunner, readBoard } from "./instant";
import type { Exec } from "./reminders/scheduler";
import { snapshotKanban } from "./wrapup";

export const MORNING_LABEL = "com.jarvis.morning-check";
export const WRAPUP_LABEL = "com.jarvis.wrapup-prompt";

export const installMorningCheck = (c: Config, exec?: Exec) => installDaily(c, MORNING_LABEL, dailyPlist(c, MORNING_LABEL, ["morning-check"], 8, 0, "morning-check.log"), exec);
export const installWrapupPrompt = (c: Config, exec?: Exec) => installDaily(c, WRAPUP_LABEL, dailyPlist(c, WRAPUP_LABEL, ["wrapup-prompt"], 0, 0, "wrapup-prompt.log"), exec);

/** Checks the Claude sign-in (notifying if it's gone) and keeps the day's Kanban snapshot. Returns a log line. */
export async function morningCheck(c: Config, run: Runner = homeRunner(c), now = new Date()): Promise<string> {
  const board = await readBoard(c, run);
  if (board) snapshotKanban(c, board, now);
  const auth = await checkAuth(c, run, now);
  saveAuth(c, auth);
  if (auth.problem === "signed-out") await osNotify(run, "Jarvis", SIGNED_OUT_LINE).catch(() => {});
  return `sign-in ${auth.ok ? "ok" : "SIGNED OUT"}${auth.problem === "error" ? ` (Claude error: ${auth.detail})` : ""}; kanban ${board ? "snapshot kept" : "unreadable"}`;
}

const YES = /^(?:y|yes|yeah|yep|yup|sure|ok|okay|go on|go ahead|please|yes please|do it)\b/i;

/**
 * Asks in the notch whether Leo wants his wrap-up, and on a yes sends "wrap up
 * my day" to the app like any request. Does nothing when launchd runs it late
 * (the Mac was asleep at midnight) or the app isn't open.
 */
export async function wrapupPrompt(
  c: Config,
  opts: { now?: Date; link?: Pick<NotchLink, "ask" | "close">; run?: Runner; timeoutMs?: number } = {},
): Promise<string> {
  const now = opts.now ?? new Date();
  const h = londonHour(now);
  if (h !== 23 && h !== 0) return `skipped: it's ${h}:00, not midnight`;
  const link = opts.link ?? new NotchLink({ home: c.home, client: "launcher", sessionId: null, connectTimeoutMs: 1000 });
  try {
    const a = await link.ask({
      type: "ask",
      id: `wrapup-${now.getTime()}`,
      question: "It's midnight. Want your wrap-up for today?",
      options: ["Yes", "Not tonight"],
      timeout_ms: opts.timeoutMs ?? 20 * 60 * 1000,
      session_id: null,
    });
    if (a === null) return "skipped: the notch app isn't open";
    if (a === "timeout") return "no answer";
    if (!YES.test(a.text.trim())) return `declined (${a.via})`;
    const r = await (opts.run ?? runCommand)(["open", "jarvis://ask?q=wrap%20up%20my%20day"]);
    return r.code === 0 ? "wrap-up started" : `couldn't start it: ${r.stderr.trim()}`;
  } finally {
    link.close();
  }
}
