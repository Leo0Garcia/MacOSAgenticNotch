// A small POSIX-ish shell parser: enough to find every simple command,
// its words and its redirections, including commands nested in $(...),
// backticks, subshells and heredocs fed to a shell. It never runs anything.

import { SUBST } from "./paths";

export interface Redirect {
  op: string; // ">", ">>", ">|", "&>", "<", "<<", "<<<"
  target: string;
}

export interface SimpleCommand {
  words: string[];
  redirects: Redirect[];
  heredocs: string[];
}

const MAX_DEPTH = 8;

function newCmd(): SimpleCommand {
  return { words: [], redirects: [], heredocs: [] };
}

/** Index just past the matching close paren for src[start] === "(". */
function matchParen(src: string, start: number): number {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      i = j < 0 ? src.length : j;
      continue;
    }
    if (c === '"') {
      i = matchDouble(src, i);
      continue;
    }
    if (c === "(") depth++;
    if (c === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return src.length;
}

/** Index of the closing double quote for src[start] === '"'. */
function matchDouble(src: string, start: number): number {
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === "\\") {
      i++;
      continue;
    }
    if (src[i] === "$" && src[i + 1] === "(") {
      i = matchParen(src, i + 1) - 1;
      continue;
    }
    if (src[i] === '"') return i;
  }
  return src.length;
}

export class ParseError extends Error {}

export function parseShell(src: string, depth = 0): SimpleCommand[] {
  if (depth > MAX_DEPTH) throw new ParseError("shell command nests too deeply to check");
  const cmds: SimpleCommand[] = [];
  let cur = newCmd();
  let word: string | null = null;
  let pendingRedirect: string | null = null;
  let pendingHeredocs: { delim: string; strip: boolean; cmd: SimpleCommand }[] = [];

  const pushWord = () => {
    if (word === null) return;
    if (pendingRedirect) {
      if (pendingRedirect === "<<" || pendingRedirect === "<<-") {
        pendingHeredocs.push({ delim: word, strip: pendingRedirect === "<<-", cmd: cur });
        cur.redirects.push({ op: "<<", target: word });
      } else {
        cur.redirects.push({ op: pendingRedirect, target: word });
      }
      pendingRedirect = null;
    } else {
      cur.words.push(word);
    }
    word = null;
  };
  const endCmd = () => {
    pushWord();
    if (cur.words.length || cur.redirects.length) cmds.push(cur);
    cur = newCmd();
  };
  const sub = (inner: string) => {
    cmds.push(...parseShell(inner, depth + 1));
    word = (word ?? "") + SUBST;
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];

    if (c === "\\") {
      if (n === "\n") {
        i += 2;
        continue;
      }
      word = (word ?? "") + (n ?? "");
      i += 2;
      continue;
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const end = j < 0 ? src.length : j;
      word = (word ?? "") + src.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      const end = matchDouble(src, i);
      let k = i + 1;
      let buf: string = word ?? "";
      while (k < end) {
        const d = src[k]!;
        if (d === "\\" && k + 1 < end && '"\\$`\n'.includes(src[k + 1]!)) {
          if (src[k + 1] !== "\n") buf += src[k + 1];
          k += 2;
          continue;
        }
        if (d === "$" && src[k + 1] === "(") {
          const close = matchParen(src, k + 1);
          word = buf;
          sub(src.slice(k + 2, close - 1));
          buf = word!;
          k = close;
          continue;
        }
        if (d === "`") {
          const j = src.indexOf("`", k + 1);
          const e2 = j < 0 || j > end ? end : j;
          word = buf;
          sub(src.slice(k + 1, e2));
          buf = word!;
          k = e2 + 1;
          continue;
        }
        buf += d;
        k++;
      }
      word = buf;
      i = end + 1;
      continue;
    }
    if (c === "$" && n === "(") {
      if (src[i + 2] === "(") {
        // arithmetic $(( ... ))
        const close = matchParen(src, i + 1);
        word = (word ?? "") + "0";
        i = close;
        continue;
      }
      const close = matchParen(src, i + 1);
      sub(src.slice(i + 2, close - 1));
      i = close;
      continue;
    }
    if (c === "`") {
      const j = src.indexOf("`", i + 1);
      const end = j < 0 ? src.length : j;
      sub(src.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if ((c === "<" || c === ">") && n === "(" && word === null) {
      // process substitution <(cmd) / >(cmd)
      const close = matchParen(src, i + 1);
      sub(src.slice(i + 2, close - 1));
      pushWord();
      i = close;
      continue;
    }
    if (c === "#" && word === null) {
      const j = src.indexOf("\n", i);
      i = j < 0 ? src.length : j;
      continue;
    }
    if (c === "\n") {
      endCmd();
      i++;
      // heredoc bodies start on the next line
      for (const h of pendingHeredocs) {
        const lines: string[] = [];
        while (i < src.length) {
          const j = src.indexOf("\n", i);
          const line = src.slice(i, j < 0 ? src.length : j);
          i = j < 0 ? src.length : j + 1;
          const cmp = h.strip ? line.replace(/^\t+/, "") : line;
          if (cmp === h.delim) break;
          lines.push(line);
        }
        h.cmd.heredocs.push(lines.join("\n"));
      }
      pendingHeredocs = [];
      continue;
    }
    if (c === ";" || c === "|" || c === "(" || c === ")") {
      endCmd();
      i += c === "|" && (n === "|" || n === "&") ? 2 : c === ";" && n === ";" ? 2 : 1;
      continue;
    }
    if (c === "&") {
      if (n === ">") {
        pushWord();
        const append = src[i + 2] === ">";
        pendingRedirect = append ? ">>" : "&>";
        i += append ? 3 : 2;
        continue;
      }
      endCmd();
      i += n === "&" ? 2 : 1;
      continue;
    }
    if ((c === ">" || c === "<") || (/[0-9]/.test(c) && word === null && (n === ">" || n === "<"))) {
      let k = i;
      if (/[0-9]/.test(c)) k++;
      pushWord();
      const ch = src[k]!;
      let op = ch;
      k++;
      if (ch === ">") {
        if (src[k] === ">") {
          op = ">>";
          k++;
        } else if (src[k] === "|") {
          op = ">|";
          k++;
        } else if (src[k] === "&") {
          k++;
          // >&2 duplicates a descriptor; >&file writes to a file
          const m = /^[0-9-]+/.exec(src.slice(k));
          if (m) {
            i = k + m[0].length;
            continue;
          }
          op = "&>";
        }
      } else {
        if (src[k] === "<") {
          k++;
          if (src[k] === "<") {
            op = "<<<";
            k++;
          } else if (src[k] === "-") {
            op = "<<-";
            k++;
          } else op = "<<";
        } else if (src[k] === "&") {
          k++;
          const m = /^[0-9-]+/.exec(src.slice(k));
          i = k + (m ? m[0].length : 0);
          continue;
        } else if (src[k] === ">") {
          op = ">";
          k++;
        }
      }
      pendingRedirect = op;
      i = k;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      pushWord();
      i++;
      continue;
    }
    word = (word ?? "") + c;
    i++;
  }
  endCmd();
  // a heredoc whose body ran to the end of input without a newline before it
  for (const h of pendingHeredocs) h.cmd.heredocs.push("");
  return cmds;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(["command", "builtin", "exec", "nohup", "time", "noglob"]);

/**
 * Strip leading assignments and harmless wrappers (env, nice, timeout, ...)
 * so words[0] is the real program.
 */
export function unwrap(words: string[]): string[] {
  let w = [...words];
  for (let guard = 0; guard < 10; guard++) {
    while (w.length && ASSIGNMENT.test(w[0]!)) w.shift();
    if (w[0] === "{" ) w.shift();
    if (w[w.length - 1] === "}") w.pop();
    const p = w[0] ? programName(w[0]) : "";
    if (WRAPPERS.has(p)) {
      w.shift();
      while (w[0]?.startsWith("-")) w.shift();
      continue;
    }
    if (p === "env") {
      w.shift();
      while (w.length && (w[0]!.startsWith("-") || ASSIGNMENT.test(w[0]!))) {
        const f = w.shift()!;
        if ((f === "-u" || f === "-C" || f === "-S") && w.length) w.shift();
      }
      continue;
    }
    if (p === "nice" || p === "caffeinate" || p === "stdbuf" || p === "ionice") {
      w.shift();
      while (w[0]?.startsWith("-")) {
        const f = w.shift()!;
        if ((f === "-n" || f === "-w" || f === "-t") && w.length) w.shift();
      }
      continue;
    }
    if (p === "timeout" || p === "gtimeout") {
      w.shift();
      while (w[0]?.startsWith("-")) w.shift();
      w.shift(); // duration
      continue;
    }
    break;
  }
  return w;
}

export function programName(word: string): string {
  const i = word.lastIndexOf("/");
  return i >= 0 ? word.slice(i + 1) : word;
}
