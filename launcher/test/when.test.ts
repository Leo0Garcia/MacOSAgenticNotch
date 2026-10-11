import { expect, test } from "bun:test";
import { parseWhen, WhenError } from "../src/reminders/when";

// Sunday 11 October 2026, 14:40 in London (BST, UTC+1).
const now = Date.parse("2026-10-11T13:40:00Z");
const london = (when: string, at = now) =>
  parseWhen(when, at).toLocaleString("en-GB", { timeZone: "Europe/London", weekday: "short", hour: "2-digit", minute: "2-digit", day: "numeric" });

test.each([
  ["in 20 minutes", "Sun 11, 15:00"],
  ["in an hour and a half", "Sun 11, 16:10"],
  ["in 1h30m", "Sun 11, 16:10"],
  ["in 2 hours and 5 minutes", "Sun 11, 16:45"],
  ["in half an hour", "Sun 11, 15:10"],
  ["at 6pm", "Sun 11, 18:00"],
  ["6:30 pm", "Sun 11, 18:30"],
  ["18:00", "Sun 11, 18:00"],
  ["at 5", "Sun 11, 17:00"],
  ["at 9", "Sun 11, 21:00"],
  ["at 3", "Sun 11, 15:00"],
  ["at 2", "Mon 12, 02:00"],
  ["at 9am", "Mon 12, 09:00"],
  ["tomorrow at 9", "Mon 12, 09:00"],
  ["tomorrow at 5", "Mon 12, 17:00"],
  ["tomorrow at 9am", "Mon 12, 09:00"],
  ["tonight at 8", "Sun 11, 20:00"],
  ["noon", "Mon 12, 12:00"],
  ["midnight", "Mon 12, 00:00"],
  ["friday at 10am", "Fri 16, 10:00"],
  ["at 4pm on friday", "Fri 16, 16:00"],
  ["sunday at 10am", "Sun 18, 10:00"],
  ["half past 4", "Sun 11, 16:30"],
])("%s → %s", (when, expected) => {
  expect(london(when)).toBe(expected);
});

test("ISO timestamps pass through", () => {
  expect(parseWhen("2026-10-12T09:00:00Z", now).toISOString()).toBe("2026-10-12T09:00:00.000Z");
});

test("clock times use London time across the end of BST", () => {
  // Saturday 24 October 2026 22:00 BST; clocks go back at 02:00 on Sunday.
  const sat = Date.parse("2026-10-24T21:00:00Z");
  expect(parseWhen("tomorrow at 9am", sat).toISOString()).toBe("2026-10-25T09:00:00.000Z");
});

test.each(["", "whenever", "in a while", "at 25", "13pm", "yesterday at 5", "2020-01-01T00:00:00Z", "tomorrow"])("rejects %p", (w) => {
  expect(() => parseWhen(w, now)).toThrow(WhenError);
});
