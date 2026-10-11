// The guard's single entry point: one PreToolUse input in, allow or deny out.

import { checkBash } from "./bash";
import type { GuardContext } from "./context";
import { checkText, checkUrl, type DomainEntry } from "./domains";
import { checkMcp, parseMcpName } from "./mcp";
import { canOverwrite, forbiddenWrite, isCredentialPath, resolvePath } from "./paths";
import { deny, type Denial } from "./rules";

export interface HookInput {
  hook_event_name?: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  cwd?: string;
  session_id?: string;
}

const SHELL_TOOLS = new Set(["Bash", "PowerShell", "Monitor"]);
const FILE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const FILE_READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS"]);

/** Fields that hold content Jarvis is writing (notes, drafts), not places it is going. */
const CONTENT_KEYS = new Set(["content", "contents", "text", "body", "new_string", "old_string", "new_source", "markdown", "message", "note", "description", "summary", "prompt", "question", "title", "caption", "edits"]);

function strings(v: unknown, key = "", out: string[] = []): string[] {
  if (CONTENT_KEYS.has(key)) return out;
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, "", out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) strings(x, k, out);
  return out;
}

function checkFileWrite(tool: string, input: Record<string, unknown>, cwd: string | null, ctx: GuardContext): Denial | null {
  const p = (input.file_path ?? input.notebook_path ?? input.path) as string | undefined;
  if (typeof p !== "string") return null;
  const abs = resolvePath(p, cwd, ctx);
  if (!abs) return deny("no-harm", `${tool} path "${p}" can't be checked against the allowlist`);
  const why = forbiddenWrite(abs, ctx);
  if (why) return deny("no-harm", why);
  if (tool === "Write" && ctx.exists(abs) && !canOverwrite(abs, ctx)) {
    return deny("no-harm", `Write would replace ${abs}, which isn't inside ~/Jarvis, ~/Jarvis-Memory or the Jarvis repo; edit it instead`);
  }
  return null;
}

const MCP_PATH_KEYS = ["path", "file_path", "filePath", "destination", "dest", "target", "newPath", "new_path", "source", "oldPath"];
const MCP_WRITE_WORDS = new Set(["write", "edit", "move", "create", "patch", "rename", "append", "save", "copy", "delete", "remove", "mkdir"]);

/** Filesystem-style MCP servers get the same path rules as Write. */
function checkMcpPaths(name: string, input: Record<string, unknown>, cwd: string | null, ctx: GuardContext): Denial | null {
  const n = parseMcpName(name);
  if (!n) return null;
  const writes = n.words.some((w) => MCP_WRITE_WORDS.has(w));
  for (const k of MCP_PATH_KEYS) {
    const v = input[k];
    if (typeof v !== "string" || !(v.startsWith("/") || v.startsWith("~"))) continue;
    const abs = resolvePath(v, cwd, ctx);
    if (!abs) continue;
    if (isCredentialPath(abs, ctx)) return deny("no-harm", `${abs} holds credentials`);
    if (!writes) continue;
    const why = forbiddenWrite(abs, ctx);
    if (why) return deny("no-harm", why);
    const overwriting = n.words.includes("write") || ((k === "destination" || k === "newPath" || k === "new_path" || k === "dest" || k === "target") && ctx.exists(abs));
    if (overwriting && ctx.exists(abs) && !ctx.isDir(abs) && !canOverwrite(abs, ctx)) {
      return deny("no-harm", `${n.tool} would replace ${abs}, which isn't inside ~/Jarvis, ~/Jarvis-Memory or the Jarvis repo`);
    }
  }
  return null;
}

export function decide(input: HookInput, ctx: GuardContext, domains: DomainEntry[]): Denial | null {
  const tool = input.tool_name;
  const ti = input.tool_input ?? {};
  const cwd = input.cwd ?? null;

  if (SHELL_TOOLS.has(tool)) {
    const command = ti.command;
    if (typeof command === "string") {
      const d = checkBash(command, cwd, { ctx, domains, depth: 0 });
      if (d) return d;
    }
    if (typeof ti.url === "string") {
      const d = checkUrl(ti.url, domains);
      if (d) return d;
    }
    return null;
  }

  if (FILE_WRITE_TOOLS.has(tool)) return checkFileWrite(tool, ti, cwd, ctx);

  if (FILE_READ_TOOLS.has(tool)) {
    const p = (ti.file_path ?? ti.path) as string | undefined;
    if (typeof p === "string") {
      const abs = resolvePath(p, cwd, ctx);
      if (abs && isCredentialPath(abs, ctx)) return deny("no-harm", `${abs} holds credentials`);
    }
    return null;
  }

  if (tool === "WebFetch") {
    if (typeof ti.url === "string") return checkUrl(ti.url, domains);
    return null;
  }
  if (tool === "WebSearch") return null; // searching is read-only; fetching a result goes through WebFetch

  if (tool.startsWith("mcp__")) {
    const m = checkMcp(tool, ti, ctx);
    if (m) return m;
    const p = checkMcpPaths(tool, ti, cwd, ctx);
    if (p) return p;
  }

  // Any other tool (MCP, browser, subagents): check every place it is told to go.
  for (const s of strings(ti)) {
    const d = checkText(s, domains);
    if (d) return d;
  }
  return null;
}
