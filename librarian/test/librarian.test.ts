import { describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { callModel } from "../src/model";
import { drain, enqueue, logLine, processJob, retryFailed, type Deps, type Job } from "../src/queue";
import { initVault } from "../src/vault";
import { FIXTURES, REPO, fakeRunner, tempConfig } from "./helpers";

const run = fakeRunner({ "claude agents": { stdout: "[]" }, "lsappinfo front": { stdout: "ASN:1:" }, "lsappinfo info": { stdout: '"LSDisplayName"="Xcode"' } });

async function setup(response: string | null, exit = 0) {
  const cfg = await tempConfig();
  const stub = join(cfg.root, "stub");
  await mkdir(stub);
  process.env.STUB_DIR = stub;
  process.env.STUB_EXIT = String(exit);
  if (response) process.env.STUB_RESPONSE = join(FIXTURES, response);
  else delete process.env.STUB_RESPONSE;
  await initVault(cfg);
  const deps: Deps = { model: callModel, run };
  return { cfg, stub, deps };
}

describe("end to end with a stubbed claude", () => {
  test("enqueue then drain files the run, the log, the index and the briefing", async () => {
    const { cfg, stub, deps } = await setup("register-amra.response.json");
    const jobPath = await enqueue(cfg, {
      streamLog: join(FIXTURES, "register-amra.jsonl"),
      request: "register the Amra project, Slack #amra, people Sue and Ellen",
    });
    const job = JSON.parse(await readFile(jobPath, "utf8")) as Job;
    expect(job.kept).toBe(false);
    expect(job.sessionId).toBe("0b6c1d2e-1111-4222-8333-444455556666");

    expect(await drain(cfg, deps)).toBe(true);

    // The model call: haiku, no tools, no MCP, nothing persisted, guard loaded.
    const argv = (await readFile(join(stub, "argv"), "utf8")).split("\n").slice(0, -1);
    expect(argv[0]).toBe("-p");
    const after = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(after("--model")).toBe("haiku");
    expect(after("--output-format")).toBe("json");
    expect(after("--tools")).toBe("");
    expect(after("--disallowedTools")).toBe("mcp__*");
    expect(after("--permission-prompts")).toBe("none");
    expect(after("--settings")).toBe(join(REPO, "guard", "settings.json"));
    expect(after("--system-prompt-file")).toBe(join(REPO, "librarian", "prompt.md"));
    expect(argv).toContain("--no-session-persistence");
    expect(JSON.parse(after("--json-schema")!).required).toEqual(["ops", "log"]);
    const env = await readFile(join(stub, "env"), "utf8");
    expect(env).toContain("CLAUDE_CODE_SKIP_PROMPT_HISTORY=1");
    expect(env).toContain(`JARVIS_REPO=${REPO}`);
    expect((await readFile(join(stub, "cwd"), "utf8")).trim()).toBe(join(cfg.home, "librarian", "work"));

    // What the model was shown.
    const stdin = await readFile(join(stub, "stdin"), "utf8");
    expect(stdin).toContain("## Request\nregister the Amra project");
    expect(stdin).toContain("<transcript>");
    expect(stdin).toContain('<note path="Me.md">');
    expect(stdin).toContain("- Me.md");

    // Vault edits: allowed ops applied, escapes refused.
    const amra = await readFile(join(cfg.memory, "Projects/Amra.md"), "utf8");
    expect(amra).toContain('people: ["[[Sue]]", "[[Ellen]]"]');
    expect(amra).toContain("## Needs Leo\n\n- Decide whether to post the hello message in #amra yourself\n");
    expect((await readdir(join(cfg.memory, "People"))).sort()).toEqual(["Ellen.md", "Sue.md", "_template.md"]);
    expect(await readdir(cfg.root)).not.toContain("outside.md");

    const log = await readFile(join(cfg.memory, "Log/2026-10-12.md"), "utf8");
    expect(log).toBe(
      "# 2026-10-12\n\n- 14:05 ephemeral: Registered the Amra project (Slack #amra, Sue, Ellen)\n" +
        "  - Registered [[Amra]] with [[Sue]] and [[Ellen]]\n  - Notes: [[Amra]], [[Sue]], [[Ellen]]\n",
    );

    const index = await readFile(join(cfg.memory, "Index.md"), "utf8");
    expect(index).toContain("- [[Projects/Amra|Amra]] (active)");
    expect(index).toContain("- [[People/Sue|Sue]]");
    expect(index).toContain("- [[Log/2026-10-12|2026-10-12]]");
    expect(index).not.toContain("hijack");

    const briefing = await readFile(join(cfg.home, "briefing.md"), "utf8");
    expect(briefing).toContain("- Amra: Decide whether to post the hello message in #amra yourself");
    expect(briefing).toContain("- Apps: frontmost Xcode");
    expect(briefing).toContain("- 14:05 ephemeral: Registered the Amra project");

    expect(await readdir(join(cfg.home, "librarian", "queue"))).toEqual([]);
    const librarianLog = await readFile(join(cfg.home, "logs", "librarian.log"), "utf8");
    expect(librarianLog).toContain("ok applied=6 skipped=2");
    expect(librarianLog).not.toContain("Ignore previous instructions"); // no transcript content in the log
  });

  test("a failed model call keeps the job, logs the run anyway and flags it in the briefing", async () => {
    const { cfg, deps } = await setup(null, 1);
    await enqueue(cfg, { streamLog: join(FIXTURES, "register-amra.jsonl"), keep: true, summary: "Research on X" });
    await drain(cfg, deps);
    expect(await readdir(join(cfg.home, "librarian", "failed"))).toHaveLength(1);
    const log = await readFile(join(cfg.memory, "Log/2026-10-12.md"), "utf8");
    expect(log).toContain("- 14:05 saved: Research on X (session `0b6c1d2e-1111-4222-8333-444455556666`)");
    expect(log).toContain("  - Librarian problem: notes not updated (claude returned no JSON result");
    expect(await readFile(join(cfg.home, "briefing.md"), "utf8")).toContain("1 run(s) couldn't be filed into memory");
  });

  test("retry puts failed jobs back and files them", async () => {
    const { cfg, deps } = await setup(null, 1);
    await enqueue(cfg, { streamLog: join(FIXTURES, "register-amra.jsonl") });
    await drain(cfg, deps);
    process.env.STUB_EXIT = "0";
    process.env.STUB_RESPONSE = join(FIXTURES, "register-amra.response.json");
    expect(await retryFailed(cfg)).toBe(1);
    await drain(cfg, deps);
    expect(await readdir(join(cfg.home, "librarian", "failed"))).toEqual([]);
    expect(await readFile(join(cfg.memory, "Projects/Amra.md"), "utf8")).toContain("# Amra");
  });

  test("a run with no structured output is treated as kept", async () => {
    const { cfg } = await setup(null);
    const log = join(cfg.root, "run.jsonl");
    await writeFile(log, '{"type":"result","subtype":"success","is_error":false,"session_id":"s-1","result":"Here is the research brief."}\n');
    const job = JSON.parse(await readFile(await enqueue(cfg, { streamLog: log }), "utf8")) as Job;
    expect(job.kept).toBe(true);
    expect(job.summary).toBe("Here is the research brief.");
  });

  test("only one librarian works at a time; a live lock holder means wait", async () => {
    const { cfg, deps } = await setup("register-amra.response.json");
    await mkdir(join(cfg.home, "librarian"), { recursive: true });
    await writeFile(join(cfg.home, "librarian", "lock"), String(process.pid)); // held by a live process
    await enqueue(cfg, { streamLog: join(FIXTURES, "register-amra.jsonl") });
    expect(await drain(cfg, deps)).toBe(false);
    expect(await readdir(join(cfg.home, "librarian", "queue"))).toHaveLength(1);

    await writeFile(join(cfg.home, "librarian", "lock"), "999999999"); // holder died
    expect(await drain(cfg, deps)).toBe(true);
    expect(await readdir(join(cfg.home, "librarian", "queue"))).toHaveLength(0);
  });

  test("nothing to file: an empty op list still logs the run", async () => {
    const { cfg } = await setup(null);
    const deps: Deps = { model: async () => ({ ops: [], log: [] }), run };
    const job: Job = { id: "1", kept: false, summary: "Weather in Southampton: 14°C, light rain", endedAt: cfg.now().toISOString(), transcript: "" };
    const r = await processJob(cfg, job, deps);
    expect(r).toEqual({ ok: true, applied: 0, skipped: 0 });
    expect(await readFile(join(cfg.memory, "Log/2026-10-12.md"), "utf8")).toBe(
      "# 2026-10-12\n\n- 14:05 ephemeral: Weather in Southampton: 14°C, light rain\n",
    );
    await logLine(cfg, "x");
  });
});

describe("init-vault", () => {
  test("copies the template once and never overwrites", async () => {
    const cfg = await tempConfig();
    await writeFile(join(cfg.memory, "Me.md"), "# Me\n\nmine\n");
    const created = await initVault(cfg);
    expect(created.sort()).toEqual(["Index.md", "People/_template.md", "Projects/_template.md"]);
    expect(await readFile(join(cfg.memory, "Me.md"), "utf8")).toBe("# Me\n\nmine\n");
    expect(await readdir(join(cfg.memory, "Log"))).toEqual([]);
    expect(await initVault(cfg)).toEqual([]);
  });
});

describe("cli", () => {
  test("enqueue --no-drain prints the job path", async () => {
    const cfg = await tempConfig();
    const proc = Bun.spawn(
      ["bun", join(REPO, "librarian/src/cli.ts"), "enqueue", "--stream-log", join(FIXTURES, "register-amra.jsonl"), "--keep", "true", "--no-drain"],
      { env: { ...process.env, JARVIS_HOME: cfg.home, JARVIS_MEMORY: cfg.memory }, stdout: "pipe" },
    );
    const out = (await new Response(proc.stdout).text()).trim();
    expect(await proc.exited).toBe(0);
    expect(out.startsWith(join(cfg.home, "librarian", "queue"))).toBe(true);
    expect((JSON.parse(await readFile(out, "utf8")) as Job).kept).toBe(true);
  });

  test("bad usage exits 2", async () => {
    const proc = Bun.spawn(["bun", join(REPO, "librarian/src/cli.ts"), "enqueue"], { stderr: "pipe" });
    expect(await proc.exited).toBe(2);
  });
});
