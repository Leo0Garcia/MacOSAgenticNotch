// Daily launchd agents the launcher installs: the Moodle watch (08:30), the
// morning check (08:00) and the midnight wrap-up prompt (00:00). launchd runs
// a missed time at the next wake, so each job checks the clock itself.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Config, paths } from "./config";
import { type Exec, realExec } from "./reminders/scheduler";
import { writeFileAtomic } from "./store";

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A launchd agent that runs `run.sh <args>` every day at hour:minute. */
export function dailyPlist(c: Config, label: string, args: string[], hour: number, minute: number, logName: string): string {
  const log = xml(join(paths(c).logs, logName));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${label}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/bin/sh</string>
\t\t<string>${xml(join(c.repo, "launcher", "run.sh"))}</string>
${args.map((a) => `\t\t<string>${xml(a)}</string>`).join("\n")}
\t</array>
\t<key>StartCalendarInterval</key>
\t<dict>
\t\t<key>Hour</key>
\t\t<integer>${hour}</integer>
\t\t<key>Minute</key>
\t\t<integer>${minute}</integer>
\t</dict>
\t<key>StandardOutPath</key>
\t<string>${log}</string>
\t<key>StandardErrorPath</key>
\t<string>${log}</string>
</dict>
</plist>
`;
}

/** Writes (or refreshes) an agent in ~/Library/LaunchAgents and loads it. */
export function installDaily(c: Config, label: string, plist: string, exec: Exec = realExec): void {
  const dest = join(c.launchAgentsDir, `${label}.plist`);
  mkdirSync(c.launchAgentsDir, { recursive: true });
  mkdirSync(paths(c).logs, { recursive: true });
  writeFileAtomic(dest, plist);
  const domain = `gui/${process.getuid?.() ?? 501}`;
  exec([c.launchctl, "bootout", `${domain}/${label}`]);
  const r = exec([c.launchctl, "bootstrap", domain, dest]);
  if (r.code !== 0) throw new Error(`launchctl bootstrap failed (${r.code}): ${r.stderr.trim()}`);
}

/** The hour in London, 0-23. */
export const londonHour = (d: Date) => Number(d.toLocaleTimeString("en-GB", { hour: "2-digit", hour12: false, timeZone: "Europe/London" })) % 24;
