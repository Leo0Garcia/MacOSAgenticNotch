// Reminders that fire with no run active: one launchd agent per reminder,
// com.jarvis.reminder.<id>, removed after it fires (DESIGN 2, 6 and 8.3).
// The bridge has already turned Leo's words into an instant; this file only
// schedules it, and hands the firing back to the bridge for the notch.
//
// The agent runs at load and at its calendar minute. `fire` does nothing
// until the reminder is due, so a Mac that was off at the time still fires
// it (late) at next login instead of dropping it.

import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { childEnv, type Config, paths } from "../config";
import { log, writeFileAtomic } from "../store";

export interface Reminder {
  id: string;
  text: string;
  at: string; // ISO 8601 UTC, rounded up to the minute
  sessionId: string | null;
  createdAt: string;
}

export type Exec = (cmd: string[]) => { code: number; stdout: string; stderr: string };

export const realExec: Exec = (cmd) => {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
};

const ID = /^[0-9a-f]{10}$/;
const label = (id: string) => `com.jarvis.reminder.${id}`;
const recordPath = (c: Config, id: string) => join(paths(c).reminders, `${id}.json`);
const stagedPlist = (c: Config, id: string) => join(paths(c).reminders, `${label(id)}.plist`);
const installedPlist = (c: Config, id: string) => join(c.launchAgentsDir, `${label(id)}.plist`);
const domain = () => `gui/${process.getuid?.() ?? 501}`;

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** launchd fires StartCalendarInterval in the Mac's local time, so use local fields. */
export function plist(c: Config, r: Reminder): string {
  const p = paths(c);
  const t = new Date(r.at);
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
\t\t<string>${xml(p.remindersCli)}</string>
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

const YEAR_MS = 366 * 864e5;

/** Schedules a reminder at an absolute time (the bridge parsed Leo's words). */
export function addReminder(c: Config, input: { at: string; text: string; sessionId?: string | null }, now = Date.now(), exec: Exec = realExec): Reminder {
  const text = input.text?.trim();
  if (!text) throw new Error("a reminder needs some text");
  let at = Date.parse(input.at);
  if (Number.isNaN(at)) throw new Error(`not a time: ${input.at}`);
  if (at < now - 60_000) throw new Error(`${input.at} is in the past`);
  if (at > now + YEAR_MS) throw new Error(`${input.at} is more than a year away`);
  // launchd has minute resolution: the first whole minute at or after the time, and after now.
  at = Math.max(Math.ceil(at / 6e4) * 6e4, Math.ceil((now + 1) / 6e4) * 6e4);
  const r: Reminder = { id: randomBytes(5).toString("hex"), text, at: new Date(at).toISOString(), sessionId: input.sessionId ?? null, createdAt: new Date(now).toISOString() };
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
  log(c, "reminder added", { id: r.id, at: r.at });
  return r;
}

export function listReminders(c: Config): Reminder[] {
  const dir = paths(c).reminders;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^[0-9a-f]{10}\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Reminder)
    .sort((a, b) => a.at.localeCompare(b.at));
}

function removeFiles(c: Config, id: string): void {
  for (const f of [recordPath(c, id), stagedPlist(c, id), installedPlist(c, id)]) rmSync(f, { force: true });
}

function unload(c: Config, id: string, exec: Exec): void {
  exec([c.launchctl, "bootout", `${domain()}/${label(id)}`]);
}

export function cancelReminder(c: Config, id: string, exec: Exec = realExec): boolean {
  if (!ID.test(id)) throw new Error(`not a reminder id: ${id}`);
  const existed = existsSync(recordPath(c, id));
  removeFiles(c, id);
  unload(c, id, exec);
  return existed;
}

/**
 * Called by launchd. Not yet due: exit quietly (RunAtLoad). Due: hand it to
 * the bridge (`bridge/src/cli.ts reminder`: notch via the socket, else a
 * macOS notification and `say`, plus a `reminder` row), then remove the
 * agent. bootout goes last because it stops this process.
 */
export function fireReminder(c: Config, id: string, now = Date.now(), exec: Exec = realExec): "fired" | "not-due" | "unknown" {
  if (!ID.test(id)) throw new Error(`not a reminder id: ${id}`);
  let r: Reminder;
  try {
    r = JSON.parse(readFileSync(recordPath(c, id), "utf8"));
  } catch {
    // Record gone (cancelled): make sure the agent goes too.
    rmSync(installedPlist(c, id), { force: true });
    unload(c, id, exec);
    return "unknown";
  }
  if (Date.parse(r.at) - now > 30_000) return "not-due";
  const res = exec([c.bunBin, paths(c).bridgeCli, "reminder", "--text", r.text]);
  if (res.code !== 0) {
    // Even the bridge's fallback failed: keep the agent so it tries again at next login.
    log(c, "reminder delivery failed", { id, code: res.code, stderr: res.stderr.slice(-500) });
    throw new Error(`the bridge couldn't deliver reminder ${id}: ${res.stderr.trim().split("\n").pop() || `exit ${res.code}`}`);
  }
  log(c, "reminder fired", { id, late: Math.max(0, now - Date.parse(r.at)) });
  removeFiles(c, id);
  unload(c, id, exec);
  return "fired";
}
