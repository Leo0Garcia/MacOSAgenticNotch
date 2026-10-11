// The one place the bridge runs external programs (say, osascript, the
// launcher's reminder scheduler). Tests pass a stub instead.

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (cmd: string[], opts?: { stdin?: string }) => Promise<RunResult>;

export const runCommand: Runner = async (cmd, opts = {}) => {
  let proc;
  try {
    proc = Bun.spawn(cmd, {
      stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    // ENOENT and friends: report like a failed command so callers can say what's missing.
    return { code: 127, stdout: "", stderr: `${cmd[0]}: ${(e as Error).message}` };
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

export function lastLine(s: string): string {
  return s.trim().split("\n").pop()?.trim() ?? "";
}
