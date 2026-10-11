// One Jarvis request, start to finish: plan the run, spawn claude -p, speak
// the reply as it streams, log the outcome and hand the run to the librarian.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { appendAction } from "../../bridge/src/actions";
import { NotchLink } from "../../bridge/src/notch";
import type { RunEvent } from "../../bridge/src/protocol";
import { Speaker } from "../../bridge/src/speech";
import type { Runner } from "../../bridge/src/system";
import { claudeArgs, mcpConfig, type RunPlan, savedRunName } from "./args";
import { childEnv, type Config, paths } from "./config";
import { deleteRunFile, deleteTranscript, finalize, type FinalizeInput } from "./finalize";
import { buildSystemPrompt, checkClaudeVersion, linkSkills } from "./setup";
import { ensureDirs, type LastRun, log, recentRun, saveLastRun, writeFileAtomic } from "./store";
import { toolStatus } from "./status";
import { type Denial, initProblem, RunMonitor } from "./stream";

/** Lines the launcher prints on stdout, one JSON object each, for the notch app. */
export type LauncherEvent =
  | { event: "state"; state: "working" | "done" | "needs-you" | "error"; sessionId?: string }
  | { event: "speak"; text: string }
  | { event: "status"; text: string; detail?: string }
  | { event: "denied"; tool: string; rule?: string; reason?: string }
  | { event: "warning"; message: string }
  | { event: "done"; sessionId: string; keep: boolean; summary: string; reply: string; name?: string }
  | { event: "error"; message: string; sessionId?: string };

export interface RunOptions {
  emit?: (e: LauncherEvent) => void;
  /** Defaults to librarian enqueue, then deleting an ephemeral run. Tests replace it. */
  finalize?: (f: FinalizeInput) => Promise<void>;
  /** Runs `say` for the shared Speaker. Tests replace it. */
  speechRunner?: Runner;
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
  // The notch link is optional: with the app closed, sends just return false.
  let link: NotchLink | null = null;
  let speaker = new Speaker({ home: c.home, run: opts.speechRunner });
  const notch = (e: Omit<RunEvent, "type" | "session_id">, sessionId?: string) =>
    void link?.send({ type: "run_event", session_id: sessionId ?? null, ...e });
  const speak = (text: string) => {
    emit({ event: "speak", text });
    speaker.say(text).catch((err) => log(c, "speech failed", { error: String(err) }));
  };
  const finish = async () => {
    await speaker.idle();
    link?.close();
  };
  const fail = async (message: string, sessionId?: string, spoken = message): Promise<RunOutcome> => {
    log(c, "run failed", { sessionId, message });
    speak(spoken);
    emit({ event: "error", message, sessionId });
    emit({ event: "state", state: "error", sessionId });
    notch({ event: "failed", text: message }, sessionId);
    await finish();
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
  if (!existsSync(p.bridgeServer)) return fail(`the bridge isn't installed: ${p.bridgeServer} is missing`);
  linkSkills(c);
  buildSystemPrompt(c);

  const plan = planRun(c, request, now());
  const sessionId = (plan.resume ?? plan.sessionId)!;
  link = new NotchLink({ home: c.home, client: "launcher", sessionId, connectTimeoutMs: 300 });
  speaker = new Speaker({ home: c.home, link, sessionId, run: opts.speechRunner });
  emit({ event: "state", state: "working", sessionId });
  notch({ event: "started", text: request }, sessionId);

  mkdirSync(p.runs, { recursive: true });
  const mcpFile = p.mcpConfig(sessionId);
  writeFileAtomic(mcpFile, JSON.stringify(mcpConfig(c, sessionId)));
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
    onTool: (name, input) => {
      const st = toolStatus(name, input);
      if (!st) return;
      emit({ event: "status", text: st.text, ...(st.detail ? { detail: st.detail } : {}) });
      notch({ event: "tool", text: st.text }, sessionId);
    },
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
  const reader = proc.stdout.getReader();
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
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
  rmSync(mcpFile, { force: true });

  if (initFailure) {
    // Nothing happened yet, so nothing to keep.
    if (!plan.resume) deleteTranscript(c, sessionId);
    deleteRunFile(c, plan.runLog);
    action(c, { kind: "run", summary: `Couldn't start: ${initFailure}`, sessionId });
    return fail(`run stopped before it started: ${initFailure}`, sessionId, `I can't start: ${initFailure}.`);
  }

  const res = monitor.finish(exitCode);
  for (const d of res.denials) {
    emit({ event: "denied", tool: d.tool, rule: d.rule, reason: d.reason });
    notch({ event: "denied", rule: d.rule, text: d.reason }, sessionId);
    if (d.rule) action(c, { kind: "guard", summary: d.reason ?? `guard:${d.rule}`, detail: d.tool, sessionId });
  }
  // A follow-up to a saved run never deletes it.
  const keep = plan.resumed ? true : res.keep;
  if (res.problem) log(c, "run result problem", { sessionId, problem: res.problem, exitCode, stderr: stderr.slice(-2000) });

  const guard = res.denials.find((d) => d.reason);
  if (!res.reply && guard?.reason) speak(guard.reason.replace(/^guard:[a-z-]+:\s*/, "I can't do that: "));
  else if (res.endedSilently && res.summary && !res.isError) {
    // Claude finished with only the structured output (or just a progress
    // line earlier): say the summary so Leo never gets silence.
    speak(res.summary);
    res.reply = res.reply ? `${res.reply}\n${res.summary}` : res.summary;
  } else if (!res.reply && res.isError) speak("Something went wrong with that run. It's in the log.");

  const status = res.isError && !res.reply ? "error" : res.denials.length ? "needs-you" : "done";
  const endedAt = now();
  saveLastRun(c, { sessionId, keep, endedAt, request, reply: res.reply });
  action(c, { kind: "run", summary: res.summary || plan.name || "Jarvis run", sessionId, saved: keep });
  emit({ event: "done", sessionId, keep, summary: res.summary, reply: res.reply, name: plan.name });
  emit({ event: "state", state: status, sessionId });
  notch(status === "error" ? { event: "failed", text: res.problem } : { event: "done", keep, summary: res.summary }, sessionId);

  try {
    await (opts.finalize ?? ((f) => finalize(c, f)))({ sessionId, keep, runLog: plan.runLog, request, summary: res.summary });
  } catch (e) {
    log(c, "finalize failed", { sessionId, error: String(e) });
  }
  await finish();
  return { exitCode: status === "error" ? 1 : 0, sessionId, keep, summary: res.summary, reply: res.reply, denials: res.denials };
}

/** Appends to the bridge's action log; a failure is logged, never fatal. */
function action(c: Config, a: Parameters<typeof appendAction>[1]): void {
  try {
    appendAction(c.home, a);
  } catch (e) {
    log(c, "couldn't append action", { error: String(e) });
  }
}
