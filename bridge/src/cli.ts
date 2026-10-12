#!/usr/bin/env bun
// The bridge without MCP, for the launcher and launchd jobs:
//   bun bridge/src/cli.ts speak <text>
//   bun bridge/src/cli.ts notify --title <t> --body <b>
//   bun bridge/src/cli.ts reminder --text <text>
//   bun bridge/src/cli.ts log --kind run|guard|action|note --summary <s> [--detail <d>] [--saved] [--session-id <id>]
// Exit 0 on success, 1 with a one-line reason on stderr otherwise.

import { appendAction } from "./actions";
import { argValue, loadConfig } from "./config";
import { fireReminder, NotchLink, osNotify } from "./notch";
import { ACTION_KINDS, type ActionKind } from "./protocol";
import { Speaker } from "./speech";
import { runCommand } from "./system";

const [cmd, ...rest] = process.argv.slice(2);
const config = loadConfig(rest);
const need = (flag: string) => {
  const v = argValue(rest, flag);
  if (!v) throw new Error(`${cmd} needs ${flag}`);
  return v;
};

async function main(): Promise<string> {
  switch (cmd) {
    case "speak": {
      const text = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--session-id").join(" ");
      if (!text.trim()) throw new Error("speak needs text");
      const link = new NotchLink({ home: config.home, client: "cli", sessionId: config.sessionId });
      try {
        const speaker = new Speaker({ home: config.home, link, sessionId: config.sessionId });
        await speaker.say(text);
        await speaker.idle(); // give the voice back before exiting
      } finally {
        link.close();
      }
      return "spoken";
    }
    case "notify": {
      const title = need("--title");
      const body = need("--body");
      const link = new NotchLink({ home: config.home, client: "cli", sessionId: config.sessionId });
      try {
        if (await link.send({ type: "notify", id: `n-${process.pid}`, title, body, session_id: config.sessionId })) return "notch";
      } finally {
        link.close();
      }
      await osNotify(runCommand, title, body);
      return "macos";
    }
    case "reminder":
      return fireReminder({ home: config.home, text: need("--text") });
    case "log": {
      const kind = need("--kind") as ActionKind;
      if (!ACTION_KINDS.includes(kind)) throw new Error(`--kind must be one of ${ACTION_KINDS.join(", ")}`);
      const row = appendAction(config.home, {
        kind,
        summary: need("--summary"),
        detail: argValue(rest, "--detail") ?? null,
        sessionId: config.sessionId,
        saved: rest.includes("--saved"),
      });
      const link = new NotchLink({ home: config.home, client: "cli", sessionId: config.sessionId });
      try {
        await link.send({ type: "log", row });
      } finally {
        link.close();
      }
      return JSON.stringify(row);
    }
    default:
      throw new Error(`unknown command ${cmd ?? "(none)"}; use speak, notify, reminder or log`);
  }
}

try {
  console.log(await main());
  process.exit(0);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
