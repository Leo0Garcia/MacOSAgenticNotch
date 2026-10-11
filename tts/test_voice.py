"""Settings parsing and the polish chain; no model needed. Run: python3 tts/test_voice.py"""
import json, os, sys, tempfile, types
sys.modules.setdefault("numpy", types.ModuleType("numpy"))  # voice.py imports numpy at top
sys.path.insert(0, os.path.dirname(__file__))
import voice

def settings(d):
    f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    json.dump(d, f); f.close()
    return voice.load_settings(f.name)

assert voice.load_settings("/nonexistent").name == "jarvis"
assert settings({"preset": "deeper"}).semitones == -1.0
p = settings({"custom": True, "blend": {"bm_george": 1, "bm_lewis": 0.5, "evil": 3}, "speed": 9, "semitones": -10, "effect": 0.5})
assert p.blend == {"bm_george": 1.0, "bm_lewis": 0.5}, p.blend
assert (p.speed, p.semitones, p.effect) == (1.4, -4, 0.5)
assert settings({"custom": True, "blend": {}}).blend == voice.PRESETS["jarvis"].blend
assert not any(f.startswith("aecho") for f in voice.polish(0))
assert any(f.startswith("aecho") for f in voice.polish(1))
assert -1.0 < voice.PRESETS["jarvis"].semitones < -0.5  # deeper than before, not as deep as "deeper"
print("tts: 7 checks passed")
