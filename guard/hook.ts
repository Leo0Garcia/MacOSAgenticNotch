#!/usr/bin/env bun
// Jarvis guard PreToolUse hook. Reads one hook input on stdin and either
// prints nothing (no decision: the normal permission flow continues) or
// prints a deny decision whose reason names the rule and the safe version.
// Any internal failure denies the call: the guard fails closed.

import { contextFromEnv } from "./src/context";
import { decide, type HookInput } from "./src/decide";
import { loadBlocklist } from "./src/domains";
import { formatReason, type Denial } from "./src/rules";

function emitDeny(d: Denial): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: formatReason(d),
      },
    }) + "\n",
  );
}

export async function main(stdin: string, env = process.env): Promise<number> {
  try {
    const input = JSON.parse(stdin) as HookInput;
    if (typeof input?.tool_name !== "string") throw new Error("hook input has no tool_name");
    const d = decide(input, contextFromEnv(env), loadBlocklist());
    if (d) emitDeny(d);
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    emitDeny({ rule: "no-harm", reason: `the guard couldn't check this call (${msg.slice(0, 200)}), so it is blocked` });
    process.stderr.write(`jarvis guard error: ${msg}\n`);
    return 0;
  }
}

if (import.meta.main) {
  const stdin = await Bun.stdin.text();
  process.exit(await main(stdin));
}
