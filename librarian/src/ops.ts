/**
 * Applies the model's note edits. The model never touches the filesystem: it returns a
 * list of ops, and this file checks each path and writes atomically. There is no delete op.
 */
import { join } from "node:path";
import { atomicWrite, readIfExists, resolveNotePath } from "./fsutil";
import { appendToSection, moveBetweenSections, parseNote, removeFromSection, serializeNote, setFront } from "./markdown";
import { noteName } from "./vault";

export type OpName = "create" | "replace" | "append" | "move" | "remove" | "set";

export interface Op {
  op: OpName;
  path: string;
  section?: string;
  to_section?: string;
  text?: string;
  content?: string;
  key?: string;
  value?: string;
  values?: string[];
}

export interface ModelOutput {
  ops: Op[];
  log: string[];
}

export interface ApplyReport {
  applied: string[];
  skipped: { op: Op; reason: string }[];
  /** Relative paths of notes that changed. */
  touched: string[];
}

const MAX_OPS = 40;
const MAX_CONTENT = 20_000;

/** Same JSON Schema is passed to `claude --json-schema`. */
export const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    ops: {
      type: "array",
      items: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["create", "replace", "append", "move", "remove", "set"] },
          path: { type: "string" },
          section: { type: "string" },
          to_section: { type: "string" },
          text: { type: "string" },
          content: { type: "string" },
          key: { type: "string" },
          value: { type: "string" },
          values: { type: "array", items: { type: "string" } },
        },
        required: ["op", "path"],
      },
    },
    log: { type: "array", items: { type: "string" } },
  },
  required: ["ops", "log"],
} as const;

export function validateOutput(x: unknown): ModelOutput {
  if (!x || typeof x !== "object") throw new Error("structured_output is not an object");
  const o = x as Record<string, unknown>;
  if (!Array.isArray(o.ops) || !Array.isArray(o.log)) throw new Error("structured_output lacks ops or log");
  const ops = o.ops.filter((op): op is Op => !!op && typeof op === "object" && typeof (op as Op).op === "string" && typeof (op as Op).path === "string");
  const log = o.log.filter((l): l is string => typeof l === "string" && l.trim() !== "").map((l) => l.replace(/\s*\n\s*/g, " ").trim());
  return { ops, log };
}

async function templateFor(repo: string, rel: string): Promise<string | undefined> {
  const folder = rel.startsWith("Projects/") ? "Projects" : rel.startsWith("People/") ? "People" : undefined;
  if (!folder) return undefined;
  const t = await readIfExists(join(repo, "vault-template", folder, "_template.md"));
  return t?.replaceAll("{{name}}", noteName(rel));
}

async function newNoteText(repo: string, rel: string): Promise<string> {
  return (await templateFor(repo, rel)) ?? `# ${noteName(rel)}\n`;
}

/** Secrets never go into the vault, whatever the transcript held. */
const SECRET_RE = /(sk-ant-[\w-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[\w-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const CARD_CANDIDATE_RE = /\b\d(?:[ -]?\d){12,18}\b/g;

/** Issuer prefixes in use: Amex/Diners/JCB 3, Visa 4, Mastercard 51-55 and 2221-2720, Discover/Maestro 6. */
function cardPrefix(d: string): boolean {
  if (/^[3456]/.test(d)) return true;
  const four = Number(d.slice(0, 4));
  return four >= 2221 && four <= 2720;
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function looksSecret(s: string): boolean {
  if (SECRET_RE.test(s)) return true;
  for (const m of s.matchAll(CARD_CANDIDATE_RE)) {
    const digits = m[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && cardPrefix(digits) && luhn(digits)) return true;
  }
  return false;
}

function checkText(s: string | undefined, what: string): void {
  if (s === undefined) return;
  if (s.length > MAX_CONTENT) throw new Error(`${what} is too long`);
  if (looksSecret(s)) throw new Error(`${what} looks like it contains a secret or card number`);
}

export async function applyOps(vault: string, repo: string, ops: Op[]): Promise<ApplyReport> {
  const report: ApplyReport = { applied: [], skipped: [], touched: [] };
  for (const [i, op] of ops.entries()) {
    if (i >= MAX_OPS) {
      report.skipped.push({ op, reason: `more than ${MAX_OPS} ops in one run` });
      continue;
    }
    try {
      const { abs, rel } = await resolveNotePath(vault, op.path);
      checkText(op.content, "content");
      checkText(op.text, "text");
      checkText(op.value, "value");
      for (const v of op.values ?? []) checkText(v, "value");
      const current = await readIfExists(abs);
      let next: string;

      switch (op.op) {
        case "create": {
          if (current !== undefined) throw new Error("already exists");
          next = op.content?.trim() ? op.content : await newNoteText(repo, rel);
          break;
        }
        case "replace": {
          if (!op.content?.trim()) throw new Error("replace with empty content");
          if (current !== undefined && op.content.length < current.length * 0.5) {
            throw new Error("replace would drop more than half the note; use append/move/remove");
          }
          next = op.content;
          break;
        }
        case "append": {
          if (!op.section || !op.text?.trim()) throw new Error("append needs section and text");
          const base = current ?? (await newNoteText(repo, rel));
          const items = op.text.split("\n").map((l) => l.trim()).filter(Boolean);
          const note = parseNote(base);
          note.body = appendToSection(note.body, op.section, items);
          next = serializeNote(note);
          break;
        }
        case "move": {
          if (current === undefined) throw new Error("note does not exist");
          if (!op.section || !op.to_section || !op.text) throw new Error("move needs section, to_section and text");
          const note = parseNote(current);
          note.body = moveBetweenSections(note.body, op.section, op.to_section, op.text);
          next = serializeNote(note);
          break;
        }
        case "remove": {
          if (current === undefined) throw new Error("note does not exist");
          if (!op.section || !op.text) throw new Error("remove needs section and text");
          const note = parseNote(current);
          note.body = removeFromSection(note.body, op.section, op.text)[0];
          next = serializeNote(note);
          break;
        }
        case "set": {
          if (!op.key || !/^[A-Za-z0-9_-]{1,40}$/.test(op.key)) throw new Error("set needs a simple key");
          const base = current ?? (await newNoteText(repo, rel));
          const note = parseNote(base);
          setFront(note, op.key, op.values ?? op.value ?? "");
          next = serializeNote(note);
          break;
        }
        default:
          throw new Error(`unknown op ${String((op as Op).op)}`);
      }
      if (next !== current) {
        await atomicWrite(abs, next.endsWith("\n") ? next : `${next}\n`);
        if (!report.touched.includes(rel)) report.touched.push(rel);
      }
      report.applied.push(`${op.op} ${rel}`);
    } catch (err) {
      report.skipped.push({ op, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}
