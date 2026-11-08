// Runs cut off by a Mac or Jarvis restart (DESIGN 4.4). activeRuns() moves a
// dead launcher's record to state/interrupted/; at launch the app claims the
// ones worth resuming and starts `run.sh resume <id>` for each.

import { readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { type Config, paths } from "./config";
import { hasTranscript } from "./finalize";
import { type RunOptions, run } from "./run";
import { type ActiveRun, activeRuns, log } from "./store";

export const RESUME_WITHIN_MS = 6 * 3600 * 1000;
export const RESUME_PROMPT =
  "Jarvis restarted while you were working on this. Carry on from where you left off and finish it, then tell Leo the result in one or two sentences.";

const claimedPath = (c: Config, sessionId: string) => `${paths(c).interrupted}/${sessionId}.claimed.json`;

/**
 * Interrupted runs to resume, oldest first. Each is claimed (renamed, so two
 * callers can't both get it). Too old, or with no transcript left: dropped and
 * logged, claimed ones that were never resumed included.
 */
export function claimInterrupted(c: Config, now = Date.now()): ActiveRun[] {
  activeRuns(c);
  const dir = paths(c).interrupted;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: ActiveRun[] = [];
  for (const f of files) {
    const path = `${dir}/${f}`;
    try {
      const r = JSON.parse(readFileSync(path, "utf8")) as ActiveRun;
      const drop = now - r.startedAt > RESUME_WITHIN_MS ? "too old" : !hasTranscript(c, r.sessionId) ? "no transcript" : undefined;
      if (drop) {
        rmSync(path, { force: true });
        log(c, "dropped an interrupted run", { sessionId: r.sessionId, request: r.request, why: drop });
      } else if (!f.endsWith(".claimed.json")) {
        renameSync(path, claimedPath(c, r.sessionId));
        out.push(r);
      }
    } catch {}
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

/** A claimed run's record, removed so it's resumed once. */
export function takeClaimed(c: Config, sessionId: string): ActiveRun | undefined {
  const p = claimedPath(c, sessionId);
  try {
    const r = JSON.parse(readFileSync(p, "utf8")) as ActiveRun;
    rmSync(p);
    return r;
  } catch {
    return undefined;
  }
}

export function resumeRun(c: Config, r: ActiveRun, opts: RunOptions = {}) {
  return run(c, RESUME_PROMPT, { ...opts, resume: r.sessionId, pickUp: r, background: r.background });
}
