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
# Stands in for Tailscale and GitHub: tests never change the real Tailscale or reach the internet.
# POST /__tailnet {...} changes it (installed, running, needsLogin, stopped, needEnable, latest, offline).
TAILNET = {"serving": False, "installed": True, "running": True, "needsLogin": False, "stopped": False, "needEnable": False,
           "setup": "", "latest": "1.0.0", "offline": False}
tailnet = dict(TAILNET)


class Handler(serve.Handler):
    # Files the app saves during tests land in a throwaway folder, never in the real Saved folder.
    save_root = tempfile.mkdtemp(prefix="shipdesk-saved-")
    # ...and the backup goes to another throwaway folder, never the real OneDrive.
    backup_root = tempfile.mkdtemp(prefix="shipdesk-backup-")

    def backup_folder_for(self, place):
        return self.backup_root

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
        t = tailnet
        return {"installed": t["installed"], "running": t["installed"] and t["running"], "dns": "test-pc.example.ts.net" if t["running"] else "",
                "serving": t["serving"], "needsLogin": t["needsLogin"], "stopped": t["stopped"], "setup": {"state": t["setup"], "error": ""}}

    def tailscale_install(self):
        tailnet["setup"] = "started"
        return ""

    def tailscale_login(self):
        if tailnet["stopped"]:
            tailnet.update(stopped=False, running=True)
            return True, "", ""
        return True, "", "https://login.tailscale.com/a/test-sign-in"

    def fetch_latest(self):
        if tailnet["offline"]:
            raise OSError("offline")
        return tailnet["latest"], f"https://github.com/{serve.UPDATE_REPO}/releases/tag/v{tailnet['latest']}"

    def tailscale_switch(self, on):
        if on and tailnet["needEnable"]:
            return False, "Tailscale needs secure addresses (Serve / HTTPS) switched on for your network first.", "https://login.tailscale.com/f/serve?node=test"
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
        if self.path == "/__backup":
            # Test-only: the files in the backup folder (paths relative to it, with /).
            files = [os.path.relpath(os.path.join(d, n), self.backup_root).replace(os.sep, "/")
                     for d, _, names in os.walk(self.backup_root) for n in names]
            self.reply(200, {"files": sorted(files), "folder": self.backup_root})
            return
        super().do_GET()

    def do_POST(self):
        if self.path == "/__tailnet":
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n).decode("utf-8") or "{}") if n > 0 else {}
            if body.get("reset"):
                tailnet.clear()
                tailnet.update(TAILNET)
            tailnet.update({k: v for k, v in body.items() if k in TAILNET})
            self.reply(200, dict(tailnet))
            return
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


def server_checks():
    """Checks of serve.py itself that need no browser: -> lines like the page's ("ok   server > ...")."""
    real = ("CN=Tailscale Inc., O=Tailscale Inc., L=Toronto, S=Ontario, C=CA, SERIALNUMBER=1131559-5, "
            "OID.2.5.4.15=Private Organization, OID.1.3.6.1.4.1.311.60.2.1.3=CA")
    want = serve.TAILSCALE_SIGNER
    checks = {
        "Tailscale's real certificate is accepted": serve.signer_matches(real, want),
        "a name that only contains Tailscale's is refused": not serve.signer_matches("CN=Tailscale Inc. X, O=Tailscale Inc. X, C=CA, SERIALNUMBER=1131559-5", want),
        "a shortened name is refused": not serve.signer_matches("CN=x, O=Tailscale, C=CA, SERIALNUMBER=1131559-5", want),
        "another company number is refused": not serve.signer_matches("CN=Tailscale Inc., O=Tailscale Inc., C=CA, SERIALNUMBER=999", want),
        "a field given twice is refused": not serve.signer_matches("O=Evil Ltd, O=Tailscale Inc., C=CA, SERIALNUMBER=1131559-5", want),
        "quoted names keep their comma": serve.subject_fields('CN=DigiCert G4, O="DigiCert, Inc.", C=US') == {"CN": "DigiCert G4", "O": "DigiCert, Inc.", "C": "US"},
        "PowerShell is called by its full path": os.path.isabs(serve.POWERSHELL),
    }
    return [f"{'ok  ' if good else 'FAIL'} server > signature check: {name}" for name, good in checks.items()]


def main():
    suites = sys.argv[1:]
    server = server_checks() if not suites or "server" in suites else []
    suites = [s for s in suites if s != "server"]
    if sys.argv[1:] == ["server"]:
        print("\n".join(server))
        failed = sum(1 for x in server if x.startswith("FAIL"))
        print(f"RESULT: {len(server) - failed} passed, {failed} failed")
        return 1 if failed else 0
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
        shutil.rmtree(Handler.backup_root, ignore_errors=True)
    for line in result.get("lines", []) + server:
        print(line)
    bad = sum(1 for x in server if x.startswith("FAIL"))
    passed, failed = result.get("passed", 0) + len(server) - bad, result.get("failed", 1) + bad
    print(f"RESULT: {passed} passed, {failed} failed")
    return 0 if failed == 0 and result.get("passed", 0) > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
