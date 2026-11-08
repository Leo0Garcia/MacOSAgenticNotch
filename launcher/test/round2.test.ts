import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionRow } from "../../bridge/src/protocol";
import type { Runner } from "../../bridge/src/system";
import { checkAuth, lastAuth, probeArgs, saveAuth } from "../src/auth";
import { configFromEnv } from "../src/config";
import { dailyPlist } from "../src/daily";
import { parseInstant } from "../src/instant";
import { morningCheck, wrapupPrompt } from "../src/schedules";
import { addNote, baseline, jarvisDay, snapshotKanban, wrapUp } from "../src/wrapup";

const cfg = () => {
  const c = configFromEnv({ HOME: mkdtempSync(join(tmpdir(), "jarvis-r2-")), JARVIS_REPO: "/r", JARVIS_CLAUDE_BIN: "claude" });
  mkdirSync(join(c.home, "state"), { recursive: true });
  return c;
};
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });

test("notes and the wrap-up are instant commands", () => {
  expect(parseInstant("note that the essay needs a conclusion")).toEqual({ kind: "note", text: "The essay needs a conclusion" });
  expect(parseInstant("Jarvis, make a note: buy chalk")).toEqual({ kind: "note", text: "Buy chalk" });
  expect(parseInstant("jot down call the landlord about the boiler")).toEqual({ kind: "note", text: "Call the landlord about the boiler" });
  expect(parseInstant("note that it's due on Friday")).toEqual({ kind: "note", text: "It's due on Friday" });
  // "this" is the clipboard: Claude handles it.
  for (const r of ["make a note of this", "note that down", "note this"]) expect(parseInstant(r)).toBeNull();
  for (const r of ["wrap up my day", "Wrap up the day please", "evening wrap-up", "how did today go?", "what did I get done today", "give me my wrap up"]) expect(parseInstant(r)).toEqual({ kind: "wrapup" });
});

test("notes go to the master vault's Inbox.md, created when missing", () => {
  const vault = mkdtempSync(join(tmpdir(), "vault-"));
  addNote(vault, "Buy chalk", new Date("2026-10-22T15:40:00Z"));
  addNote(vault, "Call home", new Date("2026-10-22T18:05:00Z"));
  expect(readFileSync(join(vault, "Inbox.md"), "utf8")).toBe("# Inbox\n\nQuick notes from Jarvis.\n\n- Buy chalk (22 Oct 16:40)\n- Call home (22 Oct 19:05)\n");
});

test("a day runs 5am to 5am, so just after midnight is still the day before", () => {
  expect(jarvisDay(new Date("2026-10-22T23:10:00Z"))).toBe("2026-10-22"); // 00:10 London
  expect(jarvisDay(new Date("2026-10-23T03:30:00Z"))).toBe("2026-10-22"); // 04:30
  expect(jarvisDay(new Date("2026-10-23T04:30:00Z"))).toBe("2026-10-23"); // 05:30
});

test("the Kanban snapshot is the day's first look and isn't overwritten", () => {
  const c = cfg();
  const morning = new Date("2026-10-22T07:00:00Z");
  snapshotKanban(c, { done: [], todo: ["A", "B"] }, morning);
  snapshotKanban(c, { done: ["A"], todo: ["B"] }, new Date("2026-10-22T15:00:00Z"));
  expect(baseline(c, "2026-10-22")).toEqual({ done: [], todo: ["A", "B"] });
  expect(baseline(c, "2026-10-24")).toEqual({ done: [], todo: ["A", "B"] }); // the closest earlier day
  expect(baseline(c, "2026-10-21")).toBeNull();
});

const row = (summary: string, kind: ActionRow["kind"] = "run", saved = false): ActionRow => ({ id: 1, ts: "2026-10-22T12:00:00Z", session_id: null, kind, summary, detail: null, saved });

test("the wrap-up says what got done, what moved on the Kanban and what's first tomorrow", () => {
  const text = wrapUp({
    now: new Date("2026-10-22T23:05:00Z"),
    day: "2026-10-22",
    actions: [row("Told Leo the Southampton weather"), row("Researched solid-state batteries", "run", true), row("Gave Leo the rundown of his day", "action"), row("Added \"buy chalk\" to Kanban", "action"), row("Volume: 40%", "action")],
    start: { done: [], todo: ["[[COMP2311 - Tutorial 2|Theory tutorial]] @{2026-10-22}", "Washing"] },
    board: { done: ["[[COMP2311 - Tutorial 2|Theory tutorial]] @{2026-10-22}"], todo: ["Washing", "Buy chalk"] },
    tomorrow: [{ title: "COMP2312 L1 - Programming III", start: "2026-10-23T08:00:00Z" }],
    deadlines: [{ title: "Group report", course: "COMP2211", due: "2026-10-24T15:00:00Z" }, { title: "Later", course: null, due: "2026-11-20T15:00:00Z" }],
  });
  expect(text).toBe(
    "You had me on 3 things today, mainly: researched solid-state batteries, told you the Southampton weather and added \"buy chalk\" to Kanban. On the Kanban, you finished Theory tutorial, and one card was added. Tomorrow starts with Programming III at 09:00. Due soon on Moodle: Group report, Saturday at 16:00.",
  );
});

test("a quiet day with no snapshot still wraps up", () => {
  const text = wrapUp({ now: new Date("2026-10-22T21:00:00Z"), day: "2026-10-22", actions: [], board: { done: [], todo: ["A", "B"] }, start: null, tomorrow: [], deadlines: [] });
  expect(text).toBe("Quiet day: you didn't need me for much. 2 cards left on the Kanban. Nothing on your calendar tomorrow.");
});

test("sign-in check: signed in, signed out in auth status, and expired behind a 'signed in' status", async () => {
  const c = cfg();
  const calls: string[][] = [];
  const stub = (status: number, probe: { code: number; out: object }): Runner => async (cmd) => {
    calls.push(cmd);
    if (cmd[1] === "auth") return { code: status, stdout: "{}", stderr: "" };
    return { code: probe.code, stdout: JSON.stringify(probe.out), stderr: "" };
  };
  expect(await checkAuth(c, stub(0, { code: 0, out: { is_error: false, result: "OK" } }))).toMatchObject({ ok: true });
  expect(calls[1]).toEqual(probeArgs(c));
  expect(calls[1]).toContain("--no-session-persistence");
  expect(await checkAuth(c, stub(1, { code: 0, out: {} }))).toMatchObject({ ok: false, problem: "signed-out" });
  const expired = await checkAuth(c, stub(0, { code: 1, out: { is_error: true, result: "Failed to authenticate: OAuth session expired and could not be refreshed" } }));
  expect(expired).toMatchObject({ ok: false, problem: "signed-out" });
  // A usage limit isn't a sign-in problem.
  expect(await checkAuth(c, stub(0, { code: 1, out: { is_error: true, result: "You've hit your session limit" } }))).toMatchObject({ ok: true, problem: "error" });
  saveAuth(c, expired);
  expect(lastAuth(c)?.problem).toBe("signed-out");
  expect(lastAuth(c, new Date(Date.now() + 2 * 86400_000))).toBeNull();
});

test("the morning check notifies when signed out and keeps the Kanban snapshot", async () => {
  const c = cfg();
  const notified: string[] = [];
  const run: Runner = async (cmd) => {
    if (cmd[0] === "osascript") return notified.push(cmd.at(-1)!), ok();
    if (cmd.some((a) => a.endsWith("kanban.ts"))) return ok(JSON.stringify([{ lane: "To do", complete: false, cards: ["A"] }, { lane: "Done", complete: true, cards: ["B"] }]));
    if (cmd[1] === "auth") return { code: 1, stdout: "", stderr: "" };
    return ok();
  };
  const now = new Date("2026-10-22T07:00:00Z");
  expect(await morningCheck(c, run, now)).toBe("sign-in SIGNED OUT; kanban snapshot kept");
  expect(notified[0]).toContain("type /login");
  expect(baseline(c, "2026-10-22")).toEqual({ done: ["B"], todo: ["A"] });
});

test("the midnight prompt asks in the notch and starts the wrap-up on a yes", async () => {
  const c = cfg();
  const midnight = new Date("2026-10-22T23:00:00Z"); // 00:00 London
  const opened: string[][] = [];
  const run: Runner = async (cmd) => (opened.push(cmd), ok());
  const link = (text: string | null | "timeout") => ({
    asked: [] as string[],
    async ask(m: { question: string }) {
      this.asked.push(m.question);
      return text === null || text === "timeout" ? text : { type: "answer" as const, id: "x", text, via: "voice" as const };
    },
    close() {},
  });
  const yes = link("yeah go on");
  expect(await wrapupPrompt(c, { now: midnight, link: yes, run })).toBe("wrap-up started");
  expect(yes.asked).toEqual(["It's midnight. Want your wrap-up for today?"]);
  expect(opened).toEqual([["open", "jarvis://ask?q=wrap%20up%20my%20day"]]);
  expect(await wrapupPrompt(c, { now: midnight, link: link("Not tonight"), run })).toBe("declined (voice)");
  expect(await wrapupPrompt(c, { now: midnight, link: link(null), run })).toBe("skipped: the notch app isn't open");
  // launchd runs a missed job at the next wake: not at 8am.
  expect(await wrapupPrompt(c, { now: new Date("2026-10-23T07:00:00Z"), link: link("yes"), run })).toBe("skipped: it's 8:00, not midnight");
  expect(opened).toHaveLength(1);
});

test("daily agents run run.sh with their command at the set time", () => {
  const c = cfg();
  const p = dailyPlist(c, "com.jarvis.wrapup-prompt", ["wrapup-prompt"], 0, 0, "wrapup-prompt.log");
  expect(p).toContain("<string>/r/launcher/run.sh</string>\n\t\t<string>wrapup-prompt</string>");
  expect(p).toContain("<key>Hour</key>\n\t\t<integer>0</integer>");
});
