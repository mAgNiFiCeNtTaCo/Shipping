"""Run the browser test suites in headless Edge and print the results.

    python tools/test.py                 # every suite
    python tools/test.py data render     # only these suites (app/tests/<name>.test.js)

Starts a private copy of the app server on a free port, opens app/tests/run.html in
headless Edge, waits for the page to POST its results back, prints them and exits
0 (all passed) or 1. Timeout: 120 s.
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import serve  # noqa: E402

EDGE_PATHS = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]

result = {}
done = threading.Event()
opened = []  # folders the app asked to open (never really opened during tests)
tailnet = {"serving": False}  # stands in for Tailscale: tests never change the real one


class Handler(serve.Handler):
    # Files the app saves during tests land in a throwaway folder, never in the real Saved folder.
    save_root = tempfile.mkdtemp(prefix="shipdesk-saved-")

    def open_folder(self, folder):
        opened.append(folder)

    def stop_server(self):
        # The page's "Turn off" must not end the test run: only note it (GET /__opened lists it too).
        opened.append("STOP")

    # Stands in for the Windows startup list: tests never change the real one.
    def autostart_enabled(self):
        return tailnet.get("autostart", False)

    def set_autostart(self, on):
        tailnet["autostart"] = on
        return True

    def tailscale_status(self):
        return {"installed": True, "running": True, "dns": "test-pc.example.ts.net", "serving": tailnet["serving"]}

    def tailscale_switch(self, on):
        tailnet["serving"] = on
        return True, ""

    def do_GET(self):
        # Test-only: read back a file the app saved (?rel=Saved\Labels\x.pdf), or list what was opened.
        if self.path.startswith("/__saved"):
            import urllib.parse
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            rel = (q.get("rel") or [""])[0]
            path = os.path.normpath(os.path.join(os.path.dirname(self.save_root), rel))
            if not path.startswith(self.save_root) or not os.path.isfile(path):
                self.send_error(404)
                return
            data = open(path, "rb").read()
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if self.path == "/__opened":
            self.reply(200, {"opened": opened})
            return
        super().do_GET()

    def do_POST(self):
        if self.path != "/__test-result":
            super().do_POST()
            return
        n = int(self.headers.get("Content-Length") or 0)
        if n < 0 or n > 5_000_000:
            self.send_error(400)
            return
        result.update(json.loads(self.rfile.read(n).decode("utf-8")))
        self.send_response(204)
        self.end_headers()
        done.set()


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def main():
    suites = sys.argv[1:]
    edge = next((p for p in EDGE_PATHS if os.path.exists(p)), None)
    if not edge:
        print("Microsoft Edge not found")
        return 1
    port = free_port()
    srv = serve.make_server(port, Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{port}/tests/run.html"
    if suites:
        url += "?suites=" + ",".join(suites)
    profile = tempfile.mkdtemp(prefix="shipdesk-edge-")
    proc = subprocess.Popen(
        [edge, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
         f"--user-data-dir={profile}", url],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        if not done.wait(120):
            print("TIMEOUT: the test page never reported (open the URL in Edge to see why): " + url)
            return 1
    finally:
        proc.kill()
        srv.shutdown()
        shutil.rmtree(profile, ignore_errors=True)
        shutil.rmtree(Handler.save_root, ignore_errors=True)
    for line in result.get("lines", []):
        print(line)
    print(f"RESULT: {result.get('passed', 0)} passed, {result.get('failed', 0)} failed")
    return 0 if result.get("failed", 1) == 0 and result.get("passed", 0) > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
