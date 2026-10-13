// Fast paths: requests simple enough to handle without a Claude run. Leo,
// 2026-10-13: light commands took 10+ s as a full run while his own Lights app
// is near instant. A request is handled here only when every word in it is
// understood; anything else (timing, "dim a bit", questions) goes to Claude.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface LightsConfig {
  lights: Record<string, { accessory: string; aliases?: string[] }>;
  scenes: Record<string, unknown>;
}

export interface LightsCommand {
  /** Arguments for skills/lights/lights.ts. */
  args: string[];
  /** What Jarvis says when it worked (status replies are built from the script's output). */
  say?: string;
}

const COLOURS = ["red", "orange", "amber", "yellow", "lime", "green", "teal", "cyan", "blue", "indigo", "purple", "violet", "magenta", "pink"];
const TEMPS: Record<string, string> = { warm: "warm", cool: "cool", cold: "cool", neutral: "neutral", white: "neutral", daylight: "cool" };
const SCENE_WORDS: Record<string, string> = { bedtime: "night", sleep: "night", film: "movie", cinema: "movie", study: "focus", work: "focus", working: "focus", relaxing: "relax", chill: "relax", full: "bright" };
const FILLER = new Set(["jarvis", "please", "can", "could", "you", "turn", "switch", "set", "make", "put", "change", "the", "my", "to", "a", "in", "of", "at", "and", "light", "lights", "colour", "color", "white", "mode", "scene", "percent", "per", "cent", "brightness", "now", "thanks", "thank", "up", "it", "them", "everything", "all", "room"]);

const words = (s: string) => s.toLowerCase().replace(/(\d+)\s*%/g, "$1 percent").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);

/** The light keys named in the request, in the order said; multi-word aliases match first. */
function findLights(text: string, config: LightsConfig): { keys: string[]; rest: string } {
  let t = ` ${words(text).join(" ")} `;
  const found: { key: string; at: number }[] = [];
  const names = Object.entries(config.lights)
    .flatMap(([k, l]) => [k, l.accessory, ...(l.aliases ?? [])].map((a) => [words(a).join(" "), k] as const))
    .sort((a, b) => b[0].length - a[0].length);
  for (const [alias, key] of names) {
    const at = alias ? t.indexOf(` ${alias} `) : -1;
    if (at < 0) continue;
    t = t.slice(0, at) + " " + "_".repeat(alias.length) + t.slice(at + alias.length + 1); // keep positions stable
    if (!found.some((f) => f.key === key)) found.push({ key, at });
  }
  return { keys: found.sort((a, b) => a.at - b.at).map((f) => f.key), rest: t.replace(/_+/g, " ").trim() };
}

/** A lights command when the whole request is one, else null. */
export function parseLights(request: string, config: LightsConfig): LightsCommand | null {
  const all = words(request);
  if (!all.some((w) => w === "light" || w === "lights" || w === "lamp" || Object.keys(config.lights).includes(w) || w === "mode" || w in SCENE_WORDS || w in config.scenes))
    return null;

  // "are my lights on", "which lights are on", "what are the lights at"
  if (/^(jarvis )?(are|is|which|what) (are )?(my |the |all )?(lights?|lamp)( are)? (on|off|at|doing)$/.test(all.join(" "))) return { args: ["status"] };

  const { keys, rest } = findLights(request, config);
  const left = rest.split(" ").filter(Boolean);
  let on: string | undefined, brightness: string | undefined, colour: string | undefined, temp: string | undefined, scene: string | undefined;
  const unknown: string[] = [];
  for (let i = 0; i < left.length; i++) {
    const w = left[i]!;
    if (w === "on" || w === "off") on = w;
    else if (/^\d{1,3}$/.test(w) && Number(w) <= 100 && (left[i + 1] === "percent" || left[i - 1] === "to" || left[i - 1] === "at")) brightness = w;
    else if (COLOURS.includes(w)) colour = w;
    else if (w in TEMPS && w !== "white") temp = TEMPS[w];
    else if (w in config.scenes && w !== "off") scene = w;
    else if (w in SCENE_WORDS) scene = SCENE_WORDS[w];
    else if (!FILLER.has(w)) unknown.push(w);
  }
  // "warm white" / "white" alone means a colour temperature
  if (!colour && !temp && left.includes("white")) temp = "neutral";
  if (unknown.length) return null; // "in 10 minutes", "a bit", "brighter"…: let Claude handle it

  if (scene && !keys.length && !on && !brightness && !colour && !temp) return { args: ["scene", scene], say: `Done, ${scene} lights.` };
  if (scene) return null;
  if (!on && !brightness && !colour && !temp) return null;

  const args = ["set", keys.length ? keys.join(",") : "all"];
  if (on && !brightness && !colour && !temp) args.push(on);
  if (on === "off") return { args: ["set", args[1]!, "off"], say: `Done, ${who(keys, config)} off.` };
  if (brightness) args.push("--brightness", brightness);
  if (colour) args.push("--colour", colour);
  if (temp) args.push("--temp", temp);
  const look = [colour ?? (temp ? `${temp} white` : ""), brightness ? `at ${brightness} percent` : ""].filter(Boolean).join(" ");
  return { args, say: `Done, ${who(keys, config)} ${look || "on"}.` };
}

function who(keys: string[], config: LightsConfig): string {
  if (!keys.length || keys.length === Object.keys(config.lights).length) return "all lights";
  const name = (k: string) => (k === "main" ? "main light" : k === "lamp" ? "lamp" : `${k} lights`);
  return keys.length === 1 ? name(keys[0]!) : `${keys.slice(0, -1).map(name).join(", ")} and ${name(keys.at(-1)!)}`;
}

/** "lamp: on at 10%\nmain: off" → one spoken sentence. */
export function statusSentence(output: string): string {
  const rows = output.trim().split("\n").map((l) => l.split(":").map((s) => s.trim()) as [string, string]);
  const on = rows.filter(([, s]) => s.startsWith("on"));
  if (!on.length) return "All your lights are off.";
  const name = (k: string) => (k === "main" ? "the main light" : k === "lamp" ? "the lamp" : `the ${k} lights`);
  const parts = on.map(([k, s]) => `${name(k)}${s.replace(/^on at (\d+)%$/, " at $1 percent").replace(/^on$/, "")}`);
  const list = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  const rest = rows.length > on.length ? "; the rest are off" : "";
  return `${list} ${parts.length === 1 ? "is" : "are"} on${rest}.`.replace(/^./, (c) => c.toUpperCase());
}

export function lightsConfig(repo: string): LightsConfig | null {
  const f = join(repo, "skills", "lights", "lights.json");
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}

/** "Thanks" and friends: answered instantly, like a person would. */
export function smallTalk(request: string): string | null {
  const r = request.toLowerCase().replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim().replace(/^jarvis /, "").replace(/ jarvis$/, "");
  if (/^(thanks|thank you|thank you very much|thanks a lot|cheers|ta|nice one|great thanks|perfect thanks|that's great thanks|brilliant thanks)$/.test(r)) return "You're welcome.";
  if (/^(good morning|morning)$/.test(r)) return "Good morning.";
  if (/^(good night|night)$/.test(r)) return "Good night.";
  return null;
}
