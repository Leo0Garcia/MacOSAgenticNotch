# launcher/

Starts every Jarvis run and schedules reminders. Spec: docs/DESIGN.md sections 4 (4.6 is the interface) and 8.3.

```
launcher/run.sh run "what's the weather in Southampton"     # NDJSON events on stdout
launcher/run.sh open <session-id>                          # open a saved run in the Desktop Code tab
bun launcher/src/reminders.ts schedule < {"at","text","session_id"}   # called by the bridge's remind tool
bun launcher/src/reminders.ts list | cancel <id> | fire <id>
```

A run:

1. Checks Claude Code is v2.1.295+ and that guard/ and bridge/ are there (no unguarded runs).
2. Links `skills/*` into `~/Jarvis/.claude/skills/` and writes `~/Jarvis/state/system-prompt.md` from `prompt.md` plus the librarian's `~/Jarvis/briefing.md`.
3. Writes `~/Jarvis/runs/<id>.mcp.json` for the bridge and spawns `claude -p` from `~/Jarvis` with a new `--session-id` (or `--resume` for an "and also…" within 2 minutes of a saved run), guard settings, auto mode, `--permission-prompts none`, `--chrome`, stream-json and the `{keep, summary}` schema.
4. Stops the run at `system/init` unless it is in auto mode and the `jarvis` bridge connected.
5. Speaks each sentence as it streams through the bridge's `Speaker` and tees the stream to `~/Jarvis/runs/<id>.jsonl`.
6. Logs a `run` row (and `guard` rows) in the bridge's action log, hands the run to `librarian/src/cli.ts enqueue`, then deletes the transcript and run log if `keep` is false. No valid `structured_output` counts as keep.

## Tests

```
cd launcher && bun install && bun test
```

`test/stub-claude.ts` stands in for `claude` (it replays stream-json fixtures shaped like real 2.1.296 output); `say`, `launchctl` and the librarian are stubbed too. Nothing calls a model.
