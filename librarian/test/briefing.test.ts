import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildBriefing, MAX_BRIEFING } from "../src/briefing";
import type { Snapshot } from "../src/snapshot";
import { tempConfig } from "./helpers";

const SNAP: Snapshot = { apps: "frontmost Xcode", sessions: "none running", calendar: "nothing today", timetable: "14:00-16:00 COMP2207 Lab" };

async function vault() {
  const cfg = await tempConfig();
  await mkdir(join(cfg.memory, "Projects"));
  await mkdir(join(cfg.memory, "Log"));
  await writeFile(join(cfg.memory, "Me.md"), "---\ntype: me\n---\n\n# Me\n\nLeo. Prefers short answers.\n");
  await writeFile(
    join(cfg.memory, "Projects/Amra.md"),
    '---\nstatus: active\nrepos: [Leo0Garcia/amra]\npeople: ["[[Sue]]"]\nslack_channels: ["#amra"]\n---\n# Amra\n\n## To do\n\n- [ ] Budget\n\n## Needs Leo\n\n- Approve the Slack connector\n',
  );
  await writeFile(join(cfg.memory, "Projects/Old.md"), "---\nstatus: archived\n---\n# Old\n\n## Needs Leo\n\n- stale ask\n");
  await writeFile(join(cfg.memory, "Projects/_template.md"), "---\nstatus: active\n---\n# {{name}}\n");
  await writeFile(join(cfg.memory, "Log/2026-10-12.md"), "# 2026-10-12\n\n- 09:12 ephemeral: Weather in Southampton\n  - detail\n");
  return cfg;
}

test("briefing holds Me, active projects, Needs Leo, today's runs and the live snapshot", async () => {
  const cfg = await vault();
  const b = await buildBriefing(cfg, SNAP);
  expect(b).toContain("Generated 2026-10-12 14:05 (Europe/London)");
  expect(b).toContain("## Me\n\nLeo. Prefers short answers.");
  expect(b).toContain("### Amra (active)\nrepos: Leo0Garcia/amra; people: [[Sue]]; slack: #amra\nTo do: Budget");
  expect(b).toContain("## Needs Leo\n\n- Amra: Approve the Slack connector\n");
  expect(b).not.toContain("Old");
  expect(b).not.toContain("{{name}}");
  expect(b).toContain("- 09:12 ephemeral: Weather in Southampton");
  expect(b).not.toContain("  - detail");
  expect(b).toContain("- Timetable today: 14:00-16:00 COMP2207 Lab");
  expect(b).not.toContain("Librarian problems");
});

test("an empty vault still yields a usable briefing, and size is capped", async () => {
  const cfg = await tempConfig();
  const b = await buildBriefing(cfg, SNAP);
  expect(b).toContain("Me.md is missing from the vault.");
  expect(b).toContain("None registered yet.");
  expect(b).toContain("Nothing open.");

  const big = await vault();
  for (let i = 0; i < 200; i++) {
    await writeFile(join(big.memory, `Projects/P${i}.md`), `---\nstatus: active\n---\n# P${i}\n\n## Needs Leo\n\n- ${"long ask ".repeat(20)}\n`);
  }
  const capped = await buildBriefing(big, SNAP);
  expect(capped.length).toBeLessThanOrEqual(MAX_BRIEFING + 40);
  expect(capped).toContain("[briefing truncated]");
});
