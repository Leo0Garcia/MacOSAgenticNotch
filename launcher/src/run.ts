// One Jarvis request, start to finish: plan the run, spawn claude -p, speak
// the reply as it streams, record the outcome and hand off to finalize.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { claudeArgs, type RunPlan, savedRunName } from "./args";
import { childEnv, type Config, paths } from "./config";
import { deleteRunLog, deleteTranscript, startFinalize } from "./finalize";
import { buildSystemPrompt, checkClaudeVersion, linkSkills } from "./setup";
import { Speaker } from "./speaker";
import { ensureDirs, type LastRun, log, recentRun, recordRun, saveLastRun } from "./store";
import { type Denial, initProblem, RunMonitor } from "./stream";

/** Lines the launcher prints on stdout, one JSON object each, for the notch app. */
export type LauncherEvent =
  | { event: "state"; state: "working" | "done" | "needs-you" | "error"; sessionId?: string }
  | { event: "speak"; text: string }
  | { event: "denied"; tool: string; rule?: string; reason?: string }
  | { event: "warning"; message: string }
  | { event: "done"; sessionId: string; keep: boolean; summary: string; reply: string; name?: string }
  | { event: "error"; message: string; sessionId?: string };

export interface RunOptions {
  emit?: (e: LauncherEvent) => void;
  /** Defaults to starting `cli.ts finalize` detached. Tests replace it. */
  finalize?: (sessionId: string, keep: boolean, runLog: string) => void;
  now?: () => number;
}

export interface RunOutcome {
  exitCode: number;
  sessionId?: string;
  keep?: boolean;
  summary?: string;
  reply?: string;
  denials?: Denial[];
  error?: string;
}

const FOLLOWUP = /^\s*(?:jarvis[,:]?\s+)?(?:and\s+also|and\s+then|also)\b[,:]?\s*/i;

/** Works out the claude invocation, including "and also…" follow-ups (DESIGN 4.4). */
export function planRun(c: Config, request: string, now = Date.now()): RunPlan & { runLog: string; resumed: boolean } {
  const p = paths(c);
  const last: LastRun | undefined = FOLLOWUP.test(request) ? recentRun(c, now) : undefined;
  if (last?.keep) {
    // Follow-up to a saved run: resume it. Its own log stays untouched.
    return { prompt: request, resume: last.sessionId, runLog: `${p.runs}/${last.sessionId}.followup-${now}.jsonl`, resumed: true };
  }
  const sessionId = randomUUID();
  let prompt = request;
  if (last && !last.keep && last.request !== undefined) {
    prompt = [
      "This follows on from Leo's previous request a moment ago.",
      `Leo: ${last.request}`,
      `Jarvis: ${last.reply ?? ""}`,
      "",
      `Leo now says: ${request}`,
    ].join("\n");
  }
  return { prompt, sessionId, name: savedRunName(request), runLog: p.runLog(sessionId), resumed: false };
}

export async function run(c: Config, request: string, opts: RunOptions = {}): Promise<RunOutcome> {
  const emit = opts.emit ?? ((e) => process.stdout.write(JSON.stringify(e) + "\n"));
  const now = opts.now ?? Date.now;
  const speaker = new Speaker(c.say);
  const speak = (text: string) => {
    emit({ event: "speak", text });
    speaker.say(text);
  };
  const fail = async (message: string, sessionId?: string, spoken = message): Promise<RunOutcome> => {
    log(c, "run failed", { sessionId, message });
    speak(spoken);
    emit({ event: "error", message, sessionId });
    emit({ event: "state", state: "error", sessionId });
    await speaker.drain();
    return { exitCode: 1, sessionId, error: message };
  };

  request = request.trim();
  if (!request) return fail("empty request", undefined, "I didn't catch that.");

  ensureDirs(c);
  const p = paths(c);
  const versionProblem = checkClaudeVersion(c);
  if (versionProblem) return fail(versionProblem);
  // Never run unguarded: without guard/ there are no hard limits.
  if (!existsSync(p.guardSettings)) return fail(`guard isn't installed: ${p.guardSettings} is missing`, undefined, "I can't run without my guard rules. The guard folder is missing from the Jarvis repo.");
  if (!existsSync(p.mcpConfig)) return fail(`${p.mcpConfig} is missing`);
  linkSkills(c);
  buildSystemPrompt(c);

  const plan = planRun(c, request, now());
  const sessionId = (plan.resume ?? plan.sessionId)!;
  const startedAt = new Date(now()).toISOString();
  recordRun(c, { sessionId, startedAt, request, name: plan.name, status: "running", resumedFrom: plan.resume });
  emit({ event: "state", state: "working", sessionId });

  mkdirSync(p.runs, { recursive: true });
  const logFile = Bun.file(plan.runLog).writer();
  let initFailure: string | undefined;
  const proc = Bun.spawn([c.claudeBin, ...claudeArgs(c, plan)], {
    cwd: c.home,
    env: childEnv(c, { JARVIS_RUN_SESSION_ID: sessionId }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const monitor = new RunMonitor({
    onSentence: speak,
    onInit: (init) => {
      initFailure = initProblem(init);
      if (initFailure) proc.kill("SIGTERM");
      else if (init.chromeStatus !== "connected")
        emit({ event: "warning", message: `Claude in Chrome isn't connected (status: ${init.chromeStatus ?? "missing"})` });
    },
  });

  const stderrText = new Response(proc.stderr).text();
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of proc.stdout) {
    logFile.write(chunk);
    if (initFailure) continue;
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      monitor.line(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (initFailure) break;
    }
  }
  if (!initFailure && buf) monitor.line(buf);
  await logFile.end();
  const exitCode = await proc.exited;
  const stderr = await stderrText;

  if (initFailure) {
    // Nothing happened yet, so nothing to keep.
    if (!plan.resume) {
      deleteTranscript(c, sessionId);
      deleteRunLog(c, plan.runLog);
    }
    recordRun(c, { sessionId, startedAt, endedAt: new Date(now()).toISOString(), request, status: "error", summary: initFailure, keep: false });
    return fail(`run stopped before it started: ${initFailure}`, sessionId, `I can't start: ${initFailure}.`);
  }

  const res = monitor.finish(exitCode);
  for (const d of res.denials) emit({ event: "denied", tool: d.tool, rule: d.rule, reason: d.reason });
  // A follow-up to a saved run never deletes it.
  const keep = plan.resumed ? true : res.keep;
  if (res.problem) log(c, "run result problem", { sessionId, problem: res.problem, exitCode, stderr: stderr.slice(-2000) });

  if (!res.reply) {
    const guard = res.denials.find((d) => d.reason);
    if (guard?.reason) speak(guard.reason.replace(/^guard:[a-z-]+:\s*/, "I can't do that: "));
    else if (res.isError) speak("Something went wrong with that run. It's in the log.");
  }

  const status = res.isError && !res.reply ? "error" : res.denials.length ? "needs-you" : "done";
  const endedAt = now();
  saveLastRun(c, { sessionId, keep, endedAt, request, reply: res.reply });
  recordRun(c, { sessionId, startedAt, endedAt: new Date(endedAt).toISOString(), request, name: plan.name, status, keep, summary: res.summary, denials: res.denials });
  emit({ event: "done", sessionId, keep, summary: res.summary, reply: res.reply, name: plan.name });
  emit({ event: "state", state: status, sessionId });

  (opts.finalize ?? ((id, k, l) => startFinalize(c, id, k, l)))(sessionId, keep, plan.runLog);
  await speaker.drain();
  return { exitCode: status === "error" ? 1 : 0, sessionId, keep, summary: res.summary, reply: res.reply, denials: res.denials };
}
