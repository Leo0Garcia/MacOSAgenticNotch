#!/usr/bin/env bun
// Entry point Claude Code spawns over stdio:
//   bun <repo>/bridge/src/server.ts --session-id <uuid>
// stdout carries only JSON-RPC; diagnostics go to stderr.

import { loadConfig } from "./config";
import { McpServer, serveStdio } from "./mcp";
import { NotchLink } from "./notch";
import { Speaker } from "./speech";
import { runCommand } from "./system";
import { buildTools, INSTRUCTIONS } from "./tools";

export const VERSION = "0.1.0";

const config = loadConfig();
const link = new NotchLink({ home: config.home, client: "bridge", sessionId: config.sessionId });
const speaker = new Speaker({ home: config.home, link, sessionId: config.sessionId });
const background = new Set<Promise<unknown>>();

const server = new McpServer(
  { name: "jarvis", version: VERSION, instructions: INSTRUCTIONS },
  buildTools({
    ...config,
    link,
    speaker,
    run: runCommand,
    background: (p) => {
      background.add(p);
      void p.finally(() => background.delete(p));
    },
  }),
  (line) => process.stdout.write(line),
);

// Connect early so the first speak or ask doesn't pay for it; failure just means fallbacks.
void link.connect();

await serveStdio(server);
// Claude closed stdin: finish what's being said, then go.
await Promise.race([Promise.allSettled([...background]).then(() => speaker.idle()), Bun.sleep(30_000)]);
link.close();
process.exit(0);
