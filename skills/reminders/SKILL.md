---
name: reminders
description: Set a reminder that fires through the notch and a macOS notification at a time Leo gives, even when no run is active. Use for "remind me to X at 6pm", "in 20 minutes", "tomorrow at 9".
when_to_use: "remind me", "set a reminder", "don't let me forget", "nudge me at"
allowed-tools: mcp__jarvis__remind
---

# Reminders

The Jarvis bridge tool `mcp__jarvis__remind(when, text)` does the work: it parses the time (Europe/London, across clock changes), schedules a launchd job through the launcher, and says back when it will fire. See docs/DESIGN.md section 8.3.

1. Split Leo's request into **text** and **when**.
   - `text`: a short imperative for Leo, capitalised, no full stop: "Call Mum", "Take the pizza out".
   - `when`: Leo's time words, unchanged: "at 6pm", "in 20 minutes", "at 5", "tomorrow at 9am", "monday 14:30", "tonight at 8", "noon". Don't convert them yourself; the bridge applies Leo's rules (a bare "at 5" is the next 5 o'clock still ahead).
   - Only for a calendar date the bridge doesn't read ("on the 27th", "20 October") write ISO 8601 London wall time without an offset: `2026-10-27T10:00`. Check the year and weekday against today's date in the briefing.
2. Call `mcp__jarvis__remind` once.
3. Reply in one sentence from what it returned: "I'll remind you to call Mum today at 18:00."

When it fails:

- An unreadable or past time: ask Leo with `mcp__jarvis__ask` ("What time should I remind you?"), then call `remind` again with his answer. If `ask` comes back without an answer, say the question as your reply and stop.
- The scheduler failed: say the bridge's message. Don't retry another way.
- `mcp__jarvis__remind` isn't available: run `bun "$JARVIS_REPO/skills/needs-access/ask.ts" mcp jarvis` and say what it prints. Never fall back to `at`, `launchctl`, Calendar, Reminders.app or a sleep loop.

Reminders are for Leo only. "Remind Sue to…" can't message Sue: offer to remind Leo to tell her.

End with keep=false.
