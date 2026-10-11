import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { recentActions } from "../src/actions";
import { McpServer } from "../src/mcp";
import { NotchLink } from "../src/notch";
import { Speaker } from "../src/speech";
import { runCommand } from "../src/system";
import { buildTools, type ToolDeps } from "../src/tools";
import { FakeApp, stubRunner, tempHome, type StubRunner } from "./helpers";

const NOW = new Date("2026-10-11T13:40:00Z");

let home: string;
let cleanup: () => void;
let app: FakeApp | null;
let link: NotchLink;
let run: StubRunner;
let background: Promise<unknown>[];

beforeEach(() => {
  ({ home, cleanup } = tempHome());
  app = null;
  run = stubRunner();
  background = [];
  link = new NotchLink({ home, client: "bridge", sessionId: "sess-1", connectTimeoutMs: 500 });
});
afterEach(() => {
  link.close();
  app?.stop();
  cleanup();
});

function server(over: Partial<ToolDeps> = {}) {
  const out: any[] = [];
  const deps: ToolDeps = {
    home,
    repo: join(home, "repo"),
    sessionId: "sess-1",
    link,
    speaker: new Speaker({ home, link, sessionId: "sess-1", run }),
    run,
    now: () => NOW,
    env: {},
    background: (p) => background.push(p),
    ...over,
  };
  const s = new McpServer({ name: "jarvis", version: "t" }, buildTools(deps), (l) => out.push(JSON.parse(l)), () => {});
  let n = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    const id = ++n;
    await s.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }));
    const r = out.find((o) => o.id === id);
    return { text: r.result.content[0].text as string, isError: r.result.isError as boolean };
  };
  return { call, out, s };
}

describe("speak", () => {
  test("queues speech and returns at once", async () => {
    app = new FakeApp(home);
    const r = await server().call("speak", { text: "Checking Moodle." });
    expect(r).toEqual({ text: "Speaking.", isError: false });
    await Promise.all(background);
    expect(run.calls[0]).toEqual({ cmd: ["say", "-f", "-"], stdin: "Checking Moodle." });
    expect((await app.next("speak_start")).text).toBe("Checking Moodle.");
  });
  test("rejects empty text", async () => {
    expect((await server().call("speak", { text: " " })).isError).toBe(true);
  });
});

describe("notify", () => {
  test("goes to the notch when the app is running", async () => {
    app = new FakeApp(home);
    const r = await server().call("notify", { title: "Done", body: "Research saved." });
    expect(r.text).toBe("Shown in the notch.");
    expect(await app.next("notify")).toMatchObject({ title: "Done", body: "Research saved.", session_id: "sess-1" });
    expect(run.calls).toHaveLength(0);
  });
  test("falls back to a macOS notification, text passed as argv", async () => {
    const r = await server().call("notify", { title: 'He said "hi"', body: "end tell; do shell script \"x\"" });
    expect(r.text).toMatch(/macOS notification/);
    const cmd = run.calls[0]!.cmd;
    expect(cmd[0]).toBe("osascript");
    expect(cmd.slice(-2)).toEqual(['He said "hi"', 'end tell; do shell script "x"']);
    expect(cmd.filter((a) => a.includes("shell script"))).toHaveLength(1);
  });
  test("says so when osascript fails", async () => {
    run = stubRunner(() => ({ code: 1, stderr: "not allowed" }));
    const r = await server({ run }).call("notify", { title: "t", body: "b" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not allowed/);
  });
});

describe("ask", () => {
  test("returns Leo's answer", async () => {
    app = new FakeApp(home);
    app.onAsk = (m, ws) => ws.send(JSON.stringify({ type: "answer", id: m.id, text: "the blue one", via: "voice" }));
    const r = await server().call("ask", { question: "Which one?", options: ["Red", "Blue"] });
    expect(r.text).toBe("Leo answered: the blue one");
    expect(await app.next("ask")).toMatchObject({ question: "Which one?", options: ["Red", "Blue"], timeout_ms: 120_000 });
  });
  test("no app: says he isn't available, doesn't hang", async () => {
    const r = await server().call("ask", { question: "Which one?" });
    expect(r.text).toMatch(/^Leo isn't available/);
    expect(r.isError).toBe(false);
  });
  test("dismissed", async () => {
    app = new FakeApp(home);
    app.onAsk = (m, ws) => ws.send(JSON.stringify({ type: "answer", id: m.id, text: "", via: "dismissed" }));
    expect((await server().call("ask", { question: "Go?" })).text).toMatch(/dismissed/);
  });
  test("timeout is clamped to at least 10 s", async () => {
    app = new FakeApp(home);
    app.onAsk = (m, ws) => ws.send(JSON.stringify({ type: "answer", id: m.id, text: "ok", via: "button" }));
    await server().call("ask", { question: "Go?", timeout_seconds: 1 });
    expect((await app.next("ask")).timeout_ms).toBe(10_000);
  });
  test("more than two options is an input error", async () => {
    const r = await server().call("ask", { question: "Go?", options: ["a", "b", "c"] });
    expect(r).toEqual({ text: "at most two options", isError: true });
  });
  test("a cancelled request gets no response and withdraws the question", async () => {
    app = new FakeApp(home);
    const { s, out } = server();
    const pending = s.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "ask", arguments: { question: "Go?" } } }),
    );
    await app.next("ask");
    await s.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 9 } }));
    await pending;
    expect(out.find((o) => o.id === 9)).toBeUndefined();
    expect((await app.next("ask_cancel")).reason).toBe("cancelled");
  });
});

describe("log", () => {
  test("writes a row and tells the app", async () => {
    app = new FakeApp(home);
    const r = await server().call("log", { summary: 'Moved "essay" to Completed' });
    expect(r.text).toBe("Logged #1.");
    const [row] = recentActions(home);
    expect(row).toMatchObject({ id: 1, kind: "action", summary: 'Moved "essay" to Completed', session_id: "sess-1", saved: false, ts: NOW.toISOString() });
    expect((await app.next("log")).row).toEqual(row!);
  });
  test("works without the app", async () => {
    await server().call("log", { summary: "a", kind: "note", detail: "d" });
    expect(recentActions(home)[0]).toMatchObject({ kind: "note", detail: "d" });
  });
  test("only action and note kinds from Claude", async () => {
    expect((await server().call("log", { summary: "a", kind: "guard" })).isError).toBe(true);
  });
});

describe("remind", () => {
  function stubScheduler(body: string) {
    const path = join(home, "scheduler.ts");
    writeFileSync(path, body);
    return { JARVIS_REMIND_SCHEDULER: `bun ${path}` };
  }

  test("hands the absolute time to the launcher's scheduler", async () => {
    const env = stubScheduler(`
      const input = await Bun.stdin.text();
      await Bun.write(${JSON.stringify(join(home, "got.json"))}, input);
      console.log(JSON.stringify({ id: "rem-1", at: JSON.parse(input).at }));
    `);
    const r = await server({ env, run: runCommand }).call("remind", { when: "at 6pm", text: "take the bins out" });
    expect(r).toEqual({ text: "Reminder set for today at 18:00 (UK time): take the bins out", isError: false });
    expect(await Bun.file(join(home, "got.json")).json()).toEqual({
      at: "2026-10-11T17:00:00.000Z",
      text: "take the bins out",
      session_id: "sess-1",
    });
  });

  test("scheduler failure is reported, not swallowed", async () => {
    const env = stubScheduler(`console.error("launchctl: bootstrap failed"); process.exit(1);`);
    const r = await server({ env, run: runCommand }).call("remind", { when: "in 20 minutes", text: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("The reminder scheduler failed, so no reminder was set: launchctl: bootstrap failed");
  });

  test("scheduler with no confirmation is reported", async () => {
    const env = stubScheduler(`console.log("ok")`);
    const r = await server({ env, run: runCommand }).call("remind", { when: "in 20 minutes", text: "x" });
    expect(r).toMatchObject({ isError: true, text: expect.stringMatching(/may not be set/) });
  });

  test("missing launcher says exactly what is missing", async () => {
    const r = await server().call("remind", { when: "in 20 minutes", text: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(join(home, "repo", "launcher", "src", "reminders.ts"));
    expect(run.calls).toHaveLength(0);
  });

  test("an unreadable time asks Claude to restate it", async () => {
    const r = await server().call("remind", { when: "whenever", text: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Couldn't read "whenever"/);
  });
});
