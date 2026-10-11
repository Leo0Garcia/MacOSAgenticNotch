import { expect, test } from "bun:test";
import { SentenceSplitter, speakable } from "../src/sentences";

function feed(chunks: string[]) {
  const s = new SentenceSplitter();
  const out: string[][] = chunks.map((c) => s.push(c));
  return { perChunk: out, rest: s.flush() };
}

test("the first sentence is ready as soon as the next one starts", () => {
  const { perChunk, rest } = feed(["It's 14 degrees", " and cloudy. Rain", " later."]);
  expect(perChunk).toEqual([[], ["It's 14 degrees and cloudy."], []]);
  expect(rest).toEqual(["Rain later."]);
});

test("decimals, domains and abbreviations don't end a sentence", () => {
  const { perChunk, rest } = feed(["It costs 3.5 pounds on example.com, e.g. today. Dr. Smith agrees! Next"]);
  expect(perChunk[0]).toEqual(["It costs 3.5 pounds on example.com, e.g. today.", "Dr. Smith agrees!"]);
  expect(rest).toEqual(["Next"]);
});

test("line breaks end list items", () => {
  const { perChunk } = feed(["You have:\n- **Maths** at 9\n- Physics at 11\n"]);
  expect(perChunk[0]).toEqual(["You have:", "Maths at 9", "Physics at 11"]);
});

test("closing quotes stay with their sentence", () => {
  const { perChunk } = feed(['He said "done." Then left. ']);
  expect(perChunk[0]).toEqual(['He said "done."', "Then left."]);
});

test("speakable strips markdown", () => {
  expect(speakable("See [the docs](https://x.y) and `npm test`, **now**.")).toBe("See the docs and npm test, now.");
  expect(speakable("```\ncode\n```")).toBe("");
});
