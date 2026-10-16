// Phase 1 speech: macOS `say`, one utterance at a time. Within a process a
// queue keeps sentences in order; across processes (the launcher speaking the
// streamed reply, Claude calling the speak tool) a lock directory at
// ~/Jarvis/run/speech.lock keeps them from talking over each other.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { speechLock } from "./config";
import type { NotchLink } from "./notch";
import { runCommand, type Runner } from "./system";

export const MAX_SPEAK_CHARS = 600;

const ONES = "twelve one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
const TENS = ["", "", "twenty", "thirty", "forty", "fifty"];
const num = (n: number) => (n < 20 ? (n === 0 ? "zero" : ONES[n]!) : TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : ""));

/** One clock time the way Leo would say it: "half past two", "six p.m.", "quarter to five". */
function sayTime(h: number, m: number, suffix?: string): string {
  const pm = suffix ? suffix === "p" : h >= 12;
  const h12 = (x: number) => ONES[x % 12]!;
  if (m === 0) {
    if (!suffix && h === 12) return "midday";
    if (!suffix && h === 0) return "midnight";
    return `${h12(h)} ${pm ? "p.m." : "a.m."}`;
  }
  if (m === 15) return `quarter past ${h12(h)}`;
  if (m === 30) return `half past ${h12(h)}`;
  if (m === 45) return `quarter to ${h12(h + 1)}`;
  return `${h12(h)} ${m < 10 ? `oh ${num(m)}` : num(m)}${suffix ? ` ${suffix}.m.` : ""}`;
}

/**
 * Times in a sentence, spoken naturally (Leo, 2026-10-16): "14:30" → "half
 * past two", "17:00" → "five p.m.", "9am" → "nine a.m.", "12:00–13:00" →
 * "midday to one p.m.". Only what's spoken changes; captions keep the digits.
 */
export function speakableTimes(text: string): string {
  const T = String.raw`\b([01]?\d|2[0-3]):([0-5]\d)(?:\s*([ap])(?:\.m\.|m\b))?`;
  return text
    .replace(new RegExp(`${T}\\s*[–—-]\\s*${T}`, "gi"), (_, h1, m1, s1, h2, m2, s2) => `${sayTime(+h1, +m1, s1?.toLowerCase())} to ${sayTime(+h2, +m2, s2?.toLowerCase())}`)
    .replace(new RegExp(T, "gi"), (_, h, m, s) => sayTime(+h, +m, s?.toLowerCase()))
    .replace(/\b(1[0-2]|0?[1-9])\s*([ap])(?:\.m\.|m\b)/gi, (_, h, s) => `${ONES[+h % 12]} ${s.toLowerCase()}.m.`)
    .replace(/\.m\.\./g, ".m.");
}

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

/**
 * The notch app keeps ~/Jarvis/run/listening while Leo is talking to it.
 * Speech waits until it's gone (Leo, 2026-10-15: "it should wait till I'm
 * finished"). A marker older than this is left over from a crash and ignored.
 */
export const LISTENING_MAX_MS = 60_000;

export function leoIsTalking(home: string, now = Date.now()): boolean {
  try {
    return now - statSync(join(home, "run", "listening")).mtimeMs < LISTENING_MAX_MS;
  } catch {
    return false;
  }
}

/** Renders a sentence to a WAV file; null means "use say instead". */
export interface Synth {
  render(text: string): Promise<string | null>;
}

/**
 * Jarvis's own voice: Kokoro (on-device neural TTS) behind tts/server.py on
 * ~/Jarvis/run/tts.sock. If the server isn't up, it is started in the
 * background and this sentence falls back to `say`.
 */
export class KokoroSynth implements Synth {
  private static starting = false;
  constructor(
    private home: string,
    private repo = process.env.JARVIS_REPO || resolve(import.meta.dir, "../.."),
    private preset = process.env.JARVIS_TTS_PRESET,
  ) {}

  /** Installed when the model and the venv are in ~/Jarvis/tts. */
  static available(home: string, env = process.env): boolean {
    if (env.JARVIS_TTS === "say") return false;
    return existsSync(join(home, "tts", "kokoro-v1.0.onnx")) && existsSync(join(home, "tts", ".venv", "bin", "python"));
  }

  get socket(): string {
    return join(this.home, "run", "tts.sock");
  }

  async render(text: string): Promise<string | null> {
    try {
      const res = await fetch("http://localhost/render", {
        method: "POST",
        unix: this.socket,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, preset: this.preset }),
        signal: AbortSignal.timeout(15_000),
      } as RequestInit);
      if (!res.ok) return null;
      const file = join(tmpdir(), `jarvis-say-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
      writeFileSync(file, new Uint8Array(await res.arrayBuffer()));
      return file;
    } catch {
      this.start();
      return null;
    }
  }

  /** Starts the server detached; it keeps running for the next sentences. */
  start(): void {
    if (KokoroSynth.starting) return;
    KokoroSynth.starting = true;
    try {
      const p = Bun.spawn([join(this.home, "tts", ".venv", "bin", "python"), join(this.repo, "tts", "server.py")], {
        stdio: ["ignore", "ignore", "ignore"],
        env: { ...process.env, JARVIS_HOME: this.home },
      });
      p.unref();
    } catch {}
  }
}

export interface SpeakerOptions {
  home: string;
  link?: NotchLink | null;
  sessionId?: string | null;
  run?: Runner;
  pollMs?: number;
  /** A `say` voice name; default: the best installed (see bestVoice). */
  voice?: string | null;
  /** Neural voice; default Kokoro when installed in ~/Jarvis/tts. null: always `say`. */
  synth?: Synth | null;
  /** How long to keep the voice after the last queued sentence (tests). */
  holdMs?: number;
}

/**
 * How long a speaker keeps the voice after its last queued sentence, so a
 * reply streaming in sentence by sentence isn't interleaved with another
 * run's reply (Leo, 2026-10-12: several runs talking over each other).
 */
export const HOLD_AFTER_LAST_SENTENCE_MS = 1500;

/** Longest text rendered in one go (two sentences at most). */
export const CHUNK_CHARS = 250;

export class Speaker {
  private queue: Promise<void> = Promise.resolve();
  private count = 0;
  private pending = 0;
  private batch: { text: string; opener: boolean; resolve: () => void; reject: (e: unknown) => void }[] = [];
  private holding = false;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  /** Written into the lock so this speaker can tell it still holds it. */
  private readonly token = `${process.pid}:${Math.random().toString(36).slice(2)}`;

  private synth: Synth | null;
  private muted = false;

  constructor(private opts: SpeakerOptions) {
    this.synth = opts.synth !== undefined ? opts.synth : KokoroSynth.available(opts.home) ? new KokoroSynth(opts.home) : null;
  }

  /**
   * Queues text and resolves when it has been spoken (or failed). Sentences
   * queued together are rendered two at a time (up to CHUNK_CHARS), so the
   * intonation carries across instead of resetting every sentence.
   */
  say(text: string, opts: { opener?: boolean } = {}): Promise<void> {
    const t = text.trim().slice(0, MAX_SPEAK_CHARS);
    if (!t) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.batch.push({ text: t, opener: opts.opener === true, resolve, reject });
      if (this.batch.length === 1) queueMicrotask(() => this.flush());
    });
  }

  private flush() {
    const items = this.batch.splice(0);
    if (!items.length) return; // already flushed by idle()
    const chunks: (typeof items)[] = [];
    for (const it of items) {
      const cur = chunks.at(-1);
      const len = cur ? cur.reduce((n, c) => n + c.text.length + 1, 0) : 0;
      // An opening line stays on its own: it's spoken before the work starts.
      if (cur && !it.opener && !cur[0]!.opener && cur.length < 2 && len + it.text.length <= CHUNK_CHARS) cur.push(it);
      else chunks.push([it]);
    }
    for (const chunk of chunks) {
      const text = chunk.map((c) => c.text).join(" ");
      // Render now, while earlier sentences are still playing, so there's no gap.
      const audio = this.synth ? this.synth.render(speakableTimes(text)).catch(() => null) : Promise.resolve(null);
      this.pending++;
      if (this.releaseTimer) {
        clearTimeout(this.releaseTimer);
        this.releaseTimer = null;
      }
      const job = this.queue.then(() => this.speakNow(text, audio, chunk[0]!.opener)).finally(() => {
        this.pending--;
        if (this.pending === 0) this.scheduleRelease();
      });
      this.queue = job.catch(() => {});
      job.then(() => chunk.forEach((c) => c.resolve()), (e) => chunk.forEach((c) => c.reject(e)));
    }
  }

  /**
   * Leo interrupted (Option-Space or a new request): drop everything this
   * speaker still has to say, now and later. The run's bridge (same session)
   * goes quiet too, through ~/Jarvis/run/muted/<session>. The notch app kills
   * the sentence that is playing.
   */
  mute(): void {
    this.muted = true;
    const id = this.opts.sessionId;
    if (id && /^[\w-]+$/.test(id)) {
      mkdirSync(join(this.opts.home, "run", "muted"), { recursive: true });
      writeFileSync(join(this.opts.home, "run", "muted", id), "");
    }
  }

  private silenced(): boolean {
    if (this.muted) return true;
    const id = this.opts.sessionId;
    return Boolean(id && existsSync(join(this.opts.home, "run", "muted", id)));
  }

  /** Resolves when everything queued so far has been spoken, and gives the voice back. */
  async idle(): Promise<void> {
    if (this.batch.length) this.flush();
    await this.queue;
    if (this.pending === 0) this.letGo();
  }

  /** One reply at a time: keep the lock briefly in case the reply has more sentences coming. */
  private scheduleRelease() {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      if (this.pending === 0) this.letGo();
    }, this.opts.holdMs ?? HOLD_AFTER_LAST_SENTENCE_MS);
    (this.releaseTimer as { unref?: () => void }).unref?.();
  }

  private letGo() {
    if (this.releaseTimer) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    if (!this.holding) return;
    this.holding = false;
    const lock = speechLock(this.opts.home);
    if (lockOwner(lock) === this.token) release(lock);
  }

  private async speakNow(text: string, audio: Promise<string | null>, opener = false) {
    if (this.silenced()) {
      const f = await audio;
      if (f) rmSync(f, { force: true });
      return;
    }
    const lock = speechLock(this.opts.home);
    if (!this.holding || lockOwner(lock) !== this.token) {
      await acquire(lock, this.opts.pollMs ?? 50, this.token);
      this.holding = true;
    } else {
      // Still ours: refresh it so nobody takes it over as stale mid-reply.
      try {
        const now = new Date();
        utimesSync(lock, now, now);
      } catch {}
    }
    while (leoIsTalking(this.opts.home)) {
      await Bun.sleep(this.opts.pollMs ?? 50);
      try {
        const now = new Date();
        utimesSync(lock, now, now);
      } catch {}
    }
    if (this.silenced()) {
      // Hushed while Leo was talking: drop this sentence.
      const f = await audio;
      if (f) rmSync(f, { force: true });
      return;
    }
    const id = `${process.pid}-${++this.count}`;
    const link = this.opts.link;
    try {
      const file = await audio;
      await link?.send({ type: "speak_start", id, text, session_id: this.opts.sessionId ?? null, ...(opener ? { opener: true } : {}) });
      // JARVIS_MUTE=1: captions only, no sound (for test runs while Leo is around).
      if (process.env.JARVIS_MUTE === "1") {
        if (file) rmSync(file, { force: true });
        return;
      }
      if (file) {
        try {
          // The app's player first (no gap between sentences), afplay without it.
          if (link && (await link.play(id, file))) return;
          const r = await (this.opts.run ?? runCommand)(["afplay", file]);
          if (r.code === 0 || this.silenced()) return; // killed because Leo interrupted: no say fallback
        } finally {
          rmSync(file, { force: true });
        }
      }
      // Text goes on stdin (`say -f -`) so a sentence starting with "-" can't become a flag.
      const voice = this.opts.voice !== undefined ? this.opts.voice : await defaultVoice();
      const args = voice ? ["say", "-v", voice, "-f", "-"] : ["say", "-f", "-"];
      const r = await (this.opts.run ?? runCommand)(args, { stdin: speakableTimes(text) });
      if (r.code !== 0 && this.silenced()) return;
      if (r.code !== 0) throw new Error(`say failed (exit ${r.code}): ${r.stderr.trim() || "no output"}`);
    } finally {
      await link?.send({ type: "speak_end", id });
    }
  }
}

function ownerAlive(lock: string): boolean {
  try {
    const pid = Number(readFileSync(join(lock, "pid"), "utf8").split(":")[0]);
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockOwner(lock: string): string | null {
  try {
    return readFileSync(join(lock, "pid"), "utf8").trim();
  } catch {
    return null;
  }
}

async function acquire(lock: string, pollMs: number, token = String(process.pid)) {
  mkdirSync(dirname(lock), { recursive: true });
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "pid"), token);
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
