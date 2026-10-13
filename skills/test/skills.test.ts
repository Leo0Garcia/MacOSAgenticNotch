// Every skill folder loads in Claude Code and stays inside Jarvis's limits.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../slack-digest/todos.ts";

const ROOT = join(import.meta.dir, "..");
const SKILLS = readdirSync(ROOT).filter((d) => existsSync(join(ROOT, d, "SKILL.md")));

test("every skill exists", () => {
  expect(SKILLS.sort()).toEqual(["calendar", "kanban", "lights", "moodle", "needs-access", "reminders", "slack-digest"]);
});

describe.each(SKILLS)("%s", (name) => {
  const md = readFileSync(join(ROOT, name, "SKILL.md"), "utf8");
  const fm = parseFrontmatter(md);

  test("frontmatter has name = folder and a description under the listing limit", () => {
    expect(fm.name).toBe(name);
    expect(typeof fm.description).toBe("string");
    expect(String(fm.description).length + String(fm.when_to_use ?? "").length).toBeLessThan(1536);
  });

  test("every script it references exists", () => {
    for (const m of md.matchAll(/\$\{CLAUDE_SKILL_DIR\}\/([\w./-]+\.ts)/g)) {
      expect(statSync(join(ROOT, name, m[1]!)).isFile()).toBe(true);
    }
    for (const m of md.matchAll(/\$JARVIS_REPO\/skills\/([\w./-]+\.ts)/g)) {
      expect(statSync(join(ROOT, m[1]!)).isFile()).toBe(true);
    }
  });

  test("pre-approves only its own scripts", () => {
    const allowed = String(fm["allowed-tools"] ?? "");
    for (const rule of allowed.split(/,\s*/).filter(Boolean)) {
      expect(rule).toMatch(/^(Bash\(bun \$\{CLAUDE_SKILL_DIR\}\/[\w-]+\.ts \*\)|mcp__jarvis__(remind|ask))$/);
    }
  });

  test("never tells Claude to send, pay, submit or delete", () => {
    // Slack/mail send tools are only ever named in a "never" sentence.
    for (const line of md.split("\n")) {
      if (/slack_send_message|send_email|slack_schedule_message/.test(line)) expect(line).toMatch(/\bnever\b|deny|denies/i);
    }
    expect(md).not.toMatch(/\brm -/);
  });
});

test("no script writes into the master vault except kanban.ts", () => {
  const offenders: string[] = [];
  for (const dir of SKILLS) {
    for (const f of readdirSync(join(ROOT, dir)).filter((x) => x.endsWith(".ts"))) {
      const src = readFileSync(join(ROOT, dir, f), "utf8");
      if (src.includes("masterVault(") && !(dir === "kanban" && f === "kanban.ts")) offenders.push(`${dir}/${f}`);
    }
  }
  expect(offenders).toEqual([]);
});
