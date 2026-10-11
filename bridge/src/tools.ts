// The five tools Claude Code sees as mcp__jarvis__<name>. None of the names
// trips guard/src/mcp.ts (no send, post, delete, pay ... words).

import { appendAction } from "./actions";
import { str, ToolInputError, type Tool } from "./mcp";
import { osNotify, type NotchLink } from "./notch";
import type { ActionKind } from "./protocol";
import { scheduleReminder } from "./remind";
import { MAX_SPEAK_CHARS, type Speaker } from "./speech";
import type { Runner } from "./system";
import { WhenError } from "./when";

export const DEFAULT_ASK_TIMEOUT_S = 120;

export interface ToolDeps {
  home: string;
  repo: string;
  sessionId: string | null;
  link: NotchLink;
  speaker: Speaker;
  run: Runner;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  /** Tracks fire-and-forget work (speech) so the server can finish it before exiting. */
  background?: (p: Promise<unknown>) => void;
}

export const INSTRUCTIONS = `Jarvis's link to Leo's notch.
- Your final reply is spoken automatically. Use speak only for a short progress line during long work, never to repeat the reply.
- Use ask when only Leo can decide. It waits for his answer; if he isn't there it says so, and you carry on with the safe default or stop and say what you need.
- Use remind for "remind me ..." requests. Times are Europe/London.
- notify posts a notification in the notch (or macOS when the app is closed). It never contacts anyone else.`;

let askSeq = 0;

export function buildTools(d: ToolDeps): Tool[] {
  const now = () => d.now?.() ?? new Date();

  const speak: Tool = {
    name: "speak",
    description:
      "Say a short sentence aloud to Leo now, through the notch. Returns once queued; sentences play in order. Your final reply is already spoken, so don't repeat it here.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: `What to say, at most ${MAX_SPEAK_CHARS} characters.` } },
      required: ["text"],
      additionalProperties: false,
    },
    async handler(args) {
      const text = str(args, "text", { required: true, max: MAX_SPEAK_CHARS })!;
      const p = d.speaker.say(text).catch((e) => process.stderr.write(`[jarvis-bridge] speak: ${e.message}\n`));
      d.background?.(p);
      return { text: "Speaking." };
    },
  };

  const notify: Tool = {
    name: "notify",
    description:
      "Show Leo a notification: in the notch when the app is running, otherwise as a macOS notification. Only Leo sees it; it never messages anyone.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "A few words." },
        body: { type: "string", description: "One or two sentences." },
      },
      required: ["title", "body"],
      additionalProperties: false,
    },
    async handler(args) {
      const title = str(args, "title", { required: true, max: 120 })!;
      const body = str(args, "body", { required: true, max: 500 })!;
      const id = `n-${process.pid}-${++askSeq}`;
      if (await d.link.send({ type: "notify", id, title, body, session_id: d.sessionId })) {
        return { text: "Shown in the notch." };
      }
      const r = await osNotifySafe(d.run, title, body);
      return r ?? { text: "Shown as a macOS notification (the notch app isn't running)." };
    },
  };

  const ask: Tool = {
    name: "ask",
    description:
      "Ask Leo a question and wait for his answer (typed, spoken, or a button). Use only when the choice is genuinely his. Returns his answer, or says he isn't available or didn't answer in time.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "One short question, answerable in a word or two." },
        options: {
          type: "array",
          items: { type: "string" },
          maxItems: 2,
          description: "Up to two one-or-two-word answers shown as buttons. Leo can still answer in his own words.",
        },
        timeout_seconds: {
          type: "number",
          minimum: 10,
          maximum: 600,
          description: `How long to wait. Default ${DEFAULT_ASK_TIMEOUT_S}.`,
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
    async handler(args, signal) {
      const question = str(args, "question", { required: true, max: 300 })!;
      const options = parseOptions(args.options);
      const timeoutS = parseTimeout(args.timeout_seconds);
      const id = `a-${process.pid}-${++askSeq}`;
      const answer = await d.link.ask(
        { type: "ask", id, question, options, timeout_ms: timeoutS * 1000, session_id: d.sessionId },
        signal,
      );
      if (answer === null) {
        return {
          text: "Leo isn't available: the notch app isn't running, so nobody saw the question. Carry on with the safe default and say which you chose, or stop and tell him what you need.",
        };
      }
      if (answer === "timeout") {
        return {
          text: `No answer from Leo within ${timeoutS} seconds. Carry on with the safe default and say which you chose, or stop and tell him what you need.`,
        };
      }
      if (answer.via === "dismissed" || !answer.text.trim()) {
        return { text: "Leo dismissed the question without answering. Don't go ahead with anything that needed his answer." };
      }
      return { text: `Leo answered: ${answer.text.trim()}` };
    },
  };

  const log: Tool = {
    name: "log",
    description:
      "Add one line to Leo's notch action log (what you did, in a few words, e.g. 'Moved \"essay\" to Completed'). Use for actions he may want to find later, not for every step.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One line, under 80 characters." },
        detail: { type: "string", description: "Optional longer detail." },
        kind: { type: "string", enum: ["action", "note"], description: "Default action." },
      },
      required: ["summary"],
      additionalProperties: false,
    },
    async handler(args) {
      const summary = str(args, "summary", { required: true, max: 200 })!;
      const detail = str(args, "detail", { max: 4000 }) ?? null;
      const kind = (str(args, "kind") ?? "action") as ActionKind;
      if (kind !== "action" && kind !== "note") throw new ToolInputError("kind must be action or note");
      const row = appendAction(d.home, { kind, summary, detail, sessionId: d.sessionId, now: now() });
      await d.link.send({ type: "log", row });
      return { text: `Logged #${row.id}.` };
    },
  };

  const remind: Tool = {
    name: "remind",
    description:
      'Set a reminder that fires in the notch and as a macOS notification at the given time, even with no run active. `when` is Europe/London: "in 20 minutes", "at 6pm", "at 5" (next 5 o\'clock), "tomorrow at 9am", "monday 14:30", or ISO 8601.',
    inputSchema: {
      type: "object",
      properties: {
        when: { type: "string", description: "When to fire." },
        text: { type: "string", description: "What to remind Leo of, phrased for him: 'take the bins out'." },
      },
      required: ["when", "text"],
      additionalProperties: false,
    },
    async handler(args) {
      const when = str(args, "when", { required: true, max: 100 })!;
      const text = str(args, "text", { required: true, max: 300 })!;
      try {
        const r = await scheduleReminder({
          when,
          text,
          repo: d.repo,
          sessionId: d.sessionId,
          run: d.run,
          now: now(),
          env: d.env,
        });
        return { text: `Reminder set for ${r.label} (UK time): ${text}` };
      } catch (e) {
        if (e instanceof WhenError) throw new ToolInputError(e.message);
        throw e;
      }
    },
  };

  return [speak, notify, ask, log, remind];
}

function parseOptions(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((o) => typeof o !== "string")) throw new ToolInputError("options must be a list of strings");
  const opts = v.map((o: string) => o.trim()).filter(Boolean);
  if (opts.length > 2) throw new ToolInputError("at most two options");
  if (opts.some((o) => o.length > 40)) throw new ToolInputError("options must be short (40 characters at most)");
  return opts;
}

function parseTimeout(v: unknown): number {
  if (v === undefined || v === null) return DEFAULT_ASK_TIMEOUT_S;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ToolInputError("timeout_seconds must be a number");
  return Math.min(600, Math.max(10, Math.round(v)));
}

async function osNotifySafe(run: Runner, title: string, body: string) {
  try {
    await osNotify(run, title, body);
    return null;
  } catch (e) {
    return { text: `Couldn't show the notification: ${(e as Error).message}`, isError: true };
  }
}
