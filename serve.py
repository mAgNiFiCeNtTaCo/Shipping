"""Serve the Ship Desk app on this PC only (127.0.0.1) and open it in the browser.

    python serve.py              # http://127.0.0.1:5091/
    python serve.py --port 5092 --no-browser

The app runs entirely in the browser. This server hands out the files in app/ and saves the files the app
makes (label PDFs, packing slips, import/Pirate Ship/history CSVs) into the Saved folder next to this file,
so they don't fill up the browser's Downloads folder:

    POST /api/save?kind=<labels|slips|import|pirate|history>&name=<file name>   body = the file
    POST /api/open-folder?kind=<kind or empty>                                   opens it in Explorer

Both only answer Ship Desk's own page (Host + Origin must be this server, plus an X-Ship-Desk header that
a form on another website can't send), so other websites can't write files here.
"""
import argparse
import functools
import http.server
import json
import os
import re
import threading
import urllib.parse
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "app")
SAVE_ROOT = os.path.join(HERE, "Saved")
DEFAULT_PORT = 5091
MAX_BYTES = 100 * 1024 * 1024

# kind -> subfolder of Saved
FOLDERS = {
    "labels": "Labels",
    "slips": "Packing slips",
    "import": "TCGplayer import files",
    "pirate": "Pirate Ship",
    "history": "History",
}
NAME_OK = re.compile(r"^[A-Za-z0-9 ._()-]{1,100}\.(pdf|csv)$")

TYPES = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    ".csv": "text/csv",
}


def unique_path(folder, name):
    """folder/name, or folder/'name (2).ext' etc. when that file already exists."""
    stem, ext = os.path.splitext(name)
    path, n = os.path.join(folder, name), 2
    while os.path.exists(path):
        path = os.path.join(folder, f"{stem} ({n}){ext}")
        n += 1
    return path


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, **TYPES}
    save_root = SAVE_ROOT

    def end_headers(self):
        # Always fresh files: the service worker does the offline caching.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass

    # ---------- saving files ----------

    def from_ship_desk(self):
        port = self.server.server_address[1]
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin", "")
        return host in hosts and origin == f"http://{host}" and self.headers.get("X-Ship-Desk") == "1"

    def reply(self, code, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        url = urllib.parse.urlsplit(self.path)
        if url.path not in ("/api/save", "/api/open-folder"):
            self.send_error(404)
            return
        if not self.from_ship_desk():
            self.reply(403, {"ok": False, "error": "Only Ship Desk's own page can do this."})
            return
        q = urllib.parse.parse_qs(url.query)
        kind = (q.get("kind") or [""])[0]
        if kind and kind not in FOLDERS:
            self.reply(400, {"ok": False, "error": "Unknown kind of file."})
            return
        if url.path == "/api/open-folder":
            folder = os.path.join(self.save_root, FOLDERS[kind]) if kind else self.save_root
            os.makedirs(folder, exist_ok=True)
            self.open_folder(folder)
            self.reply(200, {"ok": True, "folder": folder})
            return
        name = (q.get("name") or [""])[0]
        if not kind or not NAME_OK.match(name) or name.startswith("."):
            self.reply(400, {"ok": False, "error": "Bad file name."})
            return
        try:
            n = int(self.headers.get("Content-Length") or -1)
        except ValueError:
            n = -1
        if n < 0 or n > MAX_BYTES:
            self.reply(400, {"ok": False, "error": "Bad file size."})
            return
        data = self.rfile.read(n)
        folder = os.path.join(self.save_root, FOLDERS[kind])
        try:
            os.makedirs(folder, exist_ok=True)
            path = unique_path(folder, name)
            with open(path, "xb") as f:
                f.write(data)
        except OSError as e:
            self.reply(500, {"ok": False, "error": f"Couldn't save the file: {e.strerror or e}"})
            return
        rel = os.path.relpath(path, os.path.dirname(self.save_root))
        self.reply(200, {"ok": True, "name": os.path.basename(path), "folder": FOLDERS[kind], "path": rel, "full": path})

    def open_folder(self, folder):
        if hasattr(os, "startfile"):
            os.startfile(folder)  # Windows Explorer


class Server(http.server.ThreadingHTTPServer):
    request_queue_size = 64
    daemon_threads = True


def make_server(port, handler=Handler):
    return Server(("127.0.0.1", port), functools.partial(handler, directory=ROOT))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    srv = make_server(a.port)
    url = f"http://127.0.0.1:{a.port}/"
    print(f"Ship Desk is running at {url}  (close this window to stop it)")
    print(f"Files it makes are saved in {SAVE_ROOT}")
    if not a.no_browser:
        threading.Timer(0.5, webbrowser.open, [url]).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
