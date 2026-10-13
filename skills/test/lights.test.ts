// lights.ts: target names, colours and the HomeKit writes for each request.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Accessory, type Config, ClarifyError, parseColour, parseTemp, plan, resolveTargets } from "../lights/lights.ts";

const config: Config = JSON.parse(readFileSync(join(import.meta.dir, "../lights/lights.json"), "utf8"));

function bulb(on: boolean, extra: Partial<Record<"Brightness" | "Hue" | "Saturation" | "ColorTemperature", number>> = {}): Accessory {
  const ranges: Record<string, [number, number]> = { Brightness: [0, 100], Hue: [0, 360], Saturation: [0, 100], ColorTemperature: [140, 500] };
  return {
    uniqueId: "abc",
    serviceName: "Desk lights",
    type: "Lightbulb",
    serviceCharacteristics: [
      { type: "On", value: on ? 1 : 0 },
      ...Object.entries(extra).map(([type, value]) => ({ type, value, minValue: ranges[type]![0], maxValue: ranges[type]![1], canWrite: true })),
    ],
  };
}

describe("resolveTargets", () => {
  test("aliases, accessory names and lists", () => {
    expect(resolveTargets(config, "lamp")).toEqual(["lamp"]);
    expect(resolveTargets(config, "Smart Bulb")).toEqual(["lamp"]);
    expect(resolveTargets(config, "bed lights, desk")).toEqual(["bed", "desk"]);
    expect(resolveTargets(config, "bed and desk lights")).toEqual(["bed", "desk"]);
    expect(resolveTargets(config, "big light")).toEqual(["main"]);
  });
  test("all", () => expect(resolveTargets(config, "all")).toEqual(["main", "lamp", "bed", "desk"]));
  test("unknown light asks Leo", () => expect(() => resolveTargets(config, "fan")).toThrow(ClarifyError));
});

test("every scene names real lights", () => {
  for (const scene of Object.values(config.scenes)) {
    for (const key of Object.keys(scene)) if (key !== "all") expect(resolveTargets(config, key)).toHaveLength(1);
  }
});

describe("colours", () => {
  test("names and hex", () => {
    expect(parseColour("red")).toEqual([0, 100]);
    expect(parseColour("#0000ff")).toEqual([240, 100]);
    expect(parseColour("00ff00")).toEqual([120, 100]);
    expect(() => parseColour("sparkly")).toThrow(ClarifyError);
  });
  test("temperature in mireds", () => {
    expect(parseTemp("warm")).toBe(370);
    expect(parseTemp("cool")).toBe(154);
    expect(parseTemp("4000K")).toBe(250);
    expect(() => parseTemp("hot")).toThrow(ClarifyError);
  });
});

describe("plan", () => {
  const full = { Brightness: 35, Hue: 270, Saturation: 55, ColorTemperature: 140 };
  test("off is just On=false", () => expect(plan(bulb(true, full), { on: false, brightness: 50 })).toEqual([{ characteristicType: "On", value: false }]));
  test("toggle flips", () => {
    expect(plan(bulb(true, full), { on: "toggle" })).toEqual([{ characteristicType: "On", value: false }]);
    expect(plan(bulb(false, full), { on: "toggle" })).toEqual([{ characteristicType: "On", value: true }]);
  });
  test("brightness and colour turn it on", () =>
    expect(plan(bulb(false, full), { brightness: 40, colour: "blue" })).toEqual([
      { characteristicType: "On", value: true },
      { characteristicType: "Brightness", value: 40 },
      { characteristicType: "Hue", value: 230 },
      { characteristicType: "Saturation", value: 100 },
    ]));
  test("temperature clamps to the light's range", () =>
    expect(plan(bulb(true, full), { temp: "1000" })).toEqual([{ characteristicType: "On", value: true }, { characteristicType: "ColorTemperature", value: 500 }]));
  test("colour on a white-only light asks Leo", () => expect(() => plan(bulb(true, { Brightness: 50 }), { colour: "red" })).toThrow(ClarifyError));
});
