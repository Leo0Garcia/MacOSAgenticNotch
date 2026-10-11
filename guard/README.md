# guard/

Jarvis's hard limits, enforced in code. Every run loads this folder. Changes here need Leo's explicit approval (see docs/DESIGN.md section 3).

## How a run loads it

```
JARVIS_REPO=/absolute/path/to/MacOSAgenticNotch \
claude -p "…" --settings "$JARVIS_REPO/guard/settings.json" …
```

- `settings.json` holds the permission deny rules and registers `hook.ts` as a `PreToolUse` hook on every tool (`matcher: "*"`) with `onFailure: "block"`.
- The hook command is `bun "$JARVIS_REPO/guard/hook.ts"`. The launcher must export `JARVIS_REPO` and have `bun` on `PATH`. If either is missing the hook can't start and, with `onFailure: "block"`, every tool call is blocked rather than unguarded.
- Requires Claude Code v2.1.295 or later (`onFailure`).

Environment the hook reads (all optional except `JARVIS_REPO`):

| Variable | Default | Meaning |
| - | - | - |
| `JARVIS_REPO` | (required) | Repo root. Deletes and overwrites allowed inside, except `guard/`. |
| `JARVIS_HOME` | `~/Jarvis` | Runtime folder. Deletes and overwrites allowed inside. |
| `JARVIS_MEMORY` | `~/Jarvis-Memory` | Memory vault. Overwrites allowed, deletes not. |
| `JARVIS_MASTER_VAULT` | `/Users/leogarcia/Documents/Obsidian Master Vault` | Notes can be read, created and edited (Leo, 2026-10-11); deleting or moving notes out, and `.obsidian/` / `.trash/`, are denied. |
| `JARVIS_MASTER_VAULT_MCP` | `obsidian` | Regex for MCP server names that point at the master vault. |
| `JARVIS_GUARD_TMPDIRS` | `$TMPDIR:/tmp:/private/tmp` | Temp folders where deletes are allowed. Tests set it. |

## What a denial looks like

The hook prints

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
 "permissionDecisionReason":"guard:no-money: www.barclays.co.uk is a banking, payment, trading or shopping-checkout site (blocked-domains.txt line 17). Safe alternative: I can look it up read-only, summarise it, or set a reminder for you to do it yourself."}}
```

Rule ids: `no-money`, `no-real-consequences`, `no-contacting-as-leo`, `no-harm`. Claude relays the reason. The launcher can match `guard:<rule-id>:` in `permission_denials` to log which limit fired. When the hook allows a call it prints nothing and the normal permission flow (deny rules, auto mode) continues.

## Files

- `settings.json`: deny rules (send and trade tools, credential paths, security commands) and the hook registration.
- `blocked-domains.txt`: `<host> <rule-id> [path-regex]`, one per line. A host covers its subdomains.
- `hook.ts`: entry point. Fails closed: any internal error is a deny.
- `src/decide.ts`: routes each tool to its checks. `src/bash.ts` and `src/shell.ts` parse shell commands (nested `sh -c`, `$(...)`, heredocs, `cd`), `src/applescript.ts` covers `osascript`, `src/mcp.ts` classifies MCP tools by name, `src/paths.ts` holds the path allowlist.
- `test/fixtures/*.json`: recorded hook inputs, one file per limit plus `allowed.json`.

## Tests

```
cd guard && bun install && bun test
```
