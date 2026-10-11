// Stand-in for the claude binary. Never calls a model: it records how it was
// started and replays a stream-json fixture.
//   STUB_FIXTURE  jsonl file to print ({{SID}} is replaced by the session id)
//   STUB_CALLS    file to append {argv, cwd, env} to
//   STUB_VERSION  what --version prints
//   STUB_HANG     keep running after the fixture until killed
//   STUB_EXIT     exit code

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  console.log(`${process.env.STUB_VERSION ?? "2.1.296"} (Claude Code)`);
  process.exit(0);
}
const at = (f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
const sid = at("--session-id") ?? at("--resume") ?? "none";
const env = process.env;
if (env.STUB_CALLS)
  appendFileSync(env.STUB_CALLS, JSON.stringify({ argv, cwd: process.cwd(), mcp: at("--mcp-config") ? JSON.parse(readFileSync(at("--mcp-config")!, "utf8")) : null, env: { JARVIS_REPO: env.JARVIS_REPO, JARVIS_HOME: env.JARVIS_HOME, JARVIS_RUN_SESSION_ID: env.JARVIS_RUN_SESSION_ID, PATH: env.PATH } }) + "\n");

// What Claude Code would leave on disk for this session.
const project = join(env.CLAUDE_CONFIG_DIR!, "projects", "-Users-leogarcia-Jarvis");
mkdirSync(join(project, sid), { recursive: true });
writeFileSync(join(project, `${sid}.jsonl`), "{}\n");
writeFileSync(join(project, sid, "tool-results.txt"), "x");

const lines = readFileSync(env.STUB_FIXTURE!, "utf8").replaceAll("{{SID}}", sid).split("\n").filter(Boolean);
for (const l of lines) {
  process.stdout.write(l + "\n");
  await Bun.sleep(2);
}
if (env.STUB_HANG) await Bun.sleep(30_000);
process.exit(Number(env.STUB_EXIT ?? 0));
