import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addCard, ClarifyError, list, moveCard, parse, removeCard } from "../kanban/kanban.ts";
import { ConcurrentEditError, rewrite } from "../lib/atomic.ts";

const FIXTURE = join(import.meta.dir, "fixtures/kanban/Kanban.md");
const board = readFileSync(FIXTURE, "utf8");
const tail = board.slice(board.indexOf("***"));
const KANBAN = join(import.meta.dir, "../kanban/kanban.ts");

function lane(content: string, title: string): string {
  const start = content.indexOf(`## ${title}`);
  const next = content.indexOf("\n## ", start + 1);
  return content.slice(start, next === -1 ? undefined : next);
}

describe("parse", () => {
  test("reads lanes, the Complete marker and multi-line cards", () => {
    const b = parse(board);
    expect(b.lanes.map((l) => l.title)).toEqual(["Not Started", "In-progress", "Completed"]);
    expect(b.lanes[2]!.complete).toBe(true);
    const read = b.lanes[0]!.cards[1]!;
    expect(read.text).toBe("Read chapter 4 of the compilers book");
    expect(read.end - read.start).toBe(2);
    expect(b.lanes[0]!.cards[2]!.text).toBe("email Sue about the slides");
  });

  test("ignores the archive", () => {
    expect(list(board, { all: true }).flatMap((l) => l.cards)).not.toContain("old archived card");
  });

  test("refuses a file that isn't a Kanban board", () => {
    expect(() => parse("# Notes\n\n- [ ] x\n")).toThrow(/Kanban board/);
  });

  test("strips a max-items suffix from lane titles", () => {
    const b = parse(board.replace("## In-progress", "## In-progress (3)"));
    expect(b.lanes[1]!.title).toBe("In-progress");
  });
});

describe("list", () => {
  test("outstanding = non-complete lanes", () => {
    expect(list(board)).toEqual([
      { lane: "Not Started", complete: false, cards: ["buy chalk", "Read chapter 4 of the compilers book", "email Sue about the slides"] },
      { lane: "In-progress", complete: false, cards: ["COMP2211 group report"] },
    ]);
  });
});

describe("add", () => {
  test("appends to the end of the first open lane, preserving everything else", () => {
    const { content } = addCard(board, "  water the plants ");
    expect(content).not.toBeNull();
    expect(lane(content!, "Not Started")).toContain("- [ ] email Sue about the slides ^k3j9a1\n- [ ] water the plants\n");
    expect(content!.slice(content!.indexOf("***"))).toBe(tail);
    expect(content!.startsWith("---\n\nkanban-plugin: board\n\n---\n")).toBe(true);
  });

  test("into a named lane, case-insensitively", () => {
    const { content } = addCard(board, "fix CI", "in progress");
    expect(lane(content!, "In-progress")).toContain("- [ ] COMP2211 group report\n- [ ] fix CI\n");
  });

  test("into the Complete lane is ticked", () => {
    const { content } = addCard(board, "already did it", "completed");
    expect(lane(content!, "Completed")).toContain("- [x] buy milk\n- [x] already did it\n");
  });

  test("into an empty lane", () => {
    const empty = board.replace("- [ ] COMP2211 group report\n", "");
    const { content } = addCard(empty, "new thing", "In-progress");
    expect(lane(content!, "In-progress")).toBe("## In-progress\n\n- [ ] new thing\n\n\n");
    expect(parse(content!).lanes[1]!.cards.map((c) => c.text)).toEqual(["new thing"]);
  });

  test("duplicate is a no-op", () => {
    expect(addCard(board, "Buy Chalk").content).toBeNull();
  });

  test("unknown lane asks", () => {
    expect(() => addCard(board, "x", "Someday")).toThrow(ClarifyError);
  });
});

describe("move", () => {
  test("to Completed ticks it and keeps continuation lines", () => {
    const { content, message } = moveCard(board, "chapter 4", "Completed");
    expect(message).toBe('Moved "Read chapter 4 of the compilers book" from Not Started to Completed.');
    expect(lane(content!, "Not Started")).not.toContain("chapter 4");
    expect(lane(content!, "Completed")).toContain("- [x] buy milk\n- [x] Read chapter 4 of the compilers book\n\tnotes in [[COMP2212]]\n");
    expect(content!.slice(content!.indexOf("***"))).toBe(tail);
  });

  test("out of Completed unticks it (moving backwards in the file)", () => {
    const { content } = moveCard(board, "buy milk", "Not Started");
    expect(lane(content!, "Not Started")).toContain("- [ ] email Sue about the slides ^k3j9a1\n- [ ] buy milk\n");
    expect(lane(content!, "Completed")).not.toContain("buy milk");
  });

  test("keeps the block id", () => {
    const { content } = moveCard(board, "email sue", "In-progress");
    expect(lane(content!, "In-progress")).toContain("- [ ] email Sue about the slides ^k3j9a1");
  });

  test("ambiguous match asks which", () => {
    expect(() => moveCard(board, "buy", "In-progress")).toThrow(/Several cards match "buy"/);
  });

  test("exact match beats substring", () => {
    const b = addCard(board, "buy chalk and pens").content!;
    expect(moveCard(b, "buy chalk", "In-progress").message).toContain('"buy chalk" from');
  });

  test("no match asks", () => {
    expect(() => moveCard(board, "nonexistent", "In-progress")).toThrow(ClarifyError);
  });
});

describe("remove", () => {
  test("deletes the whole card block", () => {
    const { content } = removeCard(board, "compilers");
    expect(content).not.toContain("compilers book");
    expect(content).not.toContain("notes in [[COMP2212]]");
    expect(content).toContain("- [ ] buy chalk\n- [ ] email Sue");
  });
});

describe("atomic write", () => {
  function tmpBoard(): string {
    const dir = mkdtempSync(join(tmpdir(), "kanban-"));
    const file = join(dir, "Kanban.md");
    copyFileSync(FIXTURE, file);
    return file;
  }

  test("CLI add writes through a temp file the guard allows and leaves no temp behind", () => {
    const file = tmpBoard();
    const r = Bun.spawnSync(["bun", KANBAN, "add", "call", "the", "bank", "--file", file]);
    expect(r.stdout.toString().trim()).toBe('Added "call the bank" to Not Started.');
    expect(readFileSync(file, "utf8")).toContain("- [ ] call the bank\n");
    expect(readdirSync(join(file, ".."))).toEqual(["Kanban.md"]);
  });

  test("CLI exit 2 for a question, 1 for a missing board", () => {
    const file = tmpBoard();
    const ask = Bun.spawnSync(["bun", KANBAN, "move", "buy", "--to", "Completed", "--file", file], { stderr: "pipe" });
    expect(ask.exitCode).toBe(2);
    expect(ask.stderr.toString()).toContain("Which one?");
    const missing = Bun.spawnSync(["bun", KANBAN, "list", "--file", "/nonexistent/Kanban.md"]);
    expect(missing.exitCode).toBe(1);
  });

  test("CLI list", () => {
    const r = Bun.spawnSync(["bun", KANBAN, "list", "--file", FIXTURE]);
    expect(r.stdout.toString()).toBe(
      "Not Started (3)\n- buy chalk\n- Read chapter 4 of the compilers book\n- email Sue about the slides\n\nIn-progress (1)\n- COMP2211 group report\n",
    );
  });

  test("retries once when Obsidian edits the file mid-write, keeping Leo's edit", () => {
    const file = tmpBoard();
    let bumped = false;
    rewrite(file, (c) => ({ ...addCard(c!, "from jarvis"), value: null }), {
      beforeWrite: (attempt) => {
        if (attempt === 0 && !bumped) {
          bumped = true;
          writeFileSync(file, readFileSync(file, "utf8").replace("- [ ] buy chalk", "- [ ] buy chalk\n- [ ] typed in obsidian"));
          const t = Date.now() / 1000 + 5;
          utimesSync(file, t, t);
        }
      },
    });
    const out = readFileSync(file, "utf8");
    expect(out).toContain("- [ ] typed in obsidian");
    expect(out).toContain("- [ ] from jarvis");
  });

  test("gives up after a second concurrent edit", () => {
    const file = tmpBoard();
    let n = 0;
    expect(() =>
      rewrite(file, (c) => ({ ...addCard(c!, "x" + n), value: null }), {
        beforeWrite: () => {
          const t = Date.now() / 1000 + 10 + n++;
          utimesSync(file, t, t);
        },
      }),
    ).toThrow(ConcurrentEditError);
    expect(readFileSync(file, "utf8")).toBe(board);
    expect(existsSync(file)).toBe(true);
  });
});
