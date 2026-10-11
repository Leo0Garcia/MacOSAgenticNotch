/**
 * Small, format-preserving edits to Obsidian notes: frontmatter keys and `## Section`
 * bullet lists. Anything the parser doesn't understand is kept byte for byte.
 */

export type FrontValue = string | string[];

interface FrontEntry {
  key?: string;
  value?: FrontValue;
  raw: string[];
}

export interface Note {
  /** Frontmatter entries in order, or undefined when the note has none. */
  front?: FrontEntry[];
  body: string;
}

const KEY_RE = /^([A-Za-z0-9_-][A-Za-z0-9_ -]*):(?:\s+(.*))?$/;

function unquote(s: string): string {
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t.slice(1, -1);
    }
  }
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

function parseScalarOrFlow(s: string): FrontValue {
  const t = s.trim();
  if (t.startsWith("[") && t.endsWith("]")) {
    const inner = t.slice(1, -1).trim();
    if (inner === "") return [];
    // Split on commas outside quotes and [[wikilinks]].
    const items: string[] = [];
    let cur = "";
    let quote: string | null = null;
    let depth = 0;
    for (const ch of inner) {
      if (quote) {
        cur += ch;
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        cur += ch;
      } else if (ch === "[") {
        depth++;
        cur += ch;
      } else if (ch === "]") {
        depth--;
        cur += ch;
      } else if (ch === "," && depth === 0) {
        items.push(unquote(cur));
        cur = "";
      } else cur += ch;
    }
    items.push(unquote(cur));
    return items.filter((i) => i !== "");
  }
  return unquote(t);
}

export function parseNote(text: string): Note {
  const lines = text.split("\n");
  if (lines[0]?.trimEnd() !== "---") return { body: text };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trimEnd() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { body: text };
  const front: FrontEntry[] = [];
  for (let i = 1; i < end; i++) {
    const line = lines[i]!;
    const m = KEY_RE.exec(line);
    if (m) {
      const entry: FrontEntry = { key: m[1]!.trim(), raw: [line] };
      const rest = m[2]?.trim() ?? "";
      if (rest !== "") entry.value = parseScalarOrFlow(rest);
      else {
        // Block list on the following indented "- item" lines.
        const items: string[] = [];
        while (i + 1 < end && /^\s+-\s/.test(lines[i + 1]!)) {
          i++;
          entry.raw.push(lines[i]!);
          items.push(unquote(lines[i]!.replace(/^\s+-\s/, "")));
        }
        entry.value = items.length > 0 ? items : "";
      }
      front.push(entry);
    } else if (front.length > 0 && /^\s/.test(line)) {
      front[front.length - 1]!.raw.push(line); // continuation we don't model
      front[front.length - 1]!.value = undefined;
    } else {
      front.push({ raw: [line] });
    }
  }
  return { front, body: lines.slice(end + 1).join("\n") };
}

function needsQuote(s: string): boolean {
  return s === "" || /^[\s[\]{}>|*&!%@`#'",?:-]|[:#]\s|\s$|^\d/.test(s) || /\[\[/.test(s);
}

function fmtScalar(s: string): string {
  return needsQuote(s) ? JSON.stringify(s) : s;
}

export function formatValue(v: FrontValue): string {
  if (Array.isArray(v)) return `[${v.map(fmtScalar).join(", ")}]`;
  return fmtScalar(v);
}

export function serializeNote(note: Note): string {
  if (!note.front) return note.body;
  const fm = note.front.flatMap((e) => e.raw).join("\n");
  return `---\n${fm}${fm ? "\n" : ""}---\n${note.body}`;
}

export function getFront(note: Note, key: string): FrontValue | undefined {
  return note.front?.find((e) => e.key?.toLowerCase() === key.toLowerCase())?.value;
}

export function setFront(note: Note, key: string, value: FrontValue): void {
  note.front ??= [];
  const raw = [`${key}: ${formatValue(value)}`];
  const existing = note.front.find((e) => e.key?.toLowerCase() === key.toLowerCase());
  if (existing) {
    existing.raw = [`${existing.key}: ${formatValue(value)}`];
    existing.value = value;
  } else note.front.push({ key, value, raw });
}

/* ---------- sections ---------- */

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

function headingLevel(line: string): number {
  const m = HEADING_RE.exec(line);
  return m ? m[1]!.length : 0;
}

function sameTitle(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** [start, end): start is the heading line, end is the next heading of level <= 2 or EOF. */
function findSection(lines: string[], title: string): [number, number] | undefined {
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i]!);
    if (m && m[1]!.length === 2 && sameTitle(m[2]!, title)) {
      let j = i + 1;
      while (j < lines.length) {
        const lvl = headingLevel(lines[j]!);
        if (lvl > 0 && lvl <= 2) break;
        j++;
      }
      return [i, j];
    }
  }
  return undefined;
}

export function sectionItems(body: string, title: string): string[] {
  const lines = body.split("\n");
  const s = findSection(lines, title);
  if (!s) return [];
  return lines.slice(s[0] + 1, s[1]).filter((l) => /^\s*[-*]\s/.test(l) && !/^\s{2,}/.test(l));
}

export function itemText(line: string): string {
  return line
    .replace(/^\s*[-*]\s+/, "")
    .replace(/^\[[ xX]\]\s*/, "")
    .trim();
}

function norm(s: string): string {
  return itemText(s).toLowerCase().replace(/\s+/g, " ");
}

export function toItem(text: string): string {
  const t = text.trim();
  return /^[-*]\s/.test(t) ? t : `- ${t}`;
}

/** Appends bullet lines at the end of a section, creating the section at the end of the note if needed. */
export function appendToSection(body: string, title: string, items: string[]): string {
  const lines = body.split("\n");
  const s = findSection(lines, title);
  const newLines = items.map(toItem);
  if (!s) {
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
    lines.push("", `## ${title}`, "", ...newLines, "");
    return lines.join("\n");
  }
  let insertAt = s[1];
  while (insertAt > s[0] + 1 && lines[insertAt - 1]!.trim() === "") insertAt--;
  if (insertAt === s[0] + 1) {
    // Empty section: heading, one blank line, the items, one blank line before what follows.
    const rest = lines.slice(s[1]);
    return [...lines.slice(0, s[0] + 1), "", ...newLines, "", ...rest].join("\n");
  }
  lines.splice(insertAt, 0, ...newLines);
  return lines.join("\n");
}

export class ItemNotFound extends Error {}

/** Removes one top-level item (and its indented continuation lines) from a section. Returns [body, removedLine]. */
export function removeFromSection(body: string, title: string, text: string): [string, string] {
  const lines = body.split("\n");
  const s = findSection(lines, title);
  if (!s) throw new ItemNotFound(`no "## ${title}" section`);
  const target = norm(text);
  const candidates: number[] = [];
  for (let i = s[0] + 1; i < s[1]; i++) {
    const l = lines[i]!;
    if (!/^[-*]\s/.test(l)) continue;
    if (norm(l) === target) {
      candidates.length = 0;
      candidates.push(i);
      break;
    }
    if (target.length >= 4 && norm(l).includes(target)) candidates.push(i);
  }
  if (candidates.length === 0) throw new ItemNotFound(`"${text}" not found in ${title}`);
  if (candidates.length > 1) throw new ItemNotFound(`"${text}" matches ${candidates.length} items in ${title}`);
  const i = candidates[0]!;
  let j = i + 1;
  while (j < s[1] && /^\s+\S/.test(lines[j]!)) j++;
  const removed = lines[i]!;
  lines.splice(i, j - i);
  return [lines.join("\n"), removed];
}

const DONE_SECTIONS = new Set(["done", "completed"]);

/** Moves an item between sections, ticking or unticking a checkbox when it lands in or leaves Done. */
export function moveBetweenSections(body: string, from: string, to: string, text: string): string {
  const [without, removed] = removeFromSection(body, from, text);
  let line = removed.trim();
  if (DONE_SECTIONS.has(to.trim().toLowerCase())) line = line.replace(/^([-*]\s+)\[ \]/, "$1[x]");
  else line = line.replace(/^([-*]\s+)\[[xX]\]/, "$1[ ]");
  return appendToSection(without, to, [line]);
}

export function stripFrontmatter(text: string): string {
  const n = parseNote(text);
  return n.front ? n.body.replace(/^\n+/, "") : text;
}
