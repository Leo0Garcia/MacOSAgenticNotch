// Atomic, mtime-checked rewrite of a text file: read, transform, write a temp file
// in the same directory, rename. If the file changed underneath us, re-read and
// retry once, then give up so Claude can tell Leo instead of clobbering his edit.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export class ConcurrentEditError extends Error {}

export interface RewriteResult<T> {
  changed: boolean;
  value: T;
}

/** Temp name the guard allows next to Kanban.md: `.<name>.<pid>.tmp`. */
export function tempPathFor(path: string): string {
  return join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
}

export function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = tempPathFor(path);
  writeFileSync(tmp, content);
  try {
    renameSync(tmp, path);
  } catch (e) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw e;
  }
}

function mtime(path: string): number | null {
  return existsSync(path) ? statSync(path).mtimeMs : null;
}

/**
 * transform returns the new content (or null for "no change") plus a value to hand back.
 * `hooks.beforeWrite` exists so tests can simulate a concurrent edit.
 */
export function rewrite<T>(
  path: string,
  transform: (current: string | null) => { content: string | null; value: T },
  hooks: { beforeWrite?: (attempt: number) => void } = {},
): RewriteResult<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = mtime(path);
    const current = before === null ? null : readFileSync(path, "utf8");
    const { content, value } = transform(current);
    if (content === null || content === current) return { changed: false, value };
    hooks.beforeWrite?.(attempt);
    if (mtime(path) !== before) continue;
    writeAtomic(path, content);
    return { changed: true, value };
  }
  throw new ConcurrentEditError(`${basename(path)} changed while I was editing it, twice. I left it alone; try again in a moment.`);
}
