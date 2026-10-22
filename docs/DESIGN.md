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

Jarvis never adds files, hooks, routines, skills, settings or branches to any other project, repo or vault of Leo's. The master vault (`/Users/leogarcia/Documents/Obsidian Master Vault`): Jarvis may read, create and edit notes there, but not delete them, move them out, or touch `.obsidian/` (**Decision, Leo, 2026-10-11**; previously read-only except `Kanban.md`). Adding a project to Jarvis is one note in `~/Jarvis-Memory/Projects/`.

Two unavoidable side effects outside these places, both owned by Claude Code or macOS rather than added by Jarvis: Claude Code writes saved-run transcripts under `~/.claude/projects/`, and reminders install launchd agents in `~/Library/LaunchAgents/` named `com.jarvis.reminder.<id>.plist` (removed after they fire). Three daily agents are installed by `run.sh schedules install`: `com.jarvis.moodle-watch.plist` (08:30), `com.jarvis.morning-check.plist` (08:00) and `com.jarvis.wrapup-prompt.plist` (00:00).

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
   - **Master vault**: notes can be read, created and edited (Leo, 2026-10-11). Deletes, moving a note out of the vault, and writes under `.obsidian/` or `.trash/` are denied under `no-harm`. Obsidian MCP servers whose name matches `JARVIS_MASTER_VAULT_MCP` (default `obsidian`) get the same rule: delete, move, rename and remove tools are denied.
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

The launcher captures the stream-json output to `~/Jarvis/runs/<session-id>.jsonl` (a follow-up to a saved run writes `<session-id>.followup-<ms>.jsonl`, so the original log stays untouched). That file, not Claude Code's internal transcript, is what the librarian reads; it is deleted along with the transcript for ephemeral runs. The transcript is `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<cwd-derived>/<session-id>.jsonl` plus a `<session-id>/` folder beside it; the launcher removes both, matching the session id in every project folder.

**Code tab:** CLI sessions do not appear in Claude Desktop's Code tab; Desktop keeps its own list. So "nothing new in my Code tab" holds for every run. A saved run is named with `-n "Jarvis: <title>"`, appears in `claude --resume`, and is logged in the notch. Opening it in the Code tab is `claude --desktop --resume <session-id>` (from the notch row, or Jarvis does it when Leo says "open it"). Jarvis does **not** auto-open Desktop after a saved run (Leo's decision, section 13).

### 4.2 Launch command

```
cd ~/Jarvis && \
claude -p "<transcribed request>" \
  --session-id <uuid> \
  -n "Jarvis: <short title>" \
  --settings <repo>/guard/settings.json \
  --mcp-config ~/Jarvis/runs/<uuid>.mcp.json \
  --append-system-prompt-file ~/Jarvis/state/system-prompt.md \
  --permission-mode auto \
  --permission-prompts none \
  --chrome \
  --output-format stream-json --verbose --include-partial-messages \
  --json-schema '{"type":"object","properties":{"keep":{"type":"boolean"},"summary":{"type":"string"}},"required":["keep","summary"]}'
```

Notes:

- `--mcp-config` adds the bridge server; Leo's own MCP servers and claude.ai connectors still load. No `--strict-mcp-config`. The bridge needs the run's session id as a literal argument, so the launcher writes the config per run (`{"mcpServers":{"jarvis":{"command":"<bun>","args":["<repo>/bridge/src/server.ts","--session-id","<uuid>"],"env":{"JARVIS_REPO":…,"JARVIS_HOME":…}}}}`, absolute bun path) and deletes it when the run ends; see 8.1. (`${VAR}` expansion does work in `--mcp-config` files on v2.1.296, tested 2026-10-11, but the literal config needs no undocumented behaviour.)
- `~/Jarvis/state/system-prompt.md` is rebuilt before every run: `launcher/prompt.md` (Jarvis's standing instructions: spoken style, needs-access, guard relay, the keep rule) followed by the librarian's `~/Jarvis/briefing.md`, or a placeholder when there is none yet. One file because `--append-system-prompt-file` takes one.
- Never `--bare`: it skips skills, hooks, MCP servers and CLAUDE.md, and doesn't use the claude.ai login, which Chrome needs.
- `-n` is set only when the request matches an explicit saved intent ("start a research session on…", "write a brief…"). Other runs that end with keep=true stay unnamed in Claude Code; the notch log labels them with `summary` and they resume by ID.
- Skills load from `~/Jarvis/.claude/skills/<name>`, symlinks into `<repo>/skills/` (symlinked skill folders are supported in the project location). `-p` runs load skills and hooks the same way interactive sessions do unless `--bare` is passed.
- The launcher reads `system/init` and fails loudly if `permissionMode` isn't `auto` (auto mode falls back to Manual when unavailable, which under `--permission-prompts none` would deny every risky action), if the `jarvis` server's status in `mcp_servers` isn't `connected`, or if `mcp_server_errors` is present. It stops the run (SIGTERM), says why, and deletes the transcript. `claude-in-chrome` not connected is only a warning event.
- The launcher refuses to start without `guard/settings.json` or `bridge/src/server.ts`: no run is ever unguarded.
- Minimum Claude Code version: v2.1.295 (guard hook `onFailure: "block"`; `claude --desktop --resume` needs v2.1.285). The launcher checks `claude --version` before a run, cached against the binary's path and mtime.
- The launcher exports `JARVIS_REPO=<repo>` and makes sure `bun` is on `PATH`; the guard hook command is `bun "$JARVIS_REPO/guard/hook.ts"`. See `guard/README.md`.
- Model: quick asks run on `--model sonnet` (`JARVIS_FAST_MODEL`, empty turns routing off); research, writing, planning, code, saved intents and requests over 25 words keep Leo's default (Opus), as `needsSmartModel` in `launcher/src/args.ts` decides. Warm runs start on the fast model, so a request that needs the smart model runs cold. `JARVIS_MODEL` pins one model for everything. **Decision (Leo, 2026-10-11):** switch quick asks, keep Opus for the smartest answers.
- Computer context: the notch app writes `~/Jarvis/state/context.json` when Leo asks (the frontmost app, never Jarvis itself; the front browser tab and a screenshot for "this"/"my screen" requests only when Leo turns them on in Settings, since they need Automation and Screen Recording permission). The launcher puts it in front of the prompt as a `<computer-context>` block, marked as data, when it is under two minutes old (`launcher/src/context.ts`).

### 4.3 Speaking while streaming

The launcher parses `stream_event` text deltas from the main conversation (`parent_tool_use_id` null), cuts at the first sentence boundary, strips markdown and speaks it immediately; the rest is spoken as complete sentences arrive. It speaks through the bridge's `Speaker` library (`bridge/src/speech.ts`), so it shares the speech lock with Claude's `speak` calls and sends `speak_start`/`speak_end` captions to the app. The final `result` event carries `structured_output` and `session_id` (confirmed with stream-json, section 10). `structured_output` arrives as a `StructuredOutput` tool call, so its `input_json_delta`s are never spoken.

**Jarvis waits while Leo talks (Leo, 2026-10-15).** The app keeps `~/Jarvis/run/listening` while Listening shows. A speaker that has the lock waits until it's gone (or over 60 s old, left by a crash), then speaks; a sentence hushed in the meantime is dropped.

**Only two things are spoken (Leo, 2026-10-13):** the run's opening line when it goes on to use tools ("Adding that to your Kanban."), and its final answer. `RunMonitor` holds each message's sentences until it sees whether a tool call follows: narration before a tool is dropped (except the run's first line, marked `opener`), the text before `StructuredOutput` or the end of the turn is the answer. The notch shows the opener as the Working line and no longer lists steps. If a run ends with no text, its structured `say` line is spoken (the `summary` only as a last resort, since it reads like a log line). "Thanks" and greetings get an instant natural reply from the fast path.

**Loose ends (Leo, 2026-10-16):** the spoken answer stops after two sentences and the notch shows the whole reply. A run that goes straight to a tool says "On it." as its opener. Times are spoken naturally by the bridge ("14:30" → "half past two", "17:00" → "five p.m."); captions keep the digits, and nothing else is rewritten. An expired Claude sign-in or another API error is said plainly too ("I'm signed out of Claude… run claude, and type /login"), kept as ephemeral (Leo, 2026-10-21). Hitting Claude's usage limit is said plainly ("I've hit my Claude usage limit. It resets at 5:10pm.") and logged as ephemeral, not a saved task.

**Answers start while they stream (Leo, 2026-10-22).** A message counts as the answer, and is spoken before it finishes, once it has two complete sentences with a third begun (or 140 characters). Narration before a tool call is usually one or two short lines, so this rarely fires early; when it does and a tool call follows, what was said stands as the opener and the real answer still gets its two sentences.

### 4.4 Follow-ups

**Mid-task and just-after requests know the task (Leo, 2026-10-14).** Each run writes `state/active/<session>.json` (request, start time, opening line or latest step, launcher pid) while it works. Every new run gets a `<jarvis-activity>` block in front of the request listing those runs and the exchange that ended in the last two minutes, so "how's it going" or "make it three" isn't met with "what do you mean?". Files from a dead launcher are dropped. Asking something while a run works quietly no longer hushes it, so its answer still comes; only speech in progress is cut off.


"Jarvis, and also…" within 2 minutes of the last run:

- Last run saved: `claude -p "<request>" --resume <session-id>` (same flags). Resume by ID works from any directory; since v2.1.223 Claude Code searches every project on the machine. The original system prompt (briefing) is reused on resume until compaction, which is fine within 2 minutes.
- Last run ephemeral: a new run whose prompt is prefixed with the last request and reply, then dropped after 2 minutes.
- Follow-up phrases: "and also", "and then", "also" at the start (after an optional "Jarvis,"). Outside the window they are ordinary requests.
- The launcher is one process per request, so "in memory" is `~/Jarvis/state/last-run.json` (mode 600). The exchange text is stored only for ephemeral runs and deleted on the first read after the window closes.
- A follow-up to a saved run is always kept, whatever its `keep` says: it is the same session.

### 4.5 Needs-you

Under `-p` with `--permission-prompts none` there is no permission prompt for the `Notification` hook to report. Needs-you comes from three places:

1. The bridge `ask(question)` tool (blocks until Leo answers in the notch or the timeout returns "no answer").
2. `permission_denied` events in the stream and `permission_denials` in the result, which the launcher turns into a spoken one-liner.
3. The `needs-access` skill, which Claude uses when a connector, login, permission or key is missing, producing exactly one ask (e.g. "I need the Notion connector for that, connect it at claude.ai/customize/connectors and ask again"), then ends the run.

### 4.6 Launcher interface

`launcher/run.sh` sets `JARVIS_REPO` and a PATH with bun and claude, then runs `launcher/src/cli.ts`:

- `run.sh run "<request>"` (or the request on stdin): one run. NDJSON events on stdout, exit 0, or 1 on error.
- `run.sh open <session-id>`: `claude --desktop --resume <id>` from `~/Jarvis`, for the notch row or "open it". It runs under `script -q /dev/null` because `claude --desktop` refuses to run without a terminal and the notch app has none.
- Fast path (`launcher/src/fast.ts`): a request that is entirely a light command ("lights off", "lamp to 30%", "bed lights red", "movie mode", "are my lights on") goes straight to `skills/lights/lights.ts` with no Claude run, and Jarvis speaks a one-line confirmation. Any word it doesn't understand ("in 10 minutes", "a bit", an unknown light) sends the request to Claude as usual, as does a script failure. Measured on 2026-10-13: about 0.2–0.6 s to the spoken reply, against 12 s as a full run. `JARVIS_FAST=0` turns it off.
- Instant commands (`launcher/src/instant.ts`, Leo 2026-10-16): a request that is entirely a reminder ("remind me to X at 6pm"), a timer, "what's next today" (timetable plus Apple Calendar), "add X to my Kanban", volume (up, down, to N, mute) or "open <installed app>" runs the same scripts and bridge code a Claude run would, in well under a second. Opening an app is checked against the guard's bash rules and money-app list first; a refusal, a parse miss or any failure goes to Claude, which explains.
- "What's my day?" (Leo 2026-10-16): an instant command that speaks a short rundown, about twenty seconds, of the lectures and calendar events left today, Kanban cards due (`@{date}` on or before today), and Moodle deadlines in the next week from `~/Jarvis/state/deadlines.json` (written by the Moodle watcher). The app also asks for it on the first screen unlock between 5am and midday, once a day, when Jarvis is idle. The same works for another day ("give me an overview of tomorrow", "what's Tuesday look like"): all of that day's events, Kanban cards due by then, and Moodle deadlines in the week from it (Leo, 2026-10-18: tomorrow had taken 2 minutes as a Claude run).
- Moodle deadline watcher (Leo 2026-10-16): launchd runs `run.sh moodle-watch` daily at 08:30, or at the next wake if the Mac slept through it. That is a background Claude run: no speech, no notch, no fast path. It reads the upcoming page read-only through the moodle skill and pipes `page.ts deadlines` into `run.sh moodle-watch save`. `save` keeps `state/deadlines.json` and sets one reminder per deadline, two days before it is due (none if that time has already passed). A signed-out Moodle gets a macOS notification and no login attempt. `app/install.sh` installs the agent.
- Type to Jarvis (Leo 2026-10-16): ⌥⇧ Space opens a text box just under the notch, a non-activating panel that takes the keyboard while the app Leo is in stays frontmost. Return sends it as a request, Esc or clicking away closes it.
- "This" means the clipboard (Leo 2026-10-16): when a request says this, that, clipboard or copied, the app adds the clipboard text (up to 6000 characters) to `state/context.json`, and the launcher puts it in the computer-context block as data. Anything a password manager marks concealed or transient (nspasteboard.org types) is never sent. Reading the pasteboard needs no permission.
- `run.sh warm`: starts claude now (`--input-format stream-json`, no prompt yet), prints `{"event":"ready","sessionId"}`, then reads the request as one line on stdin and continues as `run`. The notch app keeps one warm run ready (replaced after 10 minutes so its briefing stays fresh, and started again after each run), which saves Claude Code's start-up, about 2.4 s per request (measured: first word 6.4 s warm against 8.8 s cold for "what's the time"). A follow-up (4.4) or a saved intent falls back to a cold run, since neither can be set after start; a closed stdin means no request, and the warm run cleans up and exits.
- `bun launcher/src/reminders.ts schedule | fire <id> | list | cancel <id>`: the reminder scheduler (section 8.3).

Events, one JSON object per line: `{"event":"state","state":"working"|"done"|"needs-you"|"error"}`, `{"event":"speak","text"}`, `{"event":"status","text","detail"?}` (a main-conversation tool call as a plain status line, e.g. `Reading BBC` / `bbc.co.uk/weather`; mapping in `launcher/src/status.ts`, Jarvis's own speak/ask/log calls skipped), `{"event":"denied","tool","rule","reason"}` (`rule` is a guard rule id, absent for other denials), `{"event":"warning","message"}`, `{"event":"done","sessionId","keep","summary","reply","name"}`, `{"event":"error","message"}`. A run with any denial ends in `needs-you`. The same milestones go to the app as `run_event` frames when it is running (section 8.2).

After a run the launcher appends a `run` row (`saved` = keep) and a `guard` row per guard denial with `appendAction` (section 8.4), runs the librarian's `enqueue` (section 5) and waits for it, then, if keep is false, deletes the transcript and run log. A failing or missing librarian is logged to `~/Jarvis/logs/launcher.log` and never keeps an ephemeral run on disk.

Reminder scheduling: `schedule` validates `at` (not past, at most a year ahead), rounds up to the next whole minute (launchd's resolution), writes `~/Jarvis/reminders/<id>.json`, stages the plist there, copies it to `~/Library/LaunchAgents/com.jarvis.reminder.<id>.plist` and `launchctl bootstrap gui/<uid>`s it. The agent has `RunAtLoad` and a `StartCalendarInterval` in the Mac's local time, and runs `reminders.ts fire <id>`, which exits quietly until the reminder is due. So a reminder missed while the Mac was off fires at next login instead of being lost. When due it runs `bridge/src/cli.ts reminder --text`, then deletes its files and boots itself out; if the bridge fails, the agent stays and retries at next login.

Environment overrides (tests and odd setups): `JARVIS_HOME`, `JARVIS_MEMORY`, `JARVIS_CLAUDE_BIN`, `JARVIS_MODEL`, `JARVIS_LAUNCHCTL`, `JARVIS_LAUNCH_AGENTS`, `CLAUDE_CONFIG_DIR`.

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
- **calendar**: `ics.ts` reads the iCal URL from Keychain (`security find-generic-password -s jarvis/uni-ical -w`), fetches it, caches an hour in `~/Jarvis/cache/uni.ics`, falls back to a stale cache when the fetch fails, and never prints the URL. `apple.ts` asks the notch app for Apple Calendar events over its socket (`calendar_events`, 8.2; the app holds the Calendars permission, because macOS refused it to a helper started from a run), else reads through EventKit with a small Swift helper (`eventkit.swift`, compiled on first use into `~/Jarvis/bin/jarvis-calendar`, needs Calendars access, which macOS asks Leo for once), falling back to JXA via `osascript` capped at 20 s, read-only. **Decision (2026-10-11):** JXA answered at about 12 ms per event per field, so Leo's ~1,400 events took over 3 minutes per request. Both expand recurrences themselves (daily, weekly with BYDAY, monthly by day; INTERVAL, COUNT, UNTIL, EXDATE, RECURRENCE-ID), keeping wall-clock times across clock changes, because Calendar's scripting filter only sees a repeating event's first date. Known gap: `apple.ts` doesn't read a repeating event's deleted occurrences, so one Leo deleted from a series may still show.
- **moodle**: moodle.ecs.soton.ac.uk through Claude in Chrome with Leo's logged-in session. Modules, deadlines, announcements. Never submits: guard denies browser form submits and uploads. `page.ts classify` spots the Moodle and Microsoft SSO login pages; `page.ts deadlines` parses the Upcoming events page.
- **needs-access**: `ask.ts connector|login|permission|key|chrome|mcp|guard` turns a missing connector, login, permission, key, or a `guard:<rule-id>:` denial into one exact sentence. Logins are the one case that waits: Claude puts the sentence to Leo with `ask` ("Log in to Moodle in Chrome and tell me when you're done") and retries once if he says he's done. Everything else is the final reply, and the run ends. A guard denial becomes "I can't do that: it breaks my rule of … Safe alternative", then Claude does the safe version.
- Mac tasks (open apps, find/rename files, shell, reading the screen when asked) and research ("start a research session on X" → saved run that writes findings to `~/Jarvis-Memory`) need no dedicated skill in phase 1.

Interface for the launcher: skill scripts are invoked as `bun ${CLAUDE_SKILL_DIR}/<script>.ts` (a documented SKILL.md substitution), and cross-skill calls use `$JARVIS_REPO/skills/...`, which the launcher already exports for guard. Scripts read `JARVIS_HOME`, `JARVIS_MEMORY`, `JARVIS_MASTER_VAULT` with guard's defaults. The librarian gets today's timetable without network or Keychain from `bun <repo>/skills/calendar/ics.ts --day today --cache-only --json`.

## 7. Notch app

Swift 6 / SwiftUI on DynamicNotchKit, macOS 15+, no other third-party deps beyond the wake-word SDK (phase 2).

States: idle, listening, working, done, needs-you. Visual and motion spec: [NOTCH-DESIGN.md](NOTCH-DESIGN.md) (Aurora with a pixel character and the Large layout, collapsing to the pill whenever it isn't needed: Leo's picks, 2026-10-11); interactive mockup in `docs/design/notch-mockup.html`. Leo confirmed on 2026-10-11 that the notch may use a large area; it still draws nothing while idle and stays inside its layout's max box. Push-to-talk with a global hotkey (Leo's choice for everyday use), and optional hands-free with a wake word (off by default, "Jarvis", set in Settings; Leo asked for it on 2026-10-11, ahead of phase 2): while enabled the mic stays on, a level-based speech detector watches for speech, and WhisperKit (prompted with the wake word) checks the first seconds of each utterance; "Jarvis, what's the weather" in one breath starts Listening with what was already said, a pause after the name is allowed, and 0.9 s of quiet sends it. Nothing is recorded or kept; the stream is dropped as it is read, and wake checks pause while Jarvis speaks. A third-party app can't use the always-on, low-power hardware that "Hey Siri" runs on, so a wake word means the mic is open. For mic-off use, `jarvis://listen` (URL scheme) listens for one request: a Shortcut named "Jarvis" that opens it lets Leo say "Hey Siri, Jarvis". `jarvis://ask?q=` sends text in. **Decision (differs from the spec):** no Porcupine; it needs a Picovoice key and trained keyword files, and couldn't take any word Leo types. Transcription is WhisperKit on-device. Resting the pointer on the notch for 300 ms while nothing is shown opens the Recent panel: the last 8 actions from `~/Jarvis/actions.sqlite`; clicking a saved row runs `claude --desktop --resume <session-id>`; it closes 400 ms after the pointer leaves (Leo asked for this in phase 1, 2026-10-11). macOS notifications for needs-you and reminders come through the bridge.

Built (app/, see `app/README.md`):

- **Hotkey:** ⌥ Space, push-to-talk, through Carbon `RegisterEventHotKey` (press and release events, no Accessibility or Input Monitoring permission). Esc is registered only while a dismissable panel is open, so it isn't taken from other apps otherwise.
- **Transcription:** WhisperKit 1.1.1 (Argmax, MIT; the `WhisperKit` product has no further dependencies) with `openai_whisper-small.en`, downloaded once to `~/Jarvis/models`. The buffer is re-transcribed about twice a second while the hotkey is held (words two passes agree on are confirmed) and once on release. **Decision (refines the spec):** the project rule allows no third-party dependency beyond DynamicNotchKit and the wake-word SDK, but this section names WhisperKit for phase 1, so it is the one addition; `UserDefaults` key `WhisperModel` switches model.
- **Runs:** the app spawns `launcher/run.sh run "<request>"` and reads its stdout events; captions come from the socket's `speak_start`/`speak_end` (timed to the audio), with stdout `speak` as the fallback. Runs the app didn't start show through `run_event`. The Blocked panel's safe-version button sends "And also, do the safe version instead: <offer>" as a follow-up (4.4); the reminder's "In 10 minutes" calls `launcher/src/reminders.ts schedule` directly. The Access panel is shown when the reply is the needs-access skill's sentence ("I need the … connector/login/permission/key …").
- **Hidden keeps the window:** DynamicNotchKit's `hide()` destroys its window and the next show rebuilds it, which measured 25–40 ms hitches. Hidden is instead DynamicNotchKit's compact state with empty wings (the hardware outline), alpha 0 and click-through; the window is created at launch.
- **Clicks pass through:** DynamicNotchKit's window covers half the screen; while it shows, a 30 Hz check makes everything outside the visible notch shape click-through, and the panel only becomes key when a control needs typing (`becomesKeyOnlyIfNeeded`), so Leo can keep typing and clicking while Jarvis works.
- **Signing:** `app/install.sh` signs with a self-signed "Jarvis Local Signing" identity in the login keychain (`app/setup-signing.sh`, untrusted system-wide), so macOS keeps Jarvis's permissions across rebuilds; the designated requirement is the bundle id plus that certificate, not the build's hash.
- **Settings window:** menu-bar icon → Settings… (⌘,). Voice: style (Jarvis, Natural, Deeper, Custom), depth, pace, AI effect, the Kokoro voice blend, Play sample; saved to `~/Jarvis/state/voice.json`, which `tts/voice.py` reads live. General: hotkey, hover, engines.
- **Film JARVIS voice (Leo, 2026-10-15, free tools only):** a clean, close-mic'd sound, not a robot filter. Depth is a Rubber Band pitch shift (pedalboard, in the tts venv) instead of ffmpeg `asetrate`+`atempo`; the chain is presence EQ, gentle compression and a trace of echo, no chorus; the Jarvis preset's effect is 0.3. Leo preferred it without rewriting codes, times and dates into words, so text goes to Kokoro as written. Chatterbox and Qwen3-TTS were dropped: too much memory (Leo, 2026-10-15).
- **Cheap drawing:** the rim, the character (except Listening, which follows the mic level) and the needs-you dot are Core Animation layers (a rotating conic gradient under a stroked mask; pre-rendered sprite frames stepped by a keyframe animation), so a panel that is only animating costs no app CPU. Measured on the M4, Release build: 0.18 ms/s hitch time over two demo cycles including launch, 0.06 ms/s after it (Animation Hitches; target under 1), and about 0.3% CPU while Working (target under 5%).

**Decision (differs from the spec):** the spec says rows open "via Claude Code deep link". The `claude-cli://open` deep link only takes `q`, `cwd` and `repo`; it cannot open an existing session, and it opens a terminal, not Desktop. `claude --desktop --resume <id>` is the documented way to open a CLI session in the Code tab.

## 8. Bridge

`bridge/` is a dependency-free Bun MCP server over stdio (`bun <repo>/bridge/src/server.ts --session-id <uuid>`, server name `jarvis`, so tools are `mcp__jarvis__<name>`), plus a CLI and library the launcher and reminder jobs use without MCP. None of the tool names trips guard's MCP rules. Details and commands: `bridge/README.md`.

### 8.1 Tools

| Tool | Does | Without the app |
| - | - | - |
| `speak(text)` | Queues the sentence in Jarvis's voice: Kokoro (on-device neural TTS, `tts/`, served on `~/Jarvis/run/tts.sock`, rendered ahead while the previous sentence plays; sentences queued together are rendered two at a time, up to 250 characters, so the intonation carries; played gaplessly by the app's single AVAudioEngine player through `play`/`played`, with `afplay` when the app isn't running), falling back to `say` with the best installed voice (Premium, then Enhanced, British first; `JARVIS_VOICE` overrides). Returns at once; sentences play in order. Tells the app what is being said (`speak_start`/`speak_end`) for the caption. Meant for progress lines; the final reply is spoken by the launcher. | Still speaks. |
| `notify(title, body)` | Notch notification; the app also posts the macOS one. Only Leo sees it. | `osascript display notification` (text passed as argv, never into the script). |
| `ask(question, options?, timeout_seconds?) -> string` | Needs-you question in the notch, up to two answer buttons, voice answer allowed. Blocks until answered, dismissed, or the timeout (default 120 s, 10 to 600). Returns `Leo answered: …`, or a sentence telling Claude to carry on with the safe default or stop. A cancelled MCP request withdraws the question. | Returns "Leo isn't available…" at once so the run never hangs. |
| `log(summary, detail?, kind?)` | Appends to `~/Jarvis/actions.sqlite` (kind `action` or `note`) and sends the row to the app. | Still logs. |
| `remind(when, text)` | Parses `when` (section 8.3), hands the absolute time to the launcher's scheduler, says back "Reminder set for today at 18:00 (UK time)". Fails out loud if the time is unreadable or past, or the scheduler is missing or fails. | Same. |

Speech is one reply at a time across processes: a lock directory `~/Jarvis/run/speech.lock` (holder pid and a per-speaker token inside; taken over if the holder died or after 60 s without a refresh). A speaker keeps the lock while it has sentences queued and for 1.5 s after the last one, refreshing it per sentence, so a reply that streams in sentence by sentence finishes before another run's reply starts; `idle()` gives it back at once. **Decision (Leo, 2026-10-12, several runs talking over each other):** whole replies take turns, first come first served, instead of interleaving per sentence. **Interrupting (Leo, 2026-10-13):** pressing ⌥ Space or starting another request while Jarvis talks stops it at once: the app sends SIGUSR1 to every running launcher (not the waiting warm run) and stops the playing audio; each hushed run mutes its Speaker for good and writes `~/Jarvis/run/muted/<session>` so its bridge's `speak` calls go quiet too. Hushed runs keep working silently; their results still reach the log and the notch. When Claude Code closes the bridge's stdin, the bridge finishes queued speech (up to 30 s) and exits.

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
| `calendar_events` | `id`, `from`, `to` (ISO 8601) | Reads Apple Calendar through EventKit (the app holds the Calendars permission) and replies `calendar_events_result` |

App to client:

| type | Fields |
| - | - |
| `welcome` | `protocol` |
| `answer` | `id`, `text`, `via` (`button` \| `voice` \| `dismissed`; `text` empty when dismissed) |
| `error` | optional `id`, `message` |
| `calendar_events_result` | `id`, `events` (calendar, title, start, end, allDay, location) or `error` {`code`: `denied` \| `bad_range`, `message`} |

If the socket closes while an `ask` is open, the bridge treats it as no answer. Message types and fields are in `bridge/src/protocol.ts`; the app's Swift types mirror them. `bridge/test/helpers.ts` has a fake app that shows the server side.

### 8.3 Reminders (bridge and launcher)

- `when` accepts ISO 8601 (no offset means London time), relative times ("in 20 minutes", "in an hour and a half", "in 1h30m") and clock times with an optional day ("6pm", "18:00", "at 5", "tonight at 8", "tomorrow at 9am", "monday 14:30", "noon", "midnight"). Times are Europe/London, across clock changes. A clock time with no day is its next occurrence; an ambiguous hour with no day is the next future h:00 or (h+12):00 (section 6). On an explicit later day, an ambiguous 1 to 6 is pm and 7 to 11 am. "today at 9am" after 9am is an error, not tomorrow. At most a year ahead.
- The bridge runs `bun <repo>/launcher/src/reminders.ts schedule` with stdin `{"at": "<ISO 8601 UTC>", "text": "…", "session_id": "<uuid>|null"}` and expects exit 0 with stdout (last line) `{"id": "<id>", "at": "<ISO>"}`. Non-zero exit: the last stderr line is relayed to Leo and nothing is claimed. `JARVIS_REMIND_SCHEDULER` overrides the command (tests).
- When the launchd job fires (section 4.6), the launcher runs `bun <repo>/bridge/src/cli.ts reminder --text "<text>"` (or calls `fireReminder` from `bridge/src/notch.ts`): notch reminder via the socket, else a macOS notification plus `say`. It also logs a `reminder` row.

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

**Request details (Leo, 2026-10-22).** The launcher's `run` rows and fast-path `action` rows carry a JSON `detail` (`launcher/src/details.ts`, `RunDetails` with `v: 1`): request, full reply, route (`claude`, `warm`, `instant`, `lights`), model, outcome, turns, cost, every tool step with its start and duration, and `breakdown`, where the time went (Starting Claude, Thinking, Tools, Speaking; or Working for the fast path), which adds up to `totalMs`. The row is written when the run ends and its detail rewritten once the voice has finished. Other rows' `detail` stays free text. Clicking a row in Recent opens these details.

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
| `--json-schema` with `--output-format json` | **Confirmed** | Result has `structured_output`. Failure modes: subtype `error_max_structured_output_retries`, or `success` with no `structured_output`; both handled as keep=true. **With `stream-json`: confirmed by a live run on v2.1.296 (2026-10-11)**: the final `result` event carries `structured_output`, and `--session-id` is honoured. Claude produces it through a `StructuredOutput` tool call, so the run takes an extra turn. | [headless](https://code.claude.com/docs/en/headless#get-structured-output), [structured outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs) |
| `--append-system-prompt-file` | **Confirmed** | Works in `-p`. On `--resume` the recorded system prompt is reused until compaction. | [cli-reference](https://code.claude.com/docs/en/cli-reference#system-prompt-flags) |
| `--resume` by session id from any directory | **Confirmed** (v2.1.223+) | ID search covers the current project, then every project on the machine. | [cli-reference](https://code.claude.com/docs/en/cli-reference) |
| How skills and hooks load for `-p` | **Confirmed** | `-p` loads the same as interactive (user, project, `--settings`, plugins) unless `--bare`. `--settings` hooks merge with others. | [headless](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode), [skills](https://code.claude.com/docs/en/skills), [hooks](https://code.claude.com/docs/en/hooks#hook-locations) |
| PreToolUse can block and return a reason | **Confirmed** | `hookSpecificOutput.permissionDecision: "deny"` + `permissionDecisionReason` (shown to Claude), or exit 2 with stderr. | [hooks](https://code.claude.com/docs/en/hooks#pretooluse-decision-control) |
| Notification hook event | **Confirmed, but not useful here** | Exists, can't block. Its `permission_prompt` type needs a prompt to exist; under `-p --permission-prompts none` requests are denied instead. Needs-you uses the bridge, see 4.5. | [hooks](https://code.claude.com/docs/en/hooks#notification) |
| Deep-link URL format | **Wrong for this use** | `claude-cli://open?q=&cwd=&repo=` opens a new terminal session with a pre-filled prompt; it can't open an existing session. Use `claude --desktop --resume <id>` (v2.1.285+). | [deep-links](https://code.claude.com/docs/en/deep-links), [desktop](https://code.claude.com/docs/en/desktop#coming-from-the-cli) |
| Claude in Chrome from a `-p` run | **Half confirmed** | `--chrome` is a documented CLI flag. Live `-p` run on v2.1.296 (2026-10-11): `system/init` lists `claude-in-chrome` as `connected` with its 22 tools (`navigate`, `read_page`, `get_page_text`, `form_input`, `tabs_create_mcp`, …), and a call works. With no browser attached, `list_connected_browsers` returns `[]`. Driving a real page still needs Leo's Mac with Chrome, the extension (v1.0.36+) and a claude.ai login; the Moodle skill should call `list_connected_browsers` first and use needs-access when it is empty. | [chrome](https://code.claude.com/docs/en/chrome) |
| Obsidian Kanban file format | **Confirmed, with additions** | Leo's description is right; the file also has `kanban-plugin: board` frontmatter, an optional `**Complete**` lane marker, an archive section, and a trailing settings block. See section 9. | [obsidian-kanban source](https://github.com/mgmeyers/obsidian-kanban/blob/main/src/parsers/formats/list.ts) |
| "Named session in my Code tab" (implied by the spec) | **Wrong** | CLI sessions don't appear in Desktop's Code tab; Desktop keeps its own list. See 4.1. | [desktop](https://code.claude.com/docs/en/desktop#coming-from-the-cli) |
| Hook `onFailure: "block"`, `matcher: "*"`, deny-rule tool-name globs (`mcp__*__slack_send_message`) | **Confirmed** | `onFailure` needs v2.1.295. Deny globs must match the whole tool name and remove the tool from context. `mcp__` rules with parentheses are skipped in settings files. Checked 2026-10-11 for guard/. | [hooks](https://code.claude.com/docs/en/hooks), [permissions](https://code.claude.com/docs/en/permissions#tool-name-wildcards) |
| Launcher end to end | **Confirmed** | 2026-10-11, v2.1.296, real `claude` with guard/, bridge/ and librarian/ from main: a question ran in auto mode, was spoken through the bridge Speaker, logged and deleted; "remind me to stretch in 20 minutes" went Claude → bridge `remind` → `reminders.ts schedule` → plist; a WebFetch to barclays.co.uk was denied with `guard:no-money` and reported; a saved run resumed with "and also" by session id. |
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

 hover action log, routing briefs into other projects by driving the project conversation in Claude Desktop or claude.ai/code, never by adding anything to those projects.

## 13. Decisions from Leo

- 2026-10-22 (round 2 of ideas): answers spoken as they stream; request details with a timing breakdown in Recent; a sign-in check at 08:00 (`morning-check`: `claude auth status`, then a one-line no-tools Haiku request, since an expired session still reads as signed in; a signed-out result notifies and is added to the morning rundown); "note that…" appends to the master vault's `Inbox.md` instantly; "wrap up my day" is an instant wrap-up (requests of the day, Kanban moves since the day's first snapshot, first thing tomorrow, Moodle due soon; a day runs 5am to 5am), and at midnight the notch asks whether he wants it; reply without the hotkey for a few seconds after an answer; colours chosen in Settings.

- 2026-10-11: saved runs do not auto-open in Desktop's Code tab. They open on demand from the notch row or when Leo says "open it".
