// The claude -p command line for a run (docs/DESIGN.md section 4.2). Every
// flag here is checked against code.claude.com/docs and `claude --help`.

import { BRIDGE_SERVER, type Config, paths } from "./config";

export const RESULT_SCHEMA = {
  type: "object",
  properties: {
    keep: { type: "boolean", description: "true if Leo will come back to this (research, a brief, code changes); false for questions, lookups and one-shot actions" },
    summary: { type: "string", description: "one line saying what was done, for the notch log" },
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
  const args = ["-p", plan.prompt];
  if (plan.resume) args.push("--resume", plan.resume);
  else if (plan.sessionId) args.push("--session-id", plan.sessionId);
  else throw new Error("a run needs a session id or a session to resume");
  if (plan.name) args.push("--name", plan.name);
  if (c.model) args.push("--model", c.model);
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
