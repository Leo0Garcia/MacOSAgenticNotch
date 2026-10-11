/** Reading the memory vault: listing notes, picking the ones a run touched, Index.md. */
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { Config } from "./config";
import { atomicWrite, readIfExists } from "./fsutil";
import { getFront, parseNote } from "./markdown";
import { isoDate } from "./time";

export async function listNotes(vault: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(relative(vault, abs).split("\\").join("/"));
    }
  }
  await walk(vault);
  return out.sort();
}

export const noteName = (rel: string) => basename(rel, ".md");
const isTemplate = (rel: string) => noteName(rel).startsWith("_");

export interface ProjectInfo {
  rel: string;
  name: string;
  status: string;
  text: string;
}

export async function readProjects(vault: string): Promise<ProjectInfo[]> {
  const rels = (await listNotes(vault)).filter((r) => r.startsWith("Projects/") && !isTemplate(r));
  const out: ProjectInfo[] = [];
  for (const rel of rels) {
    const text = (await readIfExists(join(vault, rel))) ?? "";
    const status = getFront(parseNote(text), "status");
    out.push({ rel, name: noteName(rel), status: typeof status === "string" && status ? status : "active", text });
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MAX_NOTE = 6_000;
const MAX_NOTES_TOTAL = 30_000;

export interface NoteContext {
  /** Every note in the vault, with project status, so the model knows what exists. */
  catalogue: string;
  /** Full text of the notes the run plausibly touched. */
  notes: { rel: string; text: string }[];
}

/**
 * Me.md, today's log, and every Projects/ or People/ note whose name appears in the run
 * (matched as a whole word, case-insensitive). Size-capped so Haiku stays fast.
 */
export async function relevantNotes(cfg: Config, haystack: string): Promise<NoteContext> {
  const all = await listNotes(cfg.memory);
  const projects = await readProjects(cfg.memory);
  const status = new Map(projects.map((p) => [p.rel, p.status]));
  const catalogue = all
    .filter((r) => !isTemplate(r) && !r.startsWith("Log/"))
    .map((r) => (status.has(r) ? `- ${r} (status: ${status.get(r)})` : `- ${r}`))
    .join("\n");

  const lower = haystack.toLowerCase();
  const today = `Log/${isoDate(cfg.now(), cfg.tz)}.md`;
  const picked = ["Me.md", today];
  for (const rel of all) {
    if (!(rel.startsWith("Projects/") || rel.startsWith("People/")) || isTemplate(rel)) continue;
    const name = noteName(rel).toLowerCase();
    if (name.length < 2) continue;
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(name)}($|[^\\p{L}\\p{N}])`, "u").test(lower)) picked.push(rel);
  }

  const notes: { rel: string; text: string }[] = [];
  let total = 0;
  for (const rel of picked) {
    const text = await readIfExists(join(cfg.memory, rel));
    if (text === undefined) continue;
    const clipped = text.length > MAX_NOTE ? `${text.slice(0, MAX_NOTE)}\n[… note truncated …]` : text;
    if (total + clipped.length > MAX_NOTES_TOTAL) break;
    total += clipped.length;
    notes.push({ rel, text: clipped });
  }
  return { catalogue, notes };
}

const link = (rel: string) => `[[${rel.replace(/\.md$/, "")}|${noteName(rel)}]]`;

/** Index.md is script-owned: rebuilt from the folder after every run. */
export async function writeIndex(cfg: Config): Promise<void> {
  const all = (await listNotes(cfg.memory)).filter((r) => !isTemplate(r) && r !== "Index.md");
  const projects = await readProjects(cfg.memory);
  const status = new Map(projects.map((p) => [p.rel, p.status]));
  const group = (prefix: string) => all.filter((r) => r.startsWith(prefix));
  const logs = group("Log/").reverse();
  const others = all.filter((r) => !/^(Projects|People|Log)\//.test(r));

  const lines = [
    "# Index",
    "",
    "The librarian regenerates this note after every run. Edits here are overwritten.",
    "",
    "## Projects",
    "",
    ...group("Projects/").map((r) => `- ${link(r)} (${status.get(r) ?? "active"})`),
    "",
    "## People",
    "",
    ...group("People/").map((r) => `- ${link(r)}`),
    "",
    "## Other notes",
    "",
    ...others.map((r) => `- ${link(r)}`),
    "",
    "## Log",
    "",
    ...logs.slice(0, 30).map((r) => `- ${link(r)}`),
    ...(logs.length > 30 ? [`- … ${logs.length - 30} older days in Log/`] : []),
    "",
  ];
  await atomicWrite(join(cfg.memory, "Index.md"), lines.join("\n"));
}

/** Copies vault-template/ into the vault, never overwriting an existing file. */
export async function initVault(cfg: Config): Promise<string[]> {
  const template = join(cfg.repo, "vault-template");
  const created: string[] = [];
  async function walk(dir: string) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const src = join(dir, e.name);
      const rel = relative(template, src);
      if (rel === "README.md") continue;
      const dest = join(cfg.memory, rel);
      if (e.isDirectory()) await walk(src);
      else if (e.isFile()) {
        await mkdir(dirname(dest), { recursive: true });
        if (e.name === ".gitkeep") continue; // keeps an empty folder in git; the folder is enough
        const exists = await stat(dest).then(() => true, () => false);
        if (exists) continue;
        await cp(src, dest, { errorOnExist: true, force: false });
        created.push(rel);
      }
    }
  }
  await walk(template);
  return created;
}
