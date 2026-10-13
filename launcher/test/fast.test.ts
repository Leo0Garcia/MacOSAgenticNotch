import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLights, statusSentence } from "../src/fast";

const config = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "skills", "lights", "lights.json"), "utf8"));
const args = (r: string) => parseLights(r, config)?.args ?? null;

test("simple light commands are understood", () => {
  expect(args("turn the lights off")).toEqual(["set", "all", "off"]);
  expect(args("Jarvis, lights on please")).toEqual(["set", "all", "on"]);
  expect(args("turn off the lamp")).toEqual(["set", "lamp", "off"]);
  expect(args("lamp to 30%")).toEqual(["set", "lamp", "--brightness", "30"]);
  expect(args("set the desk lights to 40 percent")).toEqual(["set", "desk", "--brightness", "40"]);
  expect(args("make the bed lights red")).toEqual(["set", "bed", "--colour", "red"]);
  expect(args("bed and desk lights purple at 20%")).toEqual(["set", "bed,desk", "--brightness", "20", "--colour", "purple"]);
  expect(args("main light warm white")).toEqual(["set", "main", "--temp", "warm"]);
  expect(args("movie mode")).toEqual(["scene", "movie"]);
  expect(args("bedtime lights")).toEqual(["scene", "night"]);
  expect(args("are my lights on")).toEqual(["status"]);
});

test("anything else goes to Claude", () => {
  expect(args("turn the lights off in 10 minutes")).toBeNull();
  expect(args("dim the lamp a bit")).toBeNull();
  expect(args("what's the weather")).toBeNull();
  expect(args("turn on the kitchen lights")).toBeNull(); // no such light: Claude asks
  expect(args("lights")).toBeNull();
  expect(args("turn off my computer")).toBeNull();
});

test("confirmations and status read naturally", () => {
  expect(parseLights("turn the lights off", config)?.say).toBe("Done, all lights off.");
  expect(parseLights("bed and desk lights purple at 20%", config)?.say).toBe("Done, bed lights and desk lights purple at 20 percent.");
  expect(statusSentence("main: off\nlamp: on at 10%\nbed: on at 100%\ndesk: off")).toBe("The lamp at 10 percent and the bed lights at 100 percent are on; the rest are off.");
  expect(statusSentence("main: off\nlamp: off")).toBe("All your lights are off.");
});
