#!/usr/bin/env bun
// Leo's room lights through the Homebridge UI's REST API (config-ui-x, auth "none").
// Which lights exist and what the scenes do lives in lights.json, so adding a light or
// another room is a config edit, not a code change.
//
//   bun lights.ts status [--json]
//   bun lights.ts set <light[,light…]|all> [on|off|toggle] [--brightness N] [--colour <name|#hex>] [--temp warm|neutral|cool|<kelvin>]
//   bun lights.ts scene <name>
//   bun lights.ts scenes
//
// --config <path> overrides lights.json. Exit 2 = Leo needs to clarify (unknown light,
// scene or colour); exit 1 = Homebridge or a light didn't answer.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fail, flag, parseArgs } from "../lib/env.ts";

export interface Spec {
  on?: boolean | "toggle";
  brightness?: number;
  colour?: string;
  temp?: string;
}

export interface Config {
  homebridge: string;
  lights: Record<string, { accessory: string; aliases?: string[] }>;
  scenes: Record<string, Record<string, Spec>>;
}

export interface Characteristic {
  type: string;
  value: unknown;
  minValue?: number;
  maxValue?: number;
  canWrite?: boolean;
}

export interface Accessory {
  uniqueId: string;
  serviceName: string;
  type: string;
  serviceCharacteristics: Characteristic[];
}

export interface Write {
  characteristicType: string;
  value: boolean | number;
}

export class ClarifyError extends Error {}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9#]+/g, " ").trim();

/** "lamp", "desk lights,bed", "all" → config keys. */
export function resolveTargets(config: Config, query: string): string[] {
  const q = norm(query);
  if (["all", "everything", "all lights", "lights", "room", "my room"].includes(q)) return Object.keys(config.lights);
  const out: string[] = [];
  for (const part of query.split(/,|\band\b|\+/).map(norm).filter(Boolean)) {
    const key = Object.keys(config.lights).find((k) => {
      const l = config.lights[k]!;
      return [k, l.accessory, ...(l.aliases ?? [])].map(norm).includes(part);
    });
    if (!key) throw new ClarifyError(`There's no light called "${part}". Lights: ${Object.keys(config.lights).join(", ")}.`);
    if (!out.includes(key)) out.push(key);
  }
  if (!out.length) throw new ClarifyError("Which light?");
  return out;
}

const COLOURS: Record<string, [number, number]> = {
  red: [0, 100], orange: [30, 100], amber: [38, 100], yellow: [55, 100], lime: [90, 100], green: [120, 100],
  teal: [170, 100], cyan: [185, 100], blue: [230, 100], indigo: [255, 100], purple: [275, 100], violet: [285, 80],
  magenta: [300, 100], pink: [330, 60], white: [0, 0],
};

/** Colour name or #rrggbb → HomeKit hue (0-360) and saturation (0-100). */
export function parseColour(input: string): [number, number] {
  const c = norm(input);
  if (COLOURS[c]) return COLOURS[c]!;
  const hex = /^#?([0-9a-f]{6})$/i.exec(input.trim());
  if (!hex) throw new ClarifyError(`I don't know the colour "${input}". Try ${Object.keys(COLOURS).join(", ")} or a hex code.`);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [Math.round((h * 60 + 360) % 360), Math.round(max ? (d / max) * 100 : 0)];
}

const TEMPS: Record<string, number> = { warm: 2700, "warm white": 2700, neutral: 4000, white: 4000, cool: 6500, "cool white": 6500, daylight: 6500 };

/** warm|neutral|cool|<kelvin> → mireds, the unit HomeKit's ColorTemperature uses. */
export function parseTemp(input: string): number {
  const t = norm(input).replace(/k$/, "");
  const kelvin = TEMPS[t] ?? Number(t);
  if (!Number.isFinite(kelvin) || kelvin < 1000 || kelvin > 10000) throw new ClarifyError(`I don't understand the colour temperature "${input}". Try warm, neutral, cool or a Kelvin value.`);
  return Math.round(1_000_000 / kelvin);
}

function char(acc: Accessory, type: string): Characteristic | undefined {
  return acc.serviceCharacteristics.find((c) => c.type === type);
}

function clamp(c: Characteristic, v: number): number {
  return Math.round(Math.min(c.maxValue ?? v, Math.max(c.minValue ?? v, v)));
}

/** The characteristic writes that take one accessory to `spec`, in the order HomeKit apps send them. */
export function plan(acc: Accessory, spec: Spec): Write[] {
  const writes: Write[] = [];
  const isOn = Boolean(char(acc, "On")?.value);
  const wantsLook = spec.brightness !== undefined || spec.colour !== undefined || spec.temp !== undefined;
  const on = spec.on === "toggle" ? !isOn : spec.on ?? (wantsLook ? true : undefined);
  if (on !== undefined) writes.push({ characteristicType: "On", value: on });
  if (on === false) return writes;
  const bri = char(acc, "Brightness");
  if (spec.brightness !== undefined && bri) writes.push({ characteristicType: "Brightness", value: clamp(bri, spec.brightness) });
  if (spec.colour !== undefined) {
    const [h, s] = parseColour(spec.colour);
    const hue = char(acc, "Hue"), sat = char(acc, "Saturation");
    if (!hue || !sat) throw new ClarifyError(`${acc.serviceName} can't change colour.`);
    writes.push({ characteristicType: "Hue", value: h }, { characteristicType: "Saturation", value: s });
  } else if (spec.temp !== undefined) {
    const ct = char(acc, "ColorTemperature");
    if (!ct) throw new ClarifyError(`${acc.serviceName} can't change colour temperature.`);
    writes.push({ characteristicType: "ColorTemperature", value: clamp(ct, parseTemp(spec.temp)) });
  }
  return writes;
}

export function describe(acc: Accessory): string {
  if (!char(acc, "On")?.value) return "off";
  const parts = ["on"];
  const bri = char(acc, "Brightness")?.value;
  if (typeof bri === "number") parts.push(`${bri}%`);
  return parts.join(" at ");
}

// ---- Homebridge -------------------------------------------------------------

class Homebridge {
  private token?: string;
  constructor(private base: string) {}

  private async call(method: string, path: string, body?: unknown, ms = 20_000): Promise<any> {
    this.token ??= (await (await fetch(`${this.base}/api/auth/noauth`, { method: "POST", signal: AbortSignal.timeout(5_000) })).json()).access_token;
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(ms),
    });
    if (!res.ok) throw new Error(`Homebridge said ${res.status} to ${method} ${path}`);
    return res.json();
  }

  async lights(): Promise<Accessory[]> {
    const all: Accessory[] = await this.call("GET", "/api/accessories");
    return all.filter((a) => a.type === "Lightbulb");
  }

  write(acc: Accessory, w: Write): Promise<unknown> {
    return this.call("PUT", `/api/accessories/${acc.uniqueId}`, w, 10_000);
  }

  restart(): Promise<unknown> {
    return this.call("PUT", "/api/server/restart");
  }
}

/** The accessory list, restarting Homebridge once if it has stopped answering (stale mDNS after a network change). */
async function loadLights(hb: Homebridge, config: Config): Promise<Accessory[]> {
  const wanted = Object.values(config.lights).map((l) => l.accessory);
  const complete = (accs: Accessory[]) => wanted.every((n) => accs.some((a) => a.serviceName === n));
  try {
    const accs = await hb.lights();
    if (complete(accs)) return accs;
  } catch (e) {
    if ((e as Error).name !== "TimeoutError" && !String(e).includes("Homebridge said")) {
      fail(`Homebridge isn't running at ${config.homebridge}. Start it from the Homebridge app or with hb-service start.`);
    }
  }
  console.error("Homebridge wasn't answering; restarting it once.");
  await hb.restart().catch(() => {});
  const deadline = Date.now() + 90_000;
  let accs: Accessory[] = [];
  while (Date.now() < deadline) {
    await Bun.sleep(5_000);
    accs = await hb.lights().catch(() => []);
    if (complete(accs)) return accs;
  }
  const missing = wanted.filter((n) => !accs.some((a) => a.serviceName === n));
  fail(`Homebridge still can't see ${missing.join(", ")} after a restart. Check they're powered and on the Wi-Fi.`);
}

async function apply(hb: Homebridge, config: Config, accs: Accessory[], changes: [string, Spec][]): Promise<string[]> {
  const said: string[] = [];
  const errors: string[] = [];
  await Promise.all(
    changes.map(async ([key, spec]) => {
      const acc = accs.find((a) => a.serviceName === config.lights[key]!.accessory)!;
      try {
        for (const w of plan(acc, spec)) await hb.write(acc, w);
        const on = spec.on === "toggle" ? !char(acc, "On")?.value : spec.on ?? true;
        const bits = [on ? "on" : "off"];
        if (on && spec.brightness !== undefined) bits.push(`at ${spec.brightness}%`);
        if (on && spec.colour) bits.push(spec.colour);
        else if (on && spec.temp) bits.push(spec.temp);
        said.push(`${key}: ${bits.join(" ")}`);
      } catch (e) {
        if (e instanceof ClarifyError) throw e;
        errors.push(`${key} didn't respond`);
      }
    }),
  );
  if (errors.length) fail([...said, ...errors].join("; "));
  return said;
}

function loadConfig(path: string): Config {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(flag(args, "config") ?? join(import.meta.dir, "lights.json"));
  const [cmd, ...rest] = args._;
  const hb = new Homebridge(config.homebridge);

  if (cmd === "scenes") {
    console.log(`Scenes: ${Object.keys(config.scenes).join(", ")}.`);
    return;
  }

  if (cmd === "status") {
    const accs = await loadLights(hb, config);
    const rows = Object.entries(config.lights).map(([key, l]) => {
      const acc = accs.find((a) => a.serviceName === l.accessory)!;
      return { light: key, state: describe(acc), on: Boolean(char(acc, "On")?.value), brightness: char(acc, "Brightness")?.value };
    });
    console.log(flag(args, "json") ? JSON.stringify(rows, null, 2) : rows.map((r) => `${r.light}: ${r.state}`).join("\n"));
    return;
  }

  if (cmd === "scene") {
    const name = norm(rest.join(" "));
    const scene = config.scenes[name];
    if (!scene) throw new ClarifyError(`There's no scene called "${name}". Scenes: ${Object.keys(config.scenes).join(", ")}.`);
    const changes: [string, Spec][] = scene.all ? Object.keys(config.lights).map((k) => [k, scene.all!]) : Object.entries(scene).map(([k, s]) => [resolveTargets(config, k)[0]!, s]);
    const accs = await loadLights(hb, config);
    console.log(`Scene ${name}. ${(await apply(hb, config, accs, changes)).join("; ")}`);
    return;
  }

  if (cmd === "set") {
    const words = [...rest];
    const action = ["on", "off", "toggle"].includes(words.at(-1)!) ? words.pop()! : undefined;
    const targets = resolveTargets(config, words.join(" "));
    const spec: Spec = {};
    if (action) spec.on = action === "toggle" ? "toggle" : action === "on";
    const bri = flag(args, "brightness");
    if (bri !== undefined) {
      const n = Number(bri.replace(/%$/, ""));
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new ClarifyError(`Brightness has to be 0 to 100, not "${bri}".`);
      if (n === 0) spec.on = false;
      else spec.brightness = n;
    }
    spec.colour = flag(args, "colour") ?? flag(args, "color");
    spec.temp = flag(args, "temp");
    if (spec.colour) parseColour(spec.colour);
    if (spec.temp) parseTemp(spec.temp);
    if (spec.on === undefined && spec.brightness === undefined && !spec.colour && !spec.temp) throw new ClarifyError("On, off, a brightness or a colour?");
    const accs = await loadLights(hb, config);
    console.log((await apply(hb, config, accs, targets.map((k) => [k, spec]))).join("; "));
    return;
  }

  fail("usage: lights.ts status | set <light|all> [on|off|toggle] [--brightness N] [--colour X] [--temp T] | scene <name> | scenes", 2);
}

if (import.meta.main) {
  main().catch((e) => fail((e as Error).message, e instanceof ClarifyError ? 2 : 1));
}
