import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTodos, notePath, parseFrontmatter, projectChannels } from "../slack-digest/todos.ts";

const VAULT = join(import.meta.dir, "fixtures/vault");
const AMRA = readFileSync(join(VAULT, "Projects/Amra.md"), "utf8");
const CLI = join(import.meta.dir, "../slack-digest/todos.ts");

describe("frontmatter", () => {
  test("inline lists, block lists and scalars", () => {
    expect(parseFrontmatter(AMRA)).toEqual({
      status: "active",
      repos: ["Leo0Garcia/amra"],
      people: ["[[Sue]]", "[[Ellen]]"],
      slack_channels: ["#amra", "#amra-dev"],
      claude_project_url: "https://claude.ai/project/example",
    });
  });

  test("channels lists projects, skipping the template", () => {
    expect(projectChannels(VAULT)).toEqual([
      { project: "Amra", note: "Projects/Amra.md", status: "active", slack_channels: ["#amra", "#amra-dev"], people: ["Sue", "Ellen"] },
      { project: "Thesis", note: "Projects/Thesis.md", status: "archived", slack_channels: [], people: [] },
    ]);
  });
});

describe("addTodos", () => {
  test("appends under ## To do and leaves other sections alone", () => {
    const { content, added } = addTodos(AMRA, ["Send Ellen the slides (Ellen, #amra)", "Book the room"], "Slack #amra, 11 Oct");
    expect(added).toEqual(["Send Ellen the slides (Ellen, #amra)", "Book the room"]);
    expect(content).toContain(
      "## To do\n\n- [ ] Draft the pitch deck\n- [ ] Send Ellen the slides (Ellen, #amra) (from Slack #amra, 11 Oct)\n- [ ] Book the room (from Slack #amra, 11 Oct)\n\n## Needs Leo",
    );
    expect(content.startsWith(AMRA.slice(0, AMRA.indexOf("## To do")))).toBe(true);
  });

  test("skips duplicates, ignoring case, punctuation and the source suffix", () => {
    const once = addTodos(AMRA, ["Book the room"], "Slack #amra").content;
    const twice = addTodos(once, ["book the room.", "draft the PITCH deck"], "Slack #amra-dev");
    expect(twice.added).toEqual([]);
    expect(twice.content).toBe(once);
  });

  test("creates the section before Needs Leo when missing", () => {
    const thesis = readFileSync(join(VAULT, "Projects/Thesis.md"), "utf8");
    const { content } = addTodos(thesis, ["Email supervisor draft"], "Slack DM Sue");
    expect(content).toContain("## To do\n- [ ] Email supervisor draft (from Slack DM Sue)\n\n## Needs Leo");
  });

  test("appends a section to a note with neither", () => {
    expect(addTodos("# 2026-10-11\n", ["x"], "").content).toBe("# 2026-10-11\n\n## To do\n- [ ] x\n");
  });
});

describe("notePath", () => {
  test("refuses paths outside the vault", () => {
    expect(() => notePath(VAULT, "../../etc/passwd")).toThrow(/isn't inside/);
    expect(() => notePath(VAULT, "/Users/leogarcia/Documents/Obsidian Master Vault/Kanban.md")).not.toThrow();
    expect(notePath(VAULT, "/Users/x/Kanban")).toBe(join(VAULT, "Users/x/Kanban.md"));
  });
});

describe("CLI", () => {
  function vaultCopy(): string {
    const dir = mkdtempSync(join(tmpdir(), "vault-"));
    cpSync(VAULT, dir, { recursive: true });
    return dir;
  }

  test("add to a project note", () => {
    const v = vaultCopy();
    const r = Bun.spawnSync(["bun", CLI, "add", "--note", "Projects/Amra.md", "--source", "Slack #amra", "--todo", "Book the room"], {
      env: { ...process.env, JARVIS_MEMORY: v },
    });
    expect(r.stdout.toString().trim()).toBe("Added 1 to-do to Projects/Amra.md.");
    expect(readFileSync(join(v, "Projects/Amra.md"), "utf8")).toContain("- [ ] Book the room (from Slack #amra)");
  });

  test("no note goes to today's log", () => {
    const v = vaultCopy();
    const r = Bun.spawnSync(["bun", CLI, "add", "--source", "Slack DM Sue", "--todo", "Reply to Sue"], {
      env: { ...process.env, JARVIS_MEMORY: v, JARVIS_NOW: "2026-10-11T13:00:00Z" },
    });
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(v, "Log/2026-10-11.md"), "utf8")).toBe("# 2026-10-11\n\n## To do\n- [ ] Reply to Sue (from Slack DM Sue)\n");
  });

  test("an unregistered project fails without creating a note", () => {
    const v = vaultCopy();
    const r = Bun.spawnSync(["bun", CLI, "add", "--note", "Projects/Nope.md", "--todo", "x"], { env: { ...process.env, JARVIS_MEMORY: v }, stderr: "pipe" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("Register the project first");
    expect(existsSync(join(v, "Projects/Nope.md"))).toBe(false);
  });
});
