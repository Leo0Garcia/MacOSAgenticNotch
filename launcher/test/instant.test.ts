import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findApp, parseInstant } from "../src/instant";

test("whole requests become instant commands", () => {
  expect(parseInstant("Jarvis, remind me to call Mum at 6pm")).toEqual({ kind: "remind", when: "at 6pm", text: "Call Mum" });
  expect(parseInstant("remind me in 20 minutes to take the pizza out")).toEqual({ kind: "remind", when: "in 20 minutes", text: "Take the pizza out" });
  expect(parseInstant("remind me to buy milk tomorrow at 9am")).toEqual({ kind: "remind", when: "tomorrow at 9am", text: "Buy milk" });
  expect(parseInstant("set a timer for 10 minutes")).toEqual({ kind: "timer", amount: 10, unit: "minute" });
  expect(parseInstant("start a five minute timer")).toEqual({ kind: "timer", amount: 5, unit: "minute" });
  expect(parseInstant("What's my next lecture today?")).toEqual({ kind: "next" });
  expect(parseInstant("add buy chalk to my Kanban")).toEqual({ kind: "kanban", text: "buy chalk" });
  expect(parseInstant("turn the volume down")).toEqual({ kind: "volume", by: -15 });
  expect(parseInstant("set volume to 40%")).toEqual({ kind: "volume", to: 40 });
  expect(parseInstant("mute")).toEqual({ kind: "volume", mute: true });
  expect(parseInstant("open Spotify please")).toEqual({ kind: "open", app: "Spotify" });
});

test("anything else goes to Claude", () => {
  for (const r of ["remind me about the thing", "remind me to call Mum sometime", "what's the weather", "open my notes", "open this file", "set volume to 300", "add it to my calendar", "set a timer for ages"])
    expect(parseInstant(r)).toBeNull();
});

test("apps are found by name, case-insensitively", () => {
  const d = mkdtempSync(join(tmpdir(), "apps-"));
  mkdirSync(join(d, "Spotify.app"));
  expect(findApp("spotify", [d])).toBe(join(d, "Spotify.app"));
  expect(findApp("Spot", [d])).toBeNull();
});

test("the day rundown covers lectures, calendar, Kanban and Moodle in a few sentences", () => {
  const { dayBriefing } = require("../src/instant");
  const now = new Date("2026-10-16T08:00:00Z"); // 9am London
  const ev = (title: string, start: string, end: string, source = "timetable") => ({ title, start, end, source });
  const text = dayBriefing(
    now,
    [ev("COMP2311 L3 - Theory of Computing", "2026-10-16T11:00:00Z", "2026-10-16T12:00:00Z"), ev("COMP2312 L1 - Programming III", "2026-10-16T13:00:00Z", "2026-10-16T14:00:00Z"), ev("Group meeting", "2026-10-16T12:00:00Z", "2026-10-16T13:00:00Z", "apple"), ev("Old", "2026-10-16T06:00:00Z", "2026-10-16T07:00:00Z")],
    ["[[COMP2311 - Tutorial 2|Do the tutorial for theory of computing]] @{2026-10-16} #comp2311", "Buy chalk @{2026-10-20}", "Need to do washing"],
    [{ title: "Group report", course: "COMP2211", due: "2026-10-20T15:00:00Z" }, { title: "Way later", course: null, due: "2026-12-01T12:00:00Z" }],
  );
  expect(text).toBe(
    "Good morning. You've got 2 lectures left today: Theory of Computing at 12:00 and Programming III at 14:00. On your calendar: Group meeting at 13:00. Due on your Kanban: Do the tutorial for theory of computing. Coming up on Moodle: Group report for COMP2211, Tuesday at 16:00.",
  );
});

test("'what's my day' and friends are the rundown", () => {
  for (const r of ["What's my day?", "what's my day look like", "brief me", "what have I got today", "what's on today"]) expect(parseInstant(r)).toEqual({ kind: "day" });
});
