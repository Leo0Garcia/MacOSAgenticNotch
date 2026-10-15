import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
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

test("waits while Leo is talking, then speaks; an old marker is ignored", async () => {
  const log: string[] = [];
  mkdirSync(join(home, "run"), { recursive: true });
  const marker = join(home, "run", "listening");
  writeFileSync(marker, "");
  const s = new Speaker({ home, run: timedRunner(log), pollMs: 5, holdMs: 0 });
  const said = s.say("Done.");
  await Bun.sleep(80);
  expect(log).toEqual([]);
  rmSync(marker);
  await said;
  expect(log).toEqual(["start Done.", "end Done."]);

  writeFileSync(marker, "");
  const old = (Date.now() - 120_000) / 1000;
  utimesSync(marker, old, old);
  await s.say("Again.");
  expect(log.slice(2)).toEqual(["start Again.", "end Again."]);
});

test("two speakers (launcher and bridge) never overlap", async () => {
  const log: string[] = [];
  const run = timedRunner(log, 40);
  const a = new Speaker({ home, run, pollMs: 5 });
  const b = new Speaker({ home, run, pollMs: 5 });
  await Promise.all([a.say("a1"), b.say("b1"), a.say("a2"), b.say("b2")]);
  await Promise.all([a.idle(), b.idle()]);
  for (let i = 0; i < log.length; i += 2) {
    expect(log[i]!.startsWith("start")).toBe(true);
    expect(log[i + 1]).toBe(log[i]!.replace("start", "end"));
  }
  expect(log).toHaveLength(8);
  expect(existsSync(join(home, "run", "speech.lock"))).toBe(false);
});

test("two runs replying at once take turns by whole reply, not sentence by sentence", async () => {
  const log: string[] = [];
  const run = timedRunner(log, 30);
  const a = new Speaker({ home, run, pollMs: 5, holdMs: 300 });
  const b = new Speaker({ home, run, pollMs: 5, holdMs: 300 });
  // a's reply streams in with gaps (as sentences arrive); b starts talking in the middle.
  const aDone = (async () => {
    const p1 = a.say("a1");
    await Bun.sleep(50);
    const p2 = a.say("a2");
    await Bun.sleep(50);
    await Promise.all([p1, p2, a.say("a3")]);
  })();
  await Bun.sleep(10);
  const bDone = Promise.all([b.say("b1"), b.say("b2")]);
  await Promise.all([aDone, bDone]);
  await Promise.all([a.idle(), b.idle()]);
  const spoken = log.filter((l) => l.startsWith("start")).map((l) => l.slice(6));
  expect(spoken).toEqual(["a1", "a2", "a3", "b1", "b2"]);
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

test("plays the neural voice's audio when it renders, and falls back to say when it can't", async () => {
  const run = stubRunner();
  const rendered: string[] = [];
  const synth = {
    async render(text: string) {
      rendered.push(text);
      if (text === "fallback") return null;
      const f = join(home, `${text}.wav`);
      writeFileSync(f, "RIFF");
      return f;
    },
  };
  const s = new Speaker({ home, run, synth, voice: null });
  await Promise.all([s.say("one"), s.say("fallback")]);
  expect(rendered).toEqual(["one", "fallback"]); // both rendered up front
  expect(run.calls.map((c) => c.cmd[0])).toEqual(["afplay", "say"]);
  expect(existsSync(join(home, "one.wav"))).toBe(false); // temp audio removed
});

test("Kokoro is used only when installed, and JARVIS_TTS=say turns it off", async () => {
  const { KokoroSynth } = await import("../src/speech");
  expect(KokoroSynth.available(home)).toBe(false);
  mkdirSync(join(home, "tts", ".venv", "bin"), { recursive: true });
  writeFileSync(join(home, "tts", "kokoro-v1.0.onnx"), "");
  writeFileSync(join(home, "tts", ".venv", "bin", "python"), "");
  expect(KokoroSynth.available(home)).toBe(true);
  expect(KokoroSynth.available(home, { JARVIS_TTS: "say" })).toBe(false);
});

test("JARVIS_MUTE=1 sends captions but plays nothing", async () => {
  const run = stubRunner();
  process.env.JARVIS_MUTE = "1";
  try {
    await new Speaker({ home, run, synth: null }).say("quiet please");
  } finally {
    delete process.env.JARVIS_MUTE;
  }
  expect(run.calls).toHaveLength(0);
});

test("muting drops what's queued and keeps the run quiet, bridge included", async () => {
  const log: string[] = [];
  const run = timedRunner(log, 30);
  const a = new Speaker({ home, run, synth: null, voice: null, sessionId: "s-old", holdMs: 10 });
  const first = a.say("one");
  const rest = [a.say("two"), a.say("three")];
  await Bun.sleep(10);
  a.mute(); // Leo pressed Option-Space during "one"
  await Promise.all([first, ...rest]);
  await a.say("four"); // the old run keeps working, silently
  const bridge = new Speaker({ home, run, synth: null, voice: null, sessionId: "s-old" });
  await bridge.say("progress line from the same run");
  const fresh = new Speaker({ home, run, synth: null, voice: null, sessionId: "s-new" });
  await fresh.say("new reply");
  await Promise.all([a.idle(), bridge.idle(), fresh.idle()]);
  expect(log.filter((l) => l.startsWith("start")).map((l) => l.slice(6))).toEqual(["one", "new reply"]);
});
