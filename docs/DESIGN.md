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
| `~/Jarvis` | Runtime: `briefing.md`, run logs, SQLite action log (`actions.sqlite`), `notch.json` (app socket port and token), reminder plists staging, librarian queue (`librarian/`), `cache/`, `logs/`, `.claude/skills` symlinks into this repo |
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
2. **PreToolUse hook** (`guard/hook.ts`, run with Bun) on every tool (`matcher: "*"`, so MCP servers Leo adds later are covered too), registered with `onFailure: "block"` so a hook that can't start or crashes blocks the call. It returns `permissionDecision: "deny"` with a `permissionDecisionReason` of the form `guard:<rule-id>: <one-line reason>. Safe alternative: <offer>`. Claude reads that reason and relays it.
   - **Blocked domains**: `guard/blocked-domains.txt`, one pattern per line with a category tag. Seeded with the categories above and UK specifics: Student Finance England, gov.uk (all subdomains), HMRC, University of Southampton fees, payments and registration portals, every UK high-street and online bank, card issuers, PayPal/Stripe checkout, brokers and trading platforms, crypto exchanges, NHS login and insurers. Checked against WebFetch `url`, Chrome navigation URLs, and hosts found in Bash commands.
   - **Path allowlist**: `rm`, `unlink`, `rmdir`, `trash`, `mv` onto an existing file, `>` truncation, `find -delete`, `git clean`, and `Write` over an existing file are allowed only inside `~/Jarvis`, this repo, and `$TMPDIR`. Anywhere else they are denied under `no-harm`. Creating new files and renaming files (without overwriting) is allowed, since "find and rename files" is a day-one task.
   - **Master vault**: any `Write`/`Edit`/shell write under the master vault path is denied unless the target is exactly `Kanban.md` at its root (or a `.Kanban.md.*tmp*` file beside it, for the atomic rename). Obsidian MCP servers whose name matches `JARVIS_MASTER_VAULT_MCP` (default `obsidian`) get the same rule by tool input path.
   - **Memory vault**: `~/Jarvis-Memory` may be overwritten (notes are rewritten in place) but not deleted from.
   - **MCP tools by name**: send, reply, forward, share, invite, RSVP, comment and scheduled-message tools are denied under `no-contacting-as-leo`; draft tools (`create_draft`, `slack_send_message_draft`) are allowed. Calendar create/update with attendees is denied because it sends invitations. Buy, pay, deposit, withdraw, transfer, trade and order-changing tools are denied under `no-money`; reads (`get_`, `list_`, `search_`, `view_`, `analyze_` …) are allowed. Delete, reset, revoke, merge and similar tools on Leo's cloud data, and anything naming secrets, tokens or passwords, are denied under `no-harm`.
   - **Browser**: upload and form-submit tools on any browser server are denied under `no-real-consequences`.
   - **The guard protects itself**: writes, overwrites and deletes of `<repo>/guard/**`, `~/.claude/settings*.json`, `~/Jarvis/.claude/settings*.json`, `<repo>/.claude/settings*.json` and `~/.claude.json` are denied, so a run can't switch the guard off (e.g. with `disableAllHooks`).
   - **Keychain**: `security find-generic-password -s jarvis/...` is allowed (the calendar skill needs it); every other `security` subcommand is denied.
3. **`--permission-prompts none`** on every run: anything that would prompt is denied rather than hanging.
4. **Auto mode classifier** (`--permission-mode auto`) as a second net, not relied on for the limits.

Known limits, accepted for phase 1:

- The guard sees tool calls, not what a click does. Clicking "Send" in Gmail in Chrome, or typing into a chat with computer use, isn't visible to the hook; those rely on the skills never doing it, Claude's instructions, and the auto-mode classifier. Navigation to blocked sites, upload and submit tools, and send tools are blocked.
- Inline code (`python -c`, `node -e`, AppleScript) is scanned for delete and send primitives with literal paths; computed paths or obfuscated code can evade it.
- Bash network blocking is best-effort. The hook extracts hosts from URLs and common tools (`curl`, `wget`, `open`, `python -c` with literal URLs), but an obfuscated command could evade it. The docs confirm deny rules don't match programs by path or inside `sh -c`. The Claude Code sandbox enforces network at OS level but only as an allowlist (`network.allowedDomains`), which doesn't fit a general agent, so it is not used in phase 1. Revisit if a deny-list sandbox option appears.

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

- `--mcp-config` adds the bridge server; Leo's own MCP servers and claude.ai connectors still load. No `--strict-mcp-config`. The bridge needs the run's session id as a literal argument, so the launcher writes the config per run (`{"mcpServers":{"jarvis":{"command":"bun","args":["<repo>/bridge/src/server.ts","--session-id","<uuid>"]}}}`); see 8.1.
- Never `--bare`: it skips skills, hooks, MCP servers and CLAUDE.md, and doesn't use the claude.ai login, which Chrome needs.
- `-n` is set only when the request matches an explicit saved intent ("start a research session on…", "write a brief…"). Other runs that end with keep=true stay unnamed in Claude Code; the notch log labels them with `summary` and they resume by ID.
- Skills load from `~/Jarvis/.claude/skills/<name>`, symlinks into `<repo>/skills/` (symlinked skill folders are supported in the project location). `-p` runs load skills and hooks the same way interactive sessions do unless `--bare` is passed.
- The launcher reads `system/init` and fails loudly if `permissionMode` isn't `auto` (auto mode falls back to Manual when unavailable, which under `--permission-prompts none` would deny every risky action), if the bridge isn't in `mcp_servers`, or if `mcp_server_errors` is non-empty.
- Minimum Claude Code version: v2.1.295 (guard hook `onFailure: "block"`; `claude --desktop --resume` needs v2.1.285). The launcher checks `claude --version` at startup.
- The launcher exports `JARVIS_REPO=<repo>` and makes sure `bun` is on `PATH`; the guard hook command is `bun "$JARVIS_REPO/guard/hook.ts"`. See `guard/README.md`.
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

After every run the launcher calls `bun <repo>/librarian/src/cli.ts enqueue --stream-log ~/Jarvis/runs/<session-id>.jsonl --request "<text>"` and waits for it (no model call, well under a second). It condenses the stream log into a job in `~/Jarvis/librarian/queue/` and starts a detached worker. Once `enqueue` returns, the launcher may delete an ephemeral run's transcript and stream log; the condensed job is deleted once filed. Leo never waits for the worker.

The worker files jobs one at a time (lock file `~/Jarvis/librarian/lock`), so notes aren't edited concurrently. For each job it makes one `claude -p --model haiku` call with `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1`, `--no-session-persistence`, guard's `--settings`, and **no tools** (`--tools ""`, `--strict-mcp-config`, `--disallowedTools "mcp__*"`). The condensed run, Me.md, today's log and any Projects/People note named in the run go in on stdin; the model returns note edits through `--json-schema` (`create`, `replace`, `append`, `move`, `remove`, `set`; no delete). The script validates every path (inside the vault after resolving symlinks, `.md`, not hidden, not `Index.md`, `Log/` or a template), refuses text that looks like a secret or card number, and writes atomically.

**Decision (refines the spec):** the spec gives the librarian write access through its own guard settings. Instead the model gets no tools and the script does all writes, so the "only `~/Jarvis-Memory` and `briefing.md`" limit is enforced by code the model can't reach, and transcript content (web pages, Slack messages) can't steer a file tool. Log entries, `Index.md` and `briefing.md` are built by the script, not the model.

Then the script appends the run to `Log/YYYY-MM-DD.md` and regenerates `Index.md` and `~/Jarvis/briefing.md`:

- Me.md
- Librarian problems, if any job failed
- Live snapshot: frontmost apps (`lsappinfo`, which needs no Accessibility or Automation permission), running Claude sessions (`claude agents --json`), today's Apple Calendar events (`osascript`, read-only; needs Calendar access, which macOS asks Leo for once), today's timetable from the iCal cache `~/Jarvis/cache/uni.ics` (the calendar skill owns fetching it)
- Open Needs Leo items across active projects
- Today's runs from the log
- Active projects (status != archived), last so a long registry is what gets truncated (cap 16 KB)

If the model call fails, the run is still logged with a "Librarian problem" line, the job moves to `~/Jarvis/librarian/failed/` (`cli.ts retry` re-queues it), and the briefing says so. `cli.ts briefing` rebuilds the briefing without a run (e.g. at app start); `cli.ts init-vault` copies `vault-template/` into `~/Jarvis-Memory` without overwriting. If `briefing.md` is missing or stale, the launcher still runs with whatever is there.

Known limits: AppleScript doesn't expand repeating Apple Calendar events, so a repeating event shows only on its first day (the calendar skill's reader can replace this probe once it exists). The timetable reader expands DAILY/WEEKLY rules, which covers university feeds.

## 6. Day-one capabilities (skills/)

Each skill is `skills/<name>/SKILL.md` plus, where something must be exact, a Bun script beside it. Scripts do the deterministic parts (parsing, atomic writes, secrets); Claude does the reading and the talking. Each has a fixture-based test (`cd skills && bun test`). None calls the model or a live service in tests. Details: `skills/README.md`.

- **kanban**: `Kanban.md` at master vault root (format in section 9). `kanban.ts list|add|move|remove`. Line-level splices so untouched bytes stay identical; atomic write through `.Kanban.md.<pid>.tmp` (the name guard allows), mtime check, one retry. The only script that writes to the master vault.
- **reminders**: "remind me to X at 6pm / in 20 minutes" passes Leo's time words unchanged to the bridge `remind(when, text)` (section 8.3), which owns the parsing and the launchd job. No second parser in skills/, so the rules can't drift. Only dates the bridge doesn't read ("on the 27th") are sent as ISO London wall time.
- **slack-digest**: read a channel, thread or DM via Leo's Slack connector (read and search tools only), summarise, and `todos.ts add` appends `- [ ] <to-do> (from <source>)` under `## To do` in `Projects/<name>.md`, or in `Log/YYYY-MM-DD.md` when no project matches. Deduplicated. `todos.ts channels` maps projects to their `slack_channels`. Send tools are denied by guard.
- **calendar**: `ics.ts` reads the iCal URL from Keychain (`security find-generic-password -s jarvis/uni-ical -w`), fetches it, caches an hour in `~/Jarvis/cache/uni.ics`, falls back to a stale cache when the fetch fails, and never prints the URL. `apple.ts` reads Apple Calendar with JXA via `osascript`, read-only. Both expand recurrences themselves (daily, weekly with BYDAY, monthly by day; INTERVAL, COUNT, UNTIL, EXDATE, RECURRENCE-ID), keeping wall-clock times across clock changes, because Calendar's scripting filter only sees a repeating event's first date. Known gap: `apple.ts` doesn't read a repeating event's deleted occurrences, so one Leo deleted from a series may still show.
- **moodle**: moodle.ecs.soton.ac.uk through Claude in Chrome with Leo's logged-in session. Modules, deadlines, announcements. Never submits: guard denies browser form submits and uploads. `page.ts classify` spots the Moodle and Microsoft SSO login pages; `page.ts deadlines` parses the Upcoming events page.
- **needs-access**: `ask.ts connector|login|permission|key|chrome|mcp|guard` turns a missing connector, login, permission, key, or a `guard:<rule-id>:` denial into one exact sentence. Logins are the one case that waits: Claude puts the sentence to Leo with `ask` ("Log in to Moodle in Chrome and tell me when you're done") and retries once if he says he's done. Everything else is the final reply, and the run ends. A guard denial becomes "I can't do that: it breaks my rule of … Safe alternative", then Claude does the safe version.
- Mac tasks (open apps, find/rename files, shell, reading the screen when asked) and research ("start a research session on X" → saved run that writes findings to `~/Jarvis-Memory`) need no dedicated skill in phase 1.

Interface for the launcher: skill scripts are invoked as `bun ${CLAUDE_SKILL_DIR}/<script>.ts` (a documented SKILL.md substitution), and cross-skill calls use `$JARVIS_REPO/skills/...`, which the launcher already exports for guard. Scripts read `JARVIS_HOME`, `JARVIS_MEMORY`, `JARVIS_MASTER_VAULT` with guard's defaults. The librarian gets today's timetable without network or Keychain from `bun <repo>/skills/calendar/ics.ts --day today --cache-only --json`.

## 7. Notch app

Swift 6 / SwiftUI on DynamicNotchKit, macOS 15+, no other third-party deps beyond the wake-word SDK (phase 2).

States: idle, listening, working, done, needs-you. Visual and motion spec: [NOTCH-DESIGN.md](NOTCH-DESIGN.md) (Aurora with a pixel character and the Large layout, collapsing to the pill whenever it isn't needed: Leo's picks, 2026-10-11); interactive mockup in `docs/design/notch-mockup.html`. Leo confirmed on 2026-10-11 that the notch may use a large area; it still draws nothing while idle and stays inside its layout's max box. Phase 1 is push-to-talk with a global hotkey and WhisperKit on-device transcription. Hover (phase 2) expands to the last ~8 actions from `~/Jarvis/actions.sqlite`; clicking a row runs `claude --desktop --resume <session-id>`. macOS notifications for needs-you and reminders come through the bridge.

**Decision (differs from the spec):** the spec says rows open "via Claude Code deep link". The `claude-cli://open` deep link only takes `q`, `cwd` and `repo`; it cannot open an existing session, and it opens a terminal, not Desktop. `claude --desktop --resume <id>` is the documented way to open a CLI session in the Code tab.

## 8. Bridge

`bridge/` is a dependency-free Bun MCP server over stdio (`bun <repo>/bridge/src/server.ts --session-id <uuid>`, server name `jarvis`, so tools are `mcp__jarvis__<name>`), plus a CLI and library the launcher and reminder jobs use without MCP. None of the tool names trips guard's MCP rules. Details and commands: `bridge/README.md`.

### 8.1 Tools

| Tool | Does | Without the app |
| - | - | - |
| `speak(text)` | Queues `say`, returns at once; sentences play in order. Tells the app what is being said (`speak_start`/`speak_end`) for the caption. Meant for progress lines; the final reply is spoken by the launcher. | Still speaks. |
| `notify(title, body)` | Notch notification; the app also posts the macOS one. Only Leo sees it. | `osascript display notification` (text passed as argv, never into the script). |
| `ask(question, options?, timeout_seconds?) -> string` | Needs-you question in the notch, up to two answer buttons, voice answer allowed. Blocks until answered, dismissed, or the timeout (default 120 s, 10 to 600). Returns `Leo answered: …`, or a sentence telling Claude to carry on with the safe default or stop. A cancelled MCP request withdraws the question. | Returns "Leo isn't available…" at once so the run never hangs. |
| `log(summary, detail?, kind?)` | Appends to `~/Jarvis/actions.sqlite` (kind `action` or `note`) and sends the row to the app. | Still logs. |
| `remind(when, text)` | Parses `when` (section 8.3), hands the absolute time to the launcher's scheduler, says back "Reminder set for today at 18:00 (UK time)". Fails out loud if the time is unreadable or past, or the scheduler is missing or fails. | Same. |

Speech is one utterance at a time across processes: a lock directory `~/Jarvis/run/speech.lock` (holder pid inside; taken over if the holder died or after 60 s) keeps the launcher's streamed reply and Claude's `speak` calls from talking over each other. When Claude Code closes the bridge's stdin, the bridge finishes queued speech (up to 30 s) and exits.

**Session id (decision):** the bridge takes the run's id from `--session-id <uuid>` in its args, else `JARVIS_SESSION_ID`. The docs document `${VAR}` expansion for `.mcp.json` but not for `--mcp-config`, and don't say whether stdio servers inherit the environment, so the launcher writes a per-run MCP config with the literal id (`~/Jarvis/runs/<session-id>.mcp.json`) rather than relying on either.

### 8.2 Notch socket (protocol 1)

**Decision (differs from the earlier draft):** the app hosts the WebSocket, not the bridge. Each run spawns its own bridge, and reminders must reach the notch with no run active, so the one long-lived process is the server. The app listens on `127.0.0.1` on a random port (Network.framework `NWListener` with `NWProtocolWebSocket`, no third-party code) and, once listening, writes `~/Jarvis/notch.json` atomically with mode 0600:

```json
{"port": 52731, "token": "<random 32+ bytes, hex>", "pid": 4242, "protocol": 1}
```

A new token every app launch. The app deletes the file on quit; clients also ignore it when `pid` is dead.

Frames are JSON text, one message each, with a `type`. The first client frame must be `hello`; the app answers `welcome`, or `error` and closes (code 4001) on a wrong token or protocol. Unknown types are ignored by both sides so either can add messages. `id`s are opaque strings chosen by the sender of the request.

Client to app:

| type | Fields | App does |
| - | - | - |
| `hello` | `protocol`, `token`, `client` (`bridge` \| `launcher` \| `reminder` \| `cli`), `pid`, `session_id` | Authenticates; replies `welcome {protocol}` |
| `speak_start` | `id`, `text`, `session_id` | Shows `text` as the Done caption, speaking bars on |
| `speak_end` | `id` | Speaking bars off for that id |
| `notify` | `id`, `title`, `body`, `session_id` | Notch notification + macOS notification |
| `ask` | `id`, `question`, `options` (0 to 2), `timeout_ms`, `session_id` | Needs-you question state + macOS notification; later sends `answer` |
| `ask_cancel` | `id`, `reason` (`timeout` \| `cancelled`) | Drops that question if still shown |
| `reminder` | `id`, `text` | Reminder state + macOS notification |
| `log` | `row` (an `actions` row, 8.4) | Refreshes the hover log (phase 2) |
| `run_event` | `session_id`, `event` (`started` \| `tool` \| `speaking` \| `done` \| `denied` \| `failed`), optional `text`, `keep`, `summary`, `rule` | Optional channel for the launcher's run state (working status line, saved chip, guard block with `rule` = guard rule id) if it doesn't report over stdout |

App to client:

| type | Fields |
| - | - |
| `welcome` | `protocol` |
| `answer` | `id`, `text`, `via` (`button` \| `voice` \| `dismissed`; `text` empty when dismissed) |
| `error` | optional `id`, `message` |

If the socket closes while an `ask` is open, the bridge treats it as no answer. Message types and fields are in `bridge/src/protocol.ts`; the app's Swift types mirror them. `bridge/test/helpers.ts` has a fake app that shows the server side.

### 8.3 Reminders (bridge and launcher)

- `when` accepts ISO 8601 (no offset means London time), relative times ("in 20 minutes", "in an hour and a half", "in 1h30m") and clock times with an optional day ("6pm", "18:00", "at 5", "tonight at 8", "tomorrow at 9am", "monday 14:30", "noon", "midnight"). Times are Europe/London, across clock changes. A clock time with no day is its next occurrence; an ambiguous hour with no day is the next future h:00 or (h+12):00 (section 6). On an explicit later day, an ambiguous 1 to 6 is pm and 7 to 11 am. "today at 9am" after 9am is an error, not tomorrow. At most a year ahead.
- The bridge runs `bun <repo>/launcher/src/reminders.ts schedule` with stdin `{"at": "<ISO 8601 UTC>", "text": "…", "session_id": "<uuid>|null"}` and expects exit 0 with stdout (last line) `{"id": "<id>", "at": "<ISO>"}`. Non-zero exit: the last stderr line is relayed to Leo and nothing is claimed. `JARVIS_REMIND_SCHEDULER` overrides the command (tests).
- When the launchd job fires, the launcher runs `bun <repo>/bridge/src/cli.ts reminder --text "<text>"` (or calls `fireReminder` from `bridge/src/notch.ts`): notch reminder via the socket, else a macOS notification plus `say`. It also logs a `reminder` row.

### 8.4 Action log

The bridge owns `~/Jarvis/actions.sqlite` (WAL, busy timeout 3 s):

```sql
CREATE TABLE actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,          -- ISO 8601 UTC
  session_id TEXT,
  kind TEXT NOT NULL,        -- run | action | note | guard | reminder
  summary TEXT NOT NULL,
  detail TEXT,
  saved INTEGER NOT NULL DEFAULT 0   -- 1: row opens the session (claude --desktop --resume)
);
```

Claude writes `action`/`note` through the `log` tool; the launcher writes `run` and `guard` rows with `bun <repo>/bridge/src/cli.ts log --kind run --summary "…" [--saved] --session-id <id>` or `appendAction` from `bridge/src/actions.ts`. The app reads the newest 8 rows by `id` for the hover log.

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
| Hook `onFailure: "block"`, `matcher: "*"`, deny-rule tool-name globs (`mcp__*__slack_send_message`) | **Confirmed** | `onFailure` needs v2.1.295. Deny globs must match the whole tool name and remove the tool from context. `mcp__` rules with parentheses are skipped in settings files. Checked 2026-10-11 for guard/. | [hooks](https://code.claude.com/docs/en/hooks), [permissions](https://code.claude.com/docs/en/permissions#tool-name-wildcards) |
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
