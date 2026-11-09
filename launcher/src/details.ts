// What happened in one request, and where its time went (Leo, 2026-10-22:
// "I can click into a request and see all the details"). Stored as JSON in the
// request's action row (`detail`), which the notch's Recent list opens.

import { decide } from "../../guard/src/decide";
import { contextFromEnv } from "../../guard/src/context";
import { loadBlocklist } from "../../guard/src/domains";

export interface DetailStep {
  /** What Jarvis was doing, as the notch said it ("Reading your calendar"). */
  label: string;
  detail?: string;
  /** Milliseconds from the request. */
  atMs: number;
  /** How long it took, when it has an end. */
  ms?: number;
  error?: boolean;
  /** The raw tool name, a short readable input and the start of the output. */
  tool?: string;
  input?: string;
  output?: string;
}

/** One line of the conversation: Leo, Jarvis's text (all of it, not just what was spoken), or the checker. */
export interface ChatLine {
  who: "leo" | "jarvis" | "checker";
  text: string;
  atMs: number;
}

export interface RunDetails {
  v: 1;
  request: string;
  reply: string;
  /** claude: a normal run; warm: the pre-started one; instant / lights / chat: no Claude run. */
  route: "claude" | "warm" | "instant" | "lights" | "chat";
  model?: string;
  startedAt: string;
  outcome: "done" | "needs-you" | "error";
  saved: boolean;
  /** Request to the end of speech (or to the result when nothing was said). */
  totalMs: number;
  /** Where the time went, in order. Each is a slice of totalMs. */
  breakdown: { label: string; ms: number }[];
  steps: DetailStep[];
  /** Absent on rows written before 2026-11-09; the app then builds it from request and reply. */
  chat?: ChatLine[];
  turns?: number;
  costUsd?: number;
  problem?: string;
}

export const INPUT_CHARS = 300;
export const OUTPUT_CHARS = 600;
/** Keeps actions.sqlite small: the oldest outputs, then inputs, go first. */
export const MAX_DETAIL_BYTES = 40_000;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** The part of a tool's input worth reading: the command, the path, the query. */
export function toolInput(input: Record<string, unknown>): string {
  for (const k of ["command", "file_path", "path", "query", "url", "pattern", "skill", "prompt"]) {
    if (typeof input[k] === "string") return clip(input[k] as string, INPUT_CHARS);
  }
  return clip(JSON.stringify(input), INPUT_CHARS);
}

const SECRET_TEXT = /\bsecurity\s+find-(?:generic|internet)-password\b|-----BEGIN [A-Z ]*PRIVATE KEY|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,})|\bBearer\s+[A-Za-z0-9._~+\/-]{20,}/;

/** Text that looks like a key, a token or a Keychain read. */
export const looksSecret = (text: string) => SECRET_TEXT.test(text);

/**
 * A tool call whose input and output shouldn't be stored: anything the guard
 * flags as touching credentials, and any Keychain read (even Jarvis's own).
 */
export function isSecret(tool: string, input: Record<string, unknown>, env: Record<string, string | undefined> = process.env): boolean {
  if (looksSecret(JSON.stringify(input))) return true;
  try {
    const d = decide({ tool_name: tool, tool_input: input }, contextFromEnv(env), loadBlocklist());
    return Boolean(d && /credential|keychain/i.test(d.reason));
  } catch {
    return true;
  }
}

/** Drops the oldest step outputs, then inputs, until the JSON fits. */
export function capDetails(d: RunDetails, max = MAX_DETAIL_BYTES): RunDetails {
  for (const key of ["output", "input"] as const) {
    for (const s of d.steps) {
      if (JSON.stringify(d).length <= max) return d;
      delete s[key];
    }
  }
  return d;
}

/** Collects timestamps through a run and turns them into RunDetails. */
export class Timeline {
  readonly steps: DetailStep[] = [];
  readonly chat: ChatLine[] = [];
  private open = new Map<string, DetailStep>();
  private marks = new Map<string, number>();

  constructor(
    readonly startedAt: number,
    private now: () => number = Date.now,
  ) {}

  private at(): number {
    return Math.max(0, this.now() - this.startedAt);
  }

  /** Records the first time something happened ("init", "firstText", "firstSpoken", "result", "spoken"). */
  mark(name: string): void {
    if (!this.marks.has(name)) this.marks.set(name, this.at());
  }

  /** Overwrites a mark (e.g. "spoken", which moves on until the voice is done). */
  set(name: string, ms = this.at()): void {
    this.marks.set(name, ms);
  }

  get(name: string): number | undefined {
    return this.marks.get(name);
  }

  /** A line of the conversation; empty text is skipped. */
  say(who: ChatLine["who"], text: string, atMs = this.at()): void {
    const t = text.trim();
    if (t) this.chat.push({ who, text: t, atMs });
  }

  step(label: string, detail?: string, id?: string, extra: Pick<DetailStep, "tool" | "input"> = {}): void {
    const s: DetailStep = { label, atMs: this.at(), ...(detail ? { detail } : {}), ...extra };
    this.steps.push(s);
    if (id) this.open.set(id, s);
  }

  stepDone(id: string, error = false, output?: string): void {
    const s = this.open.get(id);
    if (!s) return;
    this.open.delete(id);
    s.ms = this.at() - s.atMs;
    if (error) s.error = true;
    if (output?.trim()) s.output = clip(output.trim(), OUTPUT_CHARS);
  }

  /**
   * Startup is the request to Claude being ready (zero for a warm run), tools
   * the time spent inside tool calls, thinking the rest of Claude's time, and
   * speaking what's left after the result while the voice finishes.
   */
  finish(base: Omit<RunDetails, "v" | "totalMs" | "breakdown" | "steps" | "startedAt">): RunDetails {
    const result = this.get("result") ?? this.at();
    const total = Math.max(result, this.get("spoken") ?? 0);
    const breakdown: { label: string; ms: number }[] = [];
    const startup = Math.min(this.get("init") ?? 0, result);
    if (base.route === "claude" || base.route === "warm") {
      const tools = this.steps.reduce((n, s) => n + (s.ms ?? 0), 0);
      breakdown.push({ label: "Starting Claude", ms: startup });
      breakdown.push({ label: "Thinking", ms: Math.max(0, result - startup - tools) });
      if (tools) breakdown.push({ label: "Tools", ms: tools });
    } else {
      breakdown.push({ label: "Working", ms: result });
    }
    if (total > result) breakdown.push({ label: "Speaking", ms: total - result });
    // Runs with no streamed text (the fast path, a usage limit) still show their reply.
    const said = this.chat.some((l) => l.who === "jarvis") || !base.reply.trim() ? [] : [{ who: "jarvis" as const, text: base.reply.trim(), atMs: result }];
    const chat: ChatLine[] = [{ who: "leo" as const, text: base.request, atMs: 0 }, ...this.chat, ...said].sort((a, b) => a.atMs - b.atMs);
    // Copies, so trimming one finish() doesn't strip the next.
    const steps = this.steps.map((s) => ({ ...s }));
    return capDetails({ v: 1, ...base, startedAt: new Date(this.startedAt).toISOString(), totalMs: total, breakdown, steps, chat });
  }
}
