import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner } from "../../bridge/src/system";
import { configFromEnv } from "../src/config";
import { cardText, scout, scoutPlist } from "../src/scout";

const lanes = [
  { lane: "This week", complete: false, cards: ["[[COMP2311 - Lecture 17|Write notes: COMP2311 Lecture 17]] #comp2311 %%src:moodle:x|https://m/x.pdf%%", "Pay the gym membership @{2026-11-09}", "Buy chalk"] },
  { lane: "Done", complete: true, cards: ["Old thing"] },
];

function world() {
  const home = mkdtempSync(join(tmpdir(), "jarvis-scout-"));
  mkdirSync(join(home, "Jarvis", "state"), { recursive: true });
  const c = configFromEnv({ HOME: home, JARVIS_REPO: "/r" });
  const calls: string[][] = [];
  let classified = 0;
  const run: Runner = async (cmd) => {
    calls.push(cmd);
    if (cmd.some((x) => x.endsWith("kanban.ts"))) return { code: 0, stdout: JSON.stringify(lanes), stderr: "" };
    if (cmd.includes("--json-schema")) {
      classified++;
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          is_error: false,
          structured_output: {
            cards: [
              { index: 0, doable: "yes", request: "Write my COMP2311 Lecture 17 notes from the Moodle slides", offer: "write the notes from the slides" },
              { index: 1, doable: "safe", request: "Remind me to pay the gym membership tomorrow at 9am", offer: "set you a reminder to pay it" },
              { index: 2, doable: "no", request: "", offer: "" },
            ],
          },
        }),
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { c, calls, run, classified: () => classified };
}

const noon = new Date("2026-11-08T12:00:00Z");

test("new cards Jarvis can do are asked about; a yes sends the request, nothing runs without one", async () => {
  const w = world();
  const asked: string[] = [];
  const answers = ["Not now", "Do it"];
  const link = { ask: async (m: { question: string }) => (asked.push(m.question), { type: "answer" as const, id: "x", text: answers.shift()!, via: "button" as const }), close() {} };
  const out = await scout(w.c, { now: noon, run: w.run, link: link as any, kanbanFile: "/nonexistent" });
  expect(asked).toEqual([
    "From your Kanban: “Write notes: COMP2311 Lecture 17”. I could write the notes from the slides.",
    "From your Kanban: “Pay the gym membership”. That one's yours to do, but I could set you a reminder to pay it.",
  ]);
  expect(w.calls.find((c) => c[0] === "open")).toEqual(["open", "jarvis://ask?q=Remind%20me%20to%20pay%20the%20gym%20membership%20tomorrow%20at%209am"]);
  expect(out).toContain("3 new card(s)");
  // The next look doesn't re-sort or re-ask the same cards.
  const again = await scout(w.c, { now: noon, run: w.run, link: link as any, kanbanFile: "/nonexistent" });
  expect(w.classified()).toBe(1);
  expect(again).toContain("nothing asked");
});

test("with the notch app closed nothing is lost; at night it waits", async () => {
  const w = world();
  const closed = { ask: async () => null, close() {} };
  expect(await scout(w.c, { now: noon, run: w.run, link: closed as any, kanbanFile: "/nonexistent" })).toContain("notch app not open");
  const state = JSON.parse(readFileSync(join(w.c.home, "state", "kanban-scout.json"), "utf8"));
  expect(Object.values(state).filter((v: any) => v.status === "pending")).toHaveLength(2);
  expect(await scout(w.c, { now: new Date("2026-11-08T23:30:00Z"), run: w.run, link: closed as any })).toContain("quiet hours");
});

test("cards read as Leo sees them, and the agent watches the board", () => {
  expect(cardText("[[COMP2311 - Tutorial 6|Do Tutorial 6]] #comp2311 @{2026-11-08} %%src:x%%")).toBe("Do Tutorial 6");
  const p = scoutPlist(configFromEnv({ HOME: "/h", JARVIS_REPO: "/r" }), "/v/Kanban.md");
  expect(p).toContain("<key>WatchPaths</key>\n\t<array>\n\t\t<string>/v/Kanban.md</string>");
  expect(p).toContain("<string>kanban-scout</string>");
  expect(p).not.toContain("StartCalendarInterval");
});
