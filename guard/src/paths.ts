// Path resolution and the path allowlist (no-harm) plus master-vault rule.

import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GuardContext } from "./context";

/** Marker the shell parser puts where a $(...) or `...` substitution was. */
export const SUBST = "\u0000SUBST\u0000";

const GLOB = /[*?[\]{}]/;

/**
 * Turn a shell word or tool path into an absolute path.
 * Returns null when the path can't be known statically (unknown variables,
 * command substitutions), so callers can fail closed.
 * Globs are cut back to the deepest directory that contains no glob.
 */
export function resolvePath(word: string, cwd: string | null, ctx: GuardContext): string | null {
  if (!word) return null;
  let p = word;
  if (p.includes(SUBST) || p.includes("`")) return null;
  p = p.replace(/^~(?=\/|$)/, ctx.home);
  p = p.replace(/\$\{?HOME\}?(?![A-Za-z0-9_])/g, ctx.home);
  p = p.replace(/\$\{?TMPDIR\}?(?![A-Za-z0-9_])/g, ctx.tmpDirs[0] ?? "/tmp");
  if (cwd) p = p.replace(/\$\{?PWD\}?(?![A-Za-z0-9_])/g, cwd);
  if (p.includes("$")) return null;
  if (p.startsWith("~")) return null; // ~otheruser
  if (GLOB.test(p)) {
    const parts = p.split("/");
    const idx = parts.findIndex((s) => GLOB.test(s));
    p = parts.slice(0, idx).join("/") || (p.startsWith("/") ? "/" : ".");
  }
  if (!isAbsolute(p)) {
    if (!cwd) return null;
    p = resolve(cwd, p);
  }
  return resolve(p);
}

/** Resolve symlinks on the deepest existing ancestor, so /tmp and /private/tmp agree. */
export function canonical(p: string, ctx: GuardContext): string {
  let cur = p;
  const rest: string[] = [];
  while (!ctx.exists(cur) && dirname(cur) !== cur) {
    rest.unshift(basename(cur));
    cur = dirname(cur);
  }
  const real = ctx.exists(cur) ? ctx.realpath(cur) : cur;
  return rest.length ? join(real, ...rest) : real;
}

export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function isStrictlyInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function roots(ctx: GuardContext, list: string[]): string[] {
  return list.flatMap((r) => [r, canonical(r, ctx)]);
}

function deleteRoots(ctx: GuardContext): string[] {
  return roots(ctx, [ctx.jarvisHome, ctx.repo, ...ctx.tmpDirs]);
}

/** Deleting, truncating or `find -delete` is allowed only strictly inside these. */
export function canDelete(abs: string, ctx: GuardContext): boolean {
  if (isGuardProtected(abs, ctx)) return false;
  const c = canonical(abs, ctx);
  return deleteRoots(ctx).some((r) => isStrictlyInside(abs, r) || isStrictlyInside(c, r));
}

/** Overwriting an existing file is allowed in the delete roots, the memory vault, and Kanban.md. */
export function canOverwrite(abs: string, ctx: GuardContext): boolean {
  if (canDelete(abs, ctx)) return true;
  const c = canonical(abs, ctx);
  if (roots(ctx, [ctx.jarvisMemory]).some((r) => isStrictlyInside(abs, r) || isStrictlyInside(c, r))) return true;
  return isKanbanFile(abs, ctx);
}

export function inMasterVault(abs: string, ctx: GuardContext): boolean {
  const c = canonical(abs, ctx);
  return roots(ctx, [ctx.masterVault]).some((r) => isInside(abs, r) || isInside(c, r));
}

/** Kanban.md at the master vault root, or a temp file next to it used for the atomic rename. */
export function isKanbanFile(abs: string, ctx: GuardContext): boolean {
  if (!inMasterVault(abs, ctx)) return false;
  const vaultRoots = roots(ctx, [ctx.masterVault]);
  const c = canonical(abs, ctx);
  const atRoot = vaultRoots.some((r) => dirname(abs) === r || dirname(c) === r);
  if (!atRoot) return false;
  const name = basename(abs);
  return name === "Kanban.md" || /^\.?Kanban\.md\.[A-Za-z0-9_.-]*tmp[A-Za-z0-9_.-]*$/.test(name);
}

/** A write to the master vault that isn't Kanban.md. */
export function forbiddenVaultWrite(abs: string, ctx: GuardContext): boolean {
  return inMasterVault(abs, ctx) && !isKanbanFile(abs, ctx);
}

/** The guard itself and the settings files that could switch it off. */
export function isGuardProtected(abs: string, ctx: GuardContext): boolean {
  const c = canonical(abs, ctx);
  const guardDirs = roots(ctx, [join(ctx.repo, "guard")]);
  const settingsDirs = roots(ctx, [join(ctx.home, ".claude"), join(ctx.jarvisHome, ".claude"), join(ctx.repo, ".claude")]);
  for (const p of [abs, c]) {
    if (guardDirs.some((g) => isInside(p, g))) return true;
    if (settingsDirs.some((d) => dirname(p) === d && /^settings(\.local)?\.json$/.test(basename(p)))) return true;
    if (p === join(ctx.home, ".claude.json")) return true;
  }
  return false;
}

/** Why a write, overwrite or delete of this path is never allowed, or null. */
export function forbiddenWrite(abs: string, ctx: GuardContext): string | null {
  if (isGuardProtected(abs, ctx)) return `${abs} is part of the guard or the settings that load it, and only Leo changes those`;
  if (forbiddenVaultWrite(abs, ctx)) return `the master vault is read-only except Kanban.md (${abs})`;
  if (isCredentialPath(abs, ctx)) return `${abs} holds credentials`;
  return null;
}

const CREDENTIAL_DIRS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".azure",
  ".config/gh",
  ".config/gcloud",
  ".password-store",
  "Library/Keychains",
  "Library/Cookies",
  "Library/Application Support/1Password",
  "Library/Group Containers/2BUA8C4S2C.com.1password",
  "Library/Application Support/Bitwarden",
];
const CREDENTIAL_FILES = [
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".claude/.credentials.json",
  ".config/hub",
];
const BROWSER_SECRET_FILES = /^(Login Data|Cookies|Web Data|Login Data For Account|key4\.db|logins\.json|cookies\.sqlite)(-journal)?$/;
const SECRET_BASENAME = /^(\.env(\..+)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.+\.(pem|key|p12|pfx|keychain|keychain-db|kdbx))$/;
const SAFE_ENV_EXAMPLE = /^\.env\.(example|sample|template|dist)$/;

/** Credentials, keys, keychains, browser password and cookie stores. */
export function isCredentialPath(abs: string, ctx: GuardContext): boolean {
  const name = basename(abs);
  if (SAFE_ENV_EXAMPLE.test(name)) return false;
  if (SECRET_BASENAME.test(name)) return true;
  if (BROWSER_SECRET_FILES.test(name) && /Library\/Application Support\/(Google\/Chrome|Microsoft Edge|BraveSoftware|Arc|Firefox)/.test(abs)) return true;
  const c = canonical(abs, ctx);
  for (const p of [abs, c]) {
    for (const d of CREDENTIAL_DIRS) if (isInside(p, join(ctx.home, d))) return true;
    for (const f of CREDENTIAL_FILES) if (p === join(ctx.home, f)) return true;
    if (isInside(p, "/Library/Keychains") || p === "/etc/sudoers" || isInside(p, "/etc/sudoers.d")) return true;
    if (p === "/etc/master.passwd" || p === "/private/etc/master.passwd") return true;
  }
  return false;
}

/** Does a shell word look like a path worth checking for credentials? */
export function looksLikePath(word: string): boolean {
  if (!word || word.startsWith("-")) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(word)) return false;
  return word.includes("/") || word.startsWith("~") || word.startsWith(".") || SECRET_BASENAME.test(word);
}

export const pathSep = sep;
