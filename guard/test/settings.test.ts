// guard/settings.json: the deny rules and the hook registration a run loads with --settings.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const settings = JSON.parse(readFileSync(join(import.meta.dir, "..", "settings.json"), "utf8"));
const deny: string[] = settings.permissions.deny;

// Tool-name globs in deny rules match the whole name; * is any run of characters.
const globMatches = (rule: string, name: string) =>
  new RegExp("^" + rule.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$").test(name);
const deniedByRules = (name: string) => deny.filter((r) => !r.includes("(")).some((r) => globMatches(r, name));

test("only restricts: no allow rules, no hook switch-off", () => {
  expect(settings.permissions.allow).toBeUndefined();
  expect(settings.disableAllHooks).toBeUndefined();
  expect(Object.keys(settings).sort()).toEqual(["hooks", "permissions"]);
});

test("registers the guard hook on every tool, failing closed", () => {
  const groups = settings.hooks.PreToolUse;
  expect(groups).toHaveLength(1);
  expect(groups[0].matcher).toBe("*");
  const h = groups[0].hooks[0];
  expect(h.type).toBe("command");
  expect(h.command).toBe('bun "$JARVIS_REPO/guard/hook.ts"');
  expect(h.onFailure).toBe("block");
});

test("send tools are removed outright, drafts and reads are not", () => {
  for (const n of [
    "mcp__claude_ai_Slack__slack_send_message",
    "mcp__Slack__slack_schedule_message",
    "mcp__claude_ai_Gmail__send_email",
    "mcp__claude_ai_Gmail__send_draft",
    "mcp__Google_Calendar__respond_to_event",
    "mcp__Co-Invest__execute_order",
    "mcp__Vercel__buy_domain",
  ]) expect(deniedByRules(n)).toBeTrue();
  for (const n of [
    "mcp__claude_ai_Slack__slack_send_message_draft",
    "mcp__claude_ai_Slack__slack_read_channel",
    "mcp__claude_ai_Gmail__create_draft",
    "mcp__Co-Invest__get_portfolio",
    "mcp__Vercel__get_purchase_quote",
    "mcp__jarvis__speak",
  ]) expect(deniedByRules(n)).toBeFalse();
});

test("credential paths are denied to the file tools", () => {
  for (const p of ["~/.ssh/**", "~/.aws/**", "~/Library/Keychains/**", "//**/.env"]) {
    expect(deny).toContain(`Read(${p})`);
  }
});

test("rules are well-formed", () => {
  for (const r of deny) {
    expect(r).toMatch(/^(mcp__[A-Za-z0-9*_-]+__[A-Za-z0-9*_-]+|(Read|Edit|Bash)\(.+\))$/);
    // settings files skip mcp__ rules with parentheses
    if (r.startsWith("mcp__")) expect(r).not.toContain("(");
  }
});
