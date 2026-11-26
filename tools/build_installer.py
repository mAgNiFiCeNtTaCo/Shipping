"""Build the Ship Desk installer for Windows: dist\\ShipDesk-Setup-<version>.exe, and the same Ship Desk as a zip
that needs no installing: dist\\ShipDesk-<version>-portable.zip (2026-11-20, for PCs where Windows or an antivirus
objects to the unsigned installer).

    python tools/build_installer.py                     # build APP_VERSION (serve.py)
    python tools/build_installer.py --if-changed --test # what /save-progress runs (the user's wish, 2026-10-26)
    python tools/build_installer.py --zip-only --test   # only the zip, for a version whose installer is built already

--if-changed: build only when what goes into the installer changed since the last build (a fingerprint of serve.py
without its version line, app\\ without tests, the setup script, notices, README, LICENSE and this script); then the
patch version goes up first when the current one was built already (1.1.0 -> 1.1.1, written to serve.py).
--test: run the browser tests before building and tools/test_installer.py on the result (over the previous build).
Every build is kept in dist\\ and listed in dist\\builds.json (version, time, SHA-256, git commit, fingerprint); a
rebuilt version's older file moves to dist\\old\\. Builds older than KEEP_DAYS (31) go, but never the newest KEEP_LAST
(3). dist\\release-notes-<version>.md is written from the commits since the previous build, ready for
`gh release create`.

Needs Inno Setup 6 (winget install JRSoftware.InnoSetup) and Microsoft Edge (to draw the icon); Pillow for the .ico.
Steps: download Python's embeddable package (python.org, checked against PY_SHA256; kept in build\\cache), put
Ship Desk (serve.py + app\\ without the test pages), that Python, the icon, the guide (README.md as a web page,
without the developer notes) and the licence notices in build\\stage, then compile installer\\ShipDesk.iss.
Nothing personal goes in: no Saved folder, no install.json (setup writes that on the user's PC).
"""
import argparse
import datetime
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BUILD = os.path.join(ROOT, "build")
STAGE = os.path.join(BUILD, "stage")
CACHE = os.path.join(BUILD, "cache")
DIST = os.path.join(ROOT, "dist")

PY_VERSION = "3.14.10"
PY_URL = f"https://www.python.org/ftp/python/{PY_VERSION}/python-{PY_VERSION}-embed-amd64.zip"
# SHA-256 of that zip, as python.org lists it (api/v2/downloads/release_file, checked 2026-10-26 and 2026-10-29); a
# different file stops the build. Use the newest 3.14.x (security audit 2026-10-26).
PY_SHA256 = {"3.14.7": "d297e5ff019966817ad8502465176139f2d3d840fa4ed84b13bed399a6ab1f15",
             "3.14.10": "90905e64a840557d8c1bc4f5b74db3d7ee85e3ffb217611cac1c7813acea4159"}

# The zip: Ship Desk's own Python runs serve.py from the unzipped folder. No install.json, so serve.py keeps its files
# in Saved next to it. Only Python's own programs (signed by the Python Software Foundation) and two .bat files run.
START_BAT = r"""@echo off
rem Ship Desk (the version that needs no installing): starts it in the background with its own Python and opens it.
rem Turn it off with the switch at the top of the Ship Desk page, or "Stop Ship Desk".
cd /d "%~dp0"
if not exist "python\pythonw.exe" (
  echo.
  echo   Unzip the whole zip file first: right-click it, choose Extract All, then start Ship Desk
  echo   from the folder that makes.
  echo.
  pause
  exit /b 1
)
start "" "python\pythonw.exe" serve.py %*
"""
STOP_BAT = r"""@echo off
title Stop Ship Desk
rem Turns off Ship Desk when it runs from this folder (the same as the switch at the top of the page).
cd /d "%~dp0"
"python\python.exe" serve.py --stop %*
rem (a 3 second pause that also works when the window's input is redirected)
ping -n 4 127.0.0.1 >nul
"""
PORTABLE_README = """Ship Desk {version}: the version that needs no installing

Getting started
1. Before you unzip it: right-click the zip file, choose Properties, tick "Unblock" at the bottom
   and click OK. (Skip this and Windows may warn you the first time you start Ship Desk. If it
   does, click "More info", then "Run anyway".)
2. Right-click the zip file, choose "Extract All" and pick a place to keep Ship Desk, for example
   your Documents folder. Don't start it from inside the zip.
3. Open the folder that makes and double-click "Start Ship Desk". Ship Desk opens in your browser.

Day to day
- Your labels, slips, photos and other files go in the "Saved" folder inside this folder.
- Desktop icon: right-click "Start Ship Desk", choose "Show more options", then
  "Send to" > "Desktop (create shortcut)".
- To start Ship Desk when you sign in to Windows, tick "Start with Windows" at the top of the
  Ship Desk page.
- To turn it off: the switch at the top of the page, or double-click "Stop Ship Desk".
- To update: turn Ship Desk off, unzip the new version, move the "Saved" folder from this folder
  into the new one, start the new one and delete this folder.
- To remove it: untick "Start with Windows", turn Ship Desk off, then delete this folder.
- How to use it: open "Ship Desk guide.html".

Free under the MIT licence (LICENSE.txt). Not made by or affiliated with TCGplayer or Tailscale.
"""
PORTABLE_NOTES = """
## No installer needed: the zip

**{zip}** is the same Ship Desk without an installer, for a PC where Windows or an antivirus objects to the
installer. Right-click the zip, choose **Properties**, tick **Unblock** and click OK. Then choose **Extract All** and
double-click **Start Ship Desk** in the folder it makes. Its files go in the **Saved** folder there; **READ ME
FIRST.txt** inside has the rest (desktop icon, updating, removing).

SHA-256: `{sha}`
"""

BUILDS = os.path.join(DIST, "builds.json")
KEEP_DAYS = 31
KEEP_LAST = 3
REPO = "mAgNiFiCeNtTaCo/Shipping"

ISCC = [os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "Inno Setup 6", "ISCC.exe"),
        r"C:\Program Files (x86)\Inno Setup 6\ISCC.exe", r"C:\Program Files\Inno Setup 6\ISCC.exe"]
EDGE = [r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"]


def say(msg):
    print(msg, flush=True)


def app_version():
    text = open(os.path.join(ROOT, "serve.py"), encoding="utf-8").read()
    return re.search(r'^APP_VERSION = "([^"]+)"', text, re.M).group(1)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def python_zip():
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, os.path.basename(PY_URL))
    if not os.path.isfile(path):
        say(f"Downloading {PY_URL}")
        with urllib.request.urlopen(PY_URL, timeout=120) as r, open(path + ".part", "wb") as f:
            shutil.copyfileobj(r, f)
        os.replace(path + ".part", path)
    got = sha256(path)
    want = PY_SHA256.get(PY_VERSION)
    if want and got != want:
        os.remove(path)
        sys.exit(f"The Python download doesn't match its known checksum ({got}); not building.")
    if not want:
        say(f"  (no checksum on record for Python {PY_VERSION}; this file's SHA-256 is {got})")
    return path


def copy_app(dest):
    def skip(folder, names):
        rel = os.path.relpath(folder, os.path.join(ROOT, "app"))
        return [n for n in names if (rel == "." and n == "tests") or n == "__pycache__"]
    shutil.copytree(os.path.join(ROOT, "app"), os.path.join(dest, "app"), ignore=skip)
    shutil.copy2(os.path.join(ROOT, "serve.py"), dest)


def make_icon(dest):
    """app\\icon.svg drawn by Edge at 256 px (see-through corners), then every size Windows uses, in one .ico."""
    from PIL import Image
    edge = next((p for p in EDGE if os.path.isfile(p)), None)
    if not edge:
        sys.exit("Microsoft Edge not found (needed to draw the icon).")
    tmp = tempfile.mkdtemp(prefix="shipdesk-icon-")
    try:
        page = os.path.join(tmp, "icon.html")
        svg = open(os.path.join(ROOT, "app", "icon.svg"), encoding="utf-8").read()
        with open(page, "w", encoding="utf-8") as f:
            f.write('<!doctype html><html><body style="margin:0;background:transparent">'
                    f'<div style="width:256px;height:256px">{svg.replace("<svg ", "<svg width=\"256\" height=\"256\" ", 1)}</div></body></html>')
        png = os.path.join(tmp, "icon.png")
        subprocess.run([edge, "--headless=new", "--disable-gpu", "--hide-scrollbars", f"--user-data-dir={os.path.join(tmp, 'p')}",
                        "--default-background-color=00000000", "--window-size=256,256", f"--screenshot={png}",
                        "file:///" + page.replace("\\", "/")], check=True, capture_output=True, timeout=60)
        img = Image.open(png).convert("RGBA").crop((0, 0, 256, 256))
        img.save(os.path.join(dest, "shipdesk.ico"), sizes=[(16, 16), (20, 20), (24, 24), (32, 32), (40, 40), (48, 48), (64, 64), (128, 128), (256, 256)])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ---------- README.md -> the guide (a plain web page) ----------

def inline(text):
    t = html.escape(text, quote=False)
    t = re.sub(r"`([^`]+)`", r"<code>\1</code>", t)
    t = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", t)
    t = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", r'<a href="\2">\1</a>', t)
    return t


def guide_html(md):
    """The README's own kind of Markdown (headings, paragraphs, nested lists, tables, `code`, **bold**, links)."""
    marker = re.compile(r"^( *)([-*]|\d+\.) (.*)")
    # Lines that carry on the line above (wrapped text) are joined first, so **bold** across a wrap still works.
    lines = []
    for line in md.replace("\r\n", "\n").split("\n"):
        joins = (lines and line.strip() and lines[-1].strip() and not marker.match(line) and not line.startswith(("#", "|"))
                 and not lines[-1].startswith(("#", "|")))
        if joins:
            lines[-1] += " " + line.strip()
        else:
            lines.append(line)
    out, para, table = [], [], []
    lists = []  # open lists: [kind, indent of the marker, indent of the item's text]
    blank = False

    def flush_para():
        if para:
            out.append("<p>" + inline(" ".join(para)) + "</p>")
            para.clear()

    def close_lists(keep=0):
        while len(lists) > keep:
            out.append(f"</li></{lists.pop()[0]}>")

    def flush_table():
        if table:
            rows = [r for r in table if not re.match(r"^\|[\s:|-]+\|$", r)]
            cells = lambda r: [c.strip() for c in r.strip().strip("|").split("|")]
            out.append("<table><thead><tr>" + "".join(f"<th>{inline(c)}</th>" for c in cells(rows[0])) + "</tr></thead><tbody>")
            for r in rows[1:]:
                out.append("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in cells(r)) + "</tr>")
            out.append("</tbody></table>")
            table.clear()

    for line in lines:
        if line.startswith("|"):
            flush_para(); close_lists(); table.append(line); blank = False; continue
        flush_table()
        head = re.match(r"^(#{1,4}) (.*)", line)
        item = marker.match(line)
        indent = len(line) - len(line.lstrip(" "))
        if head:
            flush_para(); close_lists()
            n = len(head.group(1))
            out.append(f"<h{n}>{inline(head.group(2))}</h{n}>")
        elif item:
            flush_para()
            while lists and lists[-1][1] > indent:   # back out of deeper lists
                out.append(f"</li></{lists.pop()[0]}>")
            kind = "ol" if item.group(2)[0].isdigit() else "ul"
            text_at = indent + len(item.group(2)) + 1
            if lists and lists[-1][1] == indent:     # the next item of this list
                lists[-1][2] = text_at
                out.append(f"</li><li>{inline(item.group(3))}")
            else:                                    # a new list (inside the item above, if any)
                lists.append([kind, indent, text_at])
                out.append(f"<{kind}><li>{inline(item.group(3))}")
        elif not line.strip():
            flush_para()
        elif lists and indent > 0:
            # A paragraph inside a list item (indented under it, after a blank line).
            while len(lists) > 1 and lists[-1][2] > indent:
                out.append(f"</li></{lists.pop()[0]}>")
            out.append(("<p>" if blank else " ") + inline(line.strip()) + ("</p>" if blank else ""))
        else:
            close_lists()
            para.append(line.strip())
        blank = not line.strip()
    flush_para(); flush_table(); close_lists()
    body = "\n".join(out)
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ship Desk guide</title>
<style>
:root {{ color-scheme: light dark; --bg: #fbfaf7; --text: #1d2321; --muted: #5b6662; --line: #dcd8cf; --brand: #136f63; --code: #efece5; }}
@media (prefers-color-scheme: dark) {{ :root {{ --bg: #141816; --text: #e6ebe8; --muted: #9aa7a2; --line: #2d3532; --brand: #4cc2ad; --code: #222a27; }} }}
body {{ margin: 0; background: var(--bg); color: var(--text); font: 16px/1.55 system-ui, "Segoe UI", sans-serif; }}
main {{ max-width: 860px; margin: 0 auto; padding: 24px 16px 64px; }}
h1 {{ color: var(--brand); }} h2 {{ margin-top: 2em; border-bottom: 1px solid var(--line); padding-bottom: 4px; }}
code {{ background: var(--code); padding: 1px 5px; border-radius: 4px; font-size: .92em; }}
table {{ border-collapse: collapse; margin: 1em 0; }} th, td {{ border: 1px solid var(--line); padding: 6px 10px; text-align: left; vertical-align: top; }}
a {{ color: var(--brand); }} li {{ margin: .25em 0; }}
</style></head><body><main>
{body}
</main></body></html>
"""


def write_guide(dest):
    md = open(os.path.join(ROOT, "README.md"), encoding="utf-8").read()
    md = re.split(r"^## For developers", md, flags=re.M)[0]
    # The GitHub page's banner, badges, screenshots and chart sit between these markers: the guide leaves them out.
    md = re.sub(r"^<!-- github-only.*?^<!-- /github-only -->\n?", "", md.replace("\r\n", "\n"), flags=re.M | re.S)
    with open(os.path.join(dest, "Ship Desk guide.html"), "w", encoding="utf-8") as f:
        f.write(guide_html(md))


# ---------- what was built before ----------

def builds():
    try:
        with open(BUILDS, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def save_builds(items):
    os.makedirs(DIST, exist_ok=True)
    with open(BUILDS, "w", encoding="utf-8") as f:
        json.dump(items, f, indent=1)


def fingerprint(script=None):
    """One hash of everything that goes into the installer (serve.py's version line left out). `script`: this file's
    text as it was at a build (git show), to tell whether that build's contents are still what's here."""
    h = hashlib.sha256()
    files = [os.path.join(ROOT, n) for n in ("serve.py", "README.md", "LICENSE")]
    files += [os.path.join(ROOT, "installer", n) for n in ("ShipDesk.iss", "THIRD-PARTY-NOTICES.txt")]
    files.append(os.path.abspath(__file__))
    app = os.path.join(ROOT, "app")
    for folder, dirs, names in os.walk(app):
        dirs[:] = sorted(d for d in dirs if not (folder == app and d == "tests") and d != "__pycache__")
        files += [os.path.join(folder, n) for n in sorted(names)]
    for path in files:
        if not os.path.isfile(path):
            continue
        data = script if script is not None and path == os.path.abspath(__file__) else open(path, "rb").read()
        if os.path.basename(path) == "serve.py":
            data = re.sub(rb'^APP_VERSION = "[^"]*"', b"", data, flags=re.M)
        h.update(os.path.relpath(path, ROOT).replace("\\", "/").encode() + b"\0" + hashlib.sha256(data).digest())
    h.update(PY_VERSION.encode())
    return h.hexdigest()


def bump_version(version):
    """1.1.0 -> 1.1.1, written into serve.py."""
    parts = [int(x) for x in version.split(".")]
    new = ".".join(map(str, parts[:2] + [parts[2] + 1]))
    path = os.path.join(ROOT, "serve.py")
    raw = open(path, "rb").read()
    raw = re.sub(rb'^APP_VERSION = "[^"]*"', f'APP_VERSION = "{new}"'.encode(), raw, count=1, flags=re.M)
    with open(path, "wb") as f:
        f.write(raw)
    return new


def git(*args):
    r = subprocess.run(["git", "-C", ROOT, *args], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else ""


def prune():
    """Keep every build younger than KEEP_DAYS and always the newest KEEP_LAST; older ones go."""
    items = builds()
    now = datetime.datetime.now()
    keep_last = {b["file"] for b in sorted(items, key=lambda b: b.get("built", ""))[-KEEP_LAST:]}
    kept = []
    for b in items:
        try:
            age = (now - datetime.datetime.fromisoformat(b.get("built", ""))).days
        except ValueError:
            age = 0
        if age > KEEP_DAYS and b["file"] not in keep_last:
            for p in (os.path.join(DIST, b["file"]), os.path.join(DIST, f"release-notes-{b['version']}.md"),
                      os.path.join(DIST, b.get("zip") or "-")):
                if os.path.isfile(p):
                    os.remove(p)
            say(f"  removed the {age}-day-old build {b['file']}")
        else:
            kept.append(b)
    old = os.path.join(DIST, "old")
    if os.path.isdir(old):
        for n in os.listdir(old):
            p = os.path.join(old, n)
            if (now.timestamp() - os.path.getmtime(p)) / 86400 > KEEP_DAYS:
                os.remove(p)
    save_builds(kept)


def release_notes(version, exe, since, zip_path=""):
    """dist\\release-notes-<version>.md from the commits since the previous build."""
    log = git("log", "--no-merges", "--format=%s", f"{since}..HEAD") if since else ""
    lines = []
    for subject in log.splitlines():
        text = re.sub(r"^Save progress \d{4}-\d{2}-\d{2}:\s*", "", subject).strip()
        if text and text not in lines and not text.lower().startswith("release v"):
            lines.append(text)
    changes = "\n".join(f"- {t[:1].upper() + t[1:]}" for t in lines) or "- Fixes and small improvements."
    path = os.path.join(DIST, f"release-notes-{version}.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write(f"""Ship Desk {version}

## What's new

{changes}

## Install or update (Windows 10 or 11)

Download **{os.path.basename(exe)}** below and run it. Already have Ship Desk? Run it over the top: it keeps your files
folder, your settings and your History. Windows may say it's from an unknown publisher (the installer isn't signed):
click **More info → Run anyway**.

SHA-256: `{sha256(exe)}`
{portable_notes(zip_path)}
Free under the MIT licence. Not made by or affiliated with TCGplayer or Tailscale.
""")
    return path


def portable_notes(zip_path):
    return PORTABLE_NOTES.format(zip=os.path.basename(zip_path), sha=sha256(zip_path)) if zip_path else ""


def add_portable_notes(version, zip_path):
    """The zip's part of an existing release-notes file (for --zip-only), replacing an earlier one."""
    path = os.path.join(DIST, f"release-notes-{version}.md")
    text = open(path, encoding="utf-8").read() if os.path.isfile(path) else f"Ship Desk {version}\n"
    head = PORTABLE_NOTES.strip().splitlines()[0]
    if head in text:
        start = text.index(head)
        end = text.find("\n## ", start + len(head))
        tail = text[end:] if end >= 0 else ""
        if not tail and "\nFree under the MIT licence" in text[start:]:
            tail = text[text.index("\nFree under the MIT licence", start):]
        text = text[:start].rstrip("\n") + "\n" + tail
    marker = "\nFree under the MIT licence"
    block = portable_notes(zip_path)
    text = text.replace(marker, block + marker, 1) if marker in text else text.rstrip("\n") + "\n" + block
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return path


def keep_older(path):
    """A rebuild of the same version: the earlier file is kept in dist\\old."""
    if os.path.isfile(path):
        os.makedirs(os.path.join(DIST, "old"), exist_ok=True)
        stamp = datetime.datetime.fromtimestamp(os.path.getmtime(path)).strftime("%Y%m%d-%H%M")
        stem, ext = os.path.splitext(os.path.basename(path))
        shutil.move(path, os.path.join(DIST, "old", f"{stem}.built-{stamp}{ext}"))


def make_zip(version):
    """dist\\ShipDesk-<version>-portable.zip: the staged files plus the two .bat files and READ ME FIRST.txt."""
    os.makedirs(DIST, exist_ok=True)
    path = os.path.join(DIST, f"ShipDesk-{version}-portable.zip")
    keep_older(path)
    extra = {"Start Ship Desk.bat": START_BAT, "Stop Ship Desk.bat": STOP_BAT,
             "READ ME FIRST.txt": PORTABLE_README.format(version=version)}
    for name in extra:
        assert not os.path.exists(os.path.join(STAGE, name)), name
    tmp = path + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for name, text in extra.items():  # Windows line endings: .bat files need them, Notepad likes them
            z.writestr(name, text.replace("\r\n", "\n").replace("\n", "\r\n").encode("utf-8"))
        for folder, dirs, names in os.walk(STAGE):
            dirs.sort()
            for n in sorted(names):
                full = os.path.join(folder, n)
                z.write(full, os.path.relpath(full, STAGE).replace("\\", "/"))
    os.replace(tmp, path)
    say(f"  zip {os.path.basename(path)} ({os.path.getsize(path) / 1e6:.1f} MB)")
    return path


def stage(version):
    say(f"Ship Desk {version}")
    shutil.rmtree(STAGE, ignore_errors=True)
    os.makedirs(STAGE)
    copy_app(STAGE)
    with zipfile.ZipFile(python_zip()) as z:
        z.extractall(os.path.join(STAGE, "python"))
    say(f"  Python {PY_VERSION} (embeddable)")
    make_icon(STAGE)
    write_guide(STAGE)
    shutil.copy2(os.path.join(ROOT, "installer", "THIRD-PARTY-NOTICES.txt"), STAGE)
    lic = os.path.join(ROOT, "LICENSE")
    if os.path.isfile(lic):
        shutil.copy2(lic, os.path.join(STAGE, "LICENSE.txt"))
    for name in ("Saved", "install.json"):
        assert not os.path.exists(os.path.join(STAGE, name)), name
    files = sum(len(n) for _, _, n in os.walk(STAGE))
    say(f"  staged {files} files")


def build(version):
    """The installer and the zip; returns both paths."""
    iscc = next((p for p in ISCC if os.path.isfile(p)), None)
    if not iscc:
        sys.exit("Inno Setup 6 not found: winget install JRSoftware.InnoSetup")
    stage(version)
    os.makedirs(DIST, exist_ok=True)
    exe = os.path.join(DIST, f"ShipDesk-Setup-{version}.exe")
    keep_older(exe)
    subprocess.run([iscc, "/Q", f"/DAppVersion={version}", f"/DStage={STAGE}", os.path.join(ROOT, "installer", "ShipDesk.iss")], check=True)
    return exe, make_zip(version)


def test_zip(zip_path):
    return subprocess.run([sys.executable, os.path.join(ROOT, "tools", "test_portable.py"), zip_path]).returncode == 0


def zip_only(version, items, test):
    """Only the zip, for a version whose installer is built already (its contents must be what's here now)."""
    entry = next((b for b in items if b["version"] == version), None)
    if not entry:
        sys.exit(f"{version} isn't built yet: run a full build.")
    now = fingerprint()
    if entry.get("appFingerprint"):  # Ship Desk's own files only, this script left out
        same = entry["appFingerprint"] == fingerprint(script=b"")
    else:  # older entries: this script may have changed since (adding the zip), so try its last committed text too
        committed = subprocess.run(["git", "-C", ROOT, "show", "HEAD:tools/build_installer.py"], capture_output=True).stdout
        olds = {now}
        if committed:
            olds |= {fingerprint(script=committed),
                     fingerprint(script=committed.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n"))}
        same = entry.get("fingerprint") in olds
    if not same:
        sys.exit(f"Ship Desk changed since {version} was built: run a full build (python tools/build_installer.py --if-changed --test).")
    stage(version)
    zip_path = make_zip(version)
    if test and not test_zip(zip_path):
        sys.exit(f"The zip test failed: {zip_path} is built but not recorded.")
    entry.update({"zip": os.path.basename(zip_path), "zipSha256": sha256(zip_path), "fingerprint": now,
                  "appFingerprint": fingerprint(script=b"")})
    save_builds(items)
    notes = add_portable_notes(version, zip_path)
    say(f"Built {zip_path}  ({os.path.getsize(zip_path) / 1e6:.1f} MB, SHA-256 {sha256(zip_path)})")
    say(f"Add it to the release: gh release upload v{version} \"dist/{os.path.basename(zip_path)}\"")
    say(f"and its notes: gh release edit v{version} --notes-file \"dist/{os.path.basename(notes)}\"")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--if-changed", action="store_true", help="only when the installer's contents changed since the last build")
    ap.add_argument("--test", action="store_true", help="browser tests before, tools/test_installer.py after")
    ap.add_argument("--zip-only", action="store_true", help="only the no-install zip of the current version (its installer is built already)")
    a = ap.parse_args()
    items = builds()
    last = items[-1] if items else None
    fp = fingerprint()
    version = app_version()
    if a.zip_only:
        return zip_only(version, items, a.test)
    if a.if_changed:
        if last and last.get("fingerprint") == fp:
            say(f"No new build: nothing in the installer changed since {last['version']} (built {last['built'][:16]}).")
            prune()
            return
        if any(b["version"] == version for b in items):
            version = bump_version(version)
            say(f"Version {version} (APP_VERSION in serve.py)")
    if a.test:
        say("Running the tests first...")
        if subprocess.run([sys.executable, os.path.join(ROOT, "tools", "test.py")]).returncode != 0:
            sys.exit("Tests failed: no build.")
    exe, zip_path = build(version)
    digest = sha256(exe)
    if a.test:
        older = os.path.join(DIST, last["file"]) if last and os.path.isfile(os.path.join(DIST, last["file"])) and last["version"] != version else ""
        args = [sys.executable, os.path.join(ROOT, "tools", "test_installer.py"), exe] + (["--upgrade-from", older] if older else [])
        if subprocess.run(args).returncode != 0:
            sys.exit(f"The installer test failed: {exe} is built but not recorded as a good build.")
        if not test_zip(zip_path):
            sys.exit(f"The zip test failed: {zip_path} is built but not recorded as a good build.")
    items = [b for b in items if b["version"] != version]
    items.append({"version": version, "file": os.path.basename(exe), "built": datetime.datetime.now().isoformat(timespec="seconds"),
                  "sha256": digest, "commit": git("rev-parse", "--short", "HEAD"), "fingerprint": fp,
                  "appFingerprint": fingerprint(script=b""), "zip": os.path.basename(zip_path), "zipSha256": sha256(zip_path)})
    save_builds(items)
    notes = release_notes(version, exe, last.get("commit") if last else "", zip_path)
    prune()
    say(f"Built {exe}  ({os.path.getsize(exe) / 1e6:.1f} MB, SHA-256 {digest})")
    say(f"and {zip_path}  ({os.path.getsize(zip_path) / 1e6:.1f} MB)")
    say(f"Publish them: gh release create v{version} \"dist/{os.path.basename(exe)}\" \"dist/{os.path.basename(zip_path)}\" "
        f"--title \"Ship Desk {version}\" --notes-file \"dist/{os.path.basename(notes)}\" --target main")


if __name__ == "__main__":
    main()
