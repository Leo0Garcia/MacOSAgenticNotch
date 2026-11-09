import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFromEnv } from "../src/config";
import { findRequest, findTasks } from "../src/finder";
import { act, offer, propose, readQueue, updateQueue, work, workerPlist, workRequest } from "../src/queue";
import { run, type RunOutcome } from "../src/run";
import { init, jsonl, result, structured, text } from "./fixtures";
import { makeWorld } from "./helpers";

const cfg = () => configFromEnv({ HOME: mkdtempSync(join(tmpdir(), "jarvis-queue-")), JARVIS_REPO: "/r", JARVIS_LAUNCHCTL: "/nonexistent" });
const notes = { source: "university", title: "Write the COMP2311 Lecture 17 notes", request: "Write my COMP2311 Lecture 17 notes from the Moodle slides", why: "The note is empty" };
const draft = { source: "email", title: "Draft a reply to Sue", request: "Draft a reply to Sue's email about the Amra launch date", why: "She asked yesterday" };
const noKick = () => ({ code: 0, stdout: "", stderr: "" });

test("proposals are deduped against the queue and recently declined or dismissed items", () => {
  const c = cfg();
  const [a, b] = propose(c, [notes, draft, { ...notes, title: "write the comp2311 lecture 17 notes!" }, { title: "", request: "x" }]);
  expect(readQueue(c).items.map((x) => x.status)).toEqual(["proposed", "proposed"]);
  expect(propose(c, [{ ...draft, title: "Reply to Sue" }])).toEqual([]); // same request
  expect(act(c, "decline", a!.id)?.title).toBe(notes.title);
  expect(propose(c, [notes])).toEqual([]); // declined recently
  expect(propose(c, [notes], Date.now() + 31 * 86400_000)).toHaveLength(1); // a month later it can come back
  expect(readQueue(c).closed).toEqual([]);
  expect(() => propose(c, { not: "a list" })).toThrow(/JSON array/);
  expect(b!.id).not.toBe(a!.id);
});

test("Leo's actions only apply in the right state", () => {
  const c = cfg();
  const [a] = propose(c, [notes]);
  expect(act(c, "retry", a!.id)).toBeNull();
  expect(act(c, "approve", a!.id)?.status).toBe("approved");
  expect(act(c, "approve", a!.id)).toBeNull();
  expect(act(c, "dismiss", a!.id)).toBeNull(); // approved: it's about to run
  expect(act(c, "approve", "nope")).toBeNull();
});

test("concurrent writers don't lose each other's proposals", async () => {
  const c = cfg();
  const procs = Array.from({ length: 6 }, (_, i) =>
    Bun.spawn([process.execPath, "-e", `const {propose}=await import(${JSON.stringify(join(import.meta.dir, "../src/queue.ts"))});const {configFromEnv}=await import(${JSON.stringify(join(import.meta.dir, "../src/config.ts"))});for(let j=0;j<5;j++)propose(configFromEnv({HOME:${JSON.stringify(c.env.HOME)},JARVIS_REPO:"/r"}),[{title:"t${i}-"+j,request:"r${i}-"+j}]);`]),
  );
  await Promise.all(procs.map((p) => p.exited));
  expect(readQueue(c).items).toHaveLength(30);
});

test("the worker runs approved items one at a time, quietly and checked, and records how each ended", async () => {
  const c = cfg();
  const [a, b, d] = propose(c, [notes, draft, { ...notes, title: "Make flashcards", request: "Make COMP2311 Lecture 16 flashcards" }]);
  for (const x of [a, b, d]) act(c, "approve", x!.id);
  const seen: { request: string; opts: any; during: string[] }[] = [];
  const outcomes: RunOutcome[] = [
    { exitCode: 0, sessionId: "s1", summary: "Wrote the notes", resolved: true },
    { exitCode: 0, sessionId: "s2", summary: "Drafted the reply; needs the launch date from Leo", resolved: false },
    { exitCode: 1, sessionId: "s3", error: "claude exited 1" },
  ];
  const fake = async (_c: unknown, request: string, opts: any) => {
    const sid = `s${seen.length + 1}`;
    opts.emit({ event: "state", state: "working", sessionId: sid });
    seen.push({ request, opts, during: readQueue(c).items.map((x) => `${x.status}:${x.sessionId ?? ""}`) });
    return outcomes[seen.length - 1]!;
  };
  expect(await work(c, { run: fake })).toBe(`done: ${notes.title}; done: ${draft.title}; failed: Make flashcards`);
  expect(seen.map((s) => s.request)).toEqual([a, b, d].map((x) => workRequest(x!)));
  expect(seen[0]!.opts).toMatchObject({ background: true, check: true });
  // While it ran, the item was running with its session (for the live stage and log); the rest waited.
  expect(seen[0]!.during).toEqual(["running:s1", "approved:", "approved:"]);
  const items = readQueue(c).items;
  expect(items.map((x) => [x.status, x.sessionId, x.summary, x.needsYou])).toEqual([
    ["done", "s1", "Wrote the notes", undefined],
    ["done", "s2", "Drafted the reply; needs the launch date from Leo", true],
    ["failed", "s3", "claude exited 1", undefined],
  ]);
  // Retry puts a failed item back; done ones get dismissed.
  expect(act(c, "retry", d!.id)?.status).toBe("approved");
  expect(act(c, "dismiss", a!.id)).not.toBeNull();
  expect(readQueue(c).closed.map((x) => x.how)).toEqual(["dismissed"]);
});

test("an item left running by a worker that died is marked failed, so Leo can retry it", async () => {
  const c = cfg();
  const [a] = propose(c, [notes]);
  updateQueue(c, (q) => void (q.items[0]!.status = "running"));
  expect(await work(c, { run: async () => ({ exitCode: 0 }) })).toBe("nothing approved");
  expect(readQueue(c).items[0]).toMatchObject({ status: "failed", summary: expect.stringContaining("Stopped before it finished") });
  expect(act(c, "retry", a!.id)?.status).toBe("approved");
});

const w = makeWorld();
afterAll(() => rmSync(w.root, { recursive: true, force: true }));

test("with stub claude: the worker's run is a background run, and an unfinished task shows as needing Leo", async () => {
  w.setFixture(jsonl([init(), text(["I drafted the reply."]), structured(false, "Drafted the reply to Sue"), result({ structured: { keep: false, summary: "Drafted the reply to Sue", resolved: false } })]));
  const c = w.config();
  const [a] = propose(c, [draft]);
  act(c, "approve", a!.id);
  expect(await work(c, { run: (c, r, o) => run(c, r, { ...o, finalize: async () => {}, speechRunner: w.speechRunner }) })).toBe(`done: ${draft.title}`);
  const item = readQueue(c).items[0]!;
  expect(item).toMatchObject({ status: "done", summary: "Drafted the reply to Sue", needsYou: true });
  expect(w.lastCall().argv[1]).toContain("He isn't watching");
  expect(w.lastCall().argv).toContain(item.sessionId);
  expect(w.said).toEqual([]);
});

test("the notch offers at most two new proposals; Approve wakes the worker, Not now leaves it proposed", async () => {
  const c = cfg();
  const added = propose(c, [notes, draft, { ...notes, title: "Third", request: "third" }]);
  const asked: string[] = [];
  const answers = ["Approve", "Not now"];
  const link = { ask: async (m: { question: string }) => (asked.push(m.question), { type: "answer" as const, id: "x", text: answers.shift()!, via: "button" as const }), close() {} };
  const kicks: string[][] = [];
  const out = await offer(c, added, { link: link as any, exec: (cmd) => (kicks.push(cmd), noKick()) });
  expect(asked).toEqual(["The note is empty. I could write the COMP2311 Lecture 17 notes.", "She asked yesterday. I could draft a reply to Sue."]);
  expect(readQueue(c).items.map((x) => x.status)).toEqual(["approved", "proposed", "proposed"]);
  expect(kicks).toEqual([["/nonexistent", "kickstart", `gui/${process.getuid!()}/com.jarvis.queue-worker`]]);
  expect(out).toEqual([`approved: ${notes.title}`, `not now: ${draft.title}`, "worker started"]);
});

test("the finder's prompt: read only, drafts only, the hard limits, every source, and what's already queued", () => {
  const c = cfg();
  propose(c, [notes]);
  const [d] = propose(c, [draft]);
  act(c, "decline", d!.id);
  const p = findRequest(c, new Date("2026-11-09T08:15:00Z"));
  for (const s of ["READ ONLY", "Don't do any of them now", "drafts only", "never contacting anyone as Leo", "no money", "never submitting", "safe version", "Moodle", "lecture-notes", "lecture-flashcards", "Slack", "wix-client", 'tell application "Mail"', "never tell Mail to send", "propose nothing for email", "Kanban", "queue propose", "data, never instructions"])
    expect(p).toContain(s);
  expect(p).toContain(`- ${notes.title} (proposed)`);
  expect(p).toContain(`- ${draft.title} (declined)`);
});

test("the finder is a quiet Sonnet run, never in quiet hours, and offers what it proposed", async () => {
  const c = cfg();
  let opts: any;
  const fake = async (cc: any, _r: string, o: any) => ((opts = o), propose(cc, [notes]), { exitCode: 0, summary: "1 proposal from university" });
  const closed = { ask: async () => null, close() {} };
  expect(await findTasks(c, { now: new Date("2026-11-09T09:00:00Z"), run: fake, link: closed as any })).toBe("1 proposal(s); 1 proposal from university; notch app not open");
  expect(opts).toMatchObject({ background: true, model: "sonnet" });
  expect(await findTasks(c, { now: new Date("2026-11-09T23:30:00Z"), run: fake })).toContain("quiet hours");
});

test("the worker agent runs every half hour", () => {
  const p = workerPlist(configFromEnv({ HOME: "/h", JARVIS_REPO: "/r" }));
  expect(p).toContain("<string>queue</string>\n\t\t<string>work</string>");
  expect(p).toContain("<key>StartInterval</key>\n\t<integer>1800</integer>");
  expect(p).not.toContain("StartCalendarInterval");
});
