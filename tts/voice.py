"""Jarvis's voice: Kokoro (on-device neural TTS) with a blended British male
voice and a light polish chain. Shared by the speech server and the sample
script so what Leo hears in samples is what Jarvis says."""

from __future__ import annotations

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
    speed: float = 1.0
    semitones: float = 0.0           # pitch shift, formant-preserving enough at ±2
    fx: list[str] = field(default_factory=list)  # ffmpeg audio filters


# Polish for a "Jarvis" feel: tidy low end, crisp presence, a small hard room
# and a faint doubled sheen, evened out by a gentle compressor.
POLISH = [
    "highpass=f=85",
    "equalizer=f=220:t=q:w=1.2:g=-2",
    "equalizer=f=3200:t=q:w=1.0:g=3",
    "equalizer=f=9000:t=q:w=1.0:g=1.5",
    "aecho=0.85:0.5:18|37:0.14|0.08",
    "chorus=0.9:0.9:12:0.12:0.25:1.5",
    "acompressor=threshold=-20dB:ratio=2.5:attack=5:release=80",
    "alimiter=limit=0.89",
]

PRESETS = {
    "natural": Preset("natural", {"bm_george": 0.55, "bm_fable": 0.3, "bm_daniel": 0.15}, 1.0, 0, POLISH[:4]),
    "jarvis": Preset("jarvis", {"bm_george": 0.55, "bm_fable": 0.3, "bm_daniel": 0.15}, 1.06, -0.5, POLISH),
    "deeper": Preset("deeper", {"bm_george": 0.6, "bm_lewis": 0.4}, 1.0, -1.0, POLISH),
}
DEFAULT = os.environ.get("JARVIS_TTS_PRESET", "jarvis")


class Voice:
    def __init__(self) -> None:
        from kokoro_onnx import Kokoro

        # CPU: CoreML measured no faster here once ffmpeg is included.
        self.k = Kokoro(MODEL, VOICES)
        self._styles: dict[str, np.ndarray] = {}

    def style(self, p: Preset) -> np.ndarray:
        if p.name not in self._styles:
            total = sum(p.blend.values())
            self._styles[p.name] = sum(self.k.get_voice_style(v) * (w / total) for v, w in p.blend.items())
        return self._styles[p.name]

    def raw(self, text: str, p: Preset) -> np.ndarray:
        samples, _ = self.k.create(text, voice=self.style(p), speed=p.speed, lang="en-gb")
        return samples.astype(np.float32)

    def render(self, text: str, preset: str = DEFAULT) -> bytes:
        """Text → 16-bit WAV bytes with the preset's pitch and polish applied."""
        p = PRESETS.get(preset, PRESETS["jarvis"])
        audio = self.raw(text, p)
        filters = []
        if p.semitones:
            ratio = 2 ** (p.semitones / 12)
            filters += [f"asetrate={int(SR * ratio)}", f"atempo={1 / ratio:.5f}", f"aresample={SR}"]
        filters += p.fx
        filters.append("loudnorm=I=-18:TP=-1.5:LRA=9")  # same loudness for every preset
        pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
        cmd = [FFMPEG, "-loglevel", "error", "-f", "s16le", "-ar", str(SR), "-ac", "1", "-i", "pipe:0"]
        if filters:
            cmd += ["-af", ",".join(filters)]
        cmd += ["-ar", str(SR), "-f", "wav", "pipe:1"]
        return subprocess.run(cmd, input=pcm, capture_output=True, check=True).stdout
