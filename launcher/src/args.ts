// The claude -p command line for a run (docs/DESIGN.md section 4.2). Every
// flag here is checked against code.claude.com/docs and `claude --help`.

import { BRIDGE_SERVER, type Config, paths } from "./config";

export const RESULT_SCHEMA = {
  type: "object",
  properties: {
    keep: { type: "boolean", description: "true if Leo will come back to this (research, a brief, code changes); false for questions, lookups and one-shot actions" },
    summary: { type: "string", description: "one line saying what was done, for the notch log" },
    say: { type: "string", description: "what you'd say to Leo out loud, naturally (\"You're welcome.\"), if your text reply didn't already say it" },
  },
  required: ["keep", "summary"],
  additionalProperties: false,
};

export interface RunPlan {
  prompt: string;
  /** New run: the launcher-chosen session id. */
  sessionId?: string;
  /** Follow-up to a saved run: resume this session instead. */
  resume?: string;
  /** Display name, only for explicit saved intents. */
  name?: string;
  /** Warm run: started before the request exists; the prompt arrives on stdin as stream-json. */
  streamInput?: boolean;
  /** Overrides the config's model for this run (quick asks get the fast model). */
  model?: string;
}

/** The bridge entry for this run, written to ~/Jarvis/runs/<id>.mcp.json (DESIGN 8.1). */
export function mcpConfig(c: Config, sessionId: string): object {
  return {
    mcpServers: {
      [BRIDGE_SERVER]: {
        command: c.bunBin,
        args: [paths(c).bridgeServer, "--session-id", sessionId],
        env: { JARVIS_REPO: c.repo, JARVIS_HOME: c.home },
      },
    },
  };
}

export function claudeArgs(c: Config, plan: RunPlan): string[] {
  const p = paths(c);
  const id = plan.resume ?? plan.sessionId;
  const args = plan.streamInput ? ["-p", "--input-format", "stream-json"] : ["-p", plan.prompt];
  if (plan.resume) args.push("--resume", plan.resume);
  else if (plan.sessionId) args.push("--session-id", plan.sessionId);
  else throw new Error("a run needs a session id or a session to resume");
  if (plan.name) args.push("--name", plan.name);
  const model = plan.model ?? c.model;
  if (model) args.push("--model", model);
  args.push(
    "--settings", p.guardSettings,
    "--mcp-config", p.mcpConfig(id!),
    "--append-system-prompt-file", p.systemPrompt,
    "--permission-mode", "auto",
    "--permission-prompts", "none",
    "--chrome",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--json-schema", JSON.stringify(RESULT_SCHEMA),
  );
  return args;
}

const SAVED_INTENTS: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^(?:please\s+)?(?:start|begin|open|kick off)\s+(?:a\s+)?(?:new\s+)?research\s+(?:session|project)?\s*(?:on|about|into|for)\s+(.+)$/i, (m) => `Research: ${m[1]}`],
  [/^(?:please\s+)?research\s+(.+?)\s+(?:in depth|properly|thoroughly)$/i, (m) => `Research: ${m[1]}`],
  [/^(?:please\s+)?(?:write|draft|prepare|put together)\s+(?:me\s+)?(?:a|an)\s+brief(?:ing)?\s+(?:on|about|for)\s+(.+)$/i, (m) => `Brief: ${m[1]}`],
  [/^(?:please\s+)?(?:start|open)\s+(?:a\s+)?(?:saved|named)\s+session\s+(?:on|about|for)\s+(.+)$/i, (m) => m[1]],
];

/** "Jarvis: <title>" when the request explicitly asks for a saved session, else undefined. */
export function savedRunName(request: string): string | undefined {
  const r = request.trim().replace(/^jarvis[,:]?\s+/i, "");
  for (const [re, title] of SAVED_INTENTS) {
    const m = re.exec(r);
    if (!m) continue;
    let t = title(m).replace(/[.!?\s]+$/, "").trim();
    if (t.length > 60) t = t.slice(0, 59).trimEnd() + "…";
    return `Jarvis: ${t}`;
  }
  return undefined;
}

const SMART = /\b(research|analy[sz]e|analysis|plan|planning|write|draft|brief|essay|report|compare|comparison|explain why|why does|debug|code|refactor|review|think|carefully|properly|in depth|thorough(?:ly)?|step by step|strategy|summari[sz]e (?:the|my) (?:week|project|thread|channel))\b/i;

/**
 * Quick asks (weather, time, a Kanban card, a reminder, a lookup) go to the
 * fast model; research, writing, planning, code and anything long go to the
 * smart one. Leo, 2026-10-11: "switch, but keep Opus for smartest answers".
 */
export function needsSmartModel(request: string): boolean {
  const r = request.trim();
  if (savedRunName(r)) return true;
  if (r.split(/\s+/).length > 25) return true;
  return SMART.test(r);
}

/** The model for a run, or undefined for Leo's default. JARVIS_MODEL pins one for everything. */
export function modelFor(c: Config, request: string): string | undefined {
  if (c.model) return c.model;
  return needsSmartModel(request) ? undefined : c.fastModel;
}
