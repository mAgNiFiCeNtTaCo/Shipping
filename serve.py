"""Serve the Ship Desk app on this PC only (127.0.0.1) and open it in the browser.

    python serve.py              # http://127.0.0.1:5091/
    python serve.py --port 5092 --no-browser

The app runs entirely in the browser; this server only hands out the files in app/.
It never receives order data.
"""
import argparse
import functools
import http.server
import os
import threading
import webbrowser

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app")
DEFAULT_PORT = 5091

TYPES = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    ".csv": "text/csv",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, **TYPES}

    def end_headers(self):
        # Always fresh files: the service worker does the offline caching.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


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
    if not a.no_browser:
        threading.Timer(0.5, webbrowser.open, [url]).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
