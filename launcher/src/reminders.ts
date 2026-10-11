#!/usr/bin/env bun
// The reminder scheduler the bridge's remind tool calls (DESIGN 8.3).
//
//   schedule      stdin {"at": "<ISO UTC>", "text": "…", "session_id": "<uuid>"|null}
//                 stdout {"id": "<id>", "at": "<ISO>"}; on failure exit 1, reason on stderr's last line
//   fire <id>     run by the launchd agent
//   list          JSON array of pending reminders
//   cancel <id>   {"cancelled": true|false}

import { configFromEnv } from "./config";
import { addReminder, cancelReminder, fireReminder, listReminders } from "./reminders/scheduler";

export async function main(argv: string[], stdin: () => Promise<string> = () => Bun.stdin.text()): Promise<number> {
  const c = configFromEnv();
  const [cmd, arg] = argv;
  try {
    switch (cmd) {
      case "schedule": {
        let input: { at?: unknown; text?: unknown; session_id?: unknown };
        try {
          input = JSON.parse(await stdin());
        } catch {
          throw new Error("schedule expects JSON on stdin");
        }
        if (typeof input.at !== "string" || typeof input.text !== "string") throw new Error("schedule needs at and text");
        const r = addReminder(c, { at: input.at, text: input.text, sessionId: typeof input.session_id === "string" ? input.session_id : null });
        console.log(JSON.stringify({ id: r.id, at: r.at }));
        return 0;
      }
      case "fire":
        if (!arg) break;
        console.log(fireReminder(c, arg));
        return 0;
      case "list":
        console.log(JSON.stringify(listReminders(c)));
        return 0;
      case "cancel":
        if (!arg) break;
        console.log(JSON.stringify({ cancelled: cancelReminder(c, arg) }));
        return 0;
    }
    console.error("usage: reminders.ts schedule | fire <id> | list | cancel <id>");
    return 64;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
