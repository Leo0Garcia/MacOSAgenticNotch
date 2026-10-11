// Test fixtures: a fake home with ~/Jarvis, ~/Jarvis-Memory, the repo, the
// master vault and some of Leo's files, all inside a temp folder.

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { contextFromEnv, type GuardContext } from "../src/context";
import { decide, type HookInput } from "../src/decide";
import { loadBlocklist } from "../src/domains";

export interface World {
  root: string;
  home: string;
  repo: string;
  vault: string;
  tmp: string;
  ctx: GuardContext;
  vars: Record<string, string>;
}

function touch(p: string, body = "x\n") {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}

export function makeWorld(): World {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jarvis-guard-")));
  const home = join(root, "Users", "leogarcia");
  const repo = join(home, "code", "MacOSAgenticNotch");
  const vault = join(home, "Documents", "Obsidian Master Vault");
  const tmp = join(root, "T");
  for (const f of [
    join(home, "Jarvis", "briefing.md"),
    join(home, "Jarvis", "runs", "old.jsonl"),
    join(home, "Jarvis-Memory", "Me.md"),
    join(repo, "README.md"),
    join(repo, ".git", "HEAD"),
    join(vault, "Kanban.md"),
    join(vault, "Uni", "COMP1234.md"),
    join(home, "Documents", "x", "thesis.docx"),
    join(home, "Documents", "essay.md"),
    join(home, "Downloads", "report.pdf"),
    join(home, ".ssh", "id_rsa"),
    join(home, ".aws", "credentials"),
    join(home, "code", "other-project", ".env"),
    join(home, "code", "other-project", "src", "main.ts"),
    join(tmp, "scratch.txt"),
  ]) touch(f);
  const ctx = contextFromEnv({
    HOME: home,
    JARVIS_REPO: repo,
    JARVIS_MASTER_VAULT: vault,
    TMPDIR: tmp,
    JARVIS_GUARD_TMPDIRS: tmp,
  });
  return { root, home, repo, vault, tmp, ctx, vars: { $HOME: home, $REPO: repo, $VAULT: vault } };
}

export function substitute<T>(v: T, vars: Record<string, string>): T {
  let s = JSON.stringify(v);
  for (const [k, val] of Object.entries(vars)) s = s.split(k).join(val.replace(/\\/g, "\\\\"));
  return JSON.parse(s);
}

export interface Case {
  name: string;
  expect: "deny" | "allow";
  rule?: string;
  input: HookInput;
}

export function loadCases(file: string): Case[] {
  return JSON.parse(readFileSync(join(import.meta.dir, "fixtures", file), "utf8"));
}

export function run(w: World, input: HookInput) {
  return decide(substitute(input, w.vars), w.ctx, loadBlocklist());
}
