# tts/

Jarvis's voice: Kokoro, an on-device neural TTS, with a blend of its British male voices and a light polish chain tuned toward J.A.R.V.I.S (`voice.py`, presets `jarvis` (default), `natural`, `deeper`).

```
tts/setup.sh                                   # venv + model into ~/Jarvis/tts (once)
~/Jarvis/tts/.venv/bin/python tts/samples.py   # renders each preset to ~/Jarvis/tts/samples/
```

`server.py` keeps the model loaded and renders sentences over `~/Jarvis/run/tts.sock` (HTTP over a Unix socket). The notch app starts it at launch, and the bridge's `Speaker` starts it on first use if needed. Each sentence is rendered while the previous one plays, then played with `afplay`. If the server isn't installed or can't answer, speech falls back to `say` with the best installed macOS voice.

The Settings window (menu-bar icon → Settings…) writes `~/Jarvis/state/voice.json`: style, depth (semitones), pace, AI effect and the voice blend. The server re-reads it when it changes, so edits apply from the next sentence; "Play sample" previews unsaved values. `JARVIS_TTS_PRESET` forces a preset; `JARVIS_TTS=say` turns Kokoro off.
