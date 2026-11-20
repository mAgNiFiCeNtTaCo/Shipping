"""Check the no-install zip (dist\\ShipDesk-<version>-portable.zip) the way someone would use it:

    python tools/test_portable.py dist\\ShipDesk-1.1.4-portable.zip

Unzips it into a temp folder, checks what's in it (own Python, the two .bat files, READ ME FIRST, no test pages,
nothing personal), starts it with its own "Start Ship Desk.bat" on port 5097, opens the page, saves a file (it must
land in Saved inside the unzipped folder), stops it with its own "Stop Ship Desk.bat", and checks this PC's own Ship
Desk (port 5091) and its Windows entries are as they were. Off port 5091 serve.py writes no Windows entries.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_installer as ti  # noqa: E402  (same checks and helpers)

PORT = 5097
ti.PORT = PORT


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    path = os.path.abspath(sys.argv[1])
    base = tempfile.mkdtemp(prefix="shipdesk-ziptest-")
    home = os.path.join(base, "My Ship Desk")  # a space in the path, as a person's folder may have
    before, was_on = ti.windows_entries(), ti.local_ship_desk_on()
    check = ti.check
    try:
        with zipfile.ZipFile(path) as z:
            names = z.namelist()
            check(z.testzip() is None, f"the zip reads back whole ({len(names)} files)")
            z.extractall(home)
        for name in ("Start Ship Desk.bat", "Stop Ship Desk.bat", "READ ME FIRST.txt", "serve.py", "Ship Desk guide.html",
                     "LICENSE.txt", "THIRD-PARTY-NOTICES.txt", "python/pythonw.exe", "app/index.html"):
            check(name in names, f"has {name}")
        check(not any(n.startswith(("Saved/", "app/tests/")) or n == "install.json" for n in names),
              "no Saved folder, install.json or test pages")
        bat = open(os.path.join(home, "Start Ship Desk.bat"), "rb").read()
        check(b"\r\n" in bat and b"\n" not in bat.replace(b"\r\n", b""), "the .bat files have Windows line endings")
        subprocess.run(["cmd", "/c", os.path.join(home, "Start Ship Desk.bat"), "--port", str(PORT), "--no-browser"],
                       cwd=base, timeout=60)
        ping = None
        for _ in range(60):
            try:
                ping = json.loads(ti.call("/api/ping"))
                break
            except OSError:
                time.sleep(0.25)
        check(bool(ping) and os.path.normcase(ping.get("home", "")) == os.path.normcase(home),
              f"Start Ship Desk starts it from the unzipped folder (version {ping and ping.get('version')})")
        check(b"<title>Ship Desk" in ti.call("/"), "its page opens")
        saved = json.loads(ti.call("/api/save?kind=labels&name=Test%20label.pdf", "POST", b"%PDF-"))
        check(os.path.isfile(os.path.join(home, "Saved", "Labels", saved.get("name", "?"))),
              "a saved file lands in Saved inside the unzipped folder")
        out = subprocess.run(["cmd", "/c", os.path.join(home, "Stop Ship Desk.bat"), "--port", str(PORT)],
                             capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL).stdout
        check("is off" in out, "Stop Ship Desk turns it off")
        for _ in range(40):
            try:
                ti.call("/api/ping")
                time.sleep(0.25)
            except OSError:
                break
        else:
            check(False, "it really stopped")
        check(ti.windows_entries() == before, "this PC's Start-with-Windows entry and shipdesk:// link unchanged")
        check(ti.local_ship_desk_on() == was_on, "this PC's own Ship Desk is as it was")
    finally:
        time.sleep(1)
        shutil.rmtree(base, ignore_errors=True)
    print(f"RESULT: {'all good' if not ti.failed else str(len(ti.failed)) + ' failed'}")
    sys.exit(1 if ti.failed else 0)


if __name__ == "__main__":
    main()
