"""QA helper: screenshots of Ship Desk for docs/screens (needs the app server running).

    python serve.py --no-browser --port 5098      (in another window)
    python docs/make_screens.py [port]
    python docs/make_screens.py phone             (only the phone photos shots; no server needed)

Takes the app at 1280 and 500 px wide, before and after loading the sample, and page 1 of each PDF format
(plus a packing slip page) through app/tests/pdf-preview.html, with headless Edge.
Phone photos shots (phone-*.png, app-1280-phone*.png) run on a private server of their own (fake Tailscale,
throwaway Saved folder), so the real Saved folder and Tailscale are never touched.
"""
import base64
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "screens")
EDGE = next(p for p in [r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"] if os.path.exists(p))

# format id -> (page width, page height) in inches
FORMATS = {
    "thermal4x6": (4, 6), "thermal6x4": (4, 6), "letter1": (8.5, 11), "letter2": (8.5, 11), "letter3": (8.5, 11), "letter4": (8.5, 11),
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


class DevTools:
    """Just enough of Edge's DevTools protocol (a websocket) to take a real-time screenshot. The phone page keeps
    its photos in IndexedDB, which --virtual-time-budget screenshots don't wait for."""

    def __init__(self, url):
        m = re.match(r"ws://([^:/]+):(\d+)(/.*)", url)
        self.s = socket.create_connection((m.group(1), int(m.group(2))), timeout=30)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((f"GET {m.group(3)} HTTP/1.1\r\nHost: {m.group(1)}:{m.group(2)}\r\nUpgrade: websocket\r\n"
                        f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.s.recv(4096)
        head, self.buf = buf.split(b"\r\n\r\n", 1)
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise RuntimeError(head.decode(errors="replace"))
        self.n = 0

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.s.recv(1 << 20)
            if not chunk:
                raise EOFError
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _send(self, text):
        data = text.encode()
        n = len(data)
        hdr = bytes([0x81]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack(">H", n) if n < 65536
                               else bytes([0x80 | 127]) + struct.pack(">Q", n))
        mask = os.urandom(4)
        self.s.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def _recv(self):
        msg = b""
        while True:
            b1, b2 = self._read(2)
            n = b2 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            payload = self._read(n)
            if b1 & 0x0F in (0x0, 0x1):
                msg += payload
                if b1 & 0x80:
                    return msg.decode()

    def call(self, method, **params):
        self.n += 1
        self._send(json.dumps({"id": self.n, "method": method, "params": params}))
        while True:
            m = json.loads(self._recv())
            if m.get("id") == self.n:
                if "error" in m:
                    raise RuntimeError(f"{method}: {m['error']}")
                return m.get("result", {})


def live_shot(url, name, w, h, scheme="light", ready="window.previewReady === true", wait=40):
    """Screenshot in real time: open url, wait until `ready` is true in the page, then capture."""
    profile = tempfile.mkdtemp(prefix="shipdesk-shot-")
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    edge = subprocess.Popen([EDGE, "--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars",
                             f"--remote-debugging-port={port}", f"--user-data-dir={profile}", "about:blank"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    path = os.path.join(OUT, name)
    try:
        for _ in range(100):
            try:
                tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=2))
                page = next(t for t in tabs if t.get("type") == "page")
                break
            except Exception:
                time.sleep(0.2)
        cdp = DevTools(page["webSocketDebuggerUrl"])
        cdp.call("Emulation.setEmulatedMedia", features=[{"name": "prefers-color-scheme", "value": scheme}])
        cdp.call("Emulation.setDeviceMetricsOverride", width=w, height=h, deviceScaleFactor=1, mobile=w < 600)
        cdp.call("Page.navigate", url=url)
        end = time.time() + wait
        while time.time() < end:
            time.sleep(0.25)
            r = cdp.call("Runtime.evaluate", expression=ready, returnByValue=True)
            if r.get("result", {}).get("value") is True:
                break
        else:
            print("     (never said ready) " + name)
        time.sleep(0.6)
        with open(path, "wb") as f:
            f.write(base64.b64decode(cdp.call("Page.captureScreenshot", format="png")["data"]))
    finally:
        edge.kill()
        shutil.rmtree(profile, ignore_errors=True)
    print(("ok   " if os.path.exists(path) else "FAIL ") + name)


def phone_shots():
    """The phone page and the PC's phone windows, on a private server (see app/tests/phone-preview.html)."""
    import threading
    sys.path.insert(0, os.path.dirname(HERE))
    import serve

    root = tempfile.mkdtemp(prefix="shipdesk-shots-saved-")

    class Handler(serve.Handler):
        save_root = root

        def tailscale_status(self):
            return {"installed": True, "running": True, "dns": "your-pc.your-tailnet.ts.net", "serving": True}

    srv = serve.make_server(0, Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}/tests/phone-preview.html?mode="
    try:
        live_shot(base + "online", "phone-390.png", 390, 1400)   # first: it sends the photos the others show
        live_shot(base + "online", "phone-390-dark.png", 390, 1400, "dark")
        live_shot(base + "offline", "phone-390-offline.png", 390, 1000)
        live_shot(base + "scan", "phone-390-scan.png", 390, 844)
        live_shot(base + "ask", "phone-390-ask.png", 390, 844)
        live_shot(base + "pc", "app-1280-phone.png", 1280, 900)
        live_shot(base + "pc", "app-1280-phone-dark.png", 1280, 900, "dark")
        live_shot(base + "photos", "app-1280-photos.png", 1280, 900)
        live_shot(base + "proof", "proof-pack.png", 1300, 880)
        live_shot(base + "history", "app-1280-history-photos.png", 1280, 900)
        live_shot(base + "history", "app-390-history-photos.png", 390, 1600)
        live_shot(base + "pc", "app-390-phone.png", 390, 1100)
    finally:
        srv.shutdown()
        shutil.rmtree(root, ignore_errors=True)


def main():
    if sys.argv[1:] == ["phone"]:
        os.makedirs(OUT, exist_ok=True)
        phone_shots()
        return
    port = sys.argv[1] if len(sys.argv) > 1 else "5098"
    base = f"http://127.0.0.1:{port}/"
    os.makedirs(OUT, exist_ok=True)
    for w, h in [(1280, 4200), (500, 7600)]:
        light, dark = ["--blink-settings=preferredColorScheme=1"], ["--force-dark-mode", "--blink-settings=preferredColorScheme=0"]
        shot(base, f"app-{w}-empty.png", w, h, light)
        shot(base + "?sample", f"app-{w}-sample.png", w, h, light)
        shot(base + "?sample", f"app-{w}-sample-dark.png", w, h, dark)
        shot(base + "tests/history-preview.html", f"app-{w}-history.png", w, 1800 if w > 600 else 4200, light)
        shot(base + "tests/history-preview.html", f"app-{w}-history-dark.png", w, 1800 if w > 600 else 4200, dark)
    for fid, (pw, ph) in FORMATS.items():
        width = 600 if fid.startswith("thermal") else 900
        height = round(width * ph / pw)
        shot(f"{base}tests/pdf-preview.html?format={fid}&page=1&width={width}", f"pdf-{fid}.png", width, height)
    # A packing slip page: thermal slips follow the 10 labels; letter slips follow 1 (letter4 = 3 label pages).
    shot(f"{base}tests/pdf-preview.html?format=thermal4x6&page=11&width=600", "pdf-thermal4x6-slip.png", 600, 900)
    shot(f"{base}tests/pdf-preview.html?format=letter4&page=4&width=900", "pdf-letter-slip.png", 900, 1165)
    phone_shots()


if __name__ == "__main__":
    main()
