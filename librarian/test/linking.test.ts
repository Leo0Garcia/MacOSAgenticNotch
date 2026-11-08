import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { processJob, type Deps, type Job } from "../src/queue";
import { fakeRunner, tempConfig } from "./helpers";

test("a run that names a topic by its alias gets that note, and the model's linked fact lands in it", async () => {
  const cfg = await tempConfig();
  await mkdir(join(cfg.memory, "Topics"), { recursive: true });
  await mkdir(join(cfg.memory, "Projects"), { recursive: true });
  await writeFile(join(cfg.memory, "Topics", "Finite Automata.md"), "---\ntype: topic\naliases: [DFA, NFA]\n---\n# Finite Automata\n\n## Notes\n\n- Accept regular languages\n");
  await writeFile(join(cfg.memory, "Projects", "COMP2311 Theory of Computing.md"), "---\ntype: project\naliases: [COMP2311]\n---\n# COMP2311 Theory of Computing\n");
  await writeFile(join(cfg.memory, "Topics", "Turing Machines.md"), "# Turing Machines\n");

  let input = "";
  const deps: Deps = {
    run: fakeRunner({}),
    model: async (_cfg, i) => {
      input = i;
      return { ops: [{ op: "append", path: "Topics/Finite Automata.md", section: "Notes", text: "Minimising a DFA came up in the [[COMP2311 Theory of Computing]] problem sheet" }], log: [] };
    },
  };
  const job: Job = { id: "1", kept: false, summary: "Explained DFA minimisation for COMP2311", endedAt: cfg.now().toISOString(), transcript: "how do I minimise a DFA" };
  expect(await processJob(cfg, job, deps)).toEqual({ ok: true, applied: 1, skipped: 0 });

  expect(input).toContain('<note path="Topics/Finite Automata.md">');
  expect(input).toContain('<note path="Projects/COMP2311 Theory of Computing.md">');
  expect(input).not.toContain('<note path="Topics/Turing Machines.md">');
  expect(input).toContain("- Topics/Turing Machines.md"); // still in the catalogue, so the model can link it
  expect(await readFile(join(cfg.memory, "Topics", "Finite Automata.md"), "utf8")).toContain(
    "- Accept regular languages\n- Minimising a DFA came up in the [[COMP2311 Theory of Computing]] problem sheet",
  );
});
