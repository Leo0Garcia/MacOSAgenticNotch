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

export interface RunResult {
  sessionId?: string;
  keep: boolean;
  summary: string;
  reply: string;
  denials: Denial[];
  /** Why keep was forced to true, or why the run failed. */
  problem?: string;
  isError: boolean;
  costUsd?: number;
}

export interface MonitorHooks {
  onSentence?: (s: string) => void;
  onInit?: (init: InitInfo) => void;
  onDenial?: (d: Denial) => void;
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
      case "assistant":
        if (ev.parent_tool_use_id) return;
        for (const b of ev.message?.content ?? []) {
          if (b?.type === "tool_use") this.toolNames.set(b.id, b.name);
          // Without partial messages the text only arrives here.
          if (b?.type === "text" && !this.sawTextDelta) this.addText(b.text + "\n", true);
        }
        return;
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
    } else if (e?.type === "message_stop") {
      // A message that ends mid-sentence ("Let me check") before a tool call.
      for (const s of this.splitter.flush()) this.hooks.onSentence?.(s);
      if (this.replyParts.length && !/\s$/.test(this.replyParts.at(-1)!)) this.replyParts.push("\n");
    }
  }

  private addText(text: string, flush: boolean): void {
    this.replyParts.push(text);
    for (const s of this.splitter.push(text)) this.hooks.onSentence?.(s);
    if (flush) for (const s of this.splitter.flush()) this.hooks.onSentence?.(s);
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
    for (const s of this.splitter.flush()) this.hooks.onSentence?.(s);
    const reply = this.replyParts.join("").replace(/\n{3,}/g, "\n\n").trim();
    const denials = [...this.denials.values()];
    const r = this.result;
    const base = { sessionId: r?.session_id ?? this.init?.sessionId, reply, denials, costUsd: r?.total_cost_usd };
    if (!r) {
      return { ...base, keep: true, summary: "", isError: true, problem: `the run ended without a result (exit ${exitCode})` };
    }
    const so = r.structured_output;
    const isError = Boolean(r.is_error) || (r.subtype !== undefined && r.subtype !== "success");
    if (so && typeof so.keep === "boolean" && typeof so.summary === "string") {
      return { ...base, keep: so.keep, summary: so.summary, isError };
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
