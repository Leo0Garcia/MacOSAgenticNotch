// Builds stream-json runs shaped like real `claude -p --output-format
// stream-json --verbose --include-partial-messages` output (recorded from
// Claude Code 2.1.296 on 2026-10-11 and trimmed to the fields the launcher reads).

type Ev = Record<string, unknown>;
const SID = "{{SID}}";

export function init(o: { permissionMode?: string; servers?: { name: string; status: string }[]; mcpServerErrors?: unknown[] } = {}): Ev {
  const ev: Ev = {
    type: "system",
    subtype: "init",
    session_id: SID,
    cwd: "/Users/leogarcia/Jarvis",
    permissionMode: o.permissionMode ?? "auto",
    claude_code_version: "2.1.296",
    mcp_servers: o.servers ?? [
      { name: "jarvis", status: "connected", source: "dynamic" },
      { name: "claude-in-chrome", status: "connected", source: "dynamic" },
    ],
    tools: ["Bash", "WebFetch", "mcp__jarvis__speak"],
  };
  if (o.mcpServerErrors) ev.mcp_server_errors = o.mcpServerErrors;
  return ev;
}

let n = 0;
const se = (event: Ev, parent: string | null = null): Ev => ({ type: "stream_event", event, parent_tool_use_id: parent, session_id: SID, uuid: `u${n++}` });

/** A text message streamed in chunks, then the full assistant message. */
export function text(chunks: string[], parent: string | null = null): Ev[] {
  const id = `msg_${n++}`;
  return [
    se({ type: "message_start", message: { id, role: "assistant", content: [] } }, parent),
    se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, parent),
    ...chunks.map((t) => se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }, parent)),
    se({ type: "content_block_stop", index: 0 }, parent),
    se({ type: "message_delta", delta: { stop_reason: "end_turn" } }, parent),
    se({ type: "message_stop" }, parent),
    { type: "assistant", message: { id, role: "assistant", content: [{ type: "text", text: chunks.join("") }] }, parent_tool_use_id: parent, session_id: SID },
  ];
}

export function toolUse(id: string, name: string, input: Ev): Ev[] {
  const mid = `msg_${n++}`;
  return [
    se({ type: "message_start", message: { id: mid, role: "assistant", content: [] } }),
    se({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } }),
    se({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }),
    se({ type: "content_block_stop", index: 0 }),
    se({ type: "message_stop" }),
    { type: "assistant", message: { id: mid, role: "assistant", content: [{ type: "tool_use", id, name, input }] }, parent_tool_use_id: null, session_id: SID },
  ];
}

export function toolResult(id: string, content: string, isError = false): Ev {
  return { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] }, parent_tool_use_id: null, session_id: SID };
}

export function structured(keep: boolean, summary: string): Ev[] {
  return [...toolUse("toolu_so", "StructuredOutput", { keep, summary }), toolResult("toolu_so", "Structured output provided successfully")];
}

export function result(o: { structured?: unknown; denials?: Ev[]; subtype?: string; isError?: boolean } = {}): Ev {
  const ev: Ev = {
    type: "result",
    subtype: o.subtype ?? "success",
    is_error: o.isError ?? false,
    num_turns: 3,
    result: o.structured ? JSON.stringify(o.structured) : "",
    session_id: SID,
    total_cost_usd: 0.01,
    permission_denials: o.denials ?? [],
    terminal_reason: "completed",
  };
  if (o.structured !== undefined) ev.structured_output = o.structured;
  return ev;
}

export const jsonl = (events: (Ev | Ev[])[]) => events.flat().map((e) => JSON.stringify(e)).join("\n") + "\n";

export const GUARD_BANK =
  "guard:no-money: www.barclays.co.uk is a banking, payment, trading or shopping-checkout site (blocked-domains.txt line 17). Safe alternative: I can look it up read-only, summarise it, or set a reminder for you to do it yourself.";

export const runs = {
  weather: () =>
    jsonl([
      init(),
      text(["It's 14 degrees", " and cloudy in Southampton. Light rain", " is likely after 6pm."]),
      structured(false, "Told Leo the Southampton weather"),
      result({ structured: { keep: false, summary: "Told Leo the Southampton weather" } }),
    ]),
  research: () =>
    jsonl([
      init(),
      text(["I've started the research and saved my notes to your memory vault."]),
      structured(true, "Researched solid-state batteries"),
      result({ structured: { keep: true, summary: "Researched solid-state batteries" } }),
    ]),
  noStructured: () => jsonl([init(), text(["Done."]), result({ subtype: "error_max_structured_output_retries", isError: true })]),
  guardDenied: () =>
    jsonl([
      init(),
      toolUse("toolu_nav", "mcp__claude-in-chrome__navigate", { url: "https://www.barclays.co.uk" }),
      { type: "system", subtype: "permission_denied", tool_name: "mcp__claude-in-chrome__navigate", tool_use_id: "toolu_nav", session_id: SID },
      toolResult("toolu_nav", GUARD_BANK, true),
      structured(false, "Refused to open a banking site"),
      result({
        structured: { keep: false, summary: "Refused to open a banking site" },
        denials: [{ tool_name: "mcp__claude-in-chrome__navigate", tool_use_id: "toolu_nav", tool_input: { url: "https://www.barclays.co.uk" } }],
      }),
    ]),
  notAuto: () => jsonl([init({ permissionMode: "default" }), text(["This should never be read."]), result({ structured: { keep: true, summary: "x" } })]),
  noBridge: () => jsonl([init({ servers: [{ name: "jarvis", status: "failed" }] }), text(["Never."]), result({ structured: { keep: true, summary: "x" } })]),
  subagent: () =>
    jsonl([
      init(),
      text(["Subagent chatter that Leo shouldn't hear."], "toolu_agent"),
      text(["Here's the answer."]),
      structured(false, "Answered"),
      result({ structured: { keep: false, summary: "Answered" } }),
    ]),
};
