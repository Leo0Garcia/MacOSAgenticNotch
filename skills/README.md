# skills/

Claude Code skills every Jarvis run loads, through `~/Jarvis/.claude/skills/<name>` symlinks into this folder (docs/DESIGN.md section 4.2). Each skill is a `SKILL.md` plus, where something has to be exact, a small Bun script next to it. No dependencies beyond Bun.

| Skill | Script | What the script owns |
| - | - | - |
| kanban | `kanban.ts list\|add\|move\|remove` | Atomic, format-preserving edits to `Kanban.md` in the master vault |
| reminders | none | Leo's time words go straight to the bridge `mcp__jarvis__remind` |
| slack-digest | `todos.ts channels\|add` | Project to Slack channel map; to-dos into `~/Jarvis-Memory` |
| calendar | `ics.ts`, `apple.ts` | Timetable fetch/cache from Keychain URL; Apple Calendar read; recurrence |
| moodle | `page.ts classify\|deadlines` | Login-page detection and deadline parsing from page text |
| lights | `lights.ts status\|set\|scene` | Room lights through the local Homebridge API; lights and scenes live in `lights.json` |
| needs-access | `ask.ts <kind> <name>` | The one sentence Leo hears when access is missing or guard blocks |

Shared code is in `lib/` (paths, Europe/London time, recurrence, atomic writes).

## Conventions

- Scripts print what Claude should say on stdout, or one line on stderr with an exit code: `2` Leo has to clarify (ask with `mcp__jarvis__ask`), `3` Keychain item missing, `4` macOS permission missing, `1` anything else.
- SKILL.md calls scripts as `bun ${CLAUDE_SKILL_DIR}/<script>.ts` and other skills' scripts as `bun "$JARVIS_REPO/skills/<skill>/<script>.ts"`.
- Environment, same defaults as guard: `JARVIS_HOME` (`~/Jarvis`), `JARVIS_MEMORY` (`~/Jarvis-Memory`), `JARVIS_MASTER_VAULT` (Leo's master vault). `JARVIS_NOW` fixes the clock for tests.
- Read only, except: `kanban.ts` writes `Kanban.md`; `todos.ts` writes notes in `~/Jarvis-Memory`; `ics.ts` writes `~/Jarvis/cache/uni.ics`.
- Secrets stay in Keychain. `ics.ts` reads `jarvis/uni-ical` itself and never prints it.

## Tests

```
cd skills && bun install && bun test
```

Fixtures in `test/fixtures/` are hand-written in each service's format (Obsidian Kanban, iCalendar, the JXA output shape, Moodle page text), not recorded from Leo's accounts. `test/reminders.test.ts` checks the reminders examples against `bridge/src/when.ts`, so a change to the bridge's time rules shows up here.
