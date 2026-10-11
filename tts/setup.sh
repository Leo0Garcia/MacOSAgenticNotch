#!/bin/sh
# Installs Jarvis's voice: Kokoro (on-device neural TTS) into ~/Jarvis/tts.
# Needs uv and ffmpeg. About 340 MB of model files, downloaded once.
set -eu
home="${JARVIS_HOME:-$HOME/Jarvis}/tts"
mkdir -p "$home"
cd "$home"
[ -x .venv/bin/python ] || uv venv -q --python 3.12 .venv
uv pip install -q --python .venv/bin/python kokoro-onnx soundfile numpy
base=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
[ -f kokoro-v1.0.onnx ] || curl -fsSL -o kokoro-v1.0.onnx "$base/kokoro-v1.0.onnx"
[ -f voices-v1.0.bin ] || curl -fsSL -o voices-v1.0.bin "$base/voices-v1.0.bin"
echo "Kokoro installed in $home"
