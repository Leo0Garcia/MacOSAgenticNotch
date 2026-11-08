import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backupMemory, brainRequest, installTidy, runBrain, snapshotTree, changedPaths } from "../src/brain";
import { realExec } from "../src/reminders/scheduler";
import { run } from "../src/run";
import { runs } from "./fixtures";
import { makeWorld } from "./helpers";

const w = makeWorld();
afterAll(() => rmSync(w.root, { recursive: true, force: true }));
const master = join(w.root, "Master Vault");
const c = w.config({ JARVIS_MASTER_VAULT: master });
const now = new Date("2026-11-08T22:00:00Z");

mkdirSync(join(c.memory, "Log"), { recursive: true });
writeFileSync(join(c.memory, "Me.md"), "# Me\n");
mkdirSync(join(master, "Uni"), { recursive: true });
mkdirSync(join(master, ".obsidian"), { recursive: true });
writeFileSync(join(master, "Uni", "COMP2311.md"), "# Theory\n");

test("the memory vault is backed up once a day to ~/Jarvis/backups", () => {
  const dest = backupMemory(c, now);
  expect(dest).toBe(join(c.home, "backups", "Jarvis-Memory-2026-11-08.tar.gz"));
  expect(realExec(["tar", "-tzf", dest]).stdout).toContain("Jarvis-Memory/Me.md");
  // A second run the same day keeps the earlier backup rather than overwriting it.
  let ran = false;
  expect(backupMemory(c, now, () => ((ran = true), { code: 0, stdout: "", stderr: "" }))).toBe(dest);
  expect(ran).toBe(false);
  expect(() => backupMemory(c, new Date("2026-11-09T01:00:00Z"), () => ({ code: 2, stdout: "", stderr: "disk full" }))).toThrow(/disk full/);
});

test("snapshots see changed, added and removed notes, but not dot folders", () => {
  const before = snapshotTree(master);
  writeFileSync(join(master, ".obsidian", "workspace.json"), "{}");
  expect(changedPaths(before, snapshotTree(master))).toEqual([]);
  writeFileSync(join(master, "Uni", "COMP2311.md"), "# Theory, edited\n");
  writeFileSync(join(master, "New.md"), "x");
  expect(changedPaths(before, snapshotTree(master))).toEqual(["New.md", "Uni/COMP2311.md"]);
  rmSync(join(master, "New.md"));
});

test("the prompts give both paths and say the master vault is read only", () => {
  for (const job of ["first-pass", "tidy"] as const) {
    const r = brainRequest(c, job);
    expect(r).toContain(`"${c.memory}" (write here only)`);
    expect(r).toContain(`The master vault is "${master}"`);
    expect(r).toContain("THE MASTER VAULT IS READ ONLY FOR THIS JOB");
    expect(r).toContain("keep=false");
    expect(r).toMatch(/Me\.md, Log\/ and Research\/ as they are/);
  }
  const first = brainRequest(c, "first-pass");
  for (const s of ["COMP2311", "Amra Skincare", "Home.md", "Topics/", "skills/calendar/ics.ts\" --days 7 --json", join(c.home, "state", "deadlines.json"), ".trash"]) expect(first).toContain(s);
  expect(brainRequest(c, "tidy")).toContain("Merge duplicate notes");
});

test("a brain run backs up first and notifies loudly if the master vault changed", async () => {
  const notes: string[] = [];
  const notify = async (b: string) => void notes.push(b);
  let request = "";
  const quiet = await runBrain(c, "first-pass", {
    now,
    notify,
    run: async (_c, r) => {
      request = r;
      expect(existsSync(join(c.home, "backups", "Jarvis-Memory-2026-11-08.tar.gz"))).toBe(true);
      return { exitCode: 0, summary: "12 People, 9 Projects, 40 Topics" };
    },
  });
  expect(request).toBe(brainRequest(c, "first-pass"));
  expect(quiet).toStartWith("brain first-pass: 12 People, 9 Projects, 40 Topics; backup ");
  expect(notes).toEqual([]);

  writeFileSync(join(c.memory, "Home.md"), "# Home\n");
  const loud = await runBrain(c, "tidy", {
    now,
    notify,
    run: async () => {
      writeFileSync(join(master, "Uni", "COMP2311.md"), "# Theory, rewritten by the run\n");
      return { exitCode: 1, error: "claude crashed" };
    },
  });
  expect(loud).toContain("FAILED claude crashed");
  expect(loud).toContain("MASTER VAULT CHANGED: Uni/COMP2311.md");
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("Uni/COMP2311.md");
  expect(readFileSync(join(c.home, "logs", "launcher.log"), "utf8")).toContain("MASTER VAULT CHANGED DURING A BRAIN RUN");
});

test("the tidy waits for the first pass", async () => {
  const fresh = w.config({ JARVIS_MASTER_VAULT: master, JARVIS_MEMORY: join(w.root, "empty-memory") });
  expect(await runBrain(fresh, "tidy", { run: async () => { throw new Error("must not run"); } })).toStartWith("skipped");
});

test("the nightly tidy is a launchd agent at 03:30 running `run.sh brain tidy`", () => {
  installTidy(c);
  const plist = readFileSync(join(c.launchAgentsDir, "com.jarvis.brain-tidy.plist"), "utf8");
  expect(plist).toContain(`<string>${join(w.repo, "launcher", "run.sh")}</string>\n\t\t<string>brain</string>\n\t\t<string>tidy</string>`);
  expect(plist).toMatch(/<key>Hour<\/key>\s*<integer>3<\/integer>\s*<key>Minute<\/key>\s*<integer>30<\/integer>/);
  expect(w.read("launchctl.txt")).toContain(`bootstrap gui/${process.getuid!()} ${join(c.launchAgentsDir, "com.jarvis.brain-tidy.plist")}`);
});

test("a background run can pin its model", async () => {
  w.setFixture(runs.weather());
  await run(c, "what's the weather in Southampton", { background: true, model: "sonnet", emit: () => {}, finalize: async () => {}, speechRunner: w.speechRunner });
  const argv: string[] = w.lastCall().argv;
  expect(argv[argv.indexOf("--model") + 1]).toBe("sonnet");
});
