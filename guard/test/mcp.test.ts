// Real tool names from Leo's connectors and MCP servers, as Claude Code names them.

import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { makeWorld, run } from "./helpers";

const w = makeWorld();
afterAll(() => rmSync(w.root, { recursive: true, force: true }));
const call = (tool_name: string, tool_input: Record<string, unknown> = {}) => run(w, { tool_name, tool_input, cwd: "$HOME/Jarvis" });

const denied: Record<string, string> = {
  mcp__Slack__slack_send_message: "no-contacting-as-leo",
  mcp__Slack__slack_schedule_message: "no-contacting-as-leo",
  mcp__Canva__reply_to_comment: "no-contacting-as-leo",
  mcp__Miro__comment_create: "no-contacting-as-leo",
  mcp__Miro__comment_reply: "no-contacting-as-leo",
  mcp__Miro__space_share: "no-contacting-as-leo",
  mcp__Google_Calendar__respond_to_event: "no-contacting-as-leo",
  mcp__github__add_issue_comment: "no-contacting-as-leo",
  "mcp__Co-Invest__execute_order": "no-money",
  "mcp__Co-Invest__execute_orders_batch": "no-money",
  "mcp__Co-Invest__execute_prediction_order": "no-money",
  "mcp__Co-Invest__cancel_order": "no-money",
  "mcp__Co-Invest__close_positions_batch": "no-money",
  "mcp__Co-Invest__modify_position": "no-money",
  "mcp__Co-Invest__update_leverage": "no-money",
  "mcp__Co-Invest__execute_tpsl": "no-money",
  "mcp__Co-Invest__deposit_earn": "no-money",
  "mcp__Co-Invest__withdraw_earn": "no-money",
  "mcp__Co-Invest__create_onramp_session": "no-money",
  "mcp__Co-Invest__payment_link": "no-money",
  "mcp__Co-Invest__enable_automated_trading": "no-money",
  "mcp__Co-Invest__suggest_trade": "no-money",
  mcp__Vercel__buy_domain: "no-money",
  mcp__Vercel__buy_domains: "no-money",
  mcp__Vercel__create_or_transfer_domain: "no-money",
  mcp__Supabase__delete_branch: "no-harm",
  mcp__Supabase__pause_project: "no-harm",
  mcp__Supabase__reset_branch: "no-harm",
  mcp__Supabase__create_edge_function_secret: "no-harm",
  mcp__Vercel__create_edge_config_token: "no-harm",
  mcp__Vercel__revoke_kms_signing_key: "no-harm",
  mcp__Google_Calendar__delete_event: "no-harm",
  mcp__github__delete_file: "no-harm",
  mcp__github__merge_pull_request: "no-harm",
  "mcp__Anki_MCP_Server__deleteNotes": "no-harm",
  "mcp__obsidian-jarvis__delete_note": "no-harm",
  mcp__playwright__browser_file_upload: "no-real-consequences",
  "mcp__claude-in-chrome__upload_image": "no-real-consequences",
};

for (const [name, rule] of Object.entries(denied)) {
  test(`denies ${name}`, () => expect(call(name)?.rule).toBe(rule as any));
}

const allowed = [
  "mcp__Slack__slack_read_channel",
  "mcp__Slack__slack_read_thread",
  "mcp__Slack__slack_search_public_and_private",
  "mcp__Slack__slack_send_message_draft",
  "mcp__Slack__slack_create_canvas",
  "mcp__Google_Calendar__list_events",
  "mcp__Google_Calendar__create_event",
  "mcp__Google_Calendar__suggest_time",
  "mcp__Co-Invest__get_portfolio",
  "mcp__Co-Invest__get_news",
  "mcp__Co-Invest__analyze_market",
  "mcp__Co-Invest__view_open_orders",
  "mcp__Co-Invest__get_position_history",
  "mcp__Co-Invest__get_transaction_history",
  "mcp__Co-Invest__search_markets",
  "mcp__Vercel__get_purchase_quote",
  "mcp__Vercel__list_deployments",
  "mcp__FMP__quote",
  "mcp__FMP__earningsTranscript",
  "mcp__Expedia__search_flights",
  "mcp__Booking_com__accommodations_search",
  "mcp__Spotify__search",
  "mcp__Spotify__get_currently_playing",
  "mcp__Canva__remove-background",
  "mcp__Anki_MCP_Server__removeTags",
  "mcp__Anki_MCP_Server__review_stats",
  "mcp__Anki_MCP_Server__addNote",
  "mcp__tradingview__data_get_trades",
  "mcp__tradingview__quote_get",
  "mcp__github__create_pull_request",
  "mcp__github__get_file_contents",
  "mcp__Supabase__list_tables",
  "mcp__computer-use__key",
  "mcp__computer-use__hold_key",
  "mcp__playwright__browser_press_key",
  "mcp__playwright__browser_navigate",
  "mcp__playwright__browser_fill_form",
  "mcp__Control_Chrome__open_url",
  "mcp__obsidian-jarvis__write_note",
  "mcp__obsidian__search_notes",
  "mcp__obsidian__list_directory",
];

for (const name of allowed) {
  test(`allows ${name}`, () => expect(call(name)).toBeNull());
}

test("SQL that only reads is allowed", () => {
  expect(call("mcp__Supabase__execute_sql", { project_id: "p", query: "select * from tasks" })).toBeNull();
});

test("browser navigation is still checked against the domain list", () => {
  expect(call("mcp__playwright__browser_navigate", { url: "https://www.natwest.com" })?.rule).toBe("no-money");
  expect(call("mcp__Control_Chrome__open_url", { url: "https://www.gov.uk" })?.rule).toBe("no-real-consequences");
});
