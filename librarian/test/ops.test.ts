import { describe, expect, test } from "bun:test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { applyOps, looksSecret, validateOutput, type Op } from "../src/ops";
import { REPO, tempConfig } from "./helpers";

const read = (cfg: { memory: string }, rel: string) => readFile(join(cfg.memory, rel), "utf8");

describe("applyOps", () => {
  test("registers a project from the template", async () => {
    const cfg = await tempConfig();
    const ops: Op[] = [
      { op: "create", path: "Projects/Amra.md" },
      { op: "set", path: "Projects/Amra.md", key: "slack_channels", values: ["#amra"] },
      { op: "set", path: "Projects/Amra.md", key: "people", values: ["[[Sue]]", "[[Ellen]]"] },
      { op: "append", path: "Projects/Amra.md", section: "To do", text: "Draft budget\nBook room" },
      { op: "move", path: "Projects/Amra.md", section: "To do", to_section: "Done", text: "Draft budget" },
    ];
    const r = await applyOps(cfg.memory, REPO, ops);
    expect(r.skipped).toEqual([]);
    expect(r.touched).toEqual(["Projects/Amra.md"]);
    const note = await read(cfg, "Projects/Amra.md");
    expect(note).toContain("# Amra");
    expect(note).toContain('slack_channels: ["#amra"]');
    expect(note).toContain('people: ["[[Sue]]", "[[Ellen]]"]');
    expect(note).toContain("## Done\n\n- Draft budget\n\n## To do\n\n- Book room\n");
    expect(note).toContain("status: active");
  });

  test("append to a missing person note creates it from the template", async () => {
    const cfg = await tempConfig();
    const r = await applyOps(cfg.memory, REPO, [{ op: "append", path: "People/Sue.md", section: "Context", text: "Runs Amra's budget" }]);
    expect(r.skipped).toEqual([]);
    const note = await read(cfg, "People/Sue.md");
    expect(note).toContain("# Sue");
    expect(note).toContain("## Context\n\n- Runs Amra's budget\n");
  });

  test("refuses escapes, script-owned notes, overwrites and secrets, and keeps going", async () => {
    const cfg = await tempConfig();
    await writeFile(join(cfg.memory, "Me.md"), "# Me\n\n" + "Leo likes tea. ".repeat(20) + "\n");
    const ops: Op[] = [
      { op: "create", path: "../escape.md", content: "x" },
      { op: "replace", path: "Index.md", content: "x" },
      { op: "create", path: "Me.md", content: "x" },
      { op: "replace", path: "Me.md", content: "# Me\n" },
      { op: "append", path: "Me.md", section: "Notes", text: "Card 4111 1111 1111 1111" },
      { op: "append", path: "Me.md", section: "Notes", text: "token sk-ant-api03-abcdefghijklmnop" },
      { op: "append", path: "Me.md", section: "Notes", text: "Phone 02380 595000, student id 33445566" },
    ];
    const r = await applyOps(cfg.memory, REPO, ops);
    expect(r.skipped.map((s) => s.reason)).toEqual([
      expect.stringMatching(/leaves the vault/),
      expect.stringMatching(/maintained by the librarian script/),
      "already exists",
      expect.stringMatching(/drop more than half/),
      expect.stringMatching(/secret or card number/),
      expect.stringMatching(/secret or card number/),
    ]);
    expect(r.applied).toEqual(["append Me.md"]);
  });

  test("move and remove report missing items instead of guessing", async () => {
    const cfg = await tempConfig();
    await mkdir(join(cfg.memory, "Projects"));
    await writeFile(join(cfg.memory, "Projects/X.md"), "# X\n\n## To do\n\n- a thing\n");
    const r = await applyOps(cfg.memory, REPO, [
      { op: "move", path: "Projects/X.md", section: "To do", to_section: "Done", text: "other thing" },
      { op: "remove", path: "Projects/Y.md", section: "To do", text: "x" },
    ]);
    expect(r.skipped.map((s) => s.reason)).toEqual([expect.stringMatching(/not found/), "note does not exist"]);
  });

  test("caps the number of ops per run", async () => {
    const cfg = await tempConfig();
    const ops: Op[] = Array.from({ length: 45 }, (_, i) => ({ op: "append", path: "Me.md", section: "Notes", text: `fact ${i}` }));
    const r = await applyOps(cfg.memory, REPO, ops);
    expect(r.applied.length).toBe(40);
    expect(r.skipped.length).toBe(5);
  });
});

describe("validateOutput", () => {
  test("drops malformed ops and flattens log lines", () => {
    const out = validateOutput({ ops: [{ op: "create", path: "a.md" }, { path: "b.md" }, null], log: ["one\ntwo", "", 3] });
    expect(out).toEqual({ ops: [{ op: "create", path: "a.md" }], log: ["one two"] });
    expect(() => validateOutput({ ops: [] })).toThrow();
  });

  test("card detection uses Luhn so ordinary numbers pass", () => {
    expect(looksSecret("4111-1111-1111-1111")).toBe(true);
    expect(looksSecret("session 20261012130500")).toBe(false);
  });
});
