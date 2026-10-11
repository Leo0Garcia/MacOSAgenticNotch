# bridge/

Jarvis's link between a Claude Code run and the notch. A Bun MCP server over stdio with five tools (`speak`, `notify`, `ask`, `log`, `remind`), plus a CLI and library for the launcher and reminder jobs. No runtime dependencies. Spec: [docs/DESIGN.md section 8](../docs/DESIGN.md#8-bridge), including the notch WebSocket protocol the app implements.

## Run it

Claude Code spawns it from the per-run MCP config the launcher writes:

```json
{"mcpServers": {"jarvis": {"command": "bun", "args": ["<repo>/bridge/src/server.ts", "--session-id", "<uuid>"]}}}
```

Without MCP:

```
bun bridge/src/cli.ts speak "It's 14 degrees and dry."
bun bridge/src/cli.ts notify --title "Done" --body "Research saved."
bun bridge/src/cli.ts reminder --text "take the bins out"      # what the launchd job runs
bun bridge/src/cli.ts log --kind run --summary "Weather in Southampton" [--saved] --session-id <uuid>
```

Library, for the launcher's TypeScript: `Speaker` (`src/speech.ts`), `NotchLink` and `fireReminder` (`src/notch.ts`), `appendAction` (`src/actions.ts`), `parseWhen` (`src/when.ts`).

## Environment

| Variable | Default | Meaning |
| - | - | - |
| `JARVIS_HOME` | `~/Jarvis` | `notch.json`, `actions.sqlite`, `run/speech.lock` |
| `JARVIS_REPO` | two levels above `src/` | Where `launcher/src/reminders.ts` is found |
| `JARVIS_SESSION_ID` | none | Fallback when `--session-id` isn't passed |
| `JARVIS_REMIND_SCHEDULER` | `bun <repo>/launcher/src/reminders.ts schedule` | Reminder scheduler command (tests) |

## Files

- `src/server.ts`: MCP entry point. `src/mcp.ts`: minimal JSON-RPC/MCP over stdio (initialize, ping, tools/list, tools/call, cancellation).
- `src/tools.ts`: the five tools and their wording back to Claude.
- `src/protocol.ts`: notch socket message types (protocol 1). `src/notch.ts`: socket client, macOS fallbacks, `fireReminder`.
- `src/speech.ts`: serial `say` queue with a cross-process lock.
- `src/when.ts`: reminder time parsing, Europe/London. `src/remind.ts`: hand-off to the launcher's scheduler.
- `src/actions.ts`: `~/Jarvis/actions.sqlite`.
- `test/helpers.ts`: `FakeApp`, a stand-in for the Swift app's socket server.

## Tests

```
cd bridge && bun install && bun test
```

No model, no network beyond 127.0.0.1, no real `say` or `osascript` (a stub runner records the commands).
