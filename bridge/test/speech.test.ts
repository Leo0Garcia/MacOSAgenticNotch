import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Speaker } from "../src/speech";
import { NotchLink } from "../src/notch";
import { FakeApp, stubRunner, tempHome } from "./helpers";

let home: string;
let cleanup: () => void;
beforeEach(() => ({ home, cleanup } = tempHome()));
afterEach(() => cleanup());

function timedRunner(log: string[], ms = 30) {
  return stubRunner(async (_cmd, stdin) => {
    log.push(`start ${stdin}`);
    await Bun.sleep(ms);
    log.push(`end ${stdin}`);
    return {};
  });
}

test("sentences play in order, one at a time", async () => {
  const log: string[] = [];
  const s = new Speaker({ home, run: timedRunner(log) });
  await Promise.all([s.say("one"), s.say("two"), s.say("three")]);
  expect(log).toEqual(["start one", "end one", "start two", "end two", "start three", "end three"]);
});

test("two speakers (launcher and bridge) never overlap", async () => {
  const log: string[] = [];
  const run = timedRunner(log, 40);
  const a = new Speaker({ home, run, pollMs: 5 });
  const b = new Speaker({ home, run, pollMs: 5 });
  await Promise.all([a.say("a1"), b.say("b1"), a.say("a2"), b.say("b2")]);
  for (let i = 0; i < log.length; i += 2) {
    expect(log[i]!.startsWith("start")).toBe(true);
    expect(log[i + 1]).toBe(log[i]!.replace("start", "end"));
  }
  expect(log).toHaveLength(8);
  expect(existsSync(join(home, "run", "speech.lock"))).toBe(false);
});

test("a lock left by a dead process is taken over", async () => {
  const lock = join(home, "run", "speech.lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "pid"), "999999999");
  const old = new Date(Date.now() - 5000);
  utimesSync(lock, old, old);
  const run = stubRunner();
  await new Speaker({ home, run }).say("hello");
  expect(run.calls[0]).toEqual({ cmd: ["say", "-f", "-"], stdin: "hello" });
});

test("say failing is reported and the lock released", async () => {
  const run = stubRunner(() => ({ code: 127, stderr: "say: not found" }));
  const s = new Speaker({ home, run });
  await expect(s.say("hi")).rejects.toThrow(/say failed.*not found/);
  await s.say("again").catch(() => {});
  expect(run.calls).toHaveLength(2);
});

test("tells the app what is being said", async () => {
  const app = new FakeApp(home);
  const link = new NotchLink({ home, client: "launcher", sessionId: "s" });
  try {
    await new Speaker({ home, link, sessionId: "s", run: stubRunner() }).say("It's 14 degrees.");
    const start = await app.next("speak_start");
    expect(start).toMatchObject({ text: "It's 14 degrees.", session_id: "s" });
    expect((await app.next("speak_end")).id).toBe(start.id);
    expect(app.types().slice(1)).toEqual(["speak_start", "speak_end"]);
  } finally {
    link.close();
    app.stop();
  }
});

test("empty text says nothing; long text is cut", async () => {
  const run = stubRunner();
  const s = new Speaker({ home, run });
  await s.say("   ");
  await s.say("x".repeat(2000));
  expect(run.calls).toHaveLength(1);
  expect(run.calls[0]!.stdin!.length).toBe(600);
});

test("picks the most natural installed voice: Premium, then Enhanced, British first", async () => {
  const { bestVoice } = await import("../src/speech");
  const list = [
    "Daniel (English (UK)) en_GB    # Hello! My name is Daniel.",
    "Bells               en_US    # Hello! My name is Bells.",
    "Ava (Enhanced)      en_US    # Hello! My name is Ava.",
    "Jamie (Enhanced)    en_GB    # Hello! My name is Jamie.",
    "Zoe (Premium)       en_US    # Hello! My name is Zoe.",
  ].join("\n");
  expect(bestVoice(list)).toBe("Zoe (Premium)");
  expect(bestVoice(list.replace("Zoe (Premium)       en_US", "Kate (Premium)      en_GB"))).toBe("Kate (Premium)");
  expect(bestVoice(list.split("\n").slice(0, 4).join("\n"))).toBe("Jamie (Enhanced)");
  expect(bestVoice(list.split("\n").slice(0, 2).join("\n"))).toBeNull(); // only compact voices: system default
  expect(bestVoice(list, "Ava (Enhanced)")).toBe("Ava (Enhanced)");
  expect(bestVoice(list, "Not Installed")).toBe("Zoe (Premium)");
});

test("speaks with the chosen voice", async () => {
  const run = stubRunner();
  await new Speaker({ home, run, voice: "Jamie (Enhanced)" }).say("Hello.");
  expect(run.calls[0]!.cmd).toEqual(["say", "-v", "Jamie (Enhanced)", "-f", "-"]);
});
