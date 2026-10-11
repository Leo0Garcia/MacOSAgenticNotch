import { afterAll, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { addReminder, cancelReminder, type Exec, fireReminder, listReminders, plist } from "../src/reminders/scheduler";
import { makeWorld } from "./helpers";

const w = makeWorld();
afterAll(() => rmSync(w.root, { recursive: true, force: true }));
const agents = join(w.root, "LaunchAgents");
const c = w.config({ JARVIS_LAUNCH_AGENTS: agents });
const now = Date.parse("2026-10-11T13:40:20Z");
const uid = process.getuid!();
const bridgeCli = join(c.repo, "bridge", "src", "cli.ts");

function recorder(code = 0, failOn = "bootstrap") {
  const calls: string[][] = [];
  const exec: Exec = (cmd) => {
    calls.push(cmd);
    const fail = cmd.includes(failOn) ? code : 0;
    return { code: fail, stdout: "", stderr: fail ? "something failed: 5" : "" };
  };
  return { calls, exec };
}

test("schedule writes the record and agent, then bootstraps it", () => {
  const { calls, exec } = recorder();
  const r = addReminder(c, { at: "2026-10-11T14:00:20Z", text: "check the oven", sessionId: "s-1" }, now, exec);
  expect(r.id).toMatch(/^[0-9a-f]{10}$/);
  expect(r.at).toBe("2026-10-11T14:01:00.000Z"); // rounded up to the minute
  expect(r.sessionId).toBe("s-1");
  const installed = join(agents, `com.jarvis.reminder.${r.id}.plist`);
  expect(existsSync(installed)).toBe(true);
  expect(existsSync(join(c.home, "reminders", `${r.id}.json`))).toBe(true);
  expect(calls).toEqual([[c.launchctl, "bootstrap", `gui/${uid}`, installed]]);
  expect(listReminders(c).map((x) => x.text)).toContain("check the oven");
});

test("a time in the current minute still lands in a future minute", () => {
  expect(addReminder(c, { at: "2026-10-11T13:40:30Z", text: "soon" }, now, recorder().exec).at).toBe("2026-10-11T13:41:00.000Z");
});

test.each([
  [{ at: "2026-10-11T13:30:00Z", text: "x" }, "is in the past"],
  [{ at: "2028-01-01T00:00:00Z", text: "x" }, "more than a year away"],
  [{ at: "tomorrow", text: "x" }, "not a time"],
  [{ at: "2026-10-11T18:00:00Z", text: "  " }, "needs some text"],
])("refuses %p", (input, msg) => {
  expect(() => addReminder(c, input, now, recorder().exec)).toThrow(msg);
});

test("the agent runs `reminders.ts fire <id>` at load and at the local calendar minute", () => {
  const r = { id: "abcdef0123", text: "a <b> & \"c\"", at: new Date(2026, 9, 11, 18, 5).toISOString(), sessionId: null, createdAt: "" };
  const x = plist(c, r);
  expect(x).toContain("<string>com.jarvis.reminder.abcdef0123</string>");
  expect(x).toContain(`<string>${process.execPath}</string>\n\t\t<string>${join(c.repo, "launcher", "src", "reminders.ts")}</string>\n\t\t<string>fire</string>\n\t\t<string>abcdef0123</string>`);
  expect(x).toMatch(/<key>Month<\/key>\n\t\t<integer>10<\/integer>\n\t\t<key>Day<\/key>\n\t\t<integer>11<\/integer>\n\t\t<key>Hour<\/key>\n\t\t<integer>18<\/integer>\n\t\t<key>Minute<\/key>\n\t\t<integer>5<\/integer>/);
  expect(x).toContain("<key>RunAtLoad</key>\n\t<true/>");
  expect(x).toContain(`<key>JARVIS_REPO</key>\n\t\t<string>${c.repo}</string>`);
});

test("a failed bootstrap leaves nothing behind", () => {
  const before = readdirSync(agents).length;
  expect(() => addReminder(c, { at: "2026-10-11T17:00:00Z", text: "x" }, now, recorder(5).exec)).toThrow("launchctl bootstrap failed (5)");
  expect(readdirSync(agents).length).toBe(before);
});

test("fire before the time does nothing (RunAtLoad), then hands it to the bridge and cleans up", () => {
  const r = addReminder(c, { at: "2026-10-11T17:00:00Z", text: 'call "Mum" back' }, now, recorder().exec);
  const { calls, exec } = recorder();
  expect(fireReminder(c, r.id, now, exec)).toBe("not-due");
  expect(calls).toEqual([]);

  expect(fireReminder(c, r.id, Date.parse(r.at) + 1000, exec)).toBe("fired");
  expect(calls).toEqual([
    [process.execPath, bridgeCli, "reminder", "--text", 'call "Mum" back'],
    [c.launchctl, "bootout", `gui/${uid}/com.jarvis.reminder.${r.id}`],
  ]);
  expect(existsSync(join(agents, `com.jarvis.reminder.${r.id}.plist`))).toBe(false);
  expect(listReminders(c).find((x) => x.id === r.id)).toBeUndefined();
});

test("a late fire (Mac was off) still fires", () => {
  const r = addReminder(c, { at: "2026-10-11T13:45:00Z", text: "late one" }, now, recorder().exec);
  expect(fireReminder(c, r.id, now + 3 * 36e5, recorder().exec)).toBe("fired");
});

test("if the bridge can't deliver, the agent stays to retry at next login", () => {
  const r = addReminder(c, { at: "2026-10-11T13:50:00Z", text: "keep me" }, now, recorder().exec);
  const { calls, exec } = recorder(1, "reminder");
  expect(() => fireReminder(c, r.id, Date.parse(r.at), exec)).toThrow("the bridge couldn't deliver reminder");
  expect(calls.some((x) => x.includes("bootout"))).toBe(false);
  expect(existsSync(join(agents, `com.jarvis.reminder.${r.id}.plist`))).toBe(true);
});

test("cancel removes the agent; firing a cancelled one only unloads it", () => {
  const r = addReminder(c, { at: "2026-10-11T18:00:00Z", text: "cancel me" }, now, recorder().exec);
  const { calls, exec } = recorder();
  expect(cancelReminder(c, r.id, exec)).toBe(true);
  expect(calls).toEqual([[c.launchctl, "bootout", `gui/${uid}/com.jarvis.reminder.${r.id}`]]);
  expect(fireReminder(c, r.id, Date.parse(r.at), recorder().exec)).toBe("unknown");
  expect(() => cancelReminder(c, "../../etc", exec)).toThrow("not a reminder id");
});

async function runCli(env: Record<string, string>, cmd: string[], stdin: string) {
  const p = Bun.spawn(cmd, { env, stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}

test("reminders.ts schedule speaks the bridge's contract (DESIGN 8.3)", async () => {
  const cli = join(import.meta.dir, "..", "src", "reminders.ts");
  const env = { ...w.env, JARVIS_LAUNCH_AGENTS: agents };
  const at = new Date(Date.now() + 20 * 6e4).toISOString();
  const ok = await runCli(env, [process.execPath, cli, "schedule"], JSON.stringify({ at, text: "stretch", session_id: null }));
  expect(ok.code).toBe(0);
  const out = JSON.parse(ok.stdout.trim().split("\n").at(-1)!);
  expect(Object.keys(out).sort()).toEqual(["at", "id"]);
  expect(Date.parse(out.at)).toBeGreaterThanOrEqual(Date.parse(at));
  expect(w.read("launchctl.txt")).toContain("bootstrap gui/");

  const bad = await runCli(env, [process.execPath, cli, "schedule"], JSON.stringify({ at: "2020-01-01T00:00:00Z", text: "x" }));
  expect(bad.code).toBe(1);
  expect(bad.stderr.trim().split("\n").at(-1)).toBe("2020-01-01T00:00:00Z is in the past");
});

test("the bridge's own scheduler call works against this script", async () => {
  // bridge/src/remind.ts is the real caller; point it at the real launcher entry.
  const { scheduleReminder } = await import("../../bridge/src/remind");
  const repo = join(import.meta.dir, "..", "..");
  const env = { ...w.env, JARVIS_LAUNCH_AGENTS: agents };
  const run = (cmd: string[], o?: { stdin?: string }) => runCli(env, cmd[0] === "bun" ? [process.execPath, ...cmd.slice(1)] : cmd, o?.stdin ?? "");
  const s = await scheduleReminder({ when: "in 20 minutes", text: "via bridge", repo, sessionId: null, run, env: {} });
  expect(s.id).toMatch(/^[0-9a-f]{10}$/);
  expect(listReminders(c).find((x) => x.id === s.id)?.text).toBe("via bridge");
});
