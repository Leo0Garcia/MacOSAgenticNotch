#!/usr/bin/env bun
// Vault side of the Slack digest. Reading Slack and summarising is Claude's job through
// Leo's Slack connector (read tools only); this script owns the writes into ~/Jarvis-Memory.
//
//   bun todos.ts channels
//       -> [{"project":"Amra","note":"Projects/Amra.md","slack_channels":["#amra"],"people":[...]}]
//   bun todos.ts add [--note Projects/Amra.md] --source "Slack #amra, 11 Oct" --todo "…" [--todo "…"]
//       Appends unchecked items under "## To do", skipping ones already there.
//       With no --note, writes to today's Log/YYYY-MM-DD.md.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, normalize, relative } from "node:path";
import { rewrite } from "../lib/atomic.ts";
import { fail, jarvisMemory, now, parseArgs } from "../lib/env.ts";
import { dateKey } from "../lib/tz.ts";

export type Frontmatter = Record<string, string | string[]>;

/** The small YAML subset project notes use: `key: value`, `key: [a, b]`, and `- item` lists. */
export function parseFrontmatter(md: string): Frontmatter {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  const out: Frontmatter = {};
  let listKey: string | null = null;
  const clean = (v: string) => v.trim().replace(/^["']|["']$/g, "");
  for (const line of m[1]!.split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line) ?? (listKey ? /^-\s+(.*)$/.exec(line) : null);
    if (item && listKey) {
      (out[listKey] as string[]).push(clean(item[1]!));
      continue;
    }
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, raw] = kv;
    if (raw === "") {
      out[key!] = [];
      listKey = key!;
    } else if (/^\[.*\]$/.test(raw!.trim())) {
      out[key!] = raw!.trim().slice(1, -1).split(",").map(clean).filter(Boolean);
      listKey = null;
    } else {
      out[key!] = clean(raw!);
      listKey = null;
    }
  }
  return out;
}

function asList(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).map((x) => x.replace(/^\[\[|\]\]$/g, "")).filter(Boolean);
}

export interface ProjectChannels {
  project: string;
  note: string;
  status: string | null;
  slack_channels: string[];
  people: string[];
}

export function projectChannels(vault: string): ProjectChannels[] {
  const dir = join(vault, "Projects");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && !f.startsWith("_"))
    .sort()
    .map((f) => {
      const fm = parseFrontmatter(readFileSync(join(dir, f), "utf8"));
      return {
        project: f.slice(0, -3),
        note: `Projects/${f}`,
        status: typeof fm.status === "string" ? fm.status : null,
        slack_channels: asList(fm.slack_channels),
        people: asList(fm.people),
      };
    });
}

function normTodo(s: string): string {
  return s
    .replace(/^- \[[ xX]\]\s*/, "")
    .replace(/\s*\((?:from|via) [^)]*\)\s*$/i, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Insert `- [ ] todo (from source)` lines at the end of the "## To do" section, creating
 * the section (before "## Needs Leo" if present, else at the end) when it's missing.
 */
export function addTodos(md: string, todos: string[], source: string): { content: string; added: string[] } {
  const eol = md.includes("\r\n") ? "\r\n" : "\n";
  const lines = md.split(/\r?\n/);
  const existing = new Set(lines.filter((l) => /^- \[[ xX]\]/.test(l)).map(normTodo));
  const added: string[] = [];
  const newLines: string[] = [];
  for (const raw of todos) {
    const t = raw.replace(/\s+/g, " ").trim();
    if (!t || existing.has(normTodo(t))) continue;
    existing.add(normTodo(t));
    added.push(t);
    newLines.push(`- [ ] ${t}${source ? ` (from ${source})` : ""}`);
  }
  if (!added.length) return { content: md, added };

  let head = lines.findIndex((l) => /^##\s+to ?do\s*$/i.test(l));
  if (head === -1) {
    const needs = lines.findIndex((l) => /^##\s+needs leo\s*$/i.test(l));
    const section = ["## To do", ...newLines, ""];
    if (needs !== -1) lines.splice(needs, 0, ...section);
    else {
      while (lines.length && lines.at(-1) === "") lines.pop();
      lines.push("", ...section);
    }
    return { content: lines.join(eol), added };
  }
  let end = head + 1;
  while (end < lines.length && !/^#{1,2}\s/.test(lines[end]!)) end++;
  let at = end;
  while (at > head + 1 && lines[at - 1]!.trim() === "") at--;
  lines.splice(at, 0, ...newLines);
  return { content: lines.join(eol), added };
}

/** Resolve a vault-relative note path, refusing anything that escapes the vault. */
export function notePath(vault: string, note: string): string {
  const p = normalize(join(vault, note.endsWith(".md") ? note : `${note}.md`));
  const rel = relative(vault, p);
  if (rel.startsWith("..") || rel === "") throw new Error(`${note} isn't inside the Jarvis memory vault.`);
  return p;
}

function main(argv: string[]): void {
  const args = parseArgs(argv);
  const vault = jarvisMemory();
  const [cmd] = args._;
  if (cmd === "channels") {
    console.log(JSON.stringify(projectChannels(vault), null, 2));
    return;
  }
  if (cmd !== "add") fail("usage: todos.ts channels | add [--note <path>] --source <text> --todo <text>…", 64);
  const todos = args.flags.todo ?? [];
  if (!todos.length) fail("No to-dos given.", 2);
  const source = args.flags.source?.at(-1) ?? "";
  const today = dateKey(now().getTime());
  const note = args.flags.note?.at(-1) ?? `Log/${today}.md`;
  const path = notePath(vault, note);
  const isLog = note.startsWith("Log/");
  try {
    const { value } = rewrite(path, (current) => {
      if (current === null && !isLog) throw new Error(`There's no note ${note} in Jarvis memory. Register the project first.`);
      const base = current ?? `# ${today}${"\n"}`;
      const r = addTodos(base, todos, source);
      return { content: r.added.length ? r.content : null, value: r.added };
    });
    console.log(value.length ? `Added ${value.length} to-do${value.length === 1 ? "" : "s"} to ${note}.` : `Nothing new: those to-dos are already in ${note}.`);
  } catch (e) {
    fail((e as Error).message);
  }
}

if (import.meta.main) main(process.argv.slice(2));
