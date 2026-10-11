// remind(when, text): the bridge reads the time, the launcher's scheduler
// installs the launchd job. Contract in docs/DESIGN.md section 8.3.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { lastLine, type Runner } from "./system";
import { parseWhen, type When } from "./when";

export interface Scheduled extends When {
  id: string;
}

export function schedulerCommand(repo: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env.JARVIS_REMIND_SCHEDULER?.trim();
  if (override) return override.split(/\s+/);
  return ["bun", join(repo, "launcher", "src", "reminders.ts"), "schedule"];
}

export async function scheduleReminder(opts: {
  when: string;
  text: string;
  repo: string;
  sessionId: string | null;
  run: Runner;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}): Promise<Scheduled> {
  const parsed = parseWhen(opts.when, opts.now);
  const cmd = schedulerCommand(opts.repo, opts.env);
  if (cmd[0] === "bun" && cmd[1] && !existsSync(cmd[1])) {
    throw new Error(`The reminder scheduler isn't installed (${cmd[1]} is missing), so no reminder was set.`);
  }
  const r = await opts.run(cmd, {
    stdin: JSON.stringify({ at: parsed.at.toISOString(), text: opts.text, session_id: opts.sessionId }),
  });
  if (r.code !== 0) {
    throw new Error(`The reminder scheduler failed, so no reminder was set: ${lastLine(r.stderr) || `exit ${r.code}`}`);
  }
  let out: { id?: unknown };
  try {
    out = JSON.parse(lastLine(r.stdout));
  } catch {
    throw new Error("The reminder scheduler gave no confirmation, so the reminder may not be set.");
  }
  if (typeof out.id !== "string" || !out.id) {
    throw new Error("The reminder scheduler gave no reminder id, so the reminder may not be set.");
  }
  return { ...parsed, id: out.id };
}
