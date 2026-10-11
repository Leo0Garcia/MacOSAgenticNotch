import { describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveNotePath, VaultPathError } from "../src/fsutil";
import { tempConfig } from "./helpers";

describe("resolveNotePath", () => {
  test("accepts notes inside the vault", async () => {
    const cfg = await tempConfig();
    const r = await resolveNotePath(cfg.memory, "Projects/Amra.md");
    expect(r.abs).toBe(join(cfg.memory, "Projects", "Amra.md"));
    expect((await resolveNotePath(cfg.memory, "Me.md")).rel).toBe("Me.md");
  });

  test.each([
    ["../outside.md"],
    ["Projects/../../x.md"],
    ["/etc/passwd.md"],
    ["~/Documents/x.md"],
    [".obsidian/app.md"],
    ["Projects/.hidden.md"],
    ["Projects/Amra.txt"],
    ["Index.md"],
    ["Projects/_template.md"],
    ["Log/2026-10-12.md"],
    ["Projects\\Amra.md"],
    [""],
  ])("rejects %p", async (p) => {
    const cfg = await tempConfig();
    await expect(resolveNotePath(cfg.memory, p)).rejects.toThrow(VaultPathError);
  });

  test("rejects a symlinked folder that leads out of the vault", async () => {
    const cfg = await tempConfig();
    const outside = join(cfg.root, "Master Vault");
    await mkdir(outside);
    await symlink(outside, join(cfg.memory, "Master"));
    await expect(resolveNotePath(cfg.memory, "Master/Kanban.md")).rejects.toThrow(/outside the vault/);
  });

  test("rejects a note that is itself a symlink", async () => {
    const cfg = await tempConfig();
    await writeFile(join(cfg.root, "target.md"), "x");
    await symlink(join(cfg.root, "target.md"), join(cfg.memory, "Linked.md"));
    await expect(resolveNotePath(cfg.memory, "Linked.md")).rejects.toThrow(/symlink/);
  });
});
