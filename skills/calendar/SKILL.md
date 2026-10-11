---
name: calendar
description: Leo's university timetable (iCal subscription) and his personal Apple Calendar, read only. Use for "what's on today", "when's my next lecture", "am I free tomorrow afternoon", "what's my timetable on Monday".
when_to_use: "timetable", "lectures", "labs", "what's on", "am I free", "my calendar", "my schedule", "next class"
allowed-tools: Bash(bun ${CLAUDE_SKILL_DIR}/ics.ts *), Bash(bun ${CLAUDE_SKILL_DIR}/apple.ts *)
---

# Calendar

Two sources, both read only. Usually check both and merge them by time.

```
bun ${CLAUDE_SKILL_DIR}/ics.ts   --day today|tomorrow|monday|YYYY-MM-DD [--days N] [--json]   # university timetable
bun ${CLAUDE_SKILL_DIR}/apple.ts --day today|tomorrow|monday|YYYY-MM-DD [--days N] [--json]   # Apple Calendar
```

- Times are Europe/London. `--days 7` for "this week".
- `ics.ts` reads the timetable link from Keychain (`jarvis/uni-ical`) itself and caches it for an hour. Never read, print or repeat that link; it is a secret.
- `apple.ts` uses `osascript` against Calendar and never creates, changes or deletes events. If Leo asks to add or move an event, say you can only read his calendar and offer a reminder instead (reminders skill).

Exit codes:

- `ics.ts` exit `3`: the Keychain item is missing. Run `bun "$JARVIS_REPO/skills/needs-access/ask.ts" key uni-ical` and say what it prints.
- `apple.ts` exit `4`: macOS hasn't allowed Calendar automation. Run `bun "$JARVIS_REPO/skills/needs-access/ask.ts" permission automation:Calendar` and say what it prints. Don't try another route to the calendar.
- Exit `1`: say the printed message. If the timetable output starts with the stale-cache note, mention that it may be out of date.

Answer for speech: the next relevant thing first ("Your next lecture is COMP2211 at 11 in 32/1015"), then the rest briefly. Free/busy questions: say the gaps. End with keep=false.
