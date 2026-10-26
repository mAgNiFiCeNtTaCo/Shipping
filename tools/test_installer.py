"""Check a built installer end to end without touching this PC's own Ship Desk.

    python tools/test_installer.py dist/ShipDesk-Setup-1.1.1.exe [--upgrade-from dist/ShipDesk-Setup-1.1.0.exe]

Silent install into a temporary folder (no Start menu icons, no desktop icon, no "start with Windows", no phone
setup), optionally over an older version first (the files folder chosen then must be kept), run that copy on port
5099, open the page, save a file into its files folder, stop it with its own --stop (another Ship Desk running on
5091 must be left on), uninstall, and check this user's "Start with Windows" entry and shipdesk:// link are unchanged.
Prints one line per check; exits 1 when one fails.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

PORT = 5099
TASKS_OFF = "/MERGETASKS=!desktopicon,!autostart,!phonesetup"
failed = []


def check(ok, what):
    print(("ok   " if ok else "FAIL ") + what, flush=True)
    if not ok:
        failed.append(what)


def windows_entries():
    """This user's Ship Desk entries in Windows (they must be the same before and after)."""
    import winreg
    out = []
    for key, name in ((r"Software\Microsoft\Windows\CurrentVersion\Run", "Ship Desk"), (r"Software\Classes\shipdesk\shell\open\command", "")):
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key) as k:
                out.append(winreg.QueryValueEx(k, name)[0])
        except OSError:
            out.append(None)
    return out


def local_ship_desk_on():
    try:
        req = urllib.request.Request("http://127.0.0.1:5091/api/ping", headers={"X-Ship-Desk": "1"})
        with urllib.request.urlopen(req, timeout=3) as r:
            return bool(json.loads(r.read()).get("ok"))
    except OSError:
        return False


def call(path, method="GET", body=None):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=body, method=method,
                                 headers={"X-Ship-Desk": "1", "Origin": f"http://127.0.0.1:{PORT}"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.read()


def setup(exe, *args):
    return subprocess.run([exe, "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/NOICONS", TASKS_OFF, *args], timeout=600).returncode


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("installer")
    ap.add_argument("--upgrade-from", default="")
    a = ap.parse_args()
    a.installer = os.path.abspath(a.installer)
    a.upgrade_from = os.path.abspath(a.upgrade_from) if a.upgrade_from else ""
    base = tempfile.mkdtemp(prefix="shipdesk-insttest-")
    app, data = os.path.join(base, "Ship Desk"), os.path.join(base, "My Ship Desk files")
    before, was_on = windows_entries(), local_ship_desk_on()
    try:
        if a.upgrade_from:
            check(setup(a.upgrade_from, f"/DIR={app}", f"/DATADIR={data}") == 0, f"older version installs ({os.path.basename(a.upgrade_from)})")
            os.makedirs(os.path.join(data, "Labels"), exist_ok=True)
            with open(os.path.join(data, "Labels", "Kept.pdf"), "w") as f:
                f.write("%PDF-kept")
            check(setup(a.installer, f"/DIR={app}") == 0, "new version installs over it")
            check(os.path.isfile(os.path.join(data, "Labels", "Kept.pdf")), "files made before are kept")
        else:
            check(setup(a.installer, f"/DIR={app}", f"/DATADIR={data}") == 0, "installs")
        info = json.load(open(os.path.join(app, "install.json"), encoding="utf-8"))
        check(os.path.normcase(info.get("dataDir", "")) == os.path.normcase(data), "install.json names the chosen files folder")
        check(os.path.isfile(os.path.join(app, "python", "pythonw.exe")) and not os.path.exists(os.path.join(app, "app", "tests")),
              "own Python included, test pages left out")
        proc = subprocess.Popen([os.path.join(app, "python", "pythonw.exe"), os.path.join(app, "serve.py"), "--port", str(PORT), "--no-browser"], cwd=app)
        ping = None
        for _ in range(40):
            try:
                ping = json.loads(call("/api/ping"))
                break
            except OSError:
                time.sleep(0.25)
        check(bool(ping) and os.path.normcase(ping.get("home", "")) == os.path.normcase(app), f"the installed copy runs (version {ping and ping.get('version')})")
        check(b"<title>Ship Desk" in call("/"), "its page opens")
        saved = json.loads(call("/api/save?kind=labels&name=Test%20label.pdf", "POST", b"%PDF-"))
        check(os.path.isfile(os.path.join(data, "Labels", saved.get("name", "?"))), "a saved file lands in the chosen files folder")
        py = os.path.join(app, "python", "python.exe")
        out = subprocess.run([py, os.path.join(app, "serve.py"), "--stop"], capture_output=True, text=True, timeout=60).stdout
        check(not was_on or ("left on" in out and local_ship_desk_on()), "its --stop leaves this PC's own Ship Desk on")
        out = subprocess.run([py, os.path.join(app, "serve.py"), "--stop", "--port", str(PORT)], capture_output=True, text=True, timeout=60).stdout
        check("is off" in out, "its --stop turns it off")
        proc.wait(10)
        check(subprocess.run([os.path.join(app, "unins000.exe"), "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"], timeout=300).returncode == 0, "uninstalls")
        time.sleep(2)
        check(not os.path.exists(os.path.join(app, "serve.py")), "program files removed")
        check(windows_entries() == before, "this PC's Start-with-Windows entry and shipdesk:// link unchanged")
        check(local_ship_desk_on() == was_on, "this PC's own Ship Desk is as it was")
    finally:
        shutil.rmtree(base, ignore_errors=True)
    print(f"RESULT: {'all good' if not failed else str(len(failed)) + ' failed'}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
