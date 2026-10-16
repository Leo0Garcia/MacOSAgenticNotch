// Reads a claude -p stream-json run event by event: checks system/init, cuts
// the reply into sentences to speak, collects guard denials, and reads the
// final result's structured_output.

import { BRIDGE_SERVER } from "./config";
import { SentenceSplitter } from "./sentences";

export const GUARD_RULES = ["no-money", "no-real-consequences", "no-contacting-as-leo", "no-harm"] as const;
export type GuardRule = (typeof GUARD_RULES)[number];

export interface Denial {
  tool: string;
  toolUseId?: string;
  rule?: GuardRule; // set when guard/ fired; absent for auto mode or prompt denials
  reason?: string;
}

/** Spoken answers stop after this many sentences; the notch shows the whole reply (Leo, 2026-10-16). */
export const MAX_SPOKEN_SENTENCES = 2;

/** Said when Claude goes straight to a tool without saying what it's doing. */
export const DEFAULT_OPENER = "On it.";

export interface RunResult {
  /** Claude's usage limit was hit; `reply` says so plainly. */
  limited?: boolean;
  /** The structured output's `say`: the spoken line when the run wrote no text reply. */
  say?: string;
  sessionId?: string;
  keep: boolean;
  summary: string;
  reply: string;
  denials: Denial[];
  /** The run ended without a spoken answer after its last tool call (e.g. only a progress line). */
  endedSilently: boolean;
  /** Why keep was forced to true, or why the run failed. */
  problem?: string;
  isError: boolean;
  costUsd?: number;
}

export interface MonitorHooks {
  /**
   * A sentence to speak. Only two kinds reach Leo (2026-10-13: "tell me what
   * it's working on and then when it's finished"): the first line of a run
   * that goes on to use tools ("opener"), and the final answer ("reply").
   * Narration between tool calls is dropped.
   */
  onSentence?: (s: string, kind: "opener" | "reply") => void;
  onInit?: (init: InitInfo) => void;
  onDenial?: (d: Denial) => void;
  /** A tool call in the main conversation (not a subagent's). */
  onTool?: (name: string, input: Record<string, unknown>) => void;
}

export interface InitInfo {
  sessionId?: string;
  permissionMode?: string;
  bridgeStatus?: string;
  chromeStatus?: string;
  mcpServerErrors: unknown[];
  version?: string;
}

/** What is wrong with a run's init, or undefined when it can go ahead. */
export function initProblem(i: InitInfo): string | undefined {
  if (i.permissionMode !== "auto")
    return `auto mode isn't available (the run started in ${i.permissionMode ?? "an unknown"} mode), so every risky action would be denied`;
  if (i.mcpServerErrors.length) return `an MCP config entry was skipped: ${JSON.stringify(i.mcpServerErrors).slice(0, 200)}`;
  if (i.bridgeStatus !== "connected") return `the Jarvis bridge didn't connect (status: ${i.bridgeStatus ?? "missing"})`;
  return undefined;
}

const GUARD_RE = new RegExp(`guard:(${GUARD_RULES.join("|")}):\\s*([^\\n"\\\\]*)`);

export class RunMonitor {
  init?: InitInfo;
  private splitter = new SentenceSplitter();
  private replyParts: string[] = [];
  private sawTextDelta = false;
  /** Sentences of the current message, held until we know if a tool call follows. */
  private held: string[] = [];
  private openerSaid = false;
  private replySpoken = 0;
  /** Whether Claude said anything after its last real tool call. */
  private spokeSinceTool = false;
  private denials = new Map<string, Denial>();
  private result?: Record<string, any>;
  private toolNames = new Map<string, string>();

  constructor(private hooks: MonitorHooks = {}) {}

  /** Feeds one stream-json line. Bad lines are ignored, not fatal. */
  line(raw: string): void {
    if (!raw.trim()) return;
    let ev: any;
    try {
      ev = JSON.parse(raw);
    } catch {
      return;
    }
    this.event(ev);
  }

  event(ev: any): void {
    switch (ev?.type) {
      case "system":
        if (ev.subtype === "init") this.onInit(ev);
        else if (ev.subtype === "permission_denied") this.addDenial(ev.tool_name ?? "unknown", ev.tool_use_id, JSON.stringify(ev));
        return;
      case "stream_event":
        if (ev.parent_tool_use_id) return; // subagent output isn't Jarvis's reply
        return this.onStreamEvent(ev.event);
      case "assistant": {
        if (ev.parent_tool_use_id) return;
        // Claude Code's own notices (usage limit, API errors) aren't Jarvis talking.
        if (ev.message?.model === "<synthetic>") return;
        const content: any[] = ev.message?.content ?? [];
        const usesTools = content.some((b) => b?.type === "tool_use" && b.name !== "StructuredOutput");
        for (const b of content) {
          if (b?.type === "tool_use") {
            this.toolNames.set(b.id, b.name);
            if (b.name !== "StructuredOutput") this.spokeSinceTool = false;
            this.hooks.onTool?.(b.name, b.input ?? {});
          }
          // Without partial messages the text only arrives here.
          if (b?.type === "text" && !this.sawTextDelta) this.addText(b.text + "\n", true);
        }
        if (!this.sawTextDelta) this.settle(usesTools ? "working" : "final");
        return;
      }
      case "user":
        for (const b of ev.message?.content ?? []) {
          if (b?.type !== "tool_result" || !b.is_error) continue;
          const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
          if (GUARD_RE.test(text)) this.addDenial(this.toolNames.get(b.tool_use_id) ?? "unknown", b.tool_use_id, text);
        }
        return;
      case "result":
        this.result = ev;
        for (const d of ev.permission_denials ?? []) this.addDenial(d.tool_name ?? "unknown", d.tool_use_id, JSON.stringify(d));
        return;
    }
  }

  private onInit(ev: any): void {
    const servers: any[] = Array.isArray(ev.mcp_servers) ? ev.mcp_servers : [];
    this.init = {
      sessionId: ev.session_id,
      permissionMode: ev.permissionMode,
      bridgeStatus: servers.find((s) => s?.name === BRIDGE_SERVER)?.status,
      chromeStatus: servers.find((s) => s?.name === "claude-in-chrome")?.status,
      mcpServerErrors: Array.isArray(ev.mcp_server_errors) ? ev.mcp_server_errors : [],
      version: ev.claude_code_version,
    };
    this.hooks.onInit?.(this.init);
  }

  private onStreamEvent(e: any): void {
    if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") {
      this.sawTextDelta = true;
      this.addText(e.delta.text, false);
    } else if (e?.type === "content_block_start" && e.content_block?.type === "tool_use") {
      // Now we know what the text so far was: narration before a tool, or the answer.
      this.held.push(...this.splitter.flush());
      this.settle(e.content_block.name === "StructuredOutput" ? "final" : "working");
    } else if (e?.type === "message_stop") {
      // A message that ends mid-sentence ("Let me check") before a tool call.
      this.held.push(...this.splitter.flush());
      this.settle("final");
      if (this.replyParts.length && !/\s$/.test(this.replyParts.at(-1)!)) this.replyParts.push("\n");
    }
  }

  private settle(kind: "working" | "final"): void {
    const held = this.held;
    this.held = [];
    if (kind === "final") {
      for (const s of held) if (this.replySpoken++ < MAX_SPOKEN_SENTENCES) this.hooks.onSentence?.(s, "reply");
    } else if (!this.openerSaid) {
      this.openerSaid = true;
      this.hooks.onSentence?.(held[0] ?? DEFAULT_OPENER, "opener");
    }
  }

  private addText(text: string, flush: boolean): void {
    this.replyParts.push(text);
    if (text.trim()) this.spokeSinceTool = true;
    this.held.push(...this.splitter.push(text));
    if (flush) this.held.push(...this.splitter.flush());
  }

  private addDenial(tool: string, toolUseId: string | undefined, text: string): void {
    const key = toolUseId ?? `${tool}:${this.denials.size}`;
    const m = GUARD_RE.exec(text);
    const prev = this.denials.get(key);
    const d: Denial = {
      tool: prev?.tool && prev.tool !== "unknown" ? prev.tool : tool,
      toolUseId,
      rule: prev?.rule ?? (m?.[1] as GuardRule | undefined),
      reason: prev?.reason ?? (m ? `guard:${m[1]}: ${m[2].trim()}` : undefined),
    };
    this.denials.set(key, d);
    if (!prev) this.hooks.onDenial?.(d);
  }

  /** Call when the stream ends. */
  finish(exitCode: number | null): RunResult {
    this.held.push(...this.splitter.flush());
    this.settle("final");
    const reply = this.replyParts.join("").replace(/\n{3,}/g, "\n\n").trim();
    const denials = [...this.denials.values()];
    const r = this.result;
    const base = { sessionId: r?.session_id ?? this.init?.sessionId, reply, denials, costUsd: r?.total_cost_usd, endedSilently: !this.spokeSinceTool };
    if (!r) {
      return { ...base, keep: true, summary: "", isError: true, problem: `the run ended without a result (exit ${exitCode})` };
    }
    if (r.api_error === "usage_limit_reached" || r.api_error_status === 429) {
      // "You've hit your session limit · resets 5:10pm (Europe/London)"
      const resets = /resets\s+([^(·]+?)\s*(?:\(|$)/.exec(String(r.result ?? ""))?.[1];
      const line = `I've hit my Claude usage limit${resets ? `. It resets at ${resets}` : ", so I can't do that right now"}.`;
      return { ...base, reply: line, keep: false, summary: "Hit the Claude usage limit", isError: true, limited: true, problem: String(r.result ?? "usage limit") };
    }
    const so = r.structured_output;
    const isError = Boolean(r.is_error) || (r.subtype !== undefined && r.subtype !== "success");
    if (so && typeof so.keep === "boolean" && typeof so.summary === "string") {
      return { ...base, keep: so.keep, summary: so.summary, isError, say: typeof so.say === "string" && so.say.trim() ? so.say.trim() : undefined };
    }
    // DESIGN 4.1: no valid structured_output means keep, so nothing is lost silently.
    return {
      ...base,
      keep: true,
      summary: typeof so?.summary === "string" ? so.summary : "",
      isError,
      problem: `no valid structured_output (result subtype ${r.subtype ?? "unknown"})`,
    };
  }
}
