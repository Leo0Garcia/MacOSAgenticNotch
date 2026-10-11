#!/usr/bin/env bun
// jarvis launcher CLI. Use run.sh, which sets PATH and JARVIS_REPO.
//
//   run "<request>"                  one Jarvis run; NDJSON events on stdout
//   open <session-id>                open a saved run in Claude Desktop's Code tab
//   finalize --session <id> --keep <bool> --run-log <path>   (started by run)
//   remind add --when "<when>" --text "<text>"   prints the reminder as JSON
//   remind list | remind cancel <id> | remind fire <id> (launchd)

import { configFromEnv } from "./config";
import { finalize } from "./finalize";
import { addReminder, cancelReminder, fireReminder, listReminders } from "./reminders/scheduler";
import { WhenError } from "./reminders/when";
import { run } from "./run";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function usage(): never {
  process.stderr.write(
    'usage: run.sh run "<request>" | open <session-id> | remind add --when <when> --text <text> | remind list | remind cancel <id>\n',
  );
  process.exit(64);
}

export async function main(argv: string[]): Promise<number> {
  const c = configFromEnv();
  const [cmd, ...args] = argv;
  switch (cmd) {
    case "run": {
      const request = args.length ? args.join(" ") : await Bun.stdin.text();
      return (await run(c, request)).exitCode;
    }
    case "open": {
      const id = args[0];
      if (!id || !/^[0-9a-f-]{36}$/i.test(id)) usage();
      // DESIGN 4.1: the documented way to open a CLI session in the Code tab.
      const p = Bun.spawn([c.claudeBin, "--desktop", "--resume", id], { cwd: c.home, stdio: ["ignore", "inherit", "inherit"] });
      return await p.exited;
    }
    case "finalize": {
      const id = flag(args, "--session");
      const keep = flag(args, "--keep");
      const runLog = flag(args, "--run-log");
      if (!id || (keep !== "true" && keep !== "false") || !runLog) usage();
      await finalize(c, id, keep === "true", runLog);
      return 0;
    }
    case "remind": {
      const [sub, ...rest] = args;
      try {
        if (sub === "add") {
          const when = flag(rest, "--when");
          const text = flag(rest, "--text");
          if (!when || !text) usage();
          console.log(JSON.stringify(addReminder(c, when, text)));
          return 0;
        }
        if (sub === "list") {
          console.log(JSON.stringify(listReminders(c)));
          return 0;
        }
        if (sub === "cancel" && rest[0]) {
          console.log(JSON.stringify({ cancelled: cancelReminder(c, rest[0]) }));
          return 0;
        }
        if (sub === "fire" && rest[0]) {
          console.log(fireReminder(c, rest[0]));
          return 0;
        }
      } catch (e) {
        // The bridge relays this to Claude, which asks Leo to rephrase.
        console.log(JSON.stringify({ error: (e as Error).message, kind: e instanceof WhenError ? "when" : "other" }));
        return 1;
      }
      usage();
    }
    default:
      usage();
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
