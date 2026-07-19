"""Local dev server on http://localhost:8787 — mirrors the Netlify layout:

  /            -> site/ (static)
  /api/cam     -> proxies NYC DOT snapshots with CORS (like netlify/functions/cam.mjs)
  /state/*     -> serves data-local/ (like the Netlify proxy to the data branch)

Usage: python3 scripts/dev.py [port]
"""
import json
import sys
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
LOCAL = ROOT / "data-local"
ALLOW = {c["id"] for c in json.loads((SITE / "data" / "cameras.json").read_text())["cameras"]}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(SITE), **kw)

    def log_message(self, fmt, *args):
        if "/api/cam" not in (args[0] if args else ""):
            super().log_message(fmt, *args)

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/cam":
            cid = parse_qs(parsed.query).get("id", [None])[0]
            if cid not in ALLOW:
                self._send(400, b"unknown camera", "text/plain")
                return
            try:
                req = urllib.request.Request(
                    f"https://webcams.nyctmc.org/api/cameras/{cid}/image",
                    headers={"User-Agent": "parkscout-dev"})
                data = urllib.request.urlopen(req, timeout=15).read()
                self._send(200, data, "image/jpeg")
            except Exception as e:  # noqa: BLE001
                self._send(502, str(e).encode(), "text/plain")
        elif parsed.path.startswith("/state/"):
            target = (LOCAL / parsed.path[len("/state/"):]).resolve()
            if LOCAL.resolve() not in target.parents or not target.is_file():
                self._send(404, b"no state (run scraper into data-local/)", "text/plain")
                return
            self._send(200, target.read_bytes(), "application/json")
        else:
            super().do_GET()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
    print(f"parkscout dev server -> http://localhost:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
