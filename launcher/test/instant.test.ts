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
