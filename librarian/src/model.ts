/**
 * The one model call: `claude -p --model haiku` with no tools, returning note edits as
 * structured output. Flags checked against code.claude.com/docs/en/cli-reference (2026-10-11).
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { librarianDir, type Config } from "./config";
import { OUTPUT_SCHEMA, validateOutput, type ModelOutput } from "./ops";

export const MODEL_TIMEOUT_MS = 180_000;

export function librarianArgs(cfg: Config): string[] {
  return [
    "-p",
    "File this Jarvis run into memory. The run and the relevant notes are on stdin.",
    "--model",
    "haiku",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(OUTPUT_SCHEMA),
    "--system-prompt-file",
    join(cfg.repo, "librarian", "prompt.md"),
    // No tools at all: the model only reads stdin and returns ops; the script writes.
    "--tools",
    "",
    "--strict-mcp-config",
    "--disallowedTools",
    "mcp__*",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--permission-prompts",
    "none",
    "--settings",
    join(cfg.repo, "guard", "settings.json"),
  ];
}

export type ModelCall = (cfg: Config, input: string) => Promise<ModelOutput>;

export const callModel: ModelCall = async (cfg, input) => {
  const cwd = join(librarianDir(cfg), "work");
  await mkdir(cwd, { recursive: true });
  const proc = Bun.spawn([cfg.claudeBin, ...librarianArgs(cfg)], {
    cwd,
    env: { ...process.env, CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1", JARVIS_REPO: cfg.repo },
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, MODEL_TIMEOUT_MS);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  if (timedOut) throw new Error(`claude timed out after ${MODEL_TIMEOUT_MS / 1000}s`);

  let result: Record<string, unknown>;
  try {
    result = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    const why = stderr.trim().split("\n").slice(-1)[0] || `exit ${code}`;
    throw new Error(`claude returned no JSON result (${why.slice(0, 200)})`);
  }
  if (result.is_error || code !== 0) {
    throw new Error(`claude run failed: ${String(result.subtype ?? `exit ${code}`)}`);
  }
  if (result.structured_output === undefined) throw new Error("claude returned no structured_output");
  return validateOutput(result.structured_output);
};
