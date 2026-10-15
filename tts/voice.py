"""Jarvis's voice: Kokoro (on-device neural TTS) with a blended British male
voice and a light polish chain. Shared by the speech server and the sample
script so what Leo hears in samples is what Jarvis says."""

from __future__ import annotations

import json
import os
import re
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


# ---- text normalisation: say codes, times, dates and units the way Leo would ----

_ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
_TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()
_ORD = {"one": "first", "two": "second", "three": "third", "five": "fifth", "eight": "eighth", "nine": "ninth", "twelve": "twelfth"}
_MONTHS = "January February March April May June July August September October November December".split()


def words(n: int) -> str:
    """0–99 in words."""
    if n < 20:
        return _ONES[n]
    t, o = divmod(n, 10)
    return _TENS[t] + (f"-{_ONES[o]}" if o else "")


def ordinal(n: int) -> str:
    w = words(n)
    head, _, last = w.rpartition("-")
    last = _ORD.get(last) or (last[:-1] + "ieth" if last.endswith("y") else last + "th")
    return f"{head}-{last}" if head else last


def pairs(digits: str) -> str:
    """A four-digit code read in pairs, like a year: 2311 → twenty-three eleven, 2300 → twenty-three hundred, 1201 → twelve oh one."""
    a, b = int(digits[:2]), int(digits[2:])
    if b == 0:
        return f"{words(a)} hundred"
    return f"{words(a)} {'oh ' + _ONES[b] if b < 10 else words(b)}"


def clock(h: int, m: int, suffix: str | None = None) -> str:
    """16:00 → four p.m., 9:30am → nine thirty a.m., 12:00 → twelve noon."""
    if suffix is None:
        if (h, m) == (12, 0):
            return "twelve noon"
        if (h, m) == (0, 0):
            return "midnight"
        suffix = "pm" if h >= 12 else "am"
    h12 = h % 12 or 12
    mins = "" if m == 0 else f" oh {_ONES[m]}" if m < 10 else f" {words(m)}"
    return f"{words(h12)}{mins} {suffix[0]}.m."


_UNITS = {"°C": "degrees", "°": "degrees", "km": "kilometres", "kg": "kilos", "mph": "miles an hour", "GB": "gigabytes", "MB": "megabytes", "%": "percent", "ms": "milliseconds", "cm": "centimetres", "mm": "millimetres", "m": "metres"}


def normalise(text: str) -> str:
    """Rewrites what Kokoro trips over into words: module codes, times,
    dates, decimals and units. Everything else is left alone."""
    # Module codes: COMP2311 → comp twenty-three eleven.
    text = re.sub(r"\b([A-Z]{2,5})(\d{4})\b", lambda m: f"{m[1].lower()} {pairs(m[2])}", text)
    # Times: 16:00, 9:30am, 9am, 4 pm.
    text = re.sub(r"\b([01]?\d|2[0-3]):([0-5]\d)(?:\s*([ap]m)\b)?", lambda m: clock(int(m[1]), int(m[2]), m[3] and m[3].lower()), text, flags=re.I)
    text = re.sub(r"\b(1[0-2]|0?[1-9])\s*([ap])\.?m\b\.?", lambda m: clock(int(m[1]), 0, m[2].lower() + "m"), text, flags=re.I)
    # Dates: 21/10 or 21/10/2026 → the twenty-first of October (UK order).
    def date(m: re.Match) -> str:
        d, mo = int(m[1]), int(m[2])
        if not (1 <= d <= 31 and 1 <= mo <= 12):
            return m[0]
        return f"the {ordinal(d)} of {_MONTHS[mo - 1]}" + (f" {m[3]}" if m[3] else "")
    text = re.sub(r"\b(\d{1,2})/(\d{1,2})(?:/(\d{4}))?\b", date, text)
    # Units after a number: 12°C, 5.2km, 40 mph, 80%.
    units = "|".join(re.escape(u) for u in sorted(_UNITS, key=len, reverse=True))
    text = re.sub(rf"(\d)\s?({units})(?![A-Za-z])", lambda m: f"{m[1]} {_UNITS[m[2]]}", text)
    # Decimals: 5.2 → five point two (Kokoro says "point" but trips on long ones).
    text = re.sub(r"\b(\d+)\.(\d+)\b", lambda m: f"{m[1]} point {' '.join(_ONES[int(c)] for c in m[2])}", text)
    return text


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
        audio = shift_pitch(self.raw(normalise(text), p), p.semitones)
        filters = polish(p.effect)
        filters.append("loudnorm=I=-18:TP=-1.5:LRA=9")  # same loudness for every preset
        pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
        cmd = [FFMPEG, "-loglevel", "error", "-f", "s16le", "-ar", str(SR), "-ac", "1", "-i", "pipe:0"]
        if filters:
            cmd += ["-af", ",".join(filters)]
        cmd += ["-ar", str(SR), "-f", "wav", "pipe:1"]
        return subprocess.run(cmd, input=pcm, capture_output=True, check=True).stdout
