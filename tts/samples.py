"""Renders each preset to ~/Jarvis/tts/samples/<preset>.wav for Leo to compare."""
import os, sys, time
sys.path.insert(0, os.path.dirname(__file__))
from voice import HOME, PRESETS, Voice

LINE = sys.argv[1] if len(sys.argv) > 1 else "Good evening, sir. It's twelve degrees in Southampton, with patchy rain about. Your first lecture tomorrow is Programming Three, at four."
out = os.path.join(HOME, "tts", "samples")
os.makedirs(out, exist_ok=True)
v = Voice()
for name in PRESETS:
    t = time.time()
    data = v.render(LINE, name)
    open(os.path.join(out, f"{name}.wav"), "wb").write(data)
    print(name, f"{time.time() - t:.2f}s")
