import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { build, guard } from "../needs-access/ask.ts";

describe("asks", () => {
  test.each([
    ["connector", "notion", "I need the Notion connector for that. Connect it at claude.ai/customize/connectors and ask again.", false],
    ["connector", "Google Calendar", "I need the Google Calendar connector for that. Connect it at claude.ai/customize/connectors and ask again.", false],
    ["login", "moodle", "Log in to Moodle (moodle.ecs.soton.ac.uk) in Chrome and tell me when you're done.", true],
    ["login", "Blackboard", "Log in to Blackboard in Chrome and tell me when you're done.", true],
    [
      "permission",
      "microphone",
      "This needs Microphone access. Approve the prompt, or turn it on in System Settings, Privacy & Security, Microphone, then ask again.",
      false,
    ],
    [
      "permission",
      "automation:Calendar",
      "I need permission to control Calendar. Allow it in System Settings, Privacy & Security, Automation, then ask again.",
      false,
    ],
    [
      "key",
      "uni-ical",
      "I need your university timetable link in Keychain. Run security add-generic-password -s jarvis/uni-ical -a jarvis -w in Terminal, paste it when asked, then ask again.",
      false,
    ],
    ["chrome", "", "I can't reach Chrome. Open Chrome with the Claude extension signed in to your account, then ask again.", false],
  ])("%s %s", (kind, arg, say, wait) => {
    expect(build(kind, arg)).toEqual({ say, wait });
  });

  test("a key ask never contains a secret value, only the service name", () => {
    expect(build("key", "jarvis/notion-token").say).toContain("-s jarvis/notion-token -a jarvis -w in Terminal");
  });
});

describe("guard denials", () => {
  // Reason strings in the format guard/hook.ts emits (guard/README.md).
  test("names the rule, drops the line reference, and offers the safe version", () => {
    const reason =
      "guard:no-money: www.barclays.co.uk is a banking, payment, trading or shopping-checkout site (blocked-domains.txt line 17). Safe alternative: I can look it up read-only, summarise it, or set a reminder for you to do it yourself.";
    expect(guard(reason)).toEqual({
      say: "I can't do that: it breaks my rule of no money or financial actions (www.barclays.co.uk is a banking, payment, trading or shopping-checkout site). I can look it up read-only, summarise it, or set a reminder for you to do it yourself.",
      wait: false,
    });
  });

  test.each([
    ["guard:no-contacting-as-leo: mcp__slack__slack_send_message sends a message as Leo. Safe alternative: I can draft it for you to send.", "no contacting anyone as you"],
    ["guard:no-real-consequences: mcp__claude-in-chrome__form_input submits a form on Leo's behalf. Safe alternative: I can tell you what to fill in.", "nothing that signs, submits"],
    ["guard:no-harm: rm outside ~/Jarvis would delete /Users/leogarcia/Documents/x. Safe alternative: I can move it to the Trash for you to empty.", "nothing that could cause harm"],
  ])("%s", (reason, rule) => {
    expect(guard(reason).say).toContain(rule);
  });

  test("an unrecognised reason still says it was blocked", () => {
    expect(guard("something else").say).toBe("My safety rules blocked that, so I stopped.");
  });
});

test("CLI prints JSON", () => {
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "../needs-access/ask.ts"), "connector", "Notion"]);
  expect(JSON.parse(r.stdout.toString())).toEqual({
    say: "I need the Notion connector for that. Connect it at claude.ai/customize/connectors and ask again.",
    wait: false,
  });
});

describe("chrome.ts", () => {
  test("opens Chrome in the background when it's closed, and leaves it alone when running", async () => {
    const { ensureChrome } = await import("../needs-access/chrome.ts");
    const calls: string[][] = [];
    let running = false;
    const spawn = (cmd: string[]) => {
      calls.push(cmd);
      if (cmd[0] === "pgrep") return { code: running ? 0 : 1, stdout: "" };
      if (cmd[0] === "open") { running = true; return { code: 0, stdout: "" }; }
      return { code: 1, stdout: "" };
    };
    expect(await ensureChrome(spawn, async () => {}, 1000)).toBe("started");
    expect(calls).toContainEqual(["open", "-g", "-a", "Google Chrome"]);
    calls.length = 0;
    expect(await ensureChrome(spawn, async () => {}, 1000)).toBe("running");
    expect(calls.some((c) => c[0] === "open")).toBe(false);
    expect(await ensureChrome(() => ({ code: 1, stdout: "" }), async () => {}, 1000)).toBe("not-installed");
  });
});
