"""Pictures for the GitHub page (README top): cropped screenshots + PNG copies of the banner.

Run after `python docs/make_screens.py` so the crops come from fresh screenshots:
    python tools/make_readme_art.py
Writes docs/readme/*.png (sample orders only, never real ones). Needs Pillow and Edge.
"""
import os
import subprocess
import tempfile
import shutil

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCREENS = os.path.join(ROOT, "docs", "screens")
OUT = os.path.join(ROOT, "docs", "readme")
EDGE = next(p for p in [r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"] if os.path.exists(p))

# name -> (screenshot, crop box left, top, right, bottom, width to save at)
CROPS = {
    "plan": ("app-1280-sample.png", (60, 730, 1220, 1690), 1160),
    "plan-dark": ("app-1280-sample-dark.png", (60, 730, 1220, 1690), 1160),
    "print": ("app-1280-sample.png", (60, 1740, 1220, 2340), 1160),
    "history": ("app-1280-history.png", (60, 130, 1220, 1000), 1160),
    "phone": ("phone-390.png", (0, 0, 390, 760), 390),
    "scan": ("phone-390-scan.png", (0, 0, 390, 844), 390),
    "labels": ("pdf-thermalCut.png", (0, 0, 600, 445), 600),
    "slip": ("pdf-labelSlip.png", (0, 0, 900, 1165), 600),
    "proof": ("proof-pack.png", (0, 0, 1300, 880), 1160),
}


def crop_all():
    for name, (src, box, width) in CROPS.items():
        path = os.path.join(SCREENS, src)
        if not os.path.exists(path):
            print("missing", src)
            continue
        im = Image.open(path).convert("RGB")
        box = (box[0], box[1], min(box[2], im.width), min(box[3], im.height))
        im = im.crop(box)
        if im.width != width:
            im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
        im.save(os.path.join(OUT, name + ".png"), optimize=True)
        print("wrote", name + ".png", im.size)


def draw_svg(svg, png, w, h, background="#0f5a50"):
    """Draws an SVG with headless Edge, centred on a w x h page."""
    tmp = tempfile.mkdtemp()
    try:
        page = os.path.join(tmp, "p.html")
        with open(page, "w", encoding="utf-8") as f:
            f.write(f"""<!doctype html><html><body style="margin:0;background:{background};display:grid;
place-items:center;width:{w}px;height:{h}px;overflow:hidden">
<img src="file:///{svg.replace(os.sep, '/')}" style="width:{w}px;display:block"></body></html>""")
        subprocess.run([EDGE, "--headless=new", "--disable-gpu", "--hide-scrollbars", f"--user-data-dir={os.path.join(tmp, 'u')}",
                        "--allow-file-access-from-files", f"--window-size={w},{h}", "--default-background-color=00000000",
                        f"--screenshot={png}", "file:///" + page.replace(os.sep, "/")],
                       check=True, timeout=60, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print("wrote", os.path.basename(png))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    os.makedirs(OUT, exist_ok=True)
    crop_all()
    banner = os.path.join(OUT, "banner.svg")
    # GitHub's "Social preview" picture (Settings -> General -> Social preview): 1280 x 640.
    draw_svg(banner, os.path.join(OUT, "social-preview.png"), 1280, 640)
    # A PNG look at the "How a batch goes" picture, to check it by eye (not used on the page).
    draw_svg(os.path.join(OUT, "how-it-works.svg"), os.path.join(tempfile.gettempdir(), "how-it-works-check.png"), 1280, 440, "#ffffff")


if __name__ == "__main__":
    main()
