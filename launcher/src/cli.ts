#!/usr/bin/env bun
// jarvis launcher CLI. Use run.sh, which sets PATH and JARVIS_REPO.
//
//   run "<request>"     one Jarvis run (request on stdin if no argument); NDJSON events on stdout
//   open <session-id>   open a saved run in Claude Desktop's Code tab
//   interrupted         runs cut off by a restart, claimed, as a JSON array (the app resumes each)
//   resume <session-id> carry on a claimed interrupted run; NDJSON events like run
//   moodle-watch        the daily read-only Moodle deadline check (launchd runs it)
//   moodle-watch save   deadlines JSON on stdin -> state/deadlines.json and reminders
//   moodle-watch install | login-needed
//   morning-check       08:00: is Claude still signed in? Also the Kanban's start-of-day snapshot
//   wrapup-prompt       00:00: asks in the notch whether Leo wants his wrap-up
//   kanban-scout        new Kanban cards Jarvis could do: proposes them to the queue
//   queue find          08:15: the daily task finder (background, read only), proposals to the queue
//   queue propose       proposals JSON on stdin [{source, title, request, why}] -> state/queue.json
//   queue approve|decline|dismiss|retry <id>   Leo's actions (the app calls these)
//   queue work          runs approved items one at a time (launchd, and kicked on each approval)
//   brain first-pass    builds the linked second brain in ~/Jarvis-Memory (background, 20-40 min)
//   brain tidy          03:30: merges duplicates, fixes and adds links, refreshes the MOCs
//   schedules install   installs the Moodle watch, morning check, midnight prompt, scout, task finder, queue worker and brain tidy agents
//   warm                start claude now, print {"event":"ready"}, then read the
//                       request as one line on stdin (the notch app keeps one ready)
//
// Reminders have their own entry point, src/reminders.ts, which the bridge calls.

import { join } from "node:path";
import { configFromEnv } from "./config";
import { osNotify } from "../../bridge/src/notch";
import { runCommand } from "../../bridge/src/system";
import { installTidy, masterVault, runBrain } from "./brain";
import { installWatch, saveDeadlines, WATCH_REQUEST } from "./moodle-watch";
import { installMorningCheck, installWrapupPrompt, morningCheck, wrapupPrompt } from "./schedules";
import { run } from "./run";
import { claimInterrupted, resumeRun, takeClaimed } from "./resume";
import { installScout, scout } from "./scout";
import { findTasks, installFinder } from "./finder";
import { act, installWorker, propose, startWorker, work } from "./queue";

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
    case "interrupted":
      console.log(JSON.stringify(claimInterrupted(c)));
      return 0;
    case "resume": {
      const r = args[0] ? takeClaimed(c, args[0]) : undefined;
      if (!r) {
        process.stderr.write(`no claimed interrupted run ${args[0] ?? ""}\n`);
        return 1;
      }
      return (await resumeRun(c, r)).exitCode;
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
    case "morning-check":
      console.log(`${new Date().toISOString()} ${await morningCheck(c)}`);
      return 0;
    case "kanban-scout":
      console.log(`${new Date().toISOString()} ${await scout(c)}`);
      return 0;
    case "wrapup-prompt":
      console.log(`${new Date().toISOString()} ${await wrapupPrompt(c)}`);
      return 0;
    case "queue": {
      const [sub, id] = args;
      if (sub === "find") console.log(`${new Date().toISOString()} ${await findTasks(c)}`);
      else if (sub === "work") console.log(`${new Date().toISOString()} ${await work(c)}`);
      else if (sub === "propose") console.log(`${propose(c, JSON.parse(await Bun.stdin.text())).length} added to the queue`);
      else if ((sub === "approve" || sub === "decline" || sub === "dismiss" || sub === "retry") && id) {
        const item = act(c, sub, id);
        if (!item) {
          process.stderr.write(`can't ${sub} ${id}\n`);
          return 1;
        }
        if (sub === "approve" || sub === "retry") console.log(await startWorker(c));
      } else usage();
      return 0;
    }
    case "brain": {
      if (args[0] !== "first-pass" && args[0] !== "tidy") usage();
      console.log(`${new Date().toISOString()} ${await runBrain(c, args[0])}`);
      return 0;
    }
    case "schedules": {
      if (args[0] !== "install") usage();
      installWatch(c);
      installMorningCheck(c);
      installWrapupPrompt(c);
      installScout(c, join(masterVault(c), "Kanban.md"));
      installTidy(c);
      installFinder(c);
      installWorker(c);
      console.log("Installed: Moodle check 08:30, sign-in check 08:00, wrap-up prompt 00:00, Kanban scout (on board changes), task finder 08:15, queue worker (every 30 min), brain tidy 03:30");
      return 0;
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
