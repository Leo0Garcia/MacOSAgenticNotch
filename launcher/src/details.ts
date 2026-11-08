// What happened in one request, and where its time went (Leo, 2026-10-22:
// "I can click into a request and see all the details"). Stored as JSON in the
// request's action row (`detail`), which the notch's Recent list opens.

export interface DetailStep {
  /** What Jarvis was doing, as the notch said it ("Reading your calendar"). */
  label: string;
  detail?: string;
  /** Milliseconds from the request. */
  atMs: number;
  /** How long it took, when it has an end. */
  ms?: number;
  error?: boolean;
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
  turns?: number;
  costUsd?: number;
  problem?: string;
}

/** Collects timestamps through a run and turns them into RunDetails. */
export class Timeline {
  readonly steps: DetailStep[] = [];
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

  step(label: string, detail?: string, id?: string): void {
    const s: DetailStep = { label, atMs: this.at(), ...(detail ? { detail } : {}) };
    this.steps.push(s);
    if (id) this.open.set(id, s);
  }

  stepDone(id: string, error = false): void {
    const s = this.open.get(id);
    if (!s) return;
    this.open.delete(id);
    s.ms = this.at() - s.atMs;
    if (error) s.error = true;
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
    return { v: 1, ...base, startedAt: new Date(this.startedAt).toISOString(), totalMs: total, breakdown, steps: this.steps };
  }
}
