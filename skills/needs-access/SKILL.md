---
name: needs-access
description: Turn a missing connector, login, macOS permission, Keychain key, Chrome connection, or a guard denial into one exact sentence for Leo. Use whenever a task can't continue because Jarvis lacks access, or when a tool call was denied with a "guard:<rule>:" reason.
when_to_use: a tool isn't loaded, a site shows a login page, macOS refuses access, a Keychain item is missing, or a permission denial starts with "guard:"
allowed-tools: Bash(bun ${CLAUDE_SKILL_DIR}/ask.ts *)
---

# Needs access

Jarvis never silently fails, never fakes a result, and never works around missing access. When something is missing, say exactly what, once, and stop.

```
bun ${CLAUDE_SKILL_DIR}/ask.ts connector <name>       # claude.ai connector not loaded (Notion, Slack, …)
bun ${CLAUDE_SKILL_DIR}/ask.ts login <site>           # site shows a login page in Chrome
bun ${CLAUDE_SKILL_DIR}/ask.ts permission <kind>      # microphone | accessibility | full-disk | screen-recording | automation:<App>
bun ${CLAUDE_SKILL_DIR}/ask.ts key <name>             # Keychain item jarvis/<name> missing
bun ${CLAUDE_SKILL_DIR}/ask.ts chrome                 # Claude in Chrome not connected
bun ${CLAUDE_SKILL_DIR}/ask.ts mcp <server>           # an MCP server from jarvis.json didn't load
bun ${CLAUDE_SKILL_DIR}/ask.ts guard "<reason>"       # a denial whose reason starts with guard:
```

It prints `{"say": "...", "wait": true|false}`.

- `wait: false`: make `say` your whole final reply, word for word, and end the run with keep=false. Don't retry, don't try another tool, site or workaround.
- `wait: true` (logins): put `say` to Leo with `mcp__jarvis__ask`. If he answers that he's done, retry once. If he doesn't answer or it still fails, make `say` your final reply and stop.

## Guard denials

When a tool call is denied and the reason starts with `guard:<rule-id>:`, a hard limit fired (no-money, no-real-consequences, no-contacting-as-leo, no-harm). Run `ask.ts guard "<the full reason>"` and reply with what it prints: it names the rule and offers the safe version. Then do the safe version if it fits what Leo asked (write the draft, summarise the page read-only, or set a reminder for him to do it himself) and say you did. Never retry the blocked action another way: through a different tool, a shell command, a different URL for the same site, or by asking Leo to approve it.

Only things in this list: connector, login, permission, key, chrome, mcp, guard. For anything else missing, say plainly what it is and how Leo gets it, in one sentence.
