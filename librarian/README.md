# librarian/

Files each Jarvis run into the memory vault (`~/Jarvis-Memory`) and regenerates `~/Jarvis/briefing.md`. Leo never waits for it.

## How the launcher uses it

After a run's `result` event, the launcher runs, and waits for:

```
bun "$JARVIS_REPO/librarian/src/cli.ts" enqueue \
  --stream-log ~/Jarvis/runs/<session-id>.jsonl \
  --request "<transcribed request>"
```

`enqueue` is fast and makes no model call: it condenses the stream log into a job in `~/Jarvis/librarian/queue/`, starts a detached `drain`, prints the job path and exits 0. Once it returns, the launcher may delete the transcript and stream log of an ephemeral run. Optional flags: `--session-id`, `--keep true|false` and `--summary` override what the stream log's `structured_output` says (no valid `structured_output` means keep, per DESIGN 4.1); `--no-drain` skips starting the worker.

Other commands:

| Command | Does |
| - | - |
| `drain` | Files queued jobs one at a time. Only one drain works at once (`~/Jarvis/librarian/lock`); a second exits and the first picks up its jobs. |
| `retry` | Moves jobs from `~/Jarvis/librarian/failed/` back into the queue and drains. |
| `briefing` | Rebuilds `Index.md` and `briefing.md` without a run, e.g. when the app starts. |
| `init-vault` | Copies `vault-template/` into `~/Jarvis-Memory`, never overwriting. |

Environment: `JARVIS_REPO` (default: this repo), `JARVIS_HOME` (`~/Jarvis`), `JARVIS_MEMORY` (`~/Jarvis-Memory`), `JARVIS_CLAUDE_BIN` (`claude`), `JARVIS_TZ` (`Europe/London`). `bun` must be on `PATH`.

## Filing a job

1. Pick the relevant notes: `Me.md`, today's log, and every `Projects/` or `People/` note whose name appears in the run.
2. One model call, `claude -p --model haiku`, with no tools at all (`--tools ""`, `--strict-mcp-config`, `--disallowedTools "mcp__*"`), `--no-session-persistence`, `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1`, `--permission-prompts none`, guard's `--settings`, and `prompt.md` as the system prompt. The run and notes go in on stdin. It returns `{ops, log}` through `--json-schema`.
3. The script applies the ops (`create`, `replace`, `append`, `move`, `remove`, `set`; no delete). Every path is checked: relative, `.md`, inside the vault after resolving symlinks, not hidden, not `Index.md`, `Log/` or a template. Text that looks like a key, token or card number is refused. Writes are atomic.
4. The script appends the run to `Log/YYYY-MM-DD.md`, rebuilds `Index.md` and `briefing.md`.

The model never touches the filesystem, so the librarian can only write inside `~/Jarvis-Memory` and `~/Jarvis/briefing.md` (plus its own queue and log in `~/Jarvis`), and never the master vault. If the model call fails, the run is still logged with a "Librarian problem" line, the job moves to `failed/`, and the briefing says so.

`briefing.md` holds: Me, any librarian problems, a live snapshot (frontmost apps via `lsappinfo`, `claude agents --json`, today's Apple Calendar via `osascript`, today's timetable from `~/Jarvis/cache/uni.ics`), open Needs Leo items, today's runs, and active projects. Capped at 16 KB; projects come last so they are what gets cut.

## Tests

```
cd librarian && bun install && bun test
```

Tests use `test/fixtures/stub-claude.sh` in place of `claude` and a fake command runner for the snapshot. No live API calls.
