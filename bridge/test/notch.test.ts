import { afterEach, beforeEach, expect, test } from "bun:test";
import { NotchLink, fireReminder } from "../src/notch";
import { recentActions } from "../src/actions";
import type { Ask } from "../src/protocol";
import { FakeApp, stubRunner, tempHome } from "./helpers";

let home: string;
let cleanup: () => void;
let app: FakeApp | null = null;
beforeEach(() => ({ home, cleanup } = tempHome()));
afterEach(() => {
  app?.stop();
  app = null;
  cleanup();
});

const link = (opts: Partial<ConstructorParameters<typeof NotchLink>[0]> = {}) =>
  new NotchLink({ home, client: "bridge", sessionId: "sess-1", connectTimeoutMs: 500, ...opts });

const askMsg = (id: string, timeout_ms = 2000): Ask => ({
  type: "ask",
  id,
  question: "Keep it?",
  options: ["Yes", "No"],
  timeout_ms,
  session_id: "sess-1",
});

test("no notch.json means not connected", async () => {
  expect(await link().connect()).toBe(false);
});

test("notch.json from a dead app is ignored", async () => {
  app = new FakeApp(home, { pid: 999_999_999 });
  expect(await link().connect()).toBe(false);
});

test("hello carries token, client, pid and session", async () => {
  app = new FakeApp(home);
  const l = link();
  expect(await l.connect()).toBe(true);
  const hello = await app.next("hello");
  expect(hello).toMatchObject({ protocol: 1, token: app.token, client: "bridge", pid: process.pid, session_id: "sess-1" });
  l.close();
});

test("wrong token is refused", async () => {
  app = new FakeApp(home);
  app.writeNotchFile(process.pid, "wrong");
  expect(await link().connect()).toBe(false);
});

test("ask resolves with the app's answer", async () => {
  app = new FakeApp(home);
  app.onAsk = (m, ws) => ws.send(JSON.stringify({ type: "answer", id: m.id, text: "Yes", via: "button" }));
  const l = link();
  expect(await l.ask(askMsg("a1"))).toEqual({ type: "answer", id: "a1", text: "Yes", via: "button" });
  expect(await app.next("ask")).toMatchObject({ question: "Keep it?", options: ["Yes", "No"] });
  l.close();
});

test("ask times out and tells the app to drop the question", async () => {
  app = new FakeApp(home);
  const l = link();
  expect(await l.ask(askMsg("a2", 100))).toBe("timeout");
  expect(await app.next("ask_cancel")).toEqual({ type: "ask_cancel", id: "a2", reason: "timeout" });
  l.close();
});

test("ask aborted (request cancelled) withdraws the question", async () => {
  app = new FakeApp(home);
  const l = link();
  const ctl = new AbortController();
  const p = l.ask(askMsg("a3"), ctl.signal);
  await app.next("ask");
  ctl.abort();
  expect(await p).toBeNull();
  expect(await app.next("ask_cancel")).toEqual({ type: "ask_cancel", id: "a3", reason: "cancelled" });
  l.close();
});

test("app quitting mid-ask returns no answer instead of hanging", async () => {
  app = new FakeApp(home);
  app.onAsk = (_m, ws) => ws.close();
  const l = link();
  expect(await l.ask(askMsg("a4", 5000))).toBeNull();
  l.close();
});

test("ask with no app returns null at once", async () => {
  expect(await link().ask(askMsg("a5"))).toBeNull();
});

test("reconnects after the app restarts", async () => {
  app = new FakeApp(home);
  const l = link();
  expect(await l.send({ type: "notify", id: "n1", title: "t", body: "b", session_id: null })).toBe(true);
  app.stop();
  await Bun.sleep(50);
  app = new FakeApp(home);
  expect(await l.send({ type: "notify", id: "n2", title: "t", body: "b", session_id: null })).toBe(true);
  expect((await app.next("notify")).id).toBe("n2");
  l.close();
});

test("fireReminder shows it in the notch and logs it", async () => {
  app = new FakeApp(home);
  const run = stubRunner();
  expect(await fireReminder({ home, text: "bins", run })).toBe("notch");
  expect(await app.next("reminder")).toMatchObject({ text: "bins" });
  expect(run.calls).toHaveLength(0);
  expect(recentActions(home)[0]).toMatchObject({ kind: "reminder", summary: "bins" });
});

test("fireReminder without the app notifies and speaks", async () => {
  const run = stubRunner();
  expect(await fireReminder({ home, text: "bins", run })).toBe("macos");
  expect(run.calls.map((c) => c.cmd[0])).toEqual(["osascript", "say"]);
  expect(run.calls[0]!.cmd.slice(-2)).toEqual(["Reminder", "bins"]);
  expect(run.calls[1]).toEqual({ cmd: ["say", "-f", "-"], stdin: "Reminder: bins" });
});
