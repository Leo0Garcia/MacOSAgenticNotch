# Jarvis design

Source of truth for how Jarvis works. When a decision changes, change it here in the same PR.

Status: phase 1 design, nothing built yet. Docs checked against code.claude.com/docs on 2026-10-11.

## 1. What Jarvis is

Leo says "Jarvis, <request>" in one breath. The notch expands, speech is transcribed on-device while he talks, and the moment he stops a `claude -p` run starts with full access to his Mac, the web, his MCP servers and Chrome. Jarvis speaks the first sentence of the reply while the rest streams. Nothing waits for Leo.

Jarvis is a general agent. Leo asks for outcomes; Jarvis works out how with what is on the Mac and what it can find. When it lacks something (a connector, a login, a permission, a key) it says exactly what and asks, for example "I need the Notion connector for that, connect it at claude.ai/customize/connectors and ask again". It never silently fails, never fakes a result, and never works around missing access.

## 2. Self-contained

Everything Jarvis needs lives in four places:

| Place | Holds |
| - | - |
| This repo (`MacOSAgenticNotch`) | All code, skills, guard, prompts, vault template |
| `~/Jarvis` | Runtime: `briefing.md`, run logs, SQLite action log, reminder plists staging, `.claude/skills` symlinks into this repo |
| `~/Jarvis-Memory` | Long-term memory vault |
| macOS Keychain | Secrets, service names prefixed `jarvis/` |

Jarvis never adds files, hooks, routines, skills, settings or branches to any other project, repo or vault of Leo's. The master vault (`/Users/leogarcia/Documents/Obsidian Master Vault`) is read-only except `Kanban.md`. Adding a project to Jarvis is one note in `~/Jarvis-Memory/Projects/`.

Two unavoidable side effects outside these places, both owned by Claude Code or macOS rather than added by Jarvis: Claude Code writes saved-run transcripts under `~/.claude/projects/`, and reminders install launchd agents in `~/Library/LaunchAgents/` named `com.jarvis.reminder.<id>.plist` (removed after they fire).

## 3. Hard limits (guard/)

Enforced in code by `guard/`, loaded by every run. Jarvis refuses, names the rule, and offers the safe version (a draft, a summary, a reminder for Leo to do it himself). Any change to `guard/` needs Leo's explicit approval in the thread.

| Rule id | Limit |
| - | - |
| `no-money` | No payments, transfers, purchases, subscriptions, trading or banking sites or apps, no card or account details. Read-only market data is fine. |
| `no-real-consequences` | No tuition fee payment, university enrolment or registration, student finance, government, legal, medical, insurance, or anything that signs or submits on Leo's behalf. |
| `no-contacting-as-leo` | No sending messages, emails, DMs or calls to anyone, family included. Drafts only, shown to Leo. |
| `no-harm` | No deleting or overwriting data outside `~/Jarvis` and this repo, no security or privacy settings, no credentials. |

Enforcement layers:

1. **Permission deny rules** in `guard/settings.json`: send tools for Slack, mail and messaging MCP servers (tool-name globs such as `mcp__*__slack_send_message*`, `mcp__*__*send_email*`), `Read`/`Edit` of credential paths (`~/.ssh`, `~/.aws`, `~/Library/Keychains`, `.env`), Bash `security` subcommands that read or write passwords, `osascript` against Messages and Mail send, `defaults write` on privacy domains, `tccutil`, `csrutil`, `spctl`. Deny rules apply in every permission mode and merge across settings levels, so Leo's own settings cannot loosen them.
2. **PreToolUse hook** (`guard/hook.ts`, run with Bun) on `WebFetch`, `WebSearch`, `Bash`, `Write`, `Edit`, and Chrome tools (`mcp__claude-in-chrome__.*`). It returns `permissionDecision: "deny"` with a `permissionDecisionReason` of the form `guard:<rule-id>: <one-line reason>. Safe alternative: <offer>`. Claude reads that reason and relays it.
   - **Blocked domains**: `guard/blocked-domains.txt`, one pattern per line with a category tag. Seeded with the categories above and UK specifics: Student Finance England, gov.uk (all subdomains), HMRC, University of Southampton fees, payments and registration portals, every UK high-street and online bank, card issuers, PayPal/Stripe checkout, brokers and trading platforms, crypto exchanges, NHS login and insurers. Checked against WebFetch `url`, Chrome navigation URLs, and hosts found in Bash commands.
   - **Path allowlist**: `rm`, `unlink`, `rmdir`, `trash`, `mv` onto an existing file, `>` truncation, `find -delete`, `git clean`, and `Write` over an existing file are allowed only inside `~/Jarvis`, this repo, and `$TMPDIR`. Anywhere else they are denied under `no-harm`. Creating new files and renaming files (without overwriting) is allowed, since "find and rename files" is a day-one task.
   - **Master vault**: any `Write`/`Edit`/shell write under the master vault path is denied unless the target is exactly `Kanban.md` at its root.
3. **`--permission-prompts none`** on every run: anything that would prompt is denied rather than hanging.
4. **Auto mode classifier** (`--permission-mode auto`) as a second net, not relied on for the limits.

Known limit, accepted for phase 1: Bash network blocking is best-effort. The hook extracts hosts from URLs and common tools (`curl`, `wget`, `open`, `python -c` with literal URLs), but an obfuscated command could evade it. The docs confirm deny rules don't match programs by path or inside `sh -c`. The Claude Code sandbox enforces network at OS level but only as an allowlist (`network.allowedDomains`), which doesn't fit a general agent, so it is not used in phase 1. Revisit if a deny-list sandbox option appears.

`guard/` ships tests that feed recorded hook inputs for each limit (e.g. WebFetch to `www.gov.uk`, Chrome navigate to a bank, `rm -rf ~/Documents/x`, Slack send tool) and assert a deny with the right rule id, plus allowed controls (weather lookup, Kanban edit, Moodle read).

## 4. Runs

### 4.1 One agent, two outcomes

Every request is one `claude -p` run. The run decides at the end whether it is worth keeping, through structured output `{keep: boolean, summary: string}`.

- **Ephemeral** (keep=false): questions, lookups, one-shot actions. The launcher deletes the transcript after the librarian has read it.
- **Saved** (keep=true): anything Leo will come back to (research, a brief, code changes). Named, resumable session.

**Decision (differs from the spec):** the spec says ephemeral runs set `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1`. That variable must be set before the run starts, but the run only decides keep/discard at the end, and a run started with it can never be resumed. So every run starts persisted with a launcher-chosen `--session-id <uuid>`, and the launcher deletes the transcript when keep=false. The transcript exists on disk only for the length of the run plus the librarian pass. `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1` is still used for the librarian and for any run the launcher knows in advance is throwaway (e.g. reminder firing). If the result has no valid `structured_output`, the launcher treats it as keep=true so nothing is lost silently, and logs the failure.

The launcher captures the stream-json output to `~/Jarvis/runs/<session-id>.jsonl`. That file, not Claude Code's internal transcript, is what the librarian reads; it is deleted along with the transcript for ephemeral runs.

**Code tab:** CLI sessions do not appear in Claude Desktop's Code tab; Desktop keeps its own list. So "nothing new in my Code tab" holds for every run. A saved run is named with `-n "Jarvis: <title>"`, appears in `claude --resume`, and is logged in the notch. Opening it in the Code tab is `claude --desktop --resume <session-id>` (from the notch row, or Jarvis does it when Leo says "open it"). Jarvis does **not** auto-open Desktop after a saved run (Leo's decision, section 13).

### 4.2 Launch command

```
cd ~/Jarvis && \
claude -p "<transcribed request>" \
  --session-id <uuid> \
  -n "Jarvis: <short title>" \
  --settings <repo>/guard/settings.json \
  --mcp-config <repo>/launcher/jarvis.json \
  --append-system-prompt-file ~/Jarvis/briefing.md \
  --permission-mode auto \
  --permission-prompts none \
  --chrome \
  --output-format stream-json --verbose --include-partial-messages \
  --json-schema '{"type":"object","properties":{"keep":{"type":"boolean"},"summary":{"type":"string"}},"required":["keep","summary"]}'
```

Notes:

- `--mcp-config` adds the bridge server; Leo's own MCP servers and claude.ai connectors still load. No `--strict-mcp-config`.
- Never `--bare`: it skips skills, hooks, MCP servers and CLAUDE.md, and doesn't use the claude.ai login, which Chrome needs.
- `-n` is set only when the request matches an explicit saved intent ("start a research session on…", "write a brief…"). Other runs that end with keep=true stay unnamed in Claude Code; the notch log labels them with `summary` and they resume by ID.
- Skills load from `~/Jarvis/.claude/skills/<name>`, symlinks into `<repo>/skills/` (symlinked skill folders are supported in the project location). `-p` runs load skills and hooks the same way interactive sessions do unless `--bare` is passed.
- The launcher reads `system/init` and fails loudly if `permissionMode` isn't `auto` (auto mode falls back to Manual when unavailable, which under `--permission-prompts none` would deny every risky action), if the bridge isn't in `mcp_servers`, or if `mcp_server_errors` is non-empty.
- Minimum Claude Code version: v2.1.285 (`claude --desktop --resume`). The launcher checks `claude --version` at startup.
- Model: inherits Leo's default. If the ~4 s target is missed, the first lever is `--model sonnet` for ephemeral-intent runs; measured in the launcher thread.

### 4.3 Speaking while streaming

The launcher parses `stream_event` text deltas, cuts at the first sentence boundary, and sends it to the bridge `speak` immediately; the rest is spoken as complete sentences arrive. The final `result` event carries `structured_output` and `session_id`.

### 4.4 Follow-ups

"Jarvis, and also…" within 2 minutes of the last run:

- Last run saved: `claude -p "<request>" --resume <session-id>` (same flags). Resume by ID works from any directory; since v2.1.223 Claude Code searches every project on the machine. The original system prompt (briefing) is reused on resume until compaction, which is fine within 2 minutes.
- Last run ephemeral: a new run whose prompt is prefixed with the last request and reply, held by the launcher in memory for 2 minutes and then dropped.

### 4.5 Needs-you

Under `-p` with `--permission-prompts none` there is no permission prompt for the `Notification` hook to report. Needs-you comes from three places:

1. The bridge `ask(question)` tool (blocks until Leo answers in the notch or the timeout returns "no answer").
2. `permission_denied` events in the stream and `permission_denials` in the result, which the launcher turns into a spoken one-liner.
3. The `needs-access` skill, which Claude uses when a connector, login, permission or key is missing, producing exactly one ask (e.g. "I need the Notion connector for that, connect it at claude.ai/customize/connectors and ask again"), then ends the run.

## 5. Memory

`~/Jarvis-Memory` is the only long-term memory. Everything is wikilinked.

```
Me.md
Index.md
Projects/<name>.md     # frontmatter: status, repos, people, slack_channels, claude_project_url
                       # sections: ## Done, ## To do, ## Needs Leo
Projects/_template.md
People/<name>.md
Log/YYYY-MM-DD.md
```

Projects/ is the registry: "Jarvis, register the Amra project, Slack #amra, people Sue and Ellen" creates `Projects/Amra.md` and missing `People/` notes from the template.

### Librarian

After every run the launcher starts, detached, `claude -p --model haiku` with `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1`, the run's stream log, and the relevant notes. It updates notes and appends to today's Log, then regenerates `~/Jarvis/briefing.md`:

- Me.md
- Active projects (status != archived) with their Needs Leo items
- Live snapshot: frontmost apps, running Claude sessions (`claude agents --json`), today's Apple Calendar events, today's timetable from the iCal cache

Leo never waits for it. The librarian runs with its own guard settings that only allow writes inside `~/Jarvis-Memory` and `~/Jarvis/briefing.md`. Runs queue: if a librarian is still running, the next one waits for it, so notes aren't edited concurrently. If `briefing.md` is missing or stale, the launcher still runs with whatever is there.

## 6. Day-one capabilities (skills/)

Each skill has a fixture-based test. None calls the model in tests.

- **kanban**: `Kanban.md` at master vault root (format in section 9). Add, move, remove, list outstanding. Implemented as a small TS script the skill calls, not freehand edits, so writes are atomic and format-preserving.
- **reminders**: "remind me to X at 6pm / in 20 minutes" calls the bridge `remind(when, text)`, which writes a launchd agent that fires the notch pill and a macOS notification with no run active. Times are Europe/London. An ambiguous hour ("at 5") means the next future occurrence of 05:00 or 17:00, which is almost always 17:00 during the day.
- **slack-digest**: read a channel, thread or DM via Leo's Slack connector, summarise, pull to-dos into a vault note. Send tools are denied by guard.
- **calendar**: timetable from the iCal URL in Keychain (`security find-generic-password -s jarvis/uni-ical -w`), fetched directly, cached an hour in `~/Jarvis/cache/uni.ics`; personal calendar via `osascript` against Calendar, read-only.
- **moodle**: moodle.ecs.soton.ac.uk through Claude in Chrome with Leo's logged-in session. Modules, deadlines, announcements. Never submits: guard denies form submits and upload tools on that host.
- **needs-access**: turns a missing connector, login, permission or key into one exact ask.
- Mac tasks (open apps, find/rename files, shell, reading the screen when asked) and research ("start a research session on X" → saved run that writes findings to `~/Jarvis-Memory`) need no dedicated skill in phase 1.

## 7. Notch app

Swift 6 / SwiftUI on DynamicNotchKit, macOS 15+, no other third-party deps beyond the wake-word SDK (phase 2).

States: idle, listening, working, done, needs-you. Phase 1 is push-to-talk with a global hotkey and WhisperKit on-device transcription. Hover (phase 2) expands to the last ~8 actions from `~/Jarvis/actions.sqlite`; clicking a row runs `claude --desktop --resume <session-id>`. Never larger than the notch area. macOS notifications for needs-you and reminders come through the bridge.

**Decision (differs from the spec):** the spec says rows open "via Claude Code deep link". The `claude-cli://open` deep link only takes `q`, `cwd` and `repo`; it cannot open an existing session, and it opens a terminal, not Desktop. `claude --desktop --resume <id>` is the documented way to open a CLI session in the Code tab.

## 8. Bridge

Bun MCP server over stdio to Claude Code, WebSocket on `127.0.0.1` to the app (random port written to `~/Jarvis/bridge.port`, with a per-boot token so other local processes can't drive the notch). Tools: `speak(text)`, `notify(title, body)`, `ask(question) -> string`, `log(row)`, `remind(when, text)`. Phase 1 `speak` shells out to `say`. When the app isn't running, `speak`/`notify` fall back to `say`/`osascript display notification` and `ask` returns "Leo isn't available" so the run doesn't hang.

## 9. Obsidian Kanban file format (verified)

From the plugin source (mgmeyers/obsidian-kanban, `src/parsers/formats/list.ts`, `src/parsers/common.ts`):

```
---

kanban-plugin: board

---

## Not Started

- [ ] buy chalk


## In-progress

- [ ] something


## Completed

**Complete**
- [x] done thing




%% kanban:settings
```
{"kanban-plugin":"board", ...}
```
%%
```

Rules the kanban script follows:

- Frontmatter `kanban-plugin: board` must stay.
- Lanes are `## <title>` headings; a title may carry a max-items suffix, so match on the title text, not the whole line.
- A lane whose body starts with `**Complete**` marks its cards done: moving a card into it sets `[x]`, moving out sets `[ ]`.
- Cards are `- [ ] text` / `- [x] text`. Multi-line cards continue on indented lines; a card may end with a block id `^abc123`. Move cards as whole blocks.
- An archive section after `***` then `## Archive` and the trailing `%% kanban:settings` block must be preserved byte for byte.
- New cards go at the end of the lane (the plugin's default insertion).
- Atomic write: read, check mtime, write to a temp file in the same directory, `rename`. If the mtime changed between read and write, re-read and retry once, then fail and tell Leo.

Lane names `Not Started`, `In-progress`, `Completed` are Leo's; the script reads whatever lanes exist and matches case-insensitively.

## 10. Verification against the docs

| Item | Result | Notes | Source |
| - | - | - | - |
| `CLAUDE_CODE_SKIP_PROMPT_HISTORY` stops transcript saving | **Confirmed** | Skips prompt history and transcripts in any mode; such sessions can't be resumed. `--no-session-persistence` is the `-p`-only equivalent. Conflicts with "run decides keep", see 4.1. | [env-vars](https://code.claude.com/docs/en/env-vars), [cli-reference](https://code.claude.com/docs/en/cli-reference) |
| `--json-schema` with `--output-format json` | **Confirmed** | Result has `structured_output`. Failure modes: subtype `error_max_structured_output_retries`, or `success` with no `structured_output`; both handled as keep=true. With `stream-json` the final `result` event is the same result message, so it should carry `structured_output`; the docs only show `json`, so the launcher thread smoke-tests this first. | [headless](https://code.claude.com/docs/en/headless#get-structured-output), [structured outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs) |
| `--append-system-prompt-file` | **Confirmed** | Works in `-p`. On `--resume` the recorded system prompt is reused until compaction. | [cli-reference](https://code.claude.com/docs/en/cli-reference#system-prompt-flags) |
| `--resume` by session id from any directory | **Confirmed** (v2.1.223+) | ID search covers the current project, then every project on the machine. | [cli-reference](https://code.claude.com/docs/en/cli-reference) |
| How skills and hooks load for `-p` | **Confirmed** | `-p` loads the same as interactive (user, project, `--settings`, plugins) unless `--bare`. `--settings` hooks merge with others. | [headless](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode), [skills](https://code.claude.com/docs/en/skills), [hooks](https://code.claude.com/docs/en/hooks#hook-locations) |
| PreToolUse can block and return a reason | **Confirmed** | `hookSpecificOutput.permissionDecision: "deny"` + `permissionDecisionReason` (shown to Claude), or exit 2 with stderr. | [hooks](https://code.claude.com/docs/en/hooks#pretooluse-decision-control) |
| Notification hook event | **Confirmed, but not useful here** | Exists, can't block. Its `permission_prompt` type needs a prompt to exist; under `-p --permission-prompts none` requests are denied instead. Needs-you uses the bridge, see 4.5. | [hooks](https://code.claude.com/docs/en/hooks#notification) |
| Deep-link URL format | **Wrong for this use** | `claude-cli://open?q=&cwd=&repo=` opens a new terminal session with a pre-filled prompt; it can't open an existing session. Use `claude --desktop --resume <id>` (v2.1.285+). | [deep-links](https://code.claude.com/docs/en/deep-links), [desktop](https://code.claude.com/docs/en/desktop#coming-from-the-cli) |
| Claude in Chrome from a `-p` run | **Unverifiable from docs** | `--chrome` is a documented CLI flag; the docs neither confirm nor rule out `-p`. Requires claude.ai login (not an API key or `setup-token`), a direct Anthropic plan, extension v1.0.36+. Launcher thread smoke-tests it; if it fails, the Moodle skill says so instead of working around it. | [chrome](https://code.claude.com/docs/en/chrome) |
| Obsidian Kanban file format | **Confirmed, with additions** | Leo's description is right; the file also has `kanban-plugin: board` frontmatter, an optional `**Complete**` lane marker, an archive section, and a trailing settings block. See section 9. | [obsidian-kanban source](https://github.com/mgmeyers/obsidian-kanban/blob/main/src/parsers/formats/list.ts) |
| "Named session in my Code tab" (implied by the spec) | **Wrong** | CLI sessions don't appear in Desktop's Code tab; Desktop keeps its own list. See 4.1. | [desktop](https://code.claude.com/docs/en/desktop#coming-from-the-cli) |
| `--permission-mode auto` in `-p` | **Confirmed** | Falls back to Manual if unavailable; launcher checks `system/init`. Pair with `--permission-prompts none` (v2.1.259+). | [permission-modes](https://code.claude.com/docs/en/permission-modes), [headless](https://code.claude.com/docs/en/headless#turn-off-permission-prompts-in-unattended-runs) |

## 11. Phase 1 build order

1. guard/ (first; everything loads it)
2. launcher/ (smoke-tests stream-json structured output and `--chrome` under `-p` before building on them)
3. bridge/
4. skills/
5. librarian/ + vault-template/
6. app/

Each thread: branch from main, one draft PR named by area, `bun test` in bridge/, launcher/, guard/ and `xcodebuild -scheme Jarvis build` for app/ before calling it done. Every model-calling piece is tested against a stub `claude` binary.

## 12. Phase 2 (not now)

Porcupine wake word ("Jarvis" built-in keyword), better TTS, hover action log, routing briefs into other projects by driving the project conversation in Claude Desktop or claude.ai/code, never by adding anything to those projects.

## 13. Decisions from Leo

- 2026-10-11: saved runs do not auto-open in Desktop's Code tab. They open on demand from the notch row or when Leo says "open it".
