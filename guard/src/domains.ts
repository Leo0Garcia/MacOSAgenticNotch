// Blocked-domain list: parsing, URL extraction, matching.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RULE_IDS, type Denial, type RuleId } from "./rules";

export interface DomainEntry {
  host: string; // lowercased, "*" for any host
  rule: RuleId;
  path?: RegExp;
  line: number;
}

export function parseBlocklist(text: string): DomainEntry[] {
  const out: DomainEntry[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const [host, rule, ...rest] = line.split(/\s+/);
    if (!host || !rule || !(RULE_IDS as readonly string[]).includes(rule)) {
      throw new Error(`blocked-domains.txt line ${i + 1}: expected "<host> <rule-id> [path-regex]"`);
    }
    if (host === "*" && rest.length === 0) {
      throw new Error(`blocked-domains.txt line ${i + 1}: "*" needs a path-regex`);
    }
    out.push({
      host: host.toLowerCase().replace(/\.$/, ""),
      rule: rule as RuleId,
      path: rest.length ? new RegExp(rest.join(" ")) : undefined,
      line: i + 1,
    });
  });
  return out;
}

let cached: DomainEntry[] | null = null;
export function loadBlocklist(dir = join(import.meta.dir, "..")): DomainEntry[] {
  if (!cached) cached = parseBlocklist(readFileSync(join(dir, "blocked-domains.txt"), "utf8"));
  return cached;
}

function hostMatches(host: string, pattern: string): boolean {
  return pattern === "*" || host === pattern || host.endsWith("." + pattern);
}

export interface ParsedTarget {
  host: string;
  path: string;
}

/** Parse "https://x.y/z", "x.y/z", "//x.y" into host + path. */
export function parseTarget(s: string): ParsedTarget | null {
  let str = s.trim().replace(/^['"(<]+|['")>,;]+$/g, "");
  if (!str) return null;
  if (str.startsWith("//")) str = "https:" + str;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(str)) str = "https://" + str;
  try {
    const u = new URL(str);
    const host = u.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
    if (!host.includes(".")) return null;
    let path = u.pathname.toLowerCase();
    try {
      path = decodeURIComponent(path);
    } catch {}
    return { host, path };
  } catch {
    return null;
  }
}

export function checkTarget(t: ParsedTarget, list: DomainEntry[]): DomainEntry | null {
  for (const e of list) {
    if (!hostMatches(t.host, e.host)) continue;
    if (e.path && !e.path.test(t.path)) continue;
    return e;
  }
  return null;
}

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>`\\)]+/gi;
// bare host, optionally with a path: www.gov.uk, barclays.co.uk/login
const BARE_RE = /(?<![A-Za-z0-9@._%+-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?::\d+)?(?:\/[^\s'"<>`\\)]*)?/gi;

/** Every URL or bare hostname that appears in free text. */
export function extractTargets(text: string): ParsedTarget[] {
  const out: ParsedTarget[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    const t = parseTarget(s);
    if (!t) return;
    const k = t.host + t.path;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  };
  for (const m of text.matchAll(URL_RE)) add(m[0]);
  const withoutUrls = text.replace(URL_RE, " ");
  for (const m of withoutUrls.matchAll(BARE_RE)) add(m[0]);
  return out;
}

export function checkText(text: string, list: DomainEntry[]): Denial | null {
  for (const t of extractTargets(text)) {
    const e = checkTarget(t, list);
    if (e) return { rule: e.rule, reason: blockedReason(t, e) };
  }
  return null;
}

export function checkUrl(url: string, list: DomainEntry[]): Denial | null {
  const t = parseTarget(url);
  if (!t) return null;
  const e = checkTarget(t, list);
  return e ? { rule: e.rule, reason: blockedReason(t, e) } : null;
}

const RULE_WORDS: Record<RuleId, string> = {
  "no-money": "a banking, payment, trading or shopping-checkout site",
  "no-real-consequences": "a government, student finance, university fees or registration, health, insurance or signing site",
  "no-contacting-as-leo": "a service that sends messages",
  "no-harm": "a blocked site",
};

function blockedReason(t: ParsedTarget, e: DomainEntry): string {
  return `${t.host} is ${RULE_WORDS[e.rule]} (blocked-domains.txt line ${e.line})`;
}
