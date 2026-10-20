"""QA helper: screenshots of Ship Desk for docs/screens (needs the app server running).

    python serve.py --no-browser --port 5098      (in another window)
    python docs/make_screens.py [port]

Takes the app at 1280 and 500 px wide, before and after loading the sample, and page 1 of each PDF format
(plus a packing slip page) through app/tests/pdf-preview.html, with headless Edge.
"""
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "screens")
EDGE = next(p for p in [r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"] if os.path.exists(p))

# format id -> (page width, page height) in inches
FORMATS = {
    "thermal4x6": (4, 6), "thermal6x4": (6, 4), "letter1": (8.5, 11), "letter2": (8.5, 11), "letter3": (8.5, 11), "letter4": (8.5, 11),
    "labelSlip": (8.5, 11), "avery5160": (8.5, 11), "envelope10": (9.5, 4.125),
}


def shot(url, name, w, h, extra=()):
    profile = tempfile.mkdtemp(prefix="shipdesk-shot-")
    path = os.path.join(OUT, name)
    try:
        subprocess.run([EDGE, "--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars",
                        f"--user-data-dir={profile}", f"--window-size={w},{h}", "--virtual-time-budget=8000",
                        f"--screenshot={path}", *extra, url],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=90)
    finally:
        shutil.rmtree(profile, ignore_errors=True)
    print(("ok   " if os.path.exists(path) else "FAIL ") + name)


def main():
    port = sys.argv[1] if len(sys.argv) > 1 else "5098"
    base = f"http://127.0.0.1:{port}/"
    os.makedirs(OUT, exist_ok=True)
    for w, h in [(1280, 4200), (500, 7600)]:
        light, dark = ["--blink-settings=preferredColorScheme=1"], ["--force-dark-mode", "--blink-settings=preferredColorScheme=0"]
        shot(base, f"app-{w}-empty.png", w, h, light)
        shot(base + "?sample", f"app-{w}-sample.png", w, h, light)
        shot(base + "?sample", f"app-{w}-sample-dark.png", w, h, dark)
    for fid, (pw, ph) in FORMATS.items():
        width = 600 if fid == "thermal4x6" else 900
        height = round(width * ph / pw)
        shot(f"{base}tests/pdf-preview.html?format={fid}&page=1&width={width}", f"pdf-{fid}.png", width, height)
    # A packing slip page: thermal slips follow the 10 labels; letter slips follow 1 (letter4 = 3 label pages).
    shot(f"{base}tests/pdf-preview.html?format=thermal4x6&page=11&width=600", "pdf-thermal4x6-slip.png", 600, 900)
    shot(f"{base}tests/pdf-preview.html?format=letter4&page=4&width=900", "pdf-letter-slip.png", 900, 1165)


if __name__ == "__main__":
    main()
