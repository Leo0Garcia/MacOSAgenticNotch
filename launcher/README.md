# launcher/

Starts every Jarvis run and runs reminders. The design is docs/DESIGN.md sections 4 and 6; this is the short version.

```
launcher/run.sh run "what's the weather in Southampton"     # NDJSON events on stdout
launcher/run.sh open <session-id>                          # open a saved run in the Desktop Code tab
launcher/run.sh remind add --when "in 20 minutes" --text "check the oven"
launcher/run.sh remind list | remind cancel <id>
```

A run:

1. Checks Claude Code is v2.1.295+ and that `guard/settings.json` exists (no unguarded runs).
2. Links `skills/*` into `~/Jarvis/.claude/skills/` and writes `~/Jarvis/state/system-prompt.md` from `prompt.md` plus the librarian's `~/Jarvis/briefing.md`.
3. Spawns `claude -p` from `~/Jarvis` with a new `--session-id` (or `--resume` for an "and also…" within 2 minutes of a saved run), guard settings, `jarvis.json`, auto mode, `--permission-prompts none`, `--chrome`, stream-json and the `{keep, summary}` schema.
4. Stops the run at `system/init` unless it is in auto mode and the `jarvis` bridge connected.
5. Speaks each sentence as it streams (`say`; `JARVIS_SAY=""` leaves speech to the app) and tees the stream to `~/Jarvis/runs/<id>.jsonl`.
6. Records the run in `~/Jarvis/actions.sqlite` (`runs`), then starts `finalize` detached: librarian first, then, if `keep` is false, deletes the transcript and run log. No valid `structured_output` counts as keep.

Reminders are launchd agents `com.jarvis.reminder.<id>` that notify, append to `~/Jarvis/reminders/fired.jsonl`, speak, and remove themselves.

## Tests

```
cd launcher && bun install && bun test
```

Tests use `test/stub-claude.ts` in place of `claude` (it replays stream-json fixtures shaped like real 2.1.296 output) and stub `say`, `launchctl` and `osascript`. Nothing calls a model.
