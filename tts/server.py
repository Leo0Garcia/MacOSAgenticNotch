"""Jarvis speech server: keeps Kokoro loaded so each sentence renders in well
under a second. HTTP over a Unix socket at ~/Jarvis/run/tts.sock (only this
user can reach it).

  POST /render  {"text": "...", "preset": "jarvis"}  -> audio/wav
  GET  /health                                         -> {"ok": true, "preset": ...}

Started by the notch app at launch, or by the bridge's Speaker on first use.
Run: ~/Jarvis/tts/.venv/bin/python <repo>/tts/server.py
"""

from __future__ import annotations

import json
import os
import socket
import socketserver
import sys
import threading
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from voice import DEFAULT, HOME, Preset, Voice, load_settings  # noqa: E402

SOCK = os.path.join(HOME, "run", "tts.sock")
MAX_CHARS = 600
lock = threading.Lock()  # one render at a time; Kokoro isn't thread-safe
voice: Voice | None = None


class Handler(BaseHTTPRequestHandler):
    def address_string(self) -> str:  # Unix sockets have no client address
        return "local"

    def log_message(self, fmt: str, *args) -> None:  # quiet
        pass

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send(200, json.dumps({"ok": True, "preset": DEFAULT or voice.current().name}).encode(), "application/json")
        else:
            self._send(404, b"", "text/plain")

    def do_POST(self) -> None:
        if self.path != "/render":
            return self._send(404, b"", "text/plain")
        try:
            n = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(n) or b"{}")
            text = str(req.get("text", "")).strip()[:MAX_CHARS]
            if not text:
                return self._send(400, b"empty text", "text/plain")
            settings = req.get("settings")  # the settings window's "Play sample", before saving
            with lock:
                wav = voice.render(text, preview(settings) if isinstance(settings, dict) else req.get("preset") or None)
            self._send(200, wav, "audio/wav")
        except Exception as e:  # report, never crash the server
            self._send(500, str(e).encode()[:500], "text/plain")


def preview(d: dict) -> Preset:
    """Unsaved settings from the window, validated the same way as the file."""
    import tempfile

    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(d, f)
    try:
        return load_settings(f.name)
    finally:
        os.unlink(f.name)


class UnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def main() -> None:
    global voice
    os.makedirs(os.path.dirname(SOCK), exist_ok=True)
    # Another server already answering? Then there's nothing to do.
    s = socket.socket(socket.AF_UNIX)
    try:
        s.connect(SOCK)
        s.close()
        return
    except OSError:
        if os.path.exists(SOCK):
            os.unlink(SOCK)
    voice = Voice()
    voice.render("Ready.")  # warm up so the first real sentence is fast
    old = os.umask(0o077)
    srv = UnixHTTPServer(SOCK, Handler)
    os.umask(old)
    try:
        srv.serve_forever()
    finally:
        if os.path.exists(SOCK):
            os.unlink(SOCK)


if __name__ == "__main__":
    main()
