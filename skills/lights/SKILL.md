---
name: lights
description: Control the lights in Leo's room through Homebridge - the main light, the lamp, the bed lights and the desk lights. On, off, toggle, brightness, colour, warm/cool white, and named scenes (bright, relax, focus, movie, night, off). Use for "turn the lights off", "lamp to 30%", "make the bed lights red", "movie mode", "are my lights on".
when_to_use: "lights", "light", "lamp", "bed lights", "desk lights", "main light", "dim", "brighter", "scene", "movie mode", "bedtime lights"
allowed-tools: Bash(bun ${CLAUDE_SKILL_DIR}/lights.ts *)
---

# Lights

All four lights go through Homebridge on this Mac (`localhost:8581`). Never use Shortcuts, the Home app or the vendor apps for them.

```
bun ${CLAUDE_SKILL_DIR}/lights.ts status [--json]
bun ${CLAUDE_SKILL_DIR}/lights.ts set <light[,light]|all> [on|off|toggle] [--brightness 0-100] [--colour <name|#hex>] [--temp warm|neutral|cool|<kelvin>]
bun ${CLAUDE_SKILL_DIR}/lights.ts scene <name>
bun ${CLAUDE_SKILL_DIR}/lights.ts scenes
```

Lights: `main` (the Govee ceiling light), `lamp`, `bed`, `desk`, or `all`. Join several with commas: `set bed,desk off`.

- "Lights off" / "lights on" with no light named means `all`.
- Brightness or colour alone also turns the light on. `--brightness 0` turns it off.
- "Dim" / "brighter" with no number: run `status`, then go 25 points down or up from the current value.
- Colours: red, orange, amber, yellow, lime, green, teal, cyan, blue, indigo, purple, violet, magenta, pink, white, or a hex code. Use `--temp` for warm, neutral or cool white.
- Scenes are in `lights.json`. "Bedtime" means `night`, "film" means `movie`, "work" or "study" means `focus`.

Exit codes:

- `2`: the light, scene or colour doesn't exist. Ask Leo with `mcp__jarvis__ask` using the printed message, then run it again.
- `1`: say the printed message. If Homebridge stopped answering, the script restarts it once by itself and says so on stderr; don't restart it again or try another route.

Reply in one short sentence: "Done, bed and desk lights are purple at 40 percent." For `status`, say which are on. End with keep=false.

## Adding a light, a room or a scene

Everything Leo might change is in `lights.json`, not the script:

1. Add the device in Homebridge (any plugin) so it shows in the Accessories tab.
2. Add an entry under `lights`: a short key, the exact `accessory` name Homebridge shows, and the `aliases` Leo might say.
3. Optionally add scenes: `"name": { "<light>": { "on": true, "brightness": 40, "colour": "blue" } }`, or `"all": {...}` for every light.
4. Run `bun ${CLAUDE_SKILL_DIR}/lights.ts status` to check it's found.

For a second room or another Homebridge, copy the folder to `skills/<room>-lights`, change `name` above, and edit its `lights.json` (`homebridge` is the UI's URL; its auth must be `none`).
