// Reminders that fire with no run active: one launchd agent per reminder,
// com.jarvis.reminder.<id>, removed after it fires (DESIGN 2 and 6).
//
// The agent runs at load and at its calendar minute. `fire` does nothing
// until the reminder is due, so a Mac that was off at the time still fires
// it (late) at next login instead of dropping it.

import { randomBytes } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { childEnv, type Config, paths } from "../config";
import { log, writeFileAtomic } from "../store";
import { parseWhen } from "./when";

export interface Reminder {
  id: string;
  text: string;
  fireAt: string; // ISO
  when: string; // what Leo said
  createdAt: string;
}

export type Exec = (cmd: string[]) => { code: number; stdout: string; stderr: string };

export const realExec: Exec = (cmd) => {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
};

const label = (id: string) => `com.jarvis.reminder.${id}`;
const recordPath = (c: Config, id: string) => join(paths(c).reminders, `${id}.json`);
const stagedPlist = (c: Config, id: string) => join(paths(c).reminders, `${label(id)}.plist`);
const installedPlist = (c: Config, id: string) => join(c.launchAgentsDir, `${label(id)}.plist`);
const domain = () => `gui/${process.getuid?.() ?? 501}`;

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** launchd fires StartCalendarInterval in the Mac's local time, so use local fields. */
export function plist(c: Config, r: Reminder): string {
  const p = paths(c);
  const t = new Date(r.fireAt);
  const env = childEnv(c);
  const envXml = ["PATH", "HOME", "JARVIS_REPO", "JARVIS_HOME", "JARVIS_MEMORY"]
    .filter((k) => env[k])
    .map((k) => `\t\t<key>${k}</key>\n\t\t<string>${xml(env[k])}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${label(r.id)}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${xml(c.bunBin)}</string>
\t\t<string>${xml(p.cli)}</string>
\t\t<string>remind</string>
\t\t<string>fire</string>
\t\t<string>${r.id}</string>
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
${envXml}
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>StartCalendarInterval</key>
\t<dict>
\t\t<key>Month</key>
\t\t<integer>${t.getMonth() + 1}</integer>
\t\t<key>Day</key>
\t\t<integer>${t.getDate()}</integer>
\t\t<key>Hour</key>
\t\t<integer>${t.getHours()}</integer>
\t\t<key>Minute</key>
\t\t<integer>${t.getMinutes()}</integer>
\t</dict>
\t<key>StandardOutPath</key>
\t<string>${xml(join(p.logs, "reminders.log"))}</string>
\t<key>StandardErrorPath</key>
\t<string>${xml(join(p.logs, "reminders.log"))}</string>
</dict>
</plist>
`;
}

export function addReminder(c: Config, when: string, text: string, now = Date.now(), exec: Exec = realExec): Reminder {
  text = text.trim();
  if (!text) throw new Error("a reminder needs some text");
  let at = parseWhen(when, now, c.timeZone).getTime();
  // launchd has minute resolution: fire in the first whole minute at or after the time.
  at = Math.ceil(at / 6e4) * 6e4;
  const r: Reminder = { id: randomBytes(5).toString("hex"), text, fireAt: new Date(at).toISOString(), when, createdAt: new Date(now).toISOString() };
  const p = paths(c);
  mkdirSync(p.reminders, { recursive: true });
  mkdirSync(p.logs, { recursive: true });
  mkdirSync(c.launchAgentsDir, { recursive: true });
  writeFileAtomic(recordPath(c, r.id), JSON.stringify(r, null, 2));
  writeFileAtomic(stagedPlist(c, r.id), plist(c, r));
  copyFileSync(stagedPlist(c, r.id), installedPlist(c, r.id));
  const res = exec([c.launchctl, "bootstrap", domain(), installedPlist(c, r.id)]);
  if (res.code !== 0) {
    removeFiles(c, r.id);
    throw new Error(`launchctl bootstrap failed (${res.code}): ${res.stderr.trim()}`);
  }
  log(c, "reminder added", { id: r.id, fireAt: r.fireAt });
  return r;
}

export function listReminders(c: Config): Reminder[] {
  const dir = paths(c).reminders;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^[0-9a-f]{10}\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Reminder)
    .sort((a, b) => a.fireAt.localeCompare(b.fireAt));
}

function removeFiles(c: Config, id: string): void {
  for (const f of [recordPath(c, id), stagedPlist(c, id), installedPlist(c, id)]) rmSync(f, { force: true });
}

function unload(c: Config, id: string, exec: Exec): void {
  exec([c.launchctl, "bootout", `${domain()}/${label(id)}`]);
}

export function cancelReminder(c: Config, id: string, exec: Exec = realExec): boolean {
  if (!/^[0-9a-f]{10}$/.test(id)) throw new Error(`not a reminder id: ${id}`);
  const existed = existsSync(recordPath(c, id));
  removeFiles(c, id);
  unload(c, id, exec);
  return existed;
}

const osaString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * Called by launchd. Not yet due: exit quietly. Due: macOS notification,
 * a line in reminders/fired.jsonl for the notch, spoken if TTS is on, then
 * remove the agent. bootout goes last because it stops this process.
 */
export function fireReminder(c: Config, id: string, now = Date.now(), exec: Exec = realExec): "fired" | "not-due" | "unknown" {
  if (!/^[0-9a-f]{10}$/.test(id)) throw new Error(`not a reminder id: ${id}`);
  let r: Reminder;
  try {
    r = JSON.parse(readFileSync(recordPath(c, id), "utf8"));
  } catch {
    // Record gone (cancelled): make sure the agent goes too.
    rmSync(installedPlist(c, id), { force: true });
    unload(c, id, exec);
    return "unknown";
  }
  if (Date.parse(r.fireAt) - now > 30_000) return "not-due";
  exec([c.osascript, "-e", `display notification ${osaString(r.text)} with title "Jarvis" subtitle "Reminder" sound name "default"`]);
  appendFileSync(paths(c).remindersFired, JSON.stringify({ id, text: r.text, fireAt: r.fireAt, firedAt: new Date(now).toISOString() }) + "\n");
  if (c.say) exec([c.say, `Reminder: ${r.text}`]);
  log(c, "reminder fired", { id, late: Math.max(0, now - Date.parse(r.fireAt)) });
  removeFiles(c, id);
  unload(c, id, exec);
  return "fired";
}
