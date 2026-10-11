import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import { calendarToday, claudeSessions, frontmostApps, takeSnapshot, timetableToday } from "../src/snapshot";
import { FIXTURES, fakeRunner, tempConfig } from "./helpers";

describe("snapshot probes", () => {
  test("frontmost and visible apps from lsappinfo", async () => {
    const run = fakeRunner({
      "lsappinfo front": { stdout: "ASN:0x0-0x1c01c:\n" },
      "lsappinfo info": { stdout: '"LSDisplayName"="Safari"\n' },
      "lsappinfo visibleProcessList": { stdout: 'ASN:0x0-0x1c01c-"Safari": ASN:0x0-0x2d02d-"Xcode": ASN:0x0-0x3-"Finder":\n' },
    });
    expect(await frontmostApps(run)).toBe("frontmost Safari; also open: Xcode, Finder");
  });

  test("a missing tool says so", async () => {
    expect(await frontmostApps(fakeRunner({}))).toBe("unavailable (lsappinfo: lsappinfo: not found)");
  });

  test("claude agents --json, empty and populated", async () => {
    expect(await claudeSessions(fakeRunner({ "claude agents": { stdout: "[]" } }), "claude")).toBe("none running");
    const run = fakeRunner({
      "claude agents": { stdout: JSON.stringify([{ name: "Jarvis: thesis research", status: "running", cwd: "/Users/leogarcia/Jarvis" }, { id: "abc" }]) },
    });
    expect(await claudeSessions(run, "claude")).toBe("Jarvis: thesis research (running) in /Users/leogarcia/Jarvis; abc");
    expect(await claudeSessions(fakeRunner({ "claude agents": { stdout: "oops" } }), "claude")).toMatch(/isn't JSON/);
  });

  test("Calendar permission missing is named, not swallowed", async () => {
    const denied = fakeRunner({ osascript: { code: 1, stderr: "execution error: Not authorized to send Apple events to Calendar. (-1743)" } });
    expect(await calendarToday(denied)).toBe("unavailable (Calendar access not granted to Jarvis yet)");
    const ok = fakeRunner({ osascript: { stdout: "15:00\tSupervisor meeting\tWork\nall day\tMum's birthday\tHome\n" } });
    expect(await calendarToday(ok)).toBe("15:00 Supervisor meeting (Work); all day Mum's birthday (Home)");
  });

  test("timetable from the cache, and a missing or stale cache", async () => {
    const cfg = await tempConfig();
    expect(await timetableToday(cfg)).toMatch(/no timetable cache yet/);
    await mkdir(join(cfg.home, "cache"));
    const cache = join(cfg.home, "cache", "uni.ics");
    await copyFile(join(FIXTURES, "timetable.ics"), cache);
    await utimes(cache, cfg.now(), cfg.now());
    expect(await timetableToday(cfg)).toBe(
      "all day Reading week planning; 10:00-11:00 COMP2211 Lecture @ Building 32, Room 1015; 14:00-16:00 COMP2207 Lab @ Zepler",
    );
    const old = new Date(cfg.now().getTime() - 3 * 86_400_000);
    await utimes(cache, old, old);
    expect(await timetableToday(cfg)).toMatch(/\(cache over a day old\)$/);
  });

  test("takeSnapshot never throws when everything is missing", async () => {
    const cfg = await tempConfig();
    const snap = await takeSnapshot(cfg, fakeRunner({}));
    expect(Object.values(snap).every((v) => v.startsWith("unavailable"))).toBe(true);
  });
});
