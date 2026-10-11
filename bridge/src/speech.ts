// Phase 1 speech: macOS `say`, one utterance at a time. Within a process a
// queue keeps sentences in order; across processes (the launcher speaking the
// streamed reply, Claude calling the speak tool) a lock directory at
// ~/Jarvis/run/speech.lock keeps them from talking over each other.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { speechLock } from "./config";
import type { NotchLink } from "./notch";
import { runCommand, type Runner } from "./system";

export const MAX_SPEAK_CHARS = 600;

/**
 * Picks the most natural installed voice for `say`: Premium beats Enhanced
 * beats the compact default, British English first (Leo is in the UK).
 * JARVIS_VOICE overrides. Premium and Enhanced voices are free downloads in
 * System Settings > Accessibility > Spoken Content > System Voice > Manage Voices.
 */
export function bestVoice(list: string, override?: string): string | null {
  const voices = list
    .split("\n")
    .map((l) => /^(.+?)\s{2,}([a-z]{2}_[A-Z]{2})\s/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ name: m[1]!.trim(), lang: m[2]! }));
  if (override && voices.some((v) => v.name === override)) return override;
  let best: { name: string; score: number } | null = null;
  for (const v of voices) {
    if (!v.lang.startsWith("en_")) continue;
    const q = /\(Premium\)/.test(v.name) ? 3 : /\(Enhanced\)/.test(v.name) ? 2 : 0;
    if (!q) continue;
    const score = q + (v.lang === "en_GB" ? 0.5 : 0);
    if (!best || score > best.score) best = { name: v.name, score };
  }
  return best?.name ?? null;
}

let voiceCache: Promise<string | null> | null = null;

/** The voice to use, looked up once per process (`say -v ?`). */
export function defaultVoice(run: Runner = runCommand, env = process.env): Promise<string | null> {
  voiceCache ??= run(["say", "-v", "?"]).then(
    (r) => (r.code === 0 ? bestVoice(r.stdout, env.JARVIS_VOICE) : null),
    () => null,
  );
  return voiceCache;
}
const STALE_LOCK_MS = 60_000;

export interface SpeakerOptions {
  home: string;
  link?: NotchLink | null;
  sessionId?: string | null;
  run?: Runner;
  pollMs?: number;
  /** A `say` voice name; default: the best installed (see bestVoice). */
  voice?: string | null;
}

export class Speaker {
  private queue: Promise<void> = Promise.resolve();
  private count = 0;

  constructor(private opts: SpeakerOptions) {}

  /** Queues text and resolves when it has been spoken (or failed). */
  say(text: string): Promise<void> {
    const t = text.trim().slice(0, MAX_SPEAK_CHARS);
    if (!t) return Promise.resolve();
    const job = this.queue.then(() => this.speakNow(t));
    this.queue = job.catch(() => {});
    return job;
  }

  /** Resolves when everything queued so far has been spoken. */
  idle(): Promise<void> {
    return this.queue;
  }

  private async speakNow(text: string) {
    const lock = speechLock(this.opts.home);
    await acquire(lock, this.opts.pollMs ?? 50);
    const id = `${process.pid}-${++this.count}`;
    const link = this.opts.link;
    try {
      await link?.send({ type: "speak_start", id, text, session_id: this.opts.sessionId ?? null });
      // Text goes on stdin (`say -f -`) so a sentence starting with "-" can't become a flag.
      const voice = this.opts.voice !== undefined ? this.opts.voice : await defaultVoice();
      const args = voice ? ["say", "-v", voice, "-f", "-"] : ["say", "-f", "-"];
      const r = await (this.opts.run ?? runCommand)(args, { stdin: text });
      if (r.code !== 0) throw new Error(`say failed (exit ${r.code}): ${r.stderr.trim() || "no output"}`);
    } finally {
      await link?.send({ type: "speak_end", id });
      release(lock);
    }
  }
}

function ownerAlive(lock: string): boolean {
  try {
    const pid = Number(readFileSync(join(lock, "pid"), "utf8"));
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function acquire(lock: string, pollMs: number) {
  mkdirSync(dirname(lock), { recursive: true });
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "pid"), String(process.pid));
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let age = 0;
    try {
      age = Date.now() - statSync(lock).mtimeMs;
    } catch {
      continue; // released between our mkdir and stat
    }
    // A crashed speaker, or one stuck far longer than any sentence takes.
    if ((age > 1000 && !ownerAlive(lock)) || age > STALE_LOCK_MS) {
      rmSync(lock, { recursive: true, force: true });
      continue;
    }
    await Bun.sleep(pollMs);
  }
}

function release(lock: string) {
  rmSync(lock, { recursive: true, force: true });
}
