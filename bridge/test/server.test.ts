// End to end: spawn the real entry point the way Claude Code does and talk
// JSON-RPC over its stdio. No model, no network.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { recentActions } from "../src/actions";
import { FakeApp, tempHome } from "./helpers";

const SERVER = join(import.meta.dir, "..", "src", "server.ts");
const CLI = join(import.meta.dir, "..", "src", "cli.ts");

let home: string;
let cleanup: () => void;
beforeEach(() => ({ home, cleanup } = tempHome()));
afterEach(() => cleanup());

async function session(lines: object[], args: string[] = []) {
  const proc = Bun.spawn(["bun", SERVER, ...args], {
    env: { ...process.env, JARVIS_HOME: home },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  for (const l of lines) proc.stdin.write(JSON.stringify(l) + "\n");
  proc.stdin.end();
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code, replies: stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
}

test("initialize, list tools, call one, exit when stdin closes", async () => {
  const { code, replies } = await session(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "x" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "log", arguments: { summary: "Opened Safari" } } },
      { jsonrpc: "2.0", id: 4, method: "ping" },
    ],
    ["--session-id", "11111111-2222-3333-4444-555555555555"],
  );
  expect(code).toBe(0);
  const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
  expect(replies).toHaveLength(4); // stdout carries nothing but replies
  expect(byId[1].result).toMatchObject({
    protocolVersion: "2025-06-18",
    capabilities: { tools: {} },
    serverInfo: { name: "jarvis" },
  });
  expect(byId[1].result.instructions).toContain("spoken automatically");
  expect(byId[2].result.tools.map((t: any) => t.name)).toEqual(["speak", "notify", "ask", "log", "remind"]);
  for (const t of byId[2].result.tools) expect(t.inputSchema.type).toBe("object");
  expect(byId[3].result).toEqual({ content: [{ type: "text", text: "Logged #1." }], isError: false });
  expect(byId[4].result).toEqual({});
  expect(recentActions(home)[0]).toMatchObject({ summary: "Opened Safari", session_id: "11111111-2222-3333-4444-555555555555" });
});

test("protocol errors", async () => {
  const proc = await session([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } },
    { jsonrpc: "2.0", id: 2, method: "resources/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "transfer_money", arguments: {} } },
  ]);
  const byId = Object.fromEntries(proc.replies.map((r) => [r.id, r]));
  expect(byId[1].result.protocolVersion).toBe("2025-06-18");
  expect(byId[2].error.code).toBe(-32601);
  expect(byId[3].error.code).toBe(-32602);
});

test("a slow ask doesn't block other calls", async () => {
  const app = new FakeApp(home);
  let answer: (() => void) | null = null;
  app.onAsk = (m, ws) => (answer = () => ws.send(JSON.stringify({ type: "answer", id: m.id, text: "yes", via: "button" })));
  const proc = Bun.spawn(["bun", SERVER], { env: { ...process.env, JARVIS_HOME: home }, stdin: "pipe", stdout: "pipe" });
  const reader = proc.stdout.getReader();
  let buf = "";
  const nextReply = async () => {
    while (!buf.includes("\n")) buf += new TextDecoder().decode((await reader.read()).value);
    const i = buf.indexOf("\n");
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    return JSON.parse(line);
  };
  try {
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask", arguments: { question: "Go?" } } }) + "\n");
    await app.next("ask", 5000);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) + "\n");
    expect((await nextReply()).id).toBe(2);
    answer!();
    const r = await nextReply();
    expect(r.id).toBe(1);
    expect(r.result.content[0].text).toBe("Leo answered: yes");
  } finally {
    proc.stdin.end();
    await proc.exited;
    app.stop();
  }
});

test("cli log and reminder", async () => {
  const app = new FakeApp(home);
  try {
    // Async spawn: the fake app lives in this process and must keep answering.
    const cli = async (...args: string[]) => {
      const p = Bun.spawn(["bun", CLI, ...args], { env: { ...process.env, JARVIS_HOME: home }, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { stdout: stdout.trim(), stderr, code };
    };
    const log = await cli("log", "--kind", "run", "--summary", "Weather in Southampton", "--saved", "--session-id", "s9");
    expect(log.code).toBe(0);
    expect(JSON.parse(log.stdout)).toMatchObject({ kind: "run", saved: true, session_id: "s9" });
    expect((await app.next("log")).row.summary).toBe("Weather in Southampton");
    expect((await cli("reminder", "--text", "bins")).stdout).toBe("notch");
    expect((await app.next("reminder")).text).toBe("bins");
    const bad = await cli("log", "--kind", "nope", "--summary", "x");
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/--kind must be one of/);
  } finally {
    app.stop();
  }
});
