import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { condenseStream, fitTranscript } from "../src/transcript";
import { FIXTURES } from "./helpers";

test("condenses a stream-json log", async () => {
  const d = condenseStream(await readFile(join(FIXTURES, "register-amra.jsonl"), "utf8"));
  expect(d.sessionId).toBe("0b6c1d2e-1111-4222-8333-444455556666");
  expect(d.keep).toBe(false);
  expect(d.summary).toBe("Registered the Amra project (Slack #amra, Sue, Ellen)");
  expect(d.denials).toEqual(["mcp__Slack__slack_send_message"]);
  expect(d.text).toContain("Jarvis: Registering the Amra project now.");
  expect(d.text).toContain('Tool mcp__Slack__slack_search_channels: {"query":"amra"}');
  expect(d.text).toContain("Tool error: guard:no-contacting-as-leo");
  expect(d.text).toContain("Final reply: Done. Amra is registered");
  expect(d.text).not.toContain("content_block_delta");
});

test("skips junk lines and handles a run with no structured output", () => {
  const d = condenseStream('not json\n{"type":"result","is_error":true,"subtype":"error_max_structured_output_retries"}\n');
  expect(d.keep).toBeUndefined();
  expect(d.text).toContain("Run ended with an error (error_max_structured_output_retries)");
});

test("long transcripts keep the start and the end", () => {
  const text = "START " + "x".repeat(50_000) + " END";
  const out = fitTranscript(text, 1000);
  expect(out.length).toBeLessThan(1100);
  expect(out.startsWith("START")).toBe(true);
  expect(out.endsWith("END")).toBe(true);
});
