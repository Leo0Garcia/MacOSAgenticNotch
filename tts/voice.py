"""Jarvis's voice: Kokoro (on-device neural TTS) with a blended British male
voice and a light polish chain. Shared by the speech server and the sample
script so what Leo hears in samples is what Jarvis says."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass, field

import numpy as np

HOME = os.environ.get("JARVIS_HOME", os.path.expanduser("~/Jarvis"))
MODEL = os.path.join(HOME, "tts", "kokoro-v1.0.onnx")
VOICES = os.path.join(HOME, "tts", "voices-v1.0.bin")
SR = 24000
# Apps started from Finder get a minimal PATH, so look in Homebrew too.
FFMPEG = shutil.which("ffmpeg") or next((p for p in ("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg") if os.path.exists(p)), "ffmpeg")


@dataclass
class Preset:
    name: str
    blend: dict[str, float]          # Kokoro voice -> weight
    speed: float = 1.0               # pace
    semitones: float = 0.0           # depth: pitch shift, fine for about ±3
    effect: float = 1.0              # 0 = clean, 1 = the full "AI" polish

    def key(self) -> str:
        return ",".join(f"{v}:{w:.3f}" for v, w in sorted(self.blend.items()))


def polish(effect: float) -> list[str]:
    """The film JARVIS sound, scaled by `effect` (0–1): a clean, close-mic'd
    voice. Tidy low end, a little presence and air, gentle compression, and
    only a trace of a small room. No chorus: that read as a robot filter
    (Leo, 2026-10-15)."""
    e = max(0.0, min(1.0, effect))
    fx = [
        "highpass=f=80",
        "equalizer=f=250:t=q:w=1.2:g=-1.5",
        f"equalizer=f=3500:t=q:w=1.2:g={1 + 2 * e:.2f}",
        f"equalizer=f=10000:t=q:w=1.0:g={0.5 + 1.5 * e:.2f}",
        f"acompressor=threshold=-22dB:ratio={1.5 + e:.2f}:attack=8:release=120",
    ]
    if e > 0.02:
        fx.append(f"aecho=0.9:0.6:12:{0.1 * e:.3f}")
    return fx + ["alimiter=limit=0.89"]


def shift_pitch(audio: np.ndarray, semitones: float) -> np.ndarray:
    """Rubber Band pitch shift (through pedalboard) at the same length. Much
    cleaner than ffmpeg's asetrate + atempo, which smeared the voice."""
    if not semitones:
        return audio
    from pedalboard import PitchShift

    return PitchShift(semitones=semitones)(audio.reshape(1, -1), SR).reshape(-1)


PRESETS = {
    # Leo, 2026-10-11: "jarvis" good but a little deeper, not as deep as "deeper".
    # Leo, 2026-10-15: film JARVIS is clean, so the polish is down to 0.3.
    "jarvis": Preset("jarvis", {"bm_george": 0.55, "bm_fable": 0.25, "bm_daniel": 0.1, "bm_lewis": 0.1}, 1.04, -0.75, 0.3),
    "natural": Preset("natural", {"bm_george": 0.55, "bm_fable": 0.3, "bm_daniel": 0.15}, 1.0, 0.0, 0.0),
    "deeper": Preset("deeper", {"bm_george": 0.6, "bm_lewis": 0.4}, 1.0, -1.0, 1.0),
}
DEFAULT = os.environ.get("JARVIS_TTS_PRESET", "")
VOICE_NAMES = ("bm_george", "bm_fable", "bm_daniel", "bm_lewis")

# The settings window writes this; the server re-reads it when it changes.
SETTINGS = os.path.join(HOME, "state", "voice.json")


def load_settings(path: str = SETTINGS) -> Preset:
    """~/Jarvis/state/voice.json → a Preset; the jarvis preset when missing or bad."""
    base = PRESETS["jarvis"]
    try:
        with open(path) as f:
            d = json.load(f)
    except (OSError, ValueError):
        return base
    if d.get("preset") in PRESETS and d.get("custom") is not True:
        return PRESETS[d["preset"]]
    blend = {v: float(w) for v, w in (d.get("blend") or {}).items() if v in VOICE_NAMES and float(w) > 0}
    clamp = lambda x, lo, hi, dflt: max(lo, min(hi, float(x))) if isinstance(x, (int, float)) else dflt
    return Preset(
        "custom",
        blend or base.blend,
        clamp(d.get("speed"), 0.7, 1.4, base.speed),
        clamp(d.get("semitones"), -4, 3, base.semitones),
        clamp(d.get("effect"), 0, 1, base.effect),
    )


class Voice:
    def __init__(self) -> None:
        from kokoro_onnx import Kokoro

        # CPU: CoreML measured no faster here once ffmpeg is included.
        self.k = Kokoro(MODEL, VOICES)
        self._styles: dict[str, np.ndarray] = {}
        self._settings: tuple[float, Preset] | None = None

    def style(self, p: Preset) -> np.ndarray:
        if p.key() not in self._styles:
            total = sum(p.blend.values())
            self._styles[p.key()] = sum(self.k.get_voice_style(v) * (w / total) for v, w in p.blend.items())
        return self._styles[p.key()]

    def current(self) -> Preset:
        """The settings file's voice, re-read only when the file changes."""
        try:
            m = os.stat(SETTINGS).st_mtime
        except OSError:
            m = 0.0
        if not self._settings or self._settings[0] != m:
            self._settings = (m, load_settings())
        return self._settings[1]

    def raw(self, text: str, p: Preset) -> np.ndarray:
        samples, _ = self.k.create(text, voice=self.style(p), speed=p.speed, lang="en-gb")
        return samples.astype(np.float32)

    def render(self, text: str, preset: str | Preset | None = None) -> bytes:
        """Text → 16-bit WAV bytes with pitch and polish applied. `preset` names
        one of PRESETS (or is a Preset); otherwise the settings file decides."""
        name = preset or DEFAULT
        p = name if isinstance(name, Preset) else PRESETS.get(name) or self.current()
        audio = shift_pitch(self.raw(text, p), p.semitones)
        filters = polish(p.effect)
        filters.append("loudnorm=I=-18:TP=-1.5:LRA=9")  # same loudness for every preset
        pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
        cmd = [FFMPEG, "-loglevel", "error", "-f", "s16le", "-ar", str(SR), "-ac", "1", "-i", "pipe:0"]
        if filters:
            cmd += ["-af", ",".join(filters)]
        cmd += ["-ar", str(SR), "-f", "wav", "pipe:1"]
        return subprocess.run(cmd, input=pcm, capture_output=True, check=True).stdout
