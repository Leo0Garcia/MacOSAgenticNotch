# Improving Jarvis's voice: research (2026-10-15)

## Where we are

`tts/voice.py`: Kokoro 82M (ONNX, CPU) with a blend of four British male voices (`bm_george` 0.55, `bm_fable` 0.25, `bm_daniel`, `bm_lewis`) at a pace of 1.04. On top of that, a pitch drop of 0.75 of a semitone and an ffmpeg "AI" chain (EQ, a short echo, chorus, a compressor and loudnorm). Each sentence is rendered separately and played with `afplay`.

Kokoro can't do three things here:
- **Flat prosody.** It has no emotion or emphasis control and can't clone a voice. It sounds clear but reads things out rather than talking.
- **Sentence-by-sentence rendering.** Every sentence starts from neutral intonation, which gives the "list of statements" feel and a small gap between sentences.
- **Pitch shifting with `asetrate` + `atempo`.** This adds a phasey or metallic tinge. The chorus and echo make it worse and can read as cheap rather than Jarvis.

## Quick wins (no model change)

1. **Pitch shift with the rubberband filter.** Replace `asetrate/atempo` with `rubberband=pitch=<ratio>`, which needs an ffmpeg built with librubberband. It's far cleaner at small shifts.
2. **Lighten the polish.** Drop the chorus and keep a much lower echo. Movie J.A.R.V.I.S. is mostly a clean, close voice with presence EQ and slight compression. Try `effect` around 0.3.
3. **Render in bigger chunks.** Send two sentences or about 250 characters per render instead of one, so intonation carries across. It costs a little first-word latency.
4. **Text normalisation before TTS.** Expand times, dates, module codes ("COMP2311" → "comp twenty-three eleven") and units. Kokoro misreads these, and they're a big part of what sounds robotic.
5. **Gapless playback.** Queue the WAVs into one AVAudioEngine/AVAudioPlayerNode in the app instead of spawning `afplay` per sentence. This removes the clicks and gaps between sentences.

## Bigger upgrades

### Local, on-device (private, free)
- **Chatterbox / Chatterbox Turbo** (Resemble AI, MIT). It's the open model people most often rate top for expressiveness, with an "exaggeration" control and zero-shot cloning from a short clip. It runs on Apple MPS. **Best candidate.**
- **Qwen3-TTS** (0.6B / 1.7B, Apache 2.0). You can steer it with plain-language instructions ("dry, understated, slightly amused"), and it clones from about 3 seconds of audio. It runs through mlx-audio on Apple Silicon, but test its speed first.
- **mlx-audio** (Blaizzy). This is an MLX library for Kokoro, Qwen3-TTS, CSM and Dia, and it has a Swift package. Moving Kokoro to MLX alone should cut render time compared with ONNX on the CPU, and it makes trying the models above cheap.
- Skip: XTTS v2 (non-commercial licence, CPU-only on Mac) and Bark (dormant).

### Cloud (best quality, costs money, needs internet)
- **ElevenLabs.** It has the biggest voice library and Voice Design (describe a voice and it generates one). Flash claims about 75 ms to first audio, and v3 adds expressive audio tags. It's the most "film quality" option.
- **Cartesia Sonic-3.** It's the latency leader (about 40 to 90 ms claimed) and good for snappy replies.
- **OpenAI gpt-4o-mini-tts.** It's the cheapest (about 1.5¢ a minute) and steerable with an instructions prompt, but it has fewer voices and no cloning.
- Any of these would slot in behind the existing `/render` socket, with Kokoro as the offline fallback. They need an API key in Keychain, and they cost money, so Leo signs up himself.

## A note on "sounding like J.A.R.V.I.S."
Cloning Paul Bettany's actual voice from film clips is a no: it's a real person's voice. The legitimate route is a *designed* voice in the same style: British RP, mid-low, dry, unhurried, close-mic'd. Use ElevenLabs Voice Design or Chatterbox/Qwen3 cloning from a consenting reference speaker (or a voice we generate once and keep).

## Suggested order
1. Quick wins 1, 2 and 4 (about an hour, no new dependencies), then A/B them with `samples.py`.
2. Spike Chatterbox and Qwen3-TTS through mlx-audio as extra presets in `voice.py`, then compare latency and quality on the same line.
3. Only if local still isn't good enough: an optional ElevenLabs backend with Kokoro as the fallback.

## Sources
- https://www.yaps.ai/blog/best-local-tts-models
- https://openvoxai.com/blog/best-free-local-tts-models-2026
- https://www.promptquorum.com/power-local-llm/best-local-tts-mac
- https://localaimaster.com/blog/local-ai-voice-clone
- https://github.com/Blaizzy/mlx-audio
- https://futureagi.com/blog/elevenlabs-vs-cartesia-tts-2026/
- https://www.pkgpulse.com/guides/elevenlabs-vs-openai-tts-vs-cartesia-text-to-speech-2026
- https://fast.io/resources/best-ai-text-to-speech-tools-2026/
