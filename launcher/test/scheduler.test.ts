import { afterAll, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { addReminder, cancelReminder, type Exec, fireReminder, listReminders, plist } from "../src/reminders/scheduler";
import { WhenError } from "../src/reminders/when";
import { makeWorld } from "./helpers";

const w = makeWorld();
afterAll(() => rmSync(w.root, { recursive: true, force: true }));
const agents = join(w.root, "LaunchAgents");
const c = w.config({ JARVIS_LAUNCH_AGENTS: agents });
const now = Date.parse("2026-10-11T13:40:20Z");

function recorder(code = 0) {
  const calls: string[][] = [];
  const exec: Exec = (cmd) => {
    calls.push(cmd);
    return { code: cmd[1] === "bootstrap" ? code : 0, stdout: "", stderr: code ? "Bootstrap failed: 5" : "" };
  };
  return { calls, exec };
}

test("add writes the record and agent, then bootstraps it", () => {
  const { calls, exec } = recorder();
  const r = addReminder(c, "in 20 minutes", "check the oven", now, exec);
  expect(r.id).toMatch(/^[0-9a-f]{10}$/);
  expect(r.fireAt).toBe("2026-10-11T14:01:00.000Z"); // rounded up to the minute
  const installed = join(agents, `com.jarvis.reminder.${r.id}.plist`);
  expect(existsSync(installed)).toBe(true);
  expect(existsSync(join(c.home, "reminders", `${r.id}.json`))).toBe(true);
  expect(calls).toEqual([[c.launchctl, "bootstrap", `gui/${process.getuid!()}`, installed]]);
  expect(listReminders(c).map((x) => x.text)).toContain("check the oven");
});

test("the agent runs `remind fire <id>` at load and at the local calendar minute", () => {
  const r = { id: "abcdef0123", text: "a <b> & \"c\"", fireAt: new Date(2026, 9, 11, 18, 5).toISOString(), when: "6:05pm", createdAt: "" };
  const x = plist(c, r);
  expect(x).toContain("<string>com.jarvis.reminder.abcdef0123</string>");
  expect(x).toContain(`<string>${join(c.repo, "launcher", "src", "cli.ts")}</string>\n\t\t<string>remind</string>\n\t\t<string>fire</string>\n\t\t<string>abcdef0123</string>`);
  expect(x).toMatch(/<key>Month<\/key>\n\t\t<integer>10<\/integer>\n\t\t<key>Day<\/key>\n\t\t<integer>11<\/integer>\n\t\t<key>Hour<\/key>\n\t\t<integer>18<\/integer>\n\t\t<key>Minute<\/key>\n\t\t<integer>5<\/integer>/);
  expect(x).toContain("<key>RunAtLoad</key>\n\t<true/>");
  expect(x).toContain(`<key>JARVIS_REPO</key>\n\t\t<string>${c.repo}</string>`);
});

test("a failed bootstrap leaves nothing behind", () => {
  const before = readdirSync(agents).length;
  expect(() => addReminder(c, "at 6pm", "x", now, recorder(5).exec)).toThrow("launchctl bootstrap failed (5)");
  expect(readdirSync(agents).length).toBe(before);
});

test("an unreadable time is a WhenError for the bridge to relay", () => {
  expect(() => addReminder(c, "whenever", "x", now, recorder().exec)).toThrow(WhenError);
});

test("fire before the time does nothing (RunAtLoad), then fires, notifies and cleans up", () => {
  const r = addReminder(c, "at 6pm", 'call "Mum" back', now, recorder().exec);
  const { calls, exec } = recorder();
  expect(fireReminder(c, r.id, now, exec)).toBe("not-due");
  expect(calls).toEqual([]);

  const at = Date.parse(r.fireAt);
  expect(fireReminder(c, r.id, at + 1000, exec)).toBe("fired");
  expect(calls[0]).toEqual([c.osascript, "-e", 'display notification "call \\"Mum\\" back" with title "Jarvis" subtitle "Reminder" sound name "default"']);
  expect(calls[1]).toEqual([c.say!, 'Reminder: call "Mum" back']);
  expect(calls.at(-1)).toEqual([c.launchctl, "bootout", `gui/${process.getuid!()}/com.jarvis.reminder.${r.id}`]);
  const fired = readFileSync(join(c.home, "reminders", "fired.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(fired.at(-1)).toMatchObject({ id: r.id, text: 'call "Mum" back' });
  expect(existsSync(join(agents, `com.jarvis.reminder.${r.id}.plist`))).toBe(false);
  expect(listReminders(c).find((x) => x.id === r.id)).toBeUndefined();
});

test("a late fire (Mac was off) still fires", () => {
  const r = addReminder(c, "in 5 minutes", "late one", now, recorder().exec);
  expect(fireReminder(c, r.id, now + 3 * 36e5, recorder().exec)).toBe("fired");
});

test("cancel removes the agent; firing a cancelled one only unloads it", () => {
  const r = addReminder(c, "at 7pm", "cancel me", now, recorder().exec);
  const { calls, exec } = recorder();
  expect(cancelReminder(c, r.id, exec)).toBe(true);
  expect(calls).toEqual([[c.launchctl, "bootout", `gui/${process.getuid!()}/com.jarvis.reminder.${r.id}`]]);
  expect(fireReminder(c, r.id, Date.parse(r.fireAt), recorder().exec)).toBe("unknown");
  expect(() => cancelReminder(c, "../../etc", exec)).toThrow("not a reminder id");
});

test("cli: remind add prints the reminder, remind add with a bad time prints the error", async () => {
  const cli = join(import.meta.dir, "..", "src", "cli.ts");
  const env = { ...w.env, JARVIS_LAUNCH_AGENTS: agents };
  const ok = Bun.spawnSync([process.execPath, cli, "remind", "add", "--when", "in 20 minutes", "--text", "stretch"], { env });
  expect(ok.exitCode).toBe(0);
  expect(JSON.parse(ok.stdout.toString())).toMatchObject({ text: "stretch", when: "in 20 minutes" });
  expect(w.read("launchctl.txt")).toContain("bootstrap gui/");
  const bad = Bun.spawnSync([process.execPath, cli, "remind", "add", "--when", "someday", "--text", "x"], { env });
  expect(bad.exitCode).toBe(1);
  expect(JSON.parse(bad.stdout.toString())).toEqual({ error: "can't read someday", kind: "when" });
});
