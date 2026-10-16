#!/usr/bin/env bun
// jarvis launcher CLI. Use run.sh, which sets PATH and JARVIS_REPO.
//
//   run "<request>"     one Jarvis run (request on stdin if no argument); NDJSON events on stdout
//   open <session-id>   open a saved run in Claude Desktop's Code tab
//   moodle-watch        the daily read-only Moodle deadline check (launchd runs it)
//   moodle-watch save   deadlines JSON on stdin -> state/deadlines.json and reminders
//   moodle-watch install | login-needed
//   warm                start claude now, print {"event":"ready"}, then read the
//                       request as one line on stdin (the notch app keeps one ready)
//
// Reminders have their own entry point, src/reminders.ts, which the bridge calls.

import { configFromEnv } from "./config";
import { osNotify } from "../../bridge/src/notch";
import { runCommand } from "../../bridge/src/system";
import { installWatch, saveDeadlines, WATCH_REQUEST } from "./moodle-watch";
import { run } from "./run";

function usage(): never {
  process.stderr.write('usage: run.sh run "<request>" | open <session-id>\n');
  process.exit(64);
}

export function desktopOpenCommand(claudeBin: string, sessionId: string): string[] {
  return ["/usr/bin/script", "-q", "/dev/null", claudeBin, "--desktop", "--resume", sessionId];
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
      // Stopped before a request (app quit, refresh): clean up like an empty request.
      let stop: (v: null) => void = () => {};
      const stopped = new Promise<null>((r) => (stop = r));
      for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => stop(null));
      return (await run(c, "", {
        awaitRequest: async () => {
          const next = lines.next().then(({ value, done }) => (done ? null : String(value)));
          return Promise.race([next, stopped]);
        },
      })).exitCode;
    }
    case "moodle-watch": {
      if (args[0] === "save") {
        console.log(saveDeadlines(c, JSON.parse(await Bun.stdin.text())));
        return 0;
      }
      if (args[0] === "install") {
        installWatch(c);
        console.log("Moodle deadline check installed: daily at 08:30");
        return 0;
      }
      if (args[0] === "login-needed") {
        await osNotify(runCommand, "Jarvis", "I couldn't check your Moodle deadlines: you're signed out of Moodle in Chrome.");
        return 0;
      }
      return (await run(c, WATCH_REQUEST, { background: true, emit: (e) => e.event === "done" && console.log(`${new Date().toISOString()} ${e.summary}`) })).exitCode;
    }
    case "open": {
      const id = args[0];
      if (!id || !/^[0-9a-f-]{36}$/i.test(id)) usage();
      // DESIGN 4.1: the documented way to open a CLI session in the Code tab.
      // `claude --desktop` refuses to run without a terminal ("can't run
      // non-interactively"), and the notch app has none: `script` gives it a pty.
      const p = Bun.spawn(desktopOpenCommand(c.claudeBin, id), { cwd: c.home, stdio: ["ignore", "inherit", "inherit"] });
      return await p.exited;
    }
    default:
      usage();
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
