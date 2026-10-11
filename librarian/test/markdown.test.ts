import { describe, expect, test } from "bun:test";
import {
  appendToSection,
  getFront,
  ItemNotFound,
  moveBetweenSections,
  parseNote,
  removeFromSection,
  sectionItems,
  serializeNote,
  setFront,
} from "../src/markdown";

const PROJECT = `---
status: active
repos: []
people: ["[[Sue]]", Ellen]
tags:
  - work
  - uni
custom:
  nested: true
---

# Amra

## Done

## To do

- [ ] Send Sue the budget draft
  with the Q3 numbers
- [ ] Book room

## Needs Leo
`;

describe("frontmatter", () => {
  test("parses scalars, flow lists with wikilinks, and block lists", () => {
    const n = parseNote(PROJECT);
    expect(getFront(n, "status")).toBe("active");
    expect(getFront(n, "repos")).toEqual([]);
    expect(getFront(n, "people")).toEqual(["[[Sue]]", "Ellen"]);
    expect(getFront(n, "tags")).toEqual(["work", "uni"]);
  });

  test("round-trips byte for byte when nothing changes", () => {
    expect(serializeNote(parseNote(PROJECT))).toBe(PROJECT);
  });

  test("set rewrites one key and keeps the rest, including YAML it doesn't model", () => {
    const n = parseNote(PROJECT);
    setFront(n, "slack_channels", ["#amra"]);
    setFront(n, "status", "paused");
    const out = serializeNote(n);
    expect(out).toContain('slack_channels: ["#amra"]');
    expect(out).toContain("status: paused");
    expect(out).toContain("custom:\n  nested: true");
    expect(out).toContain("tags:\n  - work\n  - uni");
    expect(getFront(parseNote(out), "slack_channels")).toEqual(["#amra"]);
  });

  test("a note without frontmatter gets one", () => {
    const n = parseNote("# Sue\n");
    setFront(n, "slack", "@sue");
    expect(serializeNote(n)).toBe("---\nslack: \"@sue\"\n---\n# Sue\n");
  });
});

describe("sections", () => {
  test("append into an empty section", () => {
    const body = parseNote(PROJECT).body;
    const out = appendToSection(body, "Done", ["Kickoff call"]);
    expect(out).toContain("## Done\n\n- Kickoff call\n\n## To do");
  });

  test("append after the last item, keeping continuation lines", () => {
    const out = appendToSection(parseNote(PROJECT).body, "to do", ["- [ ] Ping Ellen"]);
    expect(out).toContain("- [ ] Book room\n- [ ] Ping Ellen\n\n## Needs Leo");
  });

  test("append to the last section and to a missing one", () => {
    let out = appendToSection(parseNote(PROJECT).body, "Needs Leo", ["Approve the budget"]);
    expect(out.endsWith("## Needs Leo\n\n- Approve the budget\n")).toBe(true);
    out = appendToSection(out, "Links", ["[[Sue]]"]);
    expect(out.endsWith("- Approve the budget\n\n## Links\n\n- [[Sue]]\n")).toBe(true);
  });

  test("move ticks the box and carries continuation lines", () => {
    const out = moveBetweenSections(parseNote(PROJECT).body, "To do", "Done", "send sue the budget draft");
    expect(sectionItems(out, "To do")).toEqual(["- [ ] Book room"]);
    expect(out).toContain("## Done\n\n- [x] Send Sue the budget draft\n");
  });

  test("remove by unique substring; ambiguous or missing items throw", () => {
    const [out, removed] = removeFromSection(parseNote(PROJECT).body, "To do", "Book");
    expect(removed).toBe("- [ ] Book room");
    expect(out).not.toContain("Book room");
    expect(() => removeFromSection(PROJECT, "To do", "Nope nope")).toThrow(ItemNotFound);
    expect(() => removeFromSection("## A\n\n- foo bar one\n- foo bar two\n", "A", "foo bar")).toThrow(/matches 2/);
    expect(() => removeFromSection(PROJECT, "Missing", "x")).toThrow(/no "## Missing"/);
  });
});
