// One Jarvis request, start to finish: plan the run, spawn claude -p, speak
// the reply as it streams, log the outcome and hand the run to the librarian.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { appendAction, setActionDetail } from "../../bridge/src/actions";
import { NotchLink } from "../../bridge/src/notch";
import type { RunEvent } from "../../bridge/src/protocol";
import { Speaker } from "../../bridge/src/speech";
import type { Runner } from "../../bridge/src/system";
import { claudeArgs, mcpConfig, modelFor, needsSmartModel, type RunPlan, savedRunName } from "./args";
import { childEnv, type Config, paths } from "./config";
import { deleteRunFile, deleteTranscript, finalize, type FinalizeInput } from "./finalize";
import { buildSystemPrompt, checkClaudeVersion, linkSkills } from "./setup";
import { type ActiveRun, clearActiveRun, ensureDirs, type LastRun, log, recentRun, saveActiveRun, saveLastRun, writeFileAtomic } from "./store";
import { withContext } from "./context";
import { lightsConfig, parseLights, smallTalk, statusSentence } from "./fast";
import { parseInstant, runInstant } from "./instant";
import { type RunDetails, Timeline } from "./details";
import { toolStatus } from "./status";
import { type Denial, initProblem, RunMonitor } from "./stream";

/** Lines the launcher prints on stdout, one JSON object each, for the notch app. */
export type LauncherEvent =
  | { event: "ready"; sessionId: string }
  | { event: "state"; state: "working" | "done" | "needs-you" | "error"; sessionId?: string }
  | { event: "speak"; text: string; opener?: boolean }
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
  /**
   * Warm run: start claude now (hooks, MCP servers) and wait for the request,
   * so the start-up cost is paid before Leo speaks. Resolves the request, or
   * null to give up. Follow-ups and saved intents fall back to a normal run.
   */
  awaitRequest?: () => Promise<string | null>;
  /** A scheduled run nobody is listening to: no speech, nothing in the notch, no fast path. */
  background?: boolean;
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
  // The last exchange (and any run still going) reaches Claude through the activity block.
  return { prompt: withContext(c, request, now), sessionId, name: savedRunName(request), runLog: p.runLog(sessionId), resumed: false };
}

export async function run(c: Config, request: string, opts: RunOptions = {}): Promise<RunOutcome> {
  const emit = opts.emit ?? ((e) => process.stdout.write(JSON.stringify(e) + "\n"));
  const now = opts.now ?? Date.now;
  let timeline = new Timeline(now(), now);
  let spokeAnything = false;
  // The notch link is optional: with the app closed, sends just return false.
  let link: NotchLink | null = null;
  let speaker = new Speaker({ home: c.home, run: opts.speechRunner });
  const notch = (e: Omit<RunEvent, "type" | "session_id">, sessionId?: string) =>
    void link?.send({ type: "run_event", session_id: sessionId ?? null, ...e });
  // SIGUSR1 from the notch app: Leo interrupted. This run goes quiet (and keeps working).
  let hushed = false;
  process.on("SIGUSR1", () => {
    hushed = true;
    speaker.mute();
  });
  const speak = (text: string, kind: "opener" | "reply" = "reply") => {
    if (hushed) return;
    spokeAnything = true;
    timeline.mark(kind === "opener" ? "opener" : "firstSpoken");
    emit({ event: "speak", text, ...(kind === "opener" ? { opener: true } : {}) });
    speaker.say(text, { opener: kind === "opener" }).catch((err) => log(c, "speech failed", { error: String(err) }));
  };
  const finish = async () => {
    await speaker.idle();
    if (spokeAnything) timeline.set("spoken");
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

  // The fast path speaks through a notch link too, so the caption shows as the audio starts.
  const fastWithCaptions = async (req: string) => {
    if ((!lightsConfig(c.repo) && !smallTalk(req) && !parseInstant(req)) || c.env.JARVIS_FAST === "0") return null;
    link = new NotchLink({ home: c.home, client: "launcher", sessionId: null, connectTimeoutMs: 300 });
    speaker = new Speaker({ home: c.home, link, run: opts.speechRunner });
    return tryFast(c, req, speak, emit, finish, now(), timeline);
  };

  const warm = opts.awaitRequest;
  request = request.trim();
  if (!request && !warm) return fail("empty request", undefined, "I didn't catch that.");

  ensureDirs(c);
  const p = paths(c);
  const versionProblem = checkClaudeVersion(c);
  if (versionProblem) return fail(versionProblem);
  // Never run unguarded: without guard/ there are no hard limits.
  if (!existsSync(p.guardSettings)) return fail(`guard isn't installed: ${p.guardSettings} is missing`, undefined, "I can't run without my guard rules. The guard folder is missing from the Jarvis repo.");
  if (!existsSync(p.bridgeServer)) return fail(`the bridge isn't installed: ${p.bridgeServer} is missing`);
  linkSkills(c);
  buildSystemPrompt(c);

  let plan: ReturnType<typeof planRun>;
  if (warm) {
    const id = randomUUID();
    // Warm runs are for quick asks, so they start on the fast model.
    plan = { prompt: "", sessionId: id, runLog: p.runLog(id), resumed: false, streamInput: true, model: c.model ?? c.fastModel };
  } else {
    const fast = opts.background ? null : await fastWithCaptions(request);
    if (fast) return fast;
    plan = planRun(c, request, now());
    // A follow-up stays on the model its session started with.
    if (!plan.resume) plan.model = modelFor(c, request);
  }
  const sessionId = (plan.resume ?? plan.sessionId)!;

  mkdirSync(p.runs, { recursive: true });
  sweepStaleMcpConfigs(p.runs, now());
  sweepStaleMcpConfigs(`${c.home}/run/muted`, now(), "");
  const mcpFile = p.mcpConfig(sessionId);
  writeFileAtomic(mcpFile, JSON.stringify(mcpConfig(c, sessionId)));
  let initFailure: string | undefined;
  const proc = Bun.spawn([c.claudeBin, ...claudeArgs(c, plan)], {
    cwd: c.home,
    env: childEnv(c, { JARVIS_RUN_SESSION_ID: sessionId }),
    stdin: warm ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (warm) {
    emit({ event: "ready", sessionId });
    const req = ((await warm()) ?? "").trim();
    const fallBack = !req || (FOLLOWUP.test(req) && recentRun(c, now())) || savedRunName(req) || (!c.model && needsSmartModel(req));
    if (fallBack) {
      // Nothing to do, or a run this warm start can't be: a follow-up resumes
      // another session, a saved intent needs its name at start, and a bigger
      // task needs the smart model.
      proc.kill("SIGTERM");
      await proc.exited;
      rmSync(mcpFile, { force: true });
      deleteTranscript(c, sessionId);
      if (!req) return { exitCode: 0 };
      return run(c, req, { ...opts, awaitRequest: undefined });
    }
    const fast = await fastWithCaptions(req);
    if (fast) {
      proc.kill("SIGTERM");
      await proc.exited;
      rmSync(mcpFile, { force: true });
      deleteTranscript(c, sessionId);
      return fast;
    }
    request = req;
    // The clock starts when Leo asks, not when the warm run was started.
    timeline = new Timeline(now(), now);
    timeline.mark("init");
    const sink = proc.stdin as import("bun").FileSink;
    sink.write(JSON.stringify({ type: "user", message: { role: "user", content: withContext(c, request, now(), sessionId) } }) + "\n");
    await sink.end();
  }

  const active: ActiveRun = { sessionId, pid: process.pid, request, startedAt: now() };
  const markActive = (doing?: string) => {
    if (doing) active.doing = doing;
    try {
      saveActiveRun(c, active);
    } catch {}
  };
  markActive();
  link?.close();
  link = opts.background ? null : new NotchLink({ home: c.home, client: "launcher", sessionId, connectTimeoutMs: 300 });
  speaker = new Speaker({ home: c.home, link, sessionId, run: opts.speechRunner });
  if (opts.background) hushed = true;
  if (hushed) speaker.mute();
  emit({ event: "state", state: "working", sessionId });
  notch({ event: "started", text: request }, sessionId);
  const logFile = Bun.file(plan.runLog).writer();
  const monitor = new RunMonitor({
    onSentence: (s, kind) => {
      if (kind === "opener") markActive(s);
      speak(s, kind);
    },
    onFirstText: () => timeline.mark("firstText"),
    onToolDone: (id, isError) => timeline.stepDone(id, isError),
    onTool: (name, input, id) => {
      const st = toolStatus(name, input);
      if (name !== "StructuredOutput") timeline.step(st?.text ?? name, st?.detail, id);
      if (!st) return;
      markActive(st.text);
      emit({ event: "status", text: st.text, ...(st.detail ? { detail: st.detail } : {}) });
      notch({ event: "tool", text: st.text }, sessionId);
    },
    onInit: (init) => {
      timeline.mark("init");
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
  timeline.mark("result");
  const stderr = await stderrText;
  rmSync(mcpFile, { force: true });
  clearActiveRun(c, sessionId);

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
  if (res.limited) speak(res.reply);
  else if (!res.reply && guard?.reason) speak(guard.reason.replace(/^guard:[a-z-]+:\s*/, "I can't do that: "));
  else if (res.endedSilently && (res.say || res.summary) && !res.isError) {
    // Claude finished with only the structured output (or just a progress
    // line earlier): say its `say` line, so Leo never gets silence. The
    // summary is a log line ("Acknowledged Leo's thanks"), so only a last resort.
    const line = res.say ?? res.summary;
    speak(line);
    res.reply = res.reply ? `${res.reply}\n${line}` : line;
  } else if (!res.reply && res.isError) speak("Something went wrong with that run. It's in the log.");

  const status = res.isError && !res.reply ? "error" : res.denials.length ? "needs-you" : "done";
  const endedAt = now();
  saveLastRun(c, { sessionId, keep, endedAt, request, reply: res.reply });
  const details = (): RunDetails =>
    timeline.finish({
      request,
      reply: res.reply,
      route: warm ? "warm" : "claude",
      model: res.model ?? plan.model,
      outcome: status,
      saved: keep,
      turns: res.turns,
      costUsd: res.costUsd,
      ...(res.problem ? { problem: res.problem } : {}),
    });
  const rowId = action(c, { kind: "run", summary: res.summary || plan.name || "Jarvis run", sessionId, saved: keep, detail: JSON.stringify(details()) });
  emit({ event: "done", sessionId, keep, summary: res.summary, reply: res.reply, name: plan.name });
  emit({ event: "state", state: status, sessionId });
  notch(status === "error" ? { event: "failed", text: res.problem } : { event: "done", keep, summary: res.summary }, sessionId);

  try {
    await (opts.finalize ?? ((f) => finalize(c, f)))({ sessionId, keep, runLog: plan.runLog, request, summary: res.summary });
  } catch (e) {
    log(c, "finalize failed", { sessionId, error: String(e) });
  }
  await finish();
  updateDetail(c, rowId, details());
  return { exitCode: status === "error" ? 1 : 0, sessionId, keep, summary: res.summary, reply: res.reply, denials: res.denials };
}

/** Appends to the bridge's action log; a failure is logged, never fatal. Returns the row id. */
function action(c: Config, a: Parameters<typeof appendAction>[1]): number | undefined {
  try {
    return appendAction(c.home, a).id;
  } catch (e) {
    log(c, "couldn't append action", { error: String(e) });
    return undefined;
  }
}

/** Rewrites a row's details once the voice has finished, so "Speaking" is in the breakdown. */
function updateDetail(c: Config, id: number | undefined, d: RunDetails): void {
  if (id === undefined) return;
  try {
    setActionDetail(c.home, id, JSON.stringify(d));
  } catch (e) {
    log(c, "couldn't update action detail", { error: String(e) });
  }
}

/** Per-run files left by runs that were killed or hushed (over 12 hours old): MCP configs, mute markers. */
export function sweepStaleMcpConfigs(dir: string, now = Date.now(), suffix = ".mcp.json"): void {
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(suffix)) continue;
      const path = `${dir}/${f}`;
      if (now - statSync(path).mtimeMs > 12 * 3600 * 1000) rmSync(path, { force: true });
    }
  } catch {}
}

/**
 * Simple light commands straight to the lights skill's script: no Claude run.
 * Null when the request isn't one, or the script couldn't do it (Claude then
 * handles it, asking Leo if needed).
 * shortcut: fast-path runs skip the librarian, so they show in the action log but not the daily log; enqueue them if Leo wants them there.
 */
async function tryFast(
  c: Config,
  request: string,
  speak: (t: string) => void,
  emit: (e: LauncherEvent) => void,
  finish: () => Promise<void>,
  at: number,
  timeline: Timeline,
): Promise<RunOutcome | null> {
  if (c.env.JARVIS_FAST === "0") return null;
  const hello = smallTalk(request);
  if (hello) {
    emit({ event: "state", state: "working" });
    speak(hello);
    emit({ event: "done", sessionId: "", keep: false, summary: hello, reply: hello });
    emit({ event: "state", state: "done" });
    await finish();
    return { exitCode: 0, keep: false, summary: hello, reply: hello };
  }
  const done = async (reply: string, summary: string, route: RunDetails["route"], what: string): Promise<RunOutcome> => {
    timeline.mark("result");
    timeline.steps.push({ label: what, atMs: 0, ms: timeline.get("result") });
    emit({ event: "state", state: "working" });
    speak(reply);
    saveLastRun(c, { sessionId: "fast", keep: false, endedAt: at, request, reply });
    const details = () => timeline.finish({ request, reply, route, outcome: "done", saved: false });
    const id = action(c, { kind: "action", summary, detail: JSON.stringify(details()) });
    emit({ event: "done", sessionId: "", keep: false, summary, reply });
    emit({ event: "state", state: "done" });
    await finish();
    updateDetail(c, id, details());
    return { exitCode: 0, keep: false, summary, reply };
  };
  const instant = parseInstant(request);
  if (instant) {
    const r = await runInstant(c, instant, new Date(at)).catch((e) => (log(c, "instant command failed", { error: String(e) }), null));
    if (r) return done(r.reply, r.summary, "instant", `Instant command: ${instant.kind}`);
    log(c, "instant command fell back to Claude", { request, kind: instant.kind });
    return null;
  }
  const config = lightsConfig(c.repo);
  const cmd = config && parseLights(request, config);
  if (!cmd) return null;
  const script = `${c.repo}/skills/lights/lights.ts`;
  const p = Bun.spawn([c.bunBin, script, ...cmd.args], { cwd: c.home, env: childEnv(c), stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  if (code !== 0) {
    log(c, "fast path fell back to Claude", { request, args: cmd.args, code });
    return null;
  }
  const reply = cmd.args[0] === "status" ? statusSentence(out) : cmd.say ?? "Done.";
  return done(reply, cmd.args[0] === "status" ? `Checked the lights: ${out.trim().replace(/\n/g, "; ")}` : `Lights: ${cmd.args.join(" ")}`, "lights", `Homebridge: ${cmd.args.join(" ")}`);
}
