#!/usr/bin/env bun
// One exact sentence for Leo when a run is missing something, or when guard blocked it.
//
//   bun ask.ts connector <name>
//   bun ask.ts login <site>
//   bun ask.ts permission <microphone|accessibility|full-disk|screen-recording|automation:<App>>
//   bun ask.ts key <keychain-name>                 e.g. uni-ical  (service jarvis/<name>)
//   bun ask.ts chrome
//   bun ask.ts mcp <server-name>
//   bun ask.ts guard "<permissionDecisionReason>"  the guard:<rule-id>: … text from a denial
//
// Prints {"say": "...", "wait": bool}. wait=true means Leo can fix it while the run
// waits (ask through the bridge, then retry once); false means say it and end the run.
import { fail } from "../lib/env.ts";

export interface Ask {
  say: string;
  wait: boolean;
}

const CONNECTORS_URL = "claude.ai/customize/connectors";

// Display names for things Leo is likely to name loosely.
const KNOWN_CONNECTORS: Record<string, string> = {
  slack: "Slack",
  notion: "Notion",
  gmail: "Gmail",
  "google calendar": "Google Calendar",
  gcal: "Google Calendar",
  "google drive": "Google Drive",
  drive: "Google Drive",
  github: "GitHub",
  linear: "Linear",
  spotify: "Spotify",
  figma: "Figma",
  asana: "Asana",
  jira: "Jira",
};

const KNOWN_SITES: Record<string, { name: string; host: string }> = {
  moodle: { name: "Moodle", host: "moodle.ecs.soton.ac.uk" },
  "moodle.ecs.soton.ac.uk": { name: "Moodle", host: "moodle.ecs.soton.ac.uk" },
};

// System Settings > Privacy & Security panes (macOS 15).
const PERMISSIONS: Record<string, string> = {
  microphone: "Microphone",
  accessibility: "Accessibility",
  "full-disk": "Full Disk Access",
  "full disk": "Full Disk Access",
  "screen-recording": "Screen & System Audio Recording",
  screen: "Screen & System Audio Recording",
};

const KEYS: Record<string, string> = {
  "uni-ical": "your university timetable link",
};

export const RULE_NAMES: Record<string, string> = {
  "no-money": "no money or financial actions",
  "no-real-consequences": "nothing that signs, submits or has real-life consequences for you",
  "no-contacting-as-leo": "no contacting anyone as you",
  "no-harm": "nothing that could cause harm or lose data",
};

function title(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function connector(name: string): Ask {
  const display = KNOWN_CONNECTORS[name.toLowerCase().trim()] ?? title(name.trim());
  return { say: `I need the ${display} connector for that. Connect it at ${CONNECTORS_URL} and ask again.`, wait: false };
}

export function login(site: string): Ask {
  const known = KNOWN_SITES[site.toLowerCase().trim()];
  const name = known ? `${known.name} (${known.host})` : site.trim();
  return { say: `Log in to ${name} in Chrome and tell me when you're done.`, wait: true };
}

export function permission(kind: string): Ask {
  const k = kind.toLowerCase().trim();
  const auto = /^automation:(.+)$/i.exec(kind.trim());
  if (auto) {
    return {
      say: `I need permission to control ${auto[1]}. Allow it in System Settings, Privacy & Security, Automation, then ask again.`,
      wait: false,
    };
  }
  const pane = PERMISSIONS[k];
  if (!pane) return { say: `I need the ${kind.trim()} permission for that. Approve it when macOS asks, then ask again.`, wait: false };
  return { say: `This needs ${pane} access. Approve the prompt, or turn it on in System Settings, Privacy & Security, ${pane}, then ask again.`, wait: false };
}

export function key(name: string): Ask {
  const n = name.replace(/^jarvis\//, "").trim();
  const what = KEYS[n] ?? `the ${n} key`;
  return {
    say: `I need ${what} in Keychain. Run security add-generic-password -s jarvis/${n} -a jarvis -w in Terminal, paste it when asked, then ask again.`,
    wait: false,
  };
}

export function chrome(): Ask {
  return {
    say: "I can't reach Chrome. Open Chrome with the Claude extension signed in to your account, then ask again.",
    wait: false,
  };
}

export function mcp(server: string): Ask {
  return { say: `The ${server.trim()} tools didn't load for this run. Check it with claude mcp list, then ask again.`, wait: false };
}

/** Turn a guard denial reason into "I can't do that (rule) because … I can … instead." */
export function guard(reason: string): Ask {
  const m = /guard:([a-z-]+):\s*(.*?)(?:\.\s*Safe alternative:\s*(.*))?$/s.exec(reason.trim());
  if (!m) return { say: "My safety rules blocked that, so I stopped.", wait: false };
  const [, id, why, alt] = m;
  const rule = RULE_NAMES[id!] ?? id!;
  const offer = alt?.trim().replace(/\.$/, "");
  // Line references into blocked-domains.txt are for the log, not for speech.
  const because = why!.trim().replace(/\s*\([^)]*\bline \d+\)$/, "").replace(/\.$/, "");
  return {
    say: `I can't do that: it breaks my rule of ${rule} (${because}).${offer ? ` ${offer[0]!.toUpperCase()}${offer.slice(1)}.` : ""}`,
    wait: false,
  };
}

export function build(kind: string, arg: string): Ask {
  switch (kind) {
    case "connector":
      return connector(arg);
    case "login":
      return login(arg);
    case "permission":
      return permission(arg);
    case "key":
      return key(arg);
    case "chrome":
      return chrome();
    case "mcp":
      return mcp(arg);
    case "guard":
      return guard(arg);
    default:
      throw new Error(`unknown kind ${kind}`);
  }
}

if (import.meta.main) {
  const [kind, ...rest] = process.argv.slice(2);
  const arg = rest.join(" ");
  if (!kind || (kind !== "chrome" && !arg)) fail("usage: ask.ts connector|login|permission|key|chrome|mcp|guard <name>", 64);
  try {
    console.log(JSON.stringify(build(kind, arg)));
  } catch (e) {
    fail((e as Error).message, 64);
  }
}
