---
name: kanban
description: Read and edit Leo's Kanban board (Kanban.md at the root of his Obsidian master vault). Use when Leo asks what's outstanding, or to add, move, finish or remove a task or card on his board.
when_to_use: "what's on my board", "add X to my kanban", "move X to in progress", "mark X done", "take X off the board", "what have I got to do"
allowed-tools: Bash(bun ${CLAUDE_SKILL_DIR}/kanban.ts *)
---

# Kanban

Leo's board is `Kanban.md` at the root of his master vault (Obsidian Kanban plugin). Change it only through this script, never with Write or Edit, so the board's format survives. Other notes in the vault can be edited normally.

```
bun ${CLAUDE_SKILL_DIR}/kanban.ts list                  # outstanding cards, by lane
bun ${CLAUDE_SKILL_DIR}/kanban.ts list --all            # every lane, done cards too
bun ${CLAUDE_SKILL_DIR}/kanban.ts add "<card text>" [--lane "<lane>"]
bun ${CLAUDE_SKILL_DIR}/kanban.ts move "<card>" --to "<lane>"
bun ${CLAUDE_SKILL_DIR}/kanban.ts remove "<card>"
```

- Lanes are Leo's own: currently `Not Started`, `In-progress`, `Completed`. Lane names match loosely ("in progress", "done" won't match `Completed`: use the real name from `list`).
- New cards go to the first lane that isn't a done lane unless Leo names one.
- "Mark X done" / "finished X" = `move "X" --to "Completed"`. The script ticks the box.
- `<card>` matches the card text case-insensitively; a unique fragment is enough.
- Card text is one line, written the way Leo said it, without a trailing full stop.

Exit codes:

- `0`: done. Say the printed line back in a few words ("Added buy chalk to Not Started.").
- `2`: Leo needs to clarify (no such card or lane, or several cards match). Ask him the printed question with `mcp__jarvis__ask`, then run again with his answer. If `ask` returns no answer, say the question as your reply and stop.
- `1`: anything else (board missing, edited by Obsidian at the same moment twice). Say the printed message; don't retry by editing the file yourself.

If a guard denial comes back, use the needs-access skill to turn it into one sentence.

This is an ephemeral action: end with keep=false unless Leo asked for something he'll come back to.
