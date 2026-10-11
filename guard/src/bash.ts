// Shell command analysis: every hard limit as it shows up in a Bash command.

import { basename, join } from "node:path";
import type { GuardContext } from "./context";
import { checkText, type DomainEntry } from "./domains";
import {
  canDelete,
  canOverwrite,
  forbiddenVaultWrite,
  inMasterVault,
  forbiddenWrite,
  isCredentialPath,
  isGuardProtected,
  looksLikePath,
  resolvePath,
} from "./paths";
import { deny, type Denial } from "./rules";
import { ParseError, parseShell, programName, unwrap, type SimpleCommand } from "./shell";
import { checkAppleScript } from "./applescript";

export interface ShellEnv {
  ctx: GuardContext;
  domains: DomainEntry[];
  depth: number;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const INTERPRETERS = new Set(["python", "python3", "python2", "node", "bun", "deno", "ruby", "perl", "php", "osascript", "swift"]);

export const MONEY_APPS =
  /\b(revolut|monzo|starling|barclays|hsbc|lloyds|natwest|santander|nationwide|halifax|first direct|wise|paypal|trading ?212|freetrade|etoro|robinhood|coinbase|binance|kraken|ledger live|exodus|electrum|metamask|hargreaves|plum|chip|moneybox|plus500|ig trading|webull|interactive brokers|ibkr|trader workstation)\b/i;

const PRIVACY_DEFAULTS =
  /(security|tcc|\.alf\b|firewall|screensaver|loginwindow|quarantine|gatekeeper|privacy|softwareupdate|commerce|sharingd|airdrop|remotelogin|com\.apple\.assistant\.support|filevault|keychain|spotlight)/i;

const SECURITY_TOOLS = new Set([
  "tccutil",
  "csrutil",
  "spctl",
  "fdesetup",
  "systemsetup",
  "pfctl",
  "socketfilterfw",
  "profiles",
  "nvram",
  "bless",
  "kextload",
  "kextunload",
  "passwd",
  "chpass",
  "ssh-keygen",
  "ssh-add",
  "crontab",
  "authorizationdb",
]);
const ESCALATE = new Set(["sudo", "su", "doas", "pkexec"]);
const DISK_WIPE = new Set(["mkfs", "newfs", "fdisk", "gpt", "shred", "srm", "wipefs"]);
const MAIL_SENDERS = new Set(["mail", "mailx", "sendmail", "msmtp", "mutt", "ssmtp", "swaks"]);
const DELETE_CMDS = new Set(["rm", "unlink", "rmdir", "trash"]);

interface State {
  cwd: string | null;
}

export function checkBash(command: string, cwd: string | null, env: ShellEnv): Denial | null {
  // Any blocked host anywhere in the command text: URLs, bare hosts, heredocs.
  const d = checkText(command, env.domains);
  if (d) return d;
  const scheme = /\b(tel|telprompt|facetime|facetime-audio|sms|imessage|whatsapp|skype|callto):/i.exec(command);
  if (scheme && /\bopen\b|osascript|location/.test(command)) {
    return deny("no-contacting-as-leo", `"${scheme[1]}:" links start a call or message as Leo`);
  }
  let cmds: SimpleCommand[];
  try {
    cmds = parseShell(command);
  } catch (e) {
    if (e instanceof ParseError) return deny("no-harm", e.message);
    throw e;
  }
  const st: State = { cwd };
  for (const c of cmds) {
    const r = checkSimple(c, st, env);
    if (r) return r;
  }
  return null;
}

function res(word: string, st: State, env: ShellEnv): string | null {
  return resolvePath(word, st.cwd, env.ctx);
}

function args(words: string[]): { flags: string[]; operands: string[] } {
  const flags: string[] = [];
  const operands: string[] = [];
  let end = false;
  for (const w of words) {
    if (!end && w === "--") {
      end = true;
      continue;
    }
    if (!end && w.startsWith("-") && w !== "-") flags.push(w);
    else operands.push(w);
  }
  return { flags, operands };
}

function hasFlag(flags: string[], short: string, long?: string): boolean {
  return flags.some(
    (f) => (long && (f === long || f.startsWith(long + "="))) || (/^-[A-Za-z]+$/.test(f) && f.includes(short)),
  );
}

function checkDeleteTargets(prog: string, targets: string[], st: State, env: ShellEnv): Denial | null {
  for (const t of targets) {
    const abs = res(t, st, env);
    if (!abs) return deny("no-harm", `${prog} target "${t}" can't be checked against the allowlist`);
    const why = forbiddenWrite(abs, env.ctx);
    if (why) return deny("no-harm", why);
    if (!canDelete(abs, env.ctx)) {
      return deny("no-harm", `${prog} would delete ${abs}, which isn't inside ~/Jarvis, the Jarvis repo or the temp folder`);
    }
  }
  return null;
}

function checkOverwrite(prog: string, target: string, st: State, env: ShellEnv): Denial | null {
  const abs = res(target, st, env);
  if (!abs) return deny("no-harm", `${prog} target "${target}" can't be checked against the allowlist`);
  if (abs.startsWith("/dev/")) return null;
  const why = forbiddenWrite(abs, env.ctx);
  if (why) return deny("no-harm", why);
  if (env.ctx.exists(abs) && !env.ctx.isDir(abs) && !canOverwrite(abs, env.ctx)) {
    return deny("no-harm", `${prog} would overwrite ${abs}, which isn't inside ~/Jarvis, ~/Jarvis-Memory or the Jarvis repo`);
  }
  return null;
}

function checkVaultWrite(prog: string, target: string, st: State, env: ShellEnv): Denial | null {
  const abs = res(target, st, env);
  if (abs && isGuardProtected(abs, env.ctx)) return deny("no-harm", forbiddenWrite(abs, env.ctx)!);
  if (abs && forbiddenVaultWrite(abs, env.ctx)) {
    return deny("no-harm", `Obsidian's own settings and plugins in the master vault are off limits (${prog} on ${abs})`);
  }
  return null;
}

function checkInlineCode(lang: string, code: string, st: State, env: ShellEnv): Denial | null {
  if (lang === "osascript") return checkAppleScript(code, st.cwd, env);
  if (/\b(smtplib|sendmail|nodemailer|twilio|send_message|sendMessage|chat\.postMessage)\b/.test(code)) {
    return deny("no-contacting-as-leo", `${lang} code that sends mail or messages`);
  }
  const destructive =
    /\b(rmtree|os\.remove|os\.unlink|os\.rmdir|unlinkSync|rmSync|rmdirSync|fs\.rm|fs\.unlink|fs\.promises\.rm|Path\([^)]*\)\.unlink|\.unlink\(|send2trash|FileUtils\.rm|File\.delete|unlink\s|shutil\.move|Bun\.file\([^)]*\)\.delete)\b/;
  if (destructive.test(code)) {
    const literals = [...code.matchAll(/["']([~/.][^"'\n]*)["']/g)].map((m) => m[1]!);
    if (literals.length === 0) {
      return deny("no-harm", `${lang} code deletes files and its targets can't be checked against the allowlist`);
    }
    for (const l of literals) {
      const abs = res(l, st, env);
      if (!abs || !canDelete(abs, env.ctx)) {
        return deny("no-harm", `${lang} code deletes or moves files outside ~/Jarvis and the Jarvis repo (${l})`);
      }
    }
  }
  for (const m of code.matchAll(/(?:os\.system|subprocess\.\w+|execSync|exec|spawnSync|Bun\.spawn|\$)\(\s*["'`]([^"'`]+)["'`]/g)) {
    const r = checkBash(m[1]!, st.cwd, { ...env, depth: env.depth + 1 });
    if (r) return r;
  }
  return null;
}

function checkSimple(raw: SimpleCommand, st: State, env: ShellEnv): Denial | null {
  const { ctx } = env;

  // Redirections: truncating writes and vault writes.
  for (const r of raw.redirects) {
    if (r.op === ">" || r.op === ">|" || r.op === "&>") {
      const d = checkOverwrite("a > redirect", r.target, st, env);
      if (d) return d;
    } else if (r.op === ">>") {
      const d = checkVaultWrite("a >> redirect", r.target, st, env);
      if (d) return d;
      const abs = res(r.target, st, env);
      if (abs && isCredentialPath(abs, ctx)) return deny("no-harm", `writing to credential file ${abs}`);
    }
    if (r.op === ">" || r.op === ">|" || r.op === "&>" || r.op === "<") {
      const abs = res(r.target, st, env);
      if (abs && isCredentialPath(abs, ctx)) return deny("no-harm", `${abs} holds credentials`);
    }
  }

  const original = raw.words;
  if (original.length === 0) return null;
  const first = programName(original[0]!);
  if (ESCALATE.has(first)) return deny("no-harm", `Jarvis never runs commands as root (${first})`);

  const words = unwrap(original);
  if (words.length === 0) return null;
  const prog = programName(words[0]!);
  const rest = words.slice(1);
  const { flags, operands } = args(rest);

  if (ESCALATE.has(prog)) return deny("no-harm", `Jarvis never runs commands as root (${prog})`);

  // Credentials named anywhere in the command.
  for (const w of rest) {
    for (const part of w.includes("=") ? [w, w.slice(w.indexOf("=") + 1)] : [w]) {
      if (!looksLikePath(part)) continue;
      const abs = res(part, st, env);
      if (abs && isCredentialPath(abs, ctx)) return deny("no-harm", `${abs} holds credentials`);
    }
  }

  // Nested shells and inline code.
  if (SHELLS.has(prog)) {
    const ci = rest.findIndex((w) => /^-[a-z]*c[a-z]*$/.test(w));
    if (ci >= 0 && rest[ci + 1] !== undefined) {
      const r = checkBash(rest[ci + 1]!, st.cwd, { ...env, depth: env.depth + 1 });
      if (r) return r;
    } else if (operands.length === 0) {
      for (const body of raw.heredocs) {
        const r = checkBash(body, st.cwd, { ...env, depth: env.depth + 1 });
        if (r) return r;
      }
      for (const r of raw.redirects) {
        if (r.op === "<<<") {
          const d = checkBash(r.target, st.cwd, { ...env, depth: env.depth + 1 });
          if (d) return d;
        }
      }
    } else {
      const script = res(operands[0]!, st, env);
      const body = script ? ctx.readFile(script) : null;
      if (body !== null) {
        const r = checkBash(body, script ? dirnameOf(script) : st.cwd, { ...env, depth: env.depth + 1 });
        if (r) return r;
      }
    }
  }
  if (prog === "eval") {
    const r = checkBash(rest.join(" "), st.cwd, { ...env, depth: env.depth + 1 });
    if (r) return r;
  }
  if (INTERPRETERS.has(prog.replace(/[0-9.]+$/, "")) || INTERPRETERS.has(prog)) {
    const lang = prog === "osascript" ? "osascript" : prog;
    const codes: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (["-c", "-e", "--eval", "-p", "--print", "-r"].includes(rest[i]!) && rest[i + 1] !== undefined) codes.push(rest[i + 1]!);
    }
    if (prog === "osascript") {
      const lines: string[] = [];
      for (let i = 0; i < rest.length; i++) if (rest[i] === "-e" && rest[i + 1] !== undefined) lines.push(rest[i + 1]!);
      codes.length = 0;
      if (lines.length) codes.push(lines.join("\n"));
      else if (operands[0]) {
        const f = res(operands[0], st, env);
        const body = f ? ctx.readFile(f) : null;
        if (body) codes.push(body);
      }
    }
    codes.push(...raw.heredocs);
    for (const r of raw.redirects) if (r.op === "<<<") codes.push(r.target);
    for (const code of codes) {
      const r = checkInlineCode(lang, code, st, env);
      if (r) return r;
    }
  }

  switch (prog) {
    case "cd": {
      if (operands.length === 0) st.cwd = ctx.home;
      else st.cwd = res(operands[0]!, st, env);
      return null;
    }
    case "pushd": {
      if (operands[0]) st.cwd = res(operands[0], st, env);
      return null;
    }
    case "rm":
    case "unlink":
    case "rmdir":
    case "trash": {
      return checkDeleteTargets(prog, operands, st, env);
    }
    case "mv":
    case "cp":
    case "ditto":
    case "install":
    case "ln": {
      const noClobber = hasFlag(flags, "n", "--no-clobber");
      const tIdx = rest.findIndex((w) => w === "-t" || w.startsWith("--target-directory"));
      let dest: string | undefined;
      let sources: string[];
      if (tIdx >= 0) {
        dest = rest[tIdx]!.includes("=") ? rest[tIdx]!.split("=")[1] : rest[tIdx + 1];
        sources = operands.filter((o) => o !== dest);
      } else {
        dest = operands[operands.length - 1];
        sources = operands.slice(0, -1);
      }
      if (!dest || sources.length === 0) return null;
      const destAbs = res(dest, st, env);
      if (!destAbs) return deny("no-harm", `${prog} destination "${dest}" can't be checked against the allowlist`);
      // Moving a note out of the master vault removes it from the vault; renaming within it is fine.
      if (prog === "mv") {
        for (const s of sources) {
          const d = checkVaultWrite("mv", s, st, env);
          if (d) return d;
          const srcAbs = res(s, st, env);
          if (srcAbs && inMasterVault(srcAbs, ctx) && !inMasterVault(destAbs, ctx))
            return deny("no-harm", `moving ${srcAbs} out of the master vault would remove it from Leo's notes`);
          const sa = res(s, st, env);
          if (sa && isCredentialPath(sa, ctx)) return deny("no-harm", `${sa} holds credentials`);
        }
      }
      const targets =
        ctx.isDir(destAbs) && !(prog === "ln" && hasFlag(flags, "n"))
          ? sources.map((s) => join(destAbs, basename(s)))
          : [destAbs];
      for (const t of targets) {
        if (isGuardProtected(t, ctx)) return deny("no-harm", forbiddenWrite(t, ctx)!);
        if (forbiddenVaultWrite(t, ctx)) return deny("no-harm", `Obsidian's own settings and plugins in the master vault are off limits (${prog} into ${t})`);
        if (!noClobber && ctx.exists(t) && !ctx.isDir(t) && !canOverwrite(t, ctx)) {
          return deny("no-harm", `${prog} would overwrite ${t}, which isn't inside ~/Jarvis, ~/Jarvis-Memory or the Jarvis repo`);
        }
      }
      return null;
    }
    case "rsync": {
      if (operands.length < 2) return null;
      const dest = operands[operands.length - 1]!;
      if (/^[^/]*:/.test(dest)) return null; // remote destination
      const destAbs = res(dest, st, env);
      if (!destAbs) return deny("no-harm", `rsync destination "${dest}" can't be checked against the allowlist`);
      if (forbiddenVaultWrite(destAbs, ctx)) return deny("no-harm", `Obsidian's own settings and plugins in the master vault are off limits (rsync into ${destAbs})`);
      const deletes = rest.some((w) => w.startsWith("--delete") || w === "--remove-source-files");
      if (deletes && !canDelete(destAbs, ctx)) {
        return deny("no-harm", `rsync --delete would remove files in ${destAbs}, outside ~/Jarvis and the Jarvis repo`);
      }
      if (ctx.exists(destAbs) && !canOverwrite(destAbs, ctx) && !hasFlag(flags, "", "--ignore-existing")) {
        return deny("no-harm", `rsync would overwrite files in ${destAbs}, outside ~/Jarvis, ~/Jarvis-Memory and the Jarvis repo`);
      }
      return null;
    }
    case "find": {
      const exprStart = rest.findIndex((w) => w.startsWith("-") || w === "(" || w === "!");
      const roots = (exprStart < 0 ? rest : rest.slice(0, exprStart)).filter((w) => !/^-[HLP]$/.test(w));
      const expr = exprStart < 0 ? [] : rest.slice(exprStart);
      let destructive = expr.includes("-delete");
      for (let i = 0; i < expr.length; i++) {
        if (["-exec", "-execdir", "-ok", "-okdir"].includes(expr[i]!)) {
          const p = programName(expr[i + 1] ?? "");
          if (DELETE_CMDS.has(p) || p === "mv" || p === "shred" || SHELLS.has(p)) destructive = true;
        }
      }
      if (!destructive) return null;
      return checkDeleteTargets("find -delete", roots.length ? roots : ["."], st, env);
    }
    case "xargs": {
      const sub = rest.filter((w) => !w.startsWith("-"));
      const p = programName(sub[0] ?? "");
      if (DELETE_CMDS.has(p) || p === "mv" || p === "shred") {
        return deny("no-harm", `xargs ${p} deletes files that can't be checked in advance; use rm with explicit paths inside ~/Jarvis`);
      }
      if (sub.length) return checkSimple({ words: sub, redirects: [], heredocs: [] }, st, env);
      return null;
    }
    case "truncate": {
      for (const o of operands) {
        const d = checkOverwrite("truncate", o, st, env);
        if (d) return d;
      }
      return null;
    }
    case "dd": {
      const of = rest.find((w) => w.startsWith("of="));
      if (of) {
        const t = of.slice(3);
        if (/^\/dev\/(r?disk|sd)/.test(t)) return deny("no-harm", `dd onto a disk device (${t})`);
        return checkOverwrite("dd", t, st, env);
      }
      return null;
    }
    case "tee": {
      const append = hasFlag(flags, "a", "--append");
      for (const o of operands) {
        const d = append ? checkVaultWrite("tee", o, st, env) : checkOverwrite("tee", o, st, env);
        if (d) return d;
      }
      return null;
    }
    case "sed":
    case "perl": {
      if (rest.some((w) => /^-[a-zA-Z]*i/.test(w) || w.startsWith("--in-place"))) {
        for (const o of operands.slice(1)) {
          const d = checkVaultWrite(`${prog} -i`, o, st, env);
          if (d) return d;
        }
      }
      return null;
    }
    case "touch":
    case "mkdir":
    case "chmod":
    case "chown":
    case "chflags":
    case "unzip":
    case "patch": {
      for (const o of operands) {
        const d = checkVaultWrite(prog, o, st, env);
        if (d) return d;
      }
      if ((prog === "chmod" || prog === "chown" || prog === "chflags") && hasFlag(flags, "R")) {
        for (const o of operands.slice(1)) {
          const abs = res(o, st, env);
          if (!abs || !canDelete(abs, ctx)) {
            return deny("no-harm", `recursive ${prog} outside ~/Jarvis and the Jarvis repo (${o})`);
          }
        }
      }
      return null;
    }
    case "tar": {
      const cIdx = rest.findIndex((w) => w === "-C" || w === "--directory");
      const extracting = rest.some((w) => /^-?[a-zA-Z]*x/.test(w) && !w.startsWith("--"));
      if (extracting) {
        const dir = cIdx >= 0 ? rest[cIdx + 1] : ".";
        if (dir) {
          const d = checkVaultWrite("tar -x", dir, st, env);
          if (d) return d;
        }
      }
      return null;
    }
    case "xattr": {
      if (rest.some((w) => /quarantine/.test(w)) && (hasFlag(flags, "d") || hasFlag(flags, "c"))) {
        return deny("no-harm", "removing the quarantine flag turns off Gatekeeper's check for that file");
      }
      return null;
    }
    case "git": {
      return checkGit(rest, st, env);
    }
    case "security": {
      const sub = rest[0] ?? "";
      if (sub === "find-generic-password") {
        const sIdx = rest.indexOf("-s");
        const service = sIdx >= 0 ? rest[sIdx + 1] : undefined;
        if (service && service.startsWith("jarvis/")) return null;
        return deny("no-harm", "reading Keychain items other than Jarvis's own (service jarvis/...) touches Leo's credentials");
      }
      return deny("no-harm", `security ${sub} touches the Keychain or system trust settings`);
    }
    case "defaults": {
      const sub = rest[0];
      if (sub === "write" || sub === "delete" || sub === "import" || sub === "rename") {
        const domain = rest.filter((w) => !w.startsWith("-"))[1] ?? "";
        if (PRIVACY_DEFAULTS.test(domain) || PRIVACY_DEFAULTS.test(rest.join(" "))) {
          return deny("no-harm", `defaults ${sub} ${domain} changes a security or privacy setting`);
        }
      }
      return null;
    }
    case "launchctl": {
      const sub = rest[0] ?? "";
      if (/^(bootout|unload|remove|disable|enable|bootstrap|load|kickstart|kill|submit|config)$/.test(sub)) {
        if (!rest.some((w) => /com\.jarvis\./.test(w))) {
          return deny("no-harm", `launchctl ${sub} on a service that isn't Jarvis's own (com.jarvis.*)`);
        }
      }
      return null;
    }
    case "networksetup":
    case "scutil": {
      if (rest.some((w) => /^-set|^--set|^-remove|^-delete|^-create/.test(w))) {
        return deny("no-harm", `${prog} changes network or proxy settings`);
      }
      return null;
    }
    case "dscl": {
      if (rest.some((w) => /^-(create|delete|passwd|append|merge|change)$/.test(w))) {
        return deny("no-harm", "dscl changes user accounts or passwords");
      }
      return null;
    }
    case "diskutil": {
      if (rest.some((w) => /^(erase|zero|secureErase|partition|reformat|apfs|deleteVolume|resetFusion|randomDisk)/i.test(w))) {
        return deny("no-harm", `diskutil ${rest[0]} erases or repartitions a disk`);
      }
      return null;
    }
    case "gpg":
    case "gpg2": {
      if (rest.some((w) => /^--(export-secret|delete|gen-key|full-gen-key|import)/.test(w))) {
        return deny("no-harm", "gpg secret-key operations touch credentials");
      }
      return null;
    }
    case "open": {
      const aIdx = rest.findIndex((w) => w === "-a" || w === "-b");
      const app = aIdx >= 0 ? rest[aIdx + 1] ?? "" : "";
      for (const target of [app, ...operands]) {
        if (MONEY_APPS.test(basename(target).replace(/\.app$/, ""))) {
          return deny("no-money", `${target} is a banking, payment or trading app`);
        }
      }
      return null;
    }
    case "gh": {
      const joined = rest.join(" ");
      if (/^(issue|pr) (comment|review)\b/.test(joined) || /^(gist create)\b.*--public/.test(joined)) {
        return deny("no-contacting-as-leo", `gh ${rest.slice(0, 2).join(" ")} posts as Leo`);
      }
      if (/^pr (merge|close)\b/.test(joined) || /^repo (delete|archive)\b/.test(joined) || /^release delete\b/.test(joined)) {
        return deny("no-harm", `gh ${rest.slice(0, 2).join(" ")} can't be undone from here`);
      }
      return null;
    }
    default:
      break;
  }

  if (DISK_WIPE.has(prog) || /^(mkfs|newfs)\./.test(prog)) return deny("no-harm", `${prog} destroys data`);
  if (SECURITY_TOOLS.has(prog)) {
    if (prog === "crontab" && (rest.length === 0 || rest[0] === "-l")) return null;
    return deny("no-harm", `${prog} changes security, privacy or login settings`);
  }
  if (MAIL_SENDERS.has(prog)) return deny("no-contacting-as-leo", `${prog} sends email as Leo`);
  return null;
}

function dirnameOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "/";
}

function checkGit(rest: string[], st: State, env: ShellEnv): Denial | null {
  let dir = st.cwd;
  const r = [...rest];
  while (r.length && r[0]!.startsWith("-")) {
    const f = r.shift()!;
    if (f === "-C" && r.length) dir = resolvePath(r.shift()!, dir, env.ctx);
    else if ((f === "-c" || f === "--git-dir" || f === "--work-tree") && r.length) r.shift();
  }
  const sub = r[0] ?? "";
  const tail = r.slice(1);
  const destructive =
    sub === "clean" ||
    (sub === "reset" && tail.includes("--hard")) ||
    (sub === "checkout" && (tail.includes("--") || tail.includes("-f") || tail.includes("--force") || tail.includes("."))) ||
    (sub === "restore" && !tail.includes("--staged") && !tail.includes("-S")) ||
    (sub === "stash" && (tail[0] === "drop" || tail[0] === "clear")) ||
    (sub === "branch" && (tail.includes("-D") || (tail.includes("--delete") && tail.includes("--force")))) ||
    (sub === "push" && tail.some((w) => w === "-f" || w === "--force" || w.startsWith("--force-with-lease") || w === "--delete" || w === "--mirror" || w.startsWith("+"))) ||
    (sub === "worktree" && tail[0] === "remove") ||
    (sub === "filter-branch" || sub === "filter-repo") ||
    (sub === "rm" && !tail.includes("--cached"));
  if (!destructive) return null;
  if (!dir) return deny("no-harm", `git ${sub} in a folder that can't be checked against the allowlist`);
  if (!canDelete(join(dir, "x"), env.ctx)) {
    return deny("no-harm", `git ${sub} discards work in ${dir}, which isn't inside ~/Jarvis or the Jarvis repo`);
  }
  return null;
}
