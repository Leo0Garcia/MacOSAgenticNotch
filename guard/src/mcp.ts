// MCP tool checks by tool name and input: sending, money, deleting, credentials,
// browser uploads and submits, and deletes or moves through the master-vault Obsidian server.

import type { GuardContext } from "./context";
import { deny, type Denial } from "./rules";

export interface McpName {
  server: string;
  tool: string;
  words: string[];
}

export function parseMcpName(name: string): McpName | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!m) return null;
  const tool = m[2]!;
  const words = tool
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_\-\s.]+/)
    .filter(Boolean);
  return { server: m[1]!, tool, words };
}

const READ_VERBS = new Set(["get", "list", "read", "search", "view", "fetch", "find", "show", "query", "describe", "count", "aggregate", "lookup", "check", "analyze", "preview", "help", "browse", "filter"]);

// No-contacting-as-leo
const SEND_WORDS = new Set(["send", "reply", "forward", "respond", "invite", "share", "dm", "sms", "tweet", "broadcast", "boardcast", "rsvp", "email"]);
const DRAFT_SAFE = /(^|_)create_draft$|^draft_|(^|_)message_draft$|(^|_)send_message_draft$|^save_draft$/i;
const COMMENT_WORDS = new Set(["comment", "comments"]);
const CREATE_VERBS = new Set(["create", "add", "post", "submit", "reply", "write", "publish"]);

// No-money
const MONEY_WORDS = new Set(["buy", "purchase", "pay", "payment", "checkout", "withdraw", "deposit", "transfer", "onramp", "subscribe", "stake", "unstake", "trade", "trading", "tpsl", "leverage", "invoice", "refund", "donate", "tip", "bet", "wager"]);
const ORDER_WORDS = new Set(["order", "orders", "position", "positions", "trade", "trades"]);
const ACT_VERBS = new Set(["execute", "place", "submit", "cancel", "close", "modify", "create", "open", "enable", "update", "edit", "confirm", "approve"]);

// No-harm
const DELETE_WORDS = new Set(["delete", "destroy", "drop", "purge", "erase", "wipe", "trash", "clear", "reset", "remove", "revoke", "pause", "archive", "unpublish", "rollback", "restore", "rebase", "merge"]);
const DELETE_SAFE = /remove_background|clear_selection|remove_tags?$|^remove_from_selection$/;
const CREDENTIAL_WORDS = new Set(["password", "passwords", "credential", "credentials", "secret", "secrets", "token", "tokens", "apikey", "keychain", "signing"]);
// "key" alone is a keyboard key in computer-use and browser tools
const KEY_QUALIFIERS = new Set(["api", "sdk", "ssh", "access", "private", "secret", "signing", "kms", "encryption"]);

const BROWSER_SERVER = /chrome|browser|playwright|puppeteer|selenium/i;

function startsWithRead(words: string[]): boolean {
  return READ_VERBS.has(words[0] ?? "") || (words.length > 1 && READ_VERBS.has(words[1] ?? "") && !SEND_WORDS.has(words[0]!) );
}

function nonEmpty(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "string") return v.trim().length > 0;
  return v !== undefined && v !== null && v !== false;
}

export function checkMcp(name: string, input: Record<string, unknown>, ctx: GuardContext): Denial | null {
  const n = parseMcpName(name);
  if (!n) return null;
  const { words, tool, server } = n;
  const label = `${server} ${tool}`;
  const read = startsWithRead(words);

  // Browser: uploads and form submits are submitting on Leo's behalf.
  if (BROWSER_SERVER.test(server)) {
    if (words.includes("upload")) {
      return deny("no-real-consequences", `${label} uploads a file to a website on Leo's behalf`);
    }
    if (words.includes("submit")) {
      return deny("no-real-consequences", `${label} submits a form on Leo's behalf`);
    }
  }

  // Sending as Leo
  if (!read && !DRAFT_SAFE.test(words.join("_"))) {
    const sendWord = words.find((w) => SEND_WORDS.has(w));
    if (sendWord) return deny("no-contacting-as-leo", `${label} would ${sendWord} as Leo`);
    if (words.includes("post") && words.some((w) => ["message", "messages", "comment", "status", "reply", "chat"].includes(w))) {
      return deny("no-contacting-as-leo", `${label} would post as Leo`);
    }
    if (words.some((w) => COMMENT_WORDS.has(w)) || (words.includes("review") && words.some((w) => CREATE_VERBS.has(w)))) {
      return deny("no-contacting-as-leo", `${label} would comment as Leo`);
    }
    if (words.includes("schedule") && words.some((w) => ["message", "email", "post", "meeting"].includes(w))) {
      return deny("no-contacting-as-leo", `${label} would schedule a message as Leo`);
    }
    // Calendar events with attendees send invitations.
    if (words.includes("event") && words.some((w) => ["create", "update", "add", "insert", "edit"].includes(w))) {
      if (nonEmpty(input.attendees) || nonEmpty(input.attendeeEmails) || nonEmpty(input.guests) || nonEmpty(input.invitees)) {
        return deny("no-contacting-as-leo", `${label} with attendees sends invitations as Leo`);
      }
    }
  }

  // Money
  if (!read) {
    const money = words.find((w) => MONEY_WORDS.has(w));
    if (money) return deny("no-money", `${label} is a payment, purchase or trading action (${money})`);
    if (words.some((w) => ORDER_WORDS.has(w)) && words.some((w) => ACT_VERBS.has(w))) {
      return deny("no-money", `${label} places or changes a trade or order`);
    }
    if (words.includes("link") && words.includes("payment")) return deny("no-money", `${label} creates a payment link`);
  }
  if (words.includes("deposit") || (words.includes("address") && words.includes("generate"))) {
    return deny("no-money", `${label} handles deposits`);
  }

  // Credentials, read or write
  const cred =
    words.find((w) => CREDENTIAL_WORDS.has(w)) ??
    (words.some((w) => w === "key" || w === "keys") && words.some((w) => KEY_QUALIFIERS.has(w)) ? "key" : undefined);
  if (cred) return deny("no-harm", `${label} touches credentials (${cred})`);

  // Deleting data outside ~/Jarvis and the repo
  if (!read && !DELETE_SAFE.test(words.join("_"))) {
    const del = words.find((w) => DELETE_WORDS.has(w));
    if (del) return deny("no-harm", `${label} would ${del} data outside ~/Jarvis and the Jarvis repo`);
  }
  for (const key of ["sql", "query", "statement"]) {
    const v = input[key];
    if (typeof v === "string" && /\b(drop|delete|truncate|alter)\b/i.test(v) && !read) {
      return deny("no-harm", `${label} runs SQL that deletes or changes structure`);
    }
  }

  // Master vault through an Obsidian MCP server: notes may be created and
  // edited (Leo, 2026-10-11), but not deleted or moved, and Obsidian's own
  // settings folder is off limits.
  if (ctx.masterVaultMcpServers.test(server) && !read) {
    const paths = ["path", "filePath", "file_path", "file", "note", "notePath", "oldPath", "newPath", "source", "destination", "target"]
      .map((k) => input[k])
      .filter((v): v is string => typeof v === "string");
    if (words.some((w) => w === "delete" || w === "move" || w === "remove" || w === "rename")) {
      return deny("no-harm", `notes in the master vault can be edited but not deleted or moved (${label} ${paths.join(" ")})`);
    }
    if (paths.some((p) => /^\/?\.(obsidian|trash)(\/|$)/.test(p.trim()))) {
      return deny("no-harm", `Obsidian's own settings and plugins in the master vault are off limits (${label} ${paths.join(" ")})`);
    }
  }
  return null;
}
