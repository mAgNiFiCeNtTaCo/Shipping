"""Build the Ship Desk installer for Windows: dist\\ShipDesk-Setup-<version>.exe.

    python tools/build_installer.py

Needs Inno Setup 6 (winget install JRSoftware.InnoSetup) and Microsoft Edge (to draw the icon); Pillow for the .ico.
Steps: download Python's embeddable package (python.org, checked against PY_SHA256; kept in build\\cache), put
Ship Desk (serve.py + app\\ without the test pages), that Python, the icon, the guide (README.md as a web page,
without the developer notes) and the licence notices in build\\stage, then compile installer\\ShipDesk.iss.
Nothing personal goes in: no Saved folder, no install.json (setup writes that on the user's PC).
"""
import hashlib
import html
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

PY_VERSION = "3.14.7"
PY_URL = f"https://www.python.org/ftp/python/{PY_VERSION}/python-{PY_VERSION}-embed-amd64.zip"
# SHA-256 of that zip, as python.org lists it (api/v2/downloads/release_file, checked 2026-10-26); a different file
# stops the build.
PY_SHA256 = {"3.14.7": "d297e5ff019966817ad8502465176139f2d3d840fa4ed84b13bed399a6ab1f15"}

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
    with open(os.path.join(dest, "Ship Desk guide.html"), "w", encoding="utf-8") as f:
        f.write(guide_html(md))


def main():
    version = app_version()
    iscc = next((p for p in ISCC if os.path.isfile(p)), None)
    if not iscc:
        sys.exit("Inno Setup 6 not found: winget install JRSoftware.InnoSetup")
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
    os.makedirs(DIST, exist_ok=True)
    subprocess.run([iscc, "/Q", f"/DAppVersion={version}", f"/DStage={STAGE}", os.path.join(ROOT, "installer", "ShipDesk.iss")], check=True)
    exe = os.path.join(DIST, f"ShipDesk-Setup-{version}.exe")
    say(f"Built {exe}  ({os.path.getsize(exe) / 1e6:.1f} MB, SHA-256 {sha256(exe)})")


if __name__ == "__main__":
    main()
