#!/usr/bin/env bun
// Kanban.md editor for the Obsidian Kanban plugin's markdown format (docs/DESIGN.md section 9).
// Edits are line-level splices so everything it doesn't touch stays byte for byte.
//
//   bun kanban.ts list [--all] [--lane <lane>] [--json]
//   bun kanban.ts add <text> [--lane <lane>]
//   bun kanban.ts move <card> --to <lane>
//   bun kanban.ts remove <card>
//
// --file <path> overrides $JARVIS_MASTER_VAULT/Kanban.md. Exit 2 = Leo needs to clarify
// (no such card or lane, or several cards match); the message says what to ask.
import { join } from "node:path";
import { rewrite } from "../lib/atomic.ts";
import { fail, flag, masterVault, parseArgs } from "../lib/env.ts";

export interface Card {
  start: number; // line index of "- [ ] ..."
  end: number; // exclusive
  text: string; // first line text without checkbox or block id
  done: boolean;
}

export interface Lane {
  title: string;
  heading: number; // line index of "## ..."
  end: number; // exclusive: next lane heading or the tail
  complete: boolean; // body starts with **Complete**
  completeLine: number | null;
  cards: Card[];
}

export interface Board {
  lines: string[];
  eol: string;
  lanes: Lane[];
}

const CARD = /^- \[([ xX])\] ?(.*)$/;
const HEADING = /^## (.*)$/;
const BLOCK_ID = /\s+\^[A-Za-z0-9-]+$/;

export class ClarifyError extends Error {}

/** Lane title without the plugin's optional max-items suffix, e.g. "Doing (3)". */
function laneTitle(raw: string): string {
  return raw.replace(/\s*\(\d+\)\s*$/, "").trim();
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[\s_-]+/g, " ").trim();
}

/** Where the lanes stop: the archive separator (*** before ## Archive) or the settings block. */
function tailStart(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (l.startsWith("%% kanban:settings")) return i;
    if (l === "***" && lines.slice(i + 1).some((x) => /^## Archive\s*$/i.test(x.trim()))) return i;
  }
  return lines.length;
}

export function parse(content: string): Board {
  if (!/^---\r?\n[\s\S]*?kanban-plugin:\s*\w+[\s\S]*?\r?\n---/.test(content)) {
    throw new Error("This doesn't look like an Obsidian Kanban board (no kanban-plugin frontmatter), so I won't touch it.");
  }
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const tail = tailStart(lines);
  // Skip the frontmatter block before looking for lane headings.
  let i = 1;
  while (i < lines.length && lines[i] !== "---") i++;
  const lanes: Lane[] = [];
  for (i = i + 1; i < tail; i++) {
    const m = HEADING.exec(lines[i]!);
    if (!m) continue;
    let end = i + 1;
    while (end < tail && !HEADING.test(lines[end]!)) end++;
    const lane: Lane = { title: laneTitle(m[1]!), heading: i, end, complete: false, completeLine: null, cards: [] };
    let seenContent = false;
    for (let j = i + 1; j < end; j++) {
      const line = lines[j]!;
      if (!seenContent && line.trim() === "**Complete**") {
        lane.complete = true;
        lane.completeLine = j;
        seenContent = true;
        continue;
      }
      const c = CARD.exec(line);
      if (c) {
        seenContent = true;
        let k = j + 1;
        while (k < end && /^[ \t]+\S/.test(lines[k]!)) k++;
        lane.cards.push({ start: j, end: k, text: c[2]!.replace(BLOCK_ID, "").trim(), done: c[1] !== " " });
        j = k - 1;
      } else if (line.trim()) {
        seenContent = true;
      }
    }
    lanes.push(lane);
    i = end - 1;
  }
  if (!lanes.length) throw new Error("The board has no lanes (## headings).");
  return { lines, eol, lanes };
}

export function findLane(board: Board, name: string): Lane {
  const n = norm(laneTitle(name));
  const exact = board.lanes.find((l) => norm(l.title) === n);
  if (exact) return exact;
  const partial = board.lanes.filter((l) => norm(l.title).includes(n) || n.includes(norm(l.title)));
  if (partial.length === 1) return partial[0]!;
  throw new ClarifyError(`There's no lane called "${name}". Lanes: ${board.lanes.map((l) => l.title).join(", ")}.`);
}

export function findCard(board: Board, query: string): { lane: Lane; card: Card } {
  const q = norm(query);
  const all = board.lanes.flatMap((lane) => lane.cards.map((card) => ({ lane, card })));
  const exact = all.filter((x) => norm(x.card.text) === q);
  const hits = exact.length ? exact : all.filter((x) => norm(x.card.text).includes(q));
  if (hits.length === 1) return hits[0]!;
  if (!hits.length) throw new ClarifyError(`No card matches "${query}".`);
  const names = hits.map((h) => `"${h.card.text}" (${h.lane.title})`).join(", ");
  throw new ClarifyError(`Several cards match "${query}": ${names}. Which one?`);
}

function defaultLane(board: Board): Lane {
  return board.lanes.find((l) => !l.complete) ?? board.lanes[0]!;
}

/** Line index where a new card goes: after the lane's last card (the plugin's default), else after the heading. */
function insertionPoint(lane: Lane): { at: number; lead: string[] } {
  const last = lane.cards.at(-1);
  if (last) return { at: last.end, lead: [] };
  if (lane.completeLine !== null) return { at: lane.completeLine + 1, lead: [] };
  return { at: lane.heading + 1, lead: [""] };
}

function setCheck(line: string, done: boolean): string {
  return line.replace(/^- \[[ xX]\]/, done ? "- [x]" : "- [ ]");
}

function render(board: Board, lines: string[]): string {
  return lines.join(board.eol);
}

export function addCard(content: string, text: string, laneName?: string): { content: string | null; message: string } {
  const board = parse(content);
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) throw new ClarifyError("What should the card say?");
  const lane = laneName ? findLane(board, laneName) : defaultLane(board);
  if (lane.cards.some((c) => norm(c.text) === norm(clean))) {
    return { content: null, message: `"${clean}" is already in ${lane.title}.` };
  }
  const { at, lead } = insertionPoint(lane);
  const lines = [...board.lines];
  lines.splice(at, 0, ...lead, `- [${lane.complete ? "x" : " "}] ${clean}`);
  return { content: render(board, lines), message: `Added "${clean}" to ${lane.title}.` };
}

export function moveCard(content: string, query: string, toLane: string): { content: string | null; message: string } {
  const board = parse(content);
  const { lane: from, card } = findCard(board, query);
  const to = findLane(board, toLane);
  if (from === to) return { content: null, message: `"${card.text}" is already in ${to.title}.` };
  const block = board.lines.slice(card.start, card.end);
  block[0] = setCheck(block[0]!, to.complete);
  const lines = [...board.lines];
  const { at, lead } = insertionPoint(to);
  // Insert first when the destination is later in the file, so the source indices stay valid.
  if (at >= card.end) {
    lines.splice(at, 0, ...lead, ...block);
    lines.splice(card.start, card.end - card.start);
  } else {
    lines.splice(card.start, card.end - card.start);
    lines.splice(at, 0, ...lead, ...block);
  }
  return { content: render(board, lines), message: `Moved "${card.text}" from ${from.title} to ${to.title}.` };
}

export function removeCard(content: string, query: string): { content: string | null; message: string } {
  const board = parse(content);
  const { lane, card } = findCard(board, query);
  const lines = [...board.lines];
  lines.splice(card.start, card.end - card.start);
  return { content: render(board, lines), message: `Removed "${card.text}" from ${lane.title}.` };
}

export interface LaneView {
  lane: string;
  complete: boolean;
  cards: string[];
}

export function list(content: string, opts: { all?: boolean; lane?: string } = {}): LaneView[] {
  const board = parse(content);
  const lanes = opts.lane ? [findLane(board, opts.lane)] : board.lanes.filter((l) => opts.all || !l.complete);
  return lanes.map((l) => ({
    lane: l.title,
    complete: l.complete,
    cards: l.cards.filter((c) => opts.all || opts.lane || !c.done).map((c) => c.text),
  }));
}

export function formatList(views: LaneView[]): string {
  return views
    .map((v) => `${v.lane} (${v.cards.length})${v.cards.length ? "\n" + v.cards.map((c) => `- ${c}`).join("\n") : ""}`)
    .join("\n\n");
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const [cmd, ...rest] = args._;
  const file = flag(args, "file") ?? join(masterVault(), "Kanban.md");
  const text = rest.join(" ");
  const missing = `I can't find the Kanban board at ${file}.`;
  try {
    if (cmd === "list") {
      const content = await Bun.file(file).text().catch(() => fail(missing));
      const views = list(content, { all: flag(args, "all") === "true", lane: flag(args, "lane") });
      console.log(flag(args, "json") ? JSON.stringify(views, null, 2) : formatList(views));
      return;
    }
    const op = (c: string): { content: string | null; message: string } => {
      if (cmd === "add") return addCard(c, text, flag(args, "lane"));
      if (cmd === "move") return moveCard(c, text, flag(args, "to") ?? fail("move needs --to <lane>", 2));
      if (cmd === "remove") return removeCard(c, text);
      return fail("usage: kanban.ts list|add|move|remove …", 64);
    };
    const { value } = rewrite(file, (current) => {
      if (current === null) throw new Error(missing);
      const r = op(current);
      return { content: r.content, value: r.message };
    });
    console.log(value);
  } catch (e) {
    fail((e as Error).message, e instanceof ClarifyError ? 2 : 1);
  }
}

if (import.meta.main) main(process.argv.slice(2));
