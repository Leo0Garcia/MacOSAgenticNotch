#!/usr/bin/env bun
// jarvis launcher CLI. Use run.sh, which sets PATH and JARVIS_REPO.
//
//   run "<request>"     one Jarvis run (request on stdin if no argument); NDJSON events on stdout
//   open <session-id>   open a saved run in Claude Desktop's Code tab
//   warm                start claude now, print {"event":"ready"}, then read the
//                       request as one line on stdin (the notch app keeps one ready)
//
// Reminders have their own entry point, src/reminders.ts, which the bridge calls.

import { configFromEnv } from "./config";
import { run } from "./run";

function usage(): never {
  process.stderr.write('usage: run.sh run "<request>" | open <session-id>\n');
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
    case "warm": {
      const lines = console[Symbol.asyncIterator]();
      return (await run(c, "", {
        awaitRequest: async () => {
          const { value, done } = await lines.next();
          return done ? null : String(value);
        },
      })).exitCode;
    }
    case "open": {
      const id = args[0];
      if (!id || !/^[0-9a-f-]{36}$/i.test(id)) usage();
      // DESIGN 4.1: the documented way to open a CLI session in the Code tab.
      const p = Bun.spawn([c.claudeBin, "--desktop", "--resume", id], { cwd: c.home, stdio: ["ignore", "inherit", "inherit"] });
      return await p.exited;
    }
    default:
      usage();
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
