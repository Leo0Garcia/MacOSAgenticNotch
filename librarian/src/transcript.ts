/**
 * Condenses a run's stream-json log (~/Jarvis/runs/<session-id>.jsonl, written by the
 * launcher) into plain text the librarian model can read cheaply.
 */

export interface RunDigest {
  sessionId?: string;
  /** From the run's structured_output; undefined when the run produced none. */
  keep?: boolean;
  summary?: string;
  finalText?: string;
  denials: string[];
  text: string;
}

const MAX_TOOL_INPUT = 300;
const MAX_TOOL_RESULT = 400;
const MAX_TEXT = 2000;
export const MAX_TRANSCRIPT = 24_000;

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= n ? one : `${one.slice(0, n)}… [${one.length - n} chars cut]`;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && "text" in c && typeof c.text === "string" ? c.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

type Json = Record<string, unknown>;

export function condenseStream(jsonl: string): RunDigest {
  const out: string[] = [];
  const digest: RunDigest = { denials: [], text: "" };

  for (const raw of jsonl.split("\n")) {
    if (!raw.trim()) continue;
    let ev: Json;
    try {
      ev = JSON.parse(raw) as Json;
    } catch {
      continue;
    }
    if (typeof ev.session_id === "string") digest.sessionId ??= ev.session_id;

    switch (ev.type) {
      case "assistant": {
        const content = (ev.message as Json | undefined)?.content;
        if (!Array.isArray(content)) break;
        for (const c of content as Json[]) {
          if (c.type === "text" && typeof c.text === "string" && c.text.trim()) {
            out.push(`Jarvis: ${clip(c.text, MAX_TEXT)}`);
          } else if (c.type === "tool_use") {
            out.push(`Tool ${String(c.name)}: ${clip(JSON.stringify(c.input ?? {}), MAX_TOOL_INPUT)}`);
          }
        }
        break;
      }
      case "user": {
        const content = (ev.message as Json | undefined)?.content;
        if (typeof content === "string") {
          out.push(`Leo: ${clip(content, MAX_TEXT)}`);
          break;
        }
        if (!Array.isArray(content)) break;
        for (const c of content as Json[]) {
          if (c.type === "tool_result") {
            const label = c.is_error ? "Tool error" : "Result";
            out.push(`${label}: ${clip(contentText(c.content), MAX_TOOL_RESULT)}`);
          } else if (c.type === "text" && typeof c.text === "string") {
            out.push(`Leo: ${clip(c.text, MAX_TEXT)}`);
          }
        }
        break;
      }
      case "result": {
        if (typeof ev.result === "string" && ev.result.trim()) digest.finalText = ev.result;
        const so = ev.structured_output as Json | undefined;
        if (so && typeof so === "object") {
          if (typeof so.keep === "boolean") digest.keep = so.keep;
          if (typeof so.summary === "string") digest.summary = so.summary;
        }
        if (Array.isArray(ev.permission_denials)) {
          for (const d of ev.permission_denials as Json[]) {
            digest.denials.push(String(d.tool_name ?? "unknown tool"));
          }
        }
        if (ev.is_error) out.push(`Run ended with an error (${String(ev.subtype ?? "unknown")}).`);
        break;
      }
      default:
        break; // system/init, stream_event partials, hook events: nothing durable
    }
  }

  if (digest.finalText) out.push(`Final reply: ${clip(digest.finalText, MAX_TEXT)}`);
  if (digest.denials.length) out.push(`Blocked tool calls: ${digest.denials.join(", ")}`);
  digest.text = fitTranscript(out.join("\n"));
  return digest;
}

/** Keeps the start (the ask) and the end (the outcome) when a transcript is too long. */
export function fitTranscript(text: string, max = MAX_TRANSCRIPT): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.3);
  const tail = max - head;
  return `${text.slice(0, head)}\n[… ${text.length - max} chars of the middle of the run cut …]\n${text.slice(-tail)}`;
}
