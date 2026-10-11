import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, posix, resolve, sep } from "node:path";

/** Write via a temp file in the same folder and rename, so readers never see half a file. */
export async function atomicWrite(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Notes the librarian must never write: the script owns them, or they are templates. */
const SCRIPT_OWNED = new Set(["Index.md", "Projects/_template.md", "People/_template.md"]);

export class VaultPathError extends Error {}

/**
 * Turns a model-supplied relative note path into an absolute path inside the vault,
 * or throws. Rejects absolute paths, `..`, hidden segments, non-.md files, script-owned
 * notes, symlinked files, and any parent that resolves outside the vault.
 */
export async function resolveNotePath(vault: string, rel: string): Promise<{ abs: string; rel: string }> {
  if (typeof rel !== "string" || rel.length === 0 || rel.length > 200) throw new VaultPathError(`bad path ${JSON.stringify(rel)}`);
  if (rel.includes("\0") || rel.includes("\\")) throw new VaultPathError(`bad characters in ${JSON.stringify(rel)}`);
  if (rel.startsWith("/") || rel.startsWith("~")) throw new VaultPathError(`${rel} is not relative to the vault`);
  const norm = posix.normalize(rel);
  const segments = norm.split("/");
  if (segments.some((s) => s === ".." || s === "" || s.startsWith("."))) {
    throw new VaultPathError(`${rel} leaves the vault or names a hidden file`);
  }
  if (!norm.endsWith(".md")) throw new VaultPathError(`${rel} is not a .md note`);
  if (SCRIPT_OWNED.has(norm)) throw new VaultPathError(`${norm} is maintained by the librarian script`);
  if (norm.startsWith("Log/")) throw new VaultPathError(`${norm}: the log is appended by the librarian script`);

  const vaultReal = await realpath(vault);
  const abs = join(vaultReal, ...segments);

  // Deepest existing ancestor must resolve inside the vault (no symlinked folders out).
  let probe = dirname(abs);
  while (true) {
    try {
      const real = await realpath(probe);
      if (real !== vaultReal && !real.startsWith(vaultReal + sep)) {
        throw new VaultPathError(`${norm} resolves outside the vault`);
      }
      break;
    } catch (err) {
      if (err instanceof VaultPathError) throw err;
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const up = dirname(probe);
      if (up === probe) throw new VaultPathError(`${norm}: vault missing`);
      probe = up;
    }
  }
  try {
    const st = await lstat(abs);
    if (st.isSymbolicLink()) throw new VaultPathError(`${norm} is a symlink`);
    if (!st.isFile()) throw new VaultPathError(`${norm} is not a file`);
  } catch (err) {
    if (err instanceof VaultPathError) throw err;
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return { abs, rel: norm };
}

export function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p + sep);
}
