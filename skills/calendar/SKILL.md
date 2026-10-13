---
name: calendar
description: Leo's university timetable (iCal subscription, read only) and his personal Apple Calendar (read, and add events). Use for "what's on today", "when's my next lecture", "am I free tomorrow afternoon", "add X to my calendar", "put a weekly meeting in".
when_to_use: "timetable", "lectures", "labs", "what's on", "am I free", "my calendar", "my schedule", "next class", "add to my calendar", "book in", "repeating event"
allowed-tools: Bash(bun ${CLAUDE_SKILL_DIR}/ics.ts *), Bash(bun ${CLAUDE_SKILL_DIR}/apple.ts *)
---

# Calendar

Two sources. Usually check both and merge them by time. The timetable is read only; Apple Calendar can also take new events.

```
bun ${CLAUDE_SKILL_DIR}/ics.ts   --day today|tomorrow|monday|YYYY-MM-DD [--days N] [--json]   # university timetable
bun ${CLAUDE_SKILL_DIR}/apple.ts --day today|tomorrow|monday|YYYY-MM-DD [--days N] [--json]   # Apple Calendar
bun ${CLAUDE_SKILL_DIR}/apple.ts add --title "Group project meeting" --start 2026-10-20T11:00 [--end 2026-10-20T12:00 | --minutes 60] \
    [--all-day] [--location L] [--calendar NAME] [--repeat daily|weekly|monthly|yearly] [--until YYYY-MM-DD]
```

- Times are Europe/London. `--days 7` for "this week".
- `ics.ts` reads the timetable link from Keychain (`jarvis/uni-ical`) itself and caches it for an hour. Never read, print or repeat that link; it is a secret.
- `apple.ts` reads Calendar through EventKit (a small helper it builds once into `~/Jarvis/bin`), falling back to `osascript`. It answers in under a second; if it reports Calendar took too long, say so rather than retrying.
- `apple.ts add` adds one event (or a repeating series) to his default calendar, or `--calendar NAME`. Times are London wall time; work out the date yourself ("next Tuesday" → YYYY-MM-DD). Default length is an hour. `--repeat weekly` repeats on the start's weekday; without `--until` it repeats forever. Read the day back first if a clash matters. Never add attendees or invitations (that would contact people as Leo). It can't move or delete events: say so and offer to add the new one so Leo can delete the old one himself.

Exit codes:

- `ics.ts` exit `3`: the Keychain item is missing. Run `bun "$JARVIS_REPO/skills/needs-access/ask.ts" key uni-ical` and say what it prints.
- `apple.ts` exit `4`: macOS hasn't allowed Jarvis to read Calendar. Run `bun "$JARVIS_REPO/skills/needs-access/ask.ts" permission calendars` and say what it prints. Don't try another route to the calendar.
- `apple.ts add` exit `5`: the Jarvis notch app isn't running, and only it may write to Calendar. Say so; don't try AppleScript.
- Exit `1`: say the printed message. If the timetable output starts with the stale-cache note, mention that it may be out of date.

Answer for speech: the next relevant thing first ("Your next lecture is COMP2211 at 11 in 32/1015"), then the rest briefly. Free/busy questions: say the gaps. After adding, confirm what and when in one sentence ("Added group project meeting, Tuesdays at 11, to Home"). End with keep=false.
