"""Serve the Ship Desk app on this PC only (127.0.0.1) and open it in the browser.

    python serve.py              # http://127.0.0.1:5091/
    python serve.py --port 5092 --no-browser

The app runs entirely in the browser. This server hands out the files in app/ and saves the files the app
makes (label PDFs, packing slips, import/Pirate Ship/history CSVs) into the Saved folder next to this file,
so they don't fill up the browser's Downloads folder:

    POST /api/save?kind=<labels|slips|import|pirate|history>&name=<file name>   body = the file
    POST /api/open-folder?kind=<kind, photos or empty>[&order=<order key>]     opens it in Explorer

Both only answer Ship Desk's own page (Host + Origin must be this server, plus an X-Ship-Desk header that
a form on another website can't send), so other websites can't write files here.

Phone photos. The server still listens on 127.0.0.1 only; the phone reaches it through Tailscale
(`tailscale serve --https=<port>` = https://<pc>.<tailnet>.ts.net:<port>, only the user's own Tailscale
devices). Anything that arrives through that proxy (Tailscale adds X-Forwarded-For and Tailscale-User-*
headers and keeps the ts.net Host) is "from the phone": it gets only the phone page and the phone API, and
the phone API also needs the pairing code (X-Ship-Desk-Key) that the PC page shows as a QR code.

    PC page:  GET  /api/ping                  "Ship Desk is on" (+ the shipdesk://start link once registered)
              POST /api/shutdown              the page's Turn off (shipdesk://start turns it on again)
              POST /api/autostart?on=1|0      start with Windows (this user's startup list) or not
              GET/POST /api/history-copy      the History list's copy in Saved/History (+ a dated copy per day)
              GET  /api/phone-link            QR link, code, Tailscale state
              POST /api/phone-access?on=1|0   switch the Tailscale address on/off
              POST /api/phone-key             make a new pairing code (old phones must scan again)
              POST /api/phone-orders          the order list the phone picks from (name, city, ZIP; no street)
              GET  /api/photos                photos per order;  GET /api/photo?id=&order=  one photo
              GET  /api/links                 tracking numbers the phone scanned that the PC hasn't taken yet
              POST /api/links-done            {"ids": [...]}: the PC put them in History
              POST /api/photo-rotate?id=&order=   body = the photo turned (a JPEG): replaces the saved file
              POST /api/photos-rekey          {"from", "to", "name"}: a mailer entry got its TCGplayer order #;
                                              its photos move to the order (later uploads under the old key too)
    Phone:    GET  /api/phone/orders          the order list + photo counts
              POST /api/phone/photo?order=&name=&kind=&id=&taken=   body = the picture
              POST /api/phone/link            {id, order, name, tracking, carrier, taken}: a mailer label's
                                              tracking number scanned and given to an order (or to a
                                              new entry "mailer:<tracking>" with the buyer's name)
A post office photo also leaves a "shipped" note for the PC page (in links.json, without a tracking number):
the order is marked shipped if it isn't already.
Photos are saved in Saved/Photos/<order # and buyer>/<Contents|Packed|Post office> <date time> <id>.jpg,
listed in Saved/Photos/photos.json. A photo sent twice (lost reply, retried) is saved once. Scanned tracking
numbers wait in Saved/Phone/links.json until the PC page takes them (same: one id, kept once).
"""
import argparse
import functools
import hashlib
import hmac
import http.server
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "app")
SAVE_ROOT = os.path.join(HERE, "Saved")
DEFAULT_PORT = 5091
MAX_BYTES = 100 * 1024 * 1024
MAX_PHOTO_BYTES = 30 * 1024 * 1024
MAX_ORDERS_BYTES = 5 * 1024 * 1024

# kind -> subfolder of Saved
FOLDERS = {
    "labels": "Labels",
    "slips": "Packing slips",
    "import": "TCGplayer import files",
    "pirate": "Pirate Ship",
    "history": "History",
    "proof": "Proof packs",
    "photos": "Photos",
}
NAME_OK = re.compile(r"^[\w ,.'&()+-]{1,150}\.(pdf|csv)$")  # \w: letters of any language, digits, _

# Photo kinds -> the word that starts the file name.
PHOTO_KINDS = {"contents": "Contents", "packed": "Packed", "postoffice": "Post office"}
PHOTO_ID_OK = re.compile(r"^[A-Za-z0-9-]{6,40}$")
TAKEN_OK = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$")
ORDER_FIELDS = ("key", "id", "source", "name", "city", "state", "zip", "labelled", "format", "shipped", "inBatch", "tracking")
TRACKING_OK = re.compile(r"^[0-9A-Z]{8,40}$")
CARRIERS = {"", "USPS", "UPS", "FedEx", "DHL"}
MAX_LINK_BYTES = 4096
MAX_HISTORY_BYTES = 20 * 1024 * 1024
HISTORY_COPY = "ship-desk-history.json"
HISTORY_BACKUP_DAYS = 30

# The only files a phone (anything through the Tailscale proxy) may load.
PHONE_FILES = {"/phone.html", "/css/phone.css", "/js/phone.js", "/phone-sw.js", "/icon.svg", "/apple-touch-icon.png",
               "/vendor/zxing-library-0.21.3.min.js", "/vendor/zxing-wasm-3.1.6/reader.js",
               "/vendor/zxing-wasm-3.1.6/zxing_reader.wasm"}
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O, 1/I

TYPES = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    ".csv": "text/csv",
    ".wasm": "application/wasm",
}

lock = threading.Lock()  # photos.json, orders.json, links.json and the pairing code

# The pages' content policy: everything from Ship Desk itself; pictures may also be data:/blob: (logos, photos,
# thumbnails); WebAssembly for the barcode reader; inline style attributes allowed (no inline scripts anywhere).
CSP = ("default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; media-src 'self' blob:; "
       "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'")


def unique_path(folder, name):
    """folder/name, or folder/'name (2).ext' etc. when that file already exists."""
    stem, ext = os.path.splitext(name)
    path, n = os.path.join(folder, name), 2
    while os.path.exists(path):
        path = os.path.join(folder, f"{stem} ({n}){ext}")
        n += 1
    return path


# On Windows a file can't be replaced while another request is reading it (and a read can meet the replace):
# both wait a moment and try again instead of failing.
RETRIES = 40


def read_json(path, default):
    for _ in range(RETRIES):
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except PermissionError:
            time.sleep(0.025)
        except (OSError, ValueError):
            return default
    return default


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    for i in range(RETRIES):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if i == RETRIES - 1:
                raise
            time.sleep(0.025)


# What an order key may look like (the PC page's history keys): a TCGplayer order number, "paste:<name>|<ZIP>" or
# "mailer:<tracking>". Anything else (e.g. "__proto__", which the page's lists would treat as every order at once)
# is refused. (Security audit 2026-10-25, SHIP-20261025-01.)
ORDER_ID_OK = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
BAD_KEYS = {"__proto__", "constructor", "prototype"}


def valid_order_key(key):
    if not key or len(key) > 200 or key in BAD_KEYS or re.search(r"[\x00-\x1f\x7f]", key):
        return False
    if key.startswith("paste:"):
        return "|" in key
    if key.startswith("mailer:"):
        return bool(TRACKING_OK.match(key[7:]))
    return bool(ORDER_ID_OK.match(key))


def clean_code(code):
    return re.sub(r"[^A-Z0-9]", "", str(code or "").upper())


def image_ext(data):
    """File extension for a JPEG/PNG/WebP/HEIC picture, or None."""
    if data[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    if data[4:8] == b"ftyp" and data[8:12] in (b"heic", b"heix", b"mif1", b"msf1", b"hevc"):
        return ".heic"
    return None


def order_folder(key, name):
    """Folder name for an order's photos: "<order #> <buyer>", "<buyer> <ZIP>" for pasted addresses, or
    "<buyer> <tracking #>" for a mailer that has no order # yet."""
    if key.startswith("mailer:"):
        base = f"{name or 'Mailer'} {key[7:]}"
    elif key.startswith("paste:"):
        who, _, zip_code = key[6:].partition("|")
        base = f"{name or who} {zip_code}"
    else:
        base = f"{key} {name}"
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", base)
    s = re.sub(r"\s+", " ", s).strip(" .")[:80].strip(" .")
    return s or "Unknown order"


def find_tailscale():
    exe = shutil.which("tailscale")
    if exe:
        return exe
    for p in (r"C:\Program Files\Tailscale\tailscale.exe", r"C:\Program Files (x86)\Tailscale\tailscale.exe"):
        if os.path.exists(p):
            return p
    return None


def run_tailscale(*args, timeout=15):
    exe = find_tailscale()
    if not exe:
        return None
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        return subprocess.run([exe, *args], capture_output=True, text=True, timeout=timeout, creationflags=flags)
    except (OSError, subprocess.SubprocessError):
        return None


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, **TYPES}
    save_root = SAVE_ROOT

    def end_headers(self):
        # Always fresh files: the service worker does the offline caching.
        self.send_header("Cache-Control", "no-cache")
        # A second wall around the pages (security audit 2026-10-25, SHIP-20261025-03): no framing by other sites,
        # no guessing file types, no referrer, and scripts/data only from Ship Desk itself (the test pages under
        # /tests/ use inline scripts, so they skip the content policy).
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        if not urllib.parse.urlsplit(self.path).path.startswith("/tests/"):
            self.send_header("Content-Security-Policy", CSP)
        super().end_headers()

    def log_message(self, fmt, *args):
        pass

    # ---------- who is asking ----------

    def local_hosts(self):
        port = self.server.server_address[1]
        return {f"127.0.0.1:{port}", f"localhost:{port}"}

    def from_phone_side(self):
        """True for anything that didn't come straight from a browser on this PC (the Tailscale proxy)."""
        if self.client_address[0] not in ("127.0.0.1", "::1"):
            return True
        if any(self.headers.get(h) for h in ("X-Forwarded-For", "X-Forwarded-Host", "Tailscale-User-Login")):
            return True
        return self.headers.get("Host", "") not in self.local_hosts()

    def from_ship_desk(self):
        """Ship Desk's own page on this PC (not another website, not the phone)."""
        if self.from_phone_side() or self.headers.get("X-Ship-Desk") != "1":
            return False
        origin = self.headers.get("Origin", "")
        host = self.headers.get("Host", "")
        # Browsers always send Origin with a POST; a same-origin GET may leave it out.
        if self.command == "POST" or origin:
            return origin == f"http://{host}"
        return True

    def from_paired_phone(self):
        key = self.phone_code(create=False)
        given = clean_code(self.headers.get("X-Ship-Desk-Key"))
        return bool(key and given) and hmac.compare_digest(given, key)

    # ---------- replies ----------

    def reply(self, code, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def refuse(self):
        self.reply(403, {"ok": False, "error": "Only Ship Desk's own page can do this."})

    def body(self, limit):
        try:
            n = int(self.headers.get("Content-Length") or -1)
        except ValueError:
            n = -1
        if n < 0 or n > limit:
            return None
        return self.rfile.read(n)

    # ---------- routing ----------

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(url.path)
        if path.startswith("/api/"):
            self.api_get(path, urllib.parse.parse_qs(url.query))
            return
        if self.from_phone_side():
            if path == "/":
                self.send_response(302)
                self.send_header("Location", "/phone.html")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if path not in PHONE_FILES:
                self.send_error(404)
                return
        super().do_GET()

    def do_HEAD(self):
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        if path.startswith("/api/") or (self.from_phone_side() and path not in PHONE_FILES):
            self.send_error(404)
            return
        super().do_HEAD()

    def api_get(self, path, q):
        arg = lambda k: (q.get(k) or [""])[0]  # noqa: E731
        if path == "/api/phone/orders":
            if not self.from_paired_phone():
                self.reply(403, {"ok": False, "error": "code"})
                return
            self.reply(200, {"ok": True, **self.phone_orders()})
            return
        if not self.from_ship_desk():
            self.refuse()
            return
        if path == "/api/ping":
            self.reply(200, {"ok": True, "launcher": LAUNCHER_URL if launcher_registered() else "",
                             "autostart": self.autostart_enabled()})
        elif path == "/api/phone-link":
            self.reply(200, {"ok": True, **self.phone_link()})
        elif path == "/api/photos":
            self.reply(200, {"ok": True, "orders": self.photo_summary()})
        elif path == "/api/photo":
            self.send_photo(arg("id"), arg("order"))
        elif path == "/api/links":
            self.reply(200, {"ok": True, "links": [ln for ln in self.links() if not ln.get("applied")]})
        elif path == "/api/history-copy":
            self.reply(200, {"ok": True, **self.history_copy()})
        else:
            self.send_error(404)

    def do_POST(self):
        url = urllib.parse.urlsplit(self.path)
        q = urllib.parse.parse_qs(url.query)
        arg = lambda k: (q.get(k) or [""])[0]  # noqa: E731
        if url.path == "/api/phone/photo":
            if not self.from_paired_phone():
                self.reply(403, {"ok": False, "error": "code"})
                return
            self.save_photo(arg)
            return
        if url.path == "/api/phone/link":
            if not self.from_paired_phone():
                self.reply(403, {"ok": False, "error": "code"})
                return
            self.save_link()
            return
        if url.path not in ("/api/save", "/api/open-folder", "/api/phone-orders", "/api/phone-key", "/api/phone-access",
                            "/api/links-done", "/api/photos-rekey", "/api/photo-rotate", "/api/shutdown",
                            "/api/autostart", "/api/history-copy"):
            self.send_error(404)
            return
        if not self.from_ship_desk():
            self.refuse()
            return
        if url.path == "/api/shutdown":
            # The page's "Turn off": answer first, then stop (the black window closes by itself).
            self.reply(200, {"ok": True})
            threading.Timer(0.3, self.stop_server).start()
            return
        if url.path == "/api/history-copy":
            self.save_history_copy()
            return
        if url.path == "/api/autostart":
            ok = self.set_autostart(arg("on") == "1")
            self.reply(200 if ok else 500, {"ok": ok, "autostart": self.autostart_enabled(),
                                            "error": "" if ok else "Windows didn't accept the change."})
            return
        if url.path == "/api/phone-orders":
            self.save_orders()
            return
        if url.path == "/api/links-done":
            self.links_done()
            return
        if url.path == "/api/photos-rekey":
            self.rekey_photos()
            return
        if url.path == "/api/photo-rotate":
            self.replace_photo(arg("id"), arg("order"))
            return
        if url.path == "/api/phone-key":
            self.phone_code(create=True, new=True)
            self.reply(200, {"ok": True, **self.phone_link()})
            return
        if url.path == "/api/phone-access":
            ok, msg = self.tailscale_switch(arg("on") == "1")
            self.reply(200 if ok else 500, {"ok": ok, "error": msg, **self.phone_link()})
            return
        kind = arg("kind")
        if kind and kind not in FOLDERS:
            self.reply(400, {"ok": False, "error": "Unknown kind of file."})
            return
        if url.path == "/api/open-folder":
            folder = os.path.join(self.save_root, FOLDERS[kind]) if kind else self.save_root
            if kind == "photos" and arg("order"):
                folder = self.order_photo_folder(arg("order")) or folder
            os.makedirs(folder, exist_ok=True)
            self.open_folder(folder)
            self.reply(200, {"ok": True, "folder": folder})
            return
        name = arg("name")
        if not kind or kind == "photos" or not NAME_OK.match(name) or name.startswith("."):
            self.reply(400, {"ok": False, "error": "Bad file name."})
            return
        data = self.body(MAX_BYTES)
        if data is None:
            self.reply(400, {"ok": False, "error": "Bad file size."})
            return
        folder = os.path.join(self.save_root, FOLDERS[kind])
        try:
            os.makedirs(folder, exist_ok=True)
            path = unique_path(folder, name)
            with open(path, "xb") as f:
                f.write(data)
        except OSError as e:
            self.reply(500, {"ok": False, "error": f"Couldn't save the file: {e.strerror or e}"})
            return
        rel = os.path.relpath(path, os.path.dirname(self.save_root))
        self.reply(200, {"ok": True, "name": os.path.basename(path), "folder": FOLDERS[kind], "path": rel, "full": path})

    def stop_server(self):
        self.server.shutdown()

    # ---------- the History list's copy on this PC ----------
    # The PC page keeps History in the browser; this keeps a copy in Saved/History so a cleared browser (or another
    # browser) can get it back: ship-desk-history.json, plus one dated copy per day in Saved/History/Backups.

    def history_dir(self):
        return os.path.join(self.save_root, FOLDERS["history"])

    def history_copy(self):
        data = read_json(os.path.join(self.history_dir(), HISTORY_COPY), {})
        hist = data.get("history") if isinstance(data, dict) else None
        if not isinstance(hist, dict):
            return {"history": None, "count": 0, "savedAt": ""}
        return {"history": hist, "count": len(hist), "savedAt": data.get("savedAt", "")}

    def save_history_copy(self):
        d = self.read_json_body(MAX_HISTORY_BYTES)
        hist = d.get("history") if isinstance(d, dict) else None
        if not isinstance(hist, dict) or not all(isinstance(v, dict) for v in hist.values()):
            self.reply(400, {"ok": False, "error": "Bad history."})
            return
        now = time.strftime("%Y-%m-%d %H:%M")
        data = {"savedAt": now, "history": hist}
        with lock:
            write_json(os.path.join(self.history_dir(), HISTORY_COPY), data)
            backups = os.path.join(self.history_dir(), "Backups")
            write_json(os.path.join(backups, f"history-{now[:10]}.json"), data)
            old = sorted(f for f in os.listdir(backups) if re.match(r"^history-\d{4}-\d{2}-\d{2}\.json$", f))
            for f in old[:-HISTORY_BACKUP_DAYS]:
                try:
                    os.remove(os.path.join(backups, f))
                except OSError:
                    pass
        self.reply(200, {"ok": True, "count": len(hist), "savedAt": now})

    # (methods, so the tests can stand in for the Windows startup list)
    def autostart_enabled(self):
        return autostart_enabled()

    def set_autostart(self, on):
        return set_autostart(on)

    def open_folder(self, folder):
        if hasattr(os, "startfile"):
            os.startfile(folder)  # Windows Explorer

    # ---------- phone pairing + Tailscale ----------

    def phone_dir(self):
        return os.path.join(self.save_root, "Phone")

    def photo_dir(self):
        return os.path.join(self.save_root, FOLDERS["photos"])

    def phone_code(self, create=True, new=False):
        """The pairing code phones must send (12 letters/digits), made on first use."""
        path = os.path.join(self.phone_dir(), "pairing-code.txt")
        with lock:
            code = "" if new else clean_code(read_text(path))
            if len(code) < 12 and create:
                code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(12))
                os.makedirs(self.phone_dir(), exist_ok=True)
                with open(path, "w", encoding="utf-8") as f:
                    f.write(code + "\n")
            return code if len(code) >= 12 else ""

    def tailscale_status(self):
        """{installed, running, dns, serving}: is https://<dns>:<port> passed on to this server?"""
        port = self.server.server_address[1]
        info = {"installed": bool(find_tailscale()), "running": False, "dns": "", "serving": False}
        st = run_tailscale("status", "--json")
        if not st or st.returncode != 0:
            return info
        try:
            data = json.loads(st.stdout)
        except ValueError:
            return info
        info["running"] = data.get("BackendState") == "Running"
        info["dns"] = ((data.get("Self") or {}).get("DNSName") or "").rstrip(".")
        sv = run_tailscale("serve", "status", "--json")
        try:
            web = (json.loads(sv.stdout) if sv and sv.returncode == 0 and sv.stdout.strip() else {}).get("Web") or {}
        except ValueError:
            web = {}
        handler = ((web.get(f"{info['dns']}:{port}") or {}).get("Handlers") or {}).get("/") or {}
        info["serving"] = str(handler.get("Proxy", "")).rstrip("/") in (f"http://127.0.0.1:{port}", f"127.0.0.1:{port}")
        return info

    def tailscale_switch(self, on):
        """Turn the tailnet-only https://<pc>:<port> address on or off. Returns (ok, message)."""
        port = self.server.server_address[1]
        if not find_tailscale():
            return False, "Tailscale isn't installed on this PC."
        args = ["serve", "--bg", f"--https={port}", f"http://127.0.0.1:{port}"] if on else ["serve", f"--https={port}", "off"]
        r = run_tailscale(*args, timeout=30)
        if not r:
            return False, "Tailscale didn't answer."
        if r.returncode != 0:
            return False, (r.stderr or r.stdout or "Tailscale refused.").strip()[:300]
        return True, ""

    def phone_link(self):
        port = self.server.server_address[1]
        ts = self.tailscale_status()
        code = self.phone_code(create=True)
        base = f"https://{ts['dns']}:{port}/phone.html" if ts["dns"] else ""
        return {
            "tailscale": ts,
            "code": "-".join(code[i:i + 4] for i in range(0, len(code), 4)),
            "address": base,
            "link": f"{base}#k={code}" if base else "",
            "ready": bool(ts["running"] and ts["serving"] and base),
        }

    # ---------- orders + photos ----------

    def save_orders(self):
        raw = self.body(MAX_ORDERS_BYTES)
        try:
            orders = json.loads(raw.decode("utf-8"))["orders"] if raw is not None else None
        except (ValueError, KeyError, TypeError, UnicodeDecodeError):
            orders = None
        if not isinstance(orders, list) or len(orders) > 10000:
            self.reply(400, {"ok": False, "error": "Bad order list."})
            return
        clean = []
        for o in orders:
            if not isinstance(o, dict) or not valid_order_key(str(o.get("key", "")).strip()):
                continue
            row = {k: o.get(k) for k in ORDER_FIELDS}
            for k, v in row.items():
                row[k] = bool(v) if k == "inBatch" else str(v if v is not None else "")[:200]
            clean.append(row)
        if not self.phone_code(create=False):
            # No phone set up yet: don't keep a copy of the order list on disk.
            self.reply(200, {"ok": True, "count": 0, "skipped": True})
            return
        with lock:
            # Tracking numbers the phone scanned that the PC hasn't taken yet stay on their orders.
            waiting = {}
            for ln in self.links():
                if not ln.get("applied"):
                    waiting.setdefault(ln["order"], []).append(ln)
            listed = {row["key"]: row for row in clean}
            for key, lns in waiting.items():
                row = listed.get(key)
                if not row:
                    row = self.link_row(lns[0])
                    clean.append(row)
                for ln in lns:
                    if ln["tracking"] and not row["tracking"]:
                        row["tracking"] = ln["tracking"]
                    row["shipped"] = row["shipped"] or ln["taken"][:10]
            write_json(os.path.join(self.phone_dir(), "orders.json"), {"updated": time.strftime("%Y-%m-%d %H:%M"), "orders": clean})
        self.reply(200, {"ok": True, "count": len(clean)})

    def photo_index(self):
        data = read_json(os.path.join(self.photo_dir(), "photos.json"), {})
        photos = data.get("photos") if isinstance(data, dict) else None
        return photos if isinstance(photos, list) else []

    def photo_path(self, p):
        root = os.path.abspath(self.photo_dir())
        path = os.path.abspath(os.path.join(root, str(p.get("file", ""))))
        return path if os.path.commonpath([root, path]) == root and os.path.isfile(path) else None

    def order_photo_folder(self, key):
        for p in self.photo_index():
            if p.get("order") == key and self.photo_path(p):
                return os.path.dirname(self.photo_path(p))
        return None

    def photo_summary(self):
        """{order key: {contents, packed, postoffice, total, photos: [{id, kind, taken, file}]}} (files that still exist)."""
        out = {}
        for p in self.photo_index():
            if p.get("kind") not in PHOTO_KINDS or not self.photo_path(p):
                continue
            o = out.setdefault(p.get("order", ""), {**{k: 0 for k in PHOTO_KINDS}, "total": 0, "photos": []})
            o[p["kind"]] += 1
            o["total"] += 1
            o["photos"].append({k: p.get(k, "") for k in ("id", "kind", "taken", "file")})
        return out

    def phone_orders(self):
        data = read_json(os.path.join(self.phone_dir(), "orders.json"), {})
        orders = data.get("orders") if isinstance(data, dict) and isinstance(data.get("orders"), list) else []
        counts = {k: {kk: v[kk] for kk in (*PHOTO_KINDS, "total")} for k, v in self.photo_summary().items()}
        return {"orders": orders, "photos": counts, "updated": data.get("updated", "") if isinstance(data, dict) else ""}

    def rekeys_path(self):
        return os.path.join(self.phone_dir(), "rekeys.json")

    def current_key(self, key):
        """A mailer entry that got its order # since the phone took this photo goes to the order."""
        moved = read_json(self.rekeys_path(), {})
        for _ in range(5):
            if not isinstance(moved, dict) or key not in moved:
                break
            key = str(moved[key])
        return key

    def save_photo(self, arg):
        key, name, kind, pid, taken = self.current_key(arg("order").strip()), arg("name").strip()[:100], arg("kind"), arg("id"), arg("taken")
        if not valid_order_key(key) or kind not in PHOTO_KINDS or not PHOTO_ID_OK.match(pid):
            self.reply(400, {"ok": False, "error": "Bad photo details."})
            return
        data = self.body(MAX_PHOTO_BYTES)
        if not data:
            self.reply(400, {"ok": False, "error": "The photo is missing or too big."})
            return
        ext = image_ext(data)
        if not ext:
            self.reply(400, {"ok": False, "error": "That isn't a photo Ship Desk can save (JPEG, PNG, WebP or HEIC)."})
            return
        if not TAKEN_OK.match(taken):
            taken = time.strftime("%Y-%m-%dT%H:%M:%S")
        when = taken.replace("T", " ").replace(":", "-")
        if len(when) == 16:
            when += "-00"
        index_path = os.path.join(self.photo_dir(), "photos.json")
        with lock:
            photos = self.photo_index()
            for p in photos:
                if p.get("id") == pid and p.get("order") == key and self.photo_path(p):
                    self.reply(200, {"ok": True, "file": p["file"], "again": True})
                    return
            folder = self.order_photo_folder(key) or os.path.join(self.photo_dir(), order_folder(key, name))
            try:
                os.makedirs(folder, exist_ok=True)
                path = unique_path(folder, f"{PHOTO_KINDS[kind]} {when} {pid[:6]}{ext}")
                with open(path, "xb") as f:
                    f.write(data)
            except OSError as e:
                self.reply(500, {"ok": False, "error": f"Couldn't save the photo: {e.strerror or e}"})
                return
            rel = os.path.relpath(path, self.photo_dir()).replace("\\", "/")
            photos.append({"id": pid, "order": key, "name": name, "kind": kind, "taken": taken,
                           "received": time.strftime("%Y-%m-%dT%H:%M:%S"), "file": rel})
            write_json(index_path, {"photos": photos})
            if kind == "postoffice":
                # Handed in at the post office: the PC page marks the order shipped (if it isn't already).
                note = "ship-" + pid + "-" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:10]
                self.record_link(note, key, "", "", taken, name)
        self.reply(200, {"ok": True, "file": rel})

    # ---------- tracking numbers scanned on the phone ----------

    def links_path(self):
        return os.path.join(self.phone_dir(), "links.json")

    def links(self):
        data = read_json(self.links_path(), {})
        links = data.get("links") if isinstance(data, dict) else None
        return [ln for ln in links if isinstance(ln, dict)] if isinstance(links, list) else []

    def read_json_body(self, limit):
        raw = self.body(limit)
        try:
            data = json.loads(raw.decode("utf-8")) if raw is not None else None
        except (ValueError, UnicodeDecodeError):
            data = None
        return data if isinstance(data, dict) else None

    def save_link(self):
        d = self.read_json_body(MAX_LINK_BYTES) or {}
        lid, key = str(d.get("id", "")), self.current_key(str(d.get("order", "")).strip())
        tracking = re.sub(r"[^0-9A-Za-z]", "", str(d.get("tracking", ""))).upper()
        carrier = str(d.get("carrier", ""))
        taken = str(d.get("taken", ""))
        if not PHOTO_ID_OK.match(lid) or not valid_order_key(key) or not TRACKING_OK.match(tracking) or carrier not in CARRIERS:
            self.reply(400, {"ok": False, "error": "Bad tracking details."})
            return
        if not TAKEN_OK.match(taken):
            taken = time.strftime("%Y-%m-%dT%H:%M:%S")
        with lock:
            fresh = self.record_link(lid, key, tracking, carrier, taken, str(d.get("name", ""))[:100])
        self.reply(200, {"ok": True} if fresh else {"ok": True, "again": True})

    def record_link(self, lid, key, tracking, carrier, taken, name):
        """Keep a note for the PC page: a tracking number for the order, or (tracking "") "it was shipped".
        Call with the lock held. False when this id is already kept."""
        links = self.links()
        if any(ln.get("id") == lid for ln in links):
            return False
        orders_path = os.path.join(self.phone_dir(), "orders.json")
        data = read_json(orders_path, {})
        orders = data.get("orders") if isinstance(data, dict) and isinstance(data.get("orders"), list) else []
        info = next((o for o in orders if isinstance(o, dict) and o.get("key") == key), None)
        # What the PC needs to put the order in History even when that batch isn't loaded any more.
        facts = {k: str((info or {}).get(k) or "") for k in ("source", "name", "city", "state", "zip")}
        facts["orderId"] = str((info or {}).get("id") or "")
        if not info:
            kind = "paste" if key.startswith("paste:") else "mailer" if key.startswith("mailer:") else "csv"
            facts.update(orderId=key if kind == "csv" else "", source=kind, name=name)
        links.append({"id": lid, "order": key, "tracking": tracking, "carrier": carrier, "taken": taken,
                      "received": time.strftime("%Y-%m-%dT%H:%M:%S"), "applied": "", **facts})
        write_json(self.links_path(), {"links": links[-2000:]})
        if info:
            if tracking:
                info["tracking"] = tracking
            info["shipped"] = info.get("shipped") or taken[:10]
        else:
            # A new entry made on the phone: list it, so the phone keeps it until the PC has taken it.
            orders.append(self.link_row({**facts, "order": key, "tracking": tracking, "taken": taken}))
            data = {"updated": data.get("updated", "") if isinstance(data, dict) else "", "orders": orders}
        write_json(orders_path, data)
        return True

    @staticmethod
    def link_row(ln):
        """An order-list row for a phone link the PC hasn't taken yet."""
        row = {k: "" for k in ORDER_FIELDS}
        row.update(key=ln["order"], id=ln.get("orderId", ""), source=ln.get("source", ""), name=ln.get("name", ""),
                   city=ln.get("city", ""), state=ln.get("state", ""), zip=ln.get("zip", ""),
                   tracking=ln["tracking"], shipped=ln["taken"][:10], inBatch=False)
        return row

    def rekey_photos(self):
        d = self.read_json_body(4096) or {}
        old, new, name = str(d.get("from", "")).strip(), str(d.get("to", "")).strip(), str(d.get("name", "")).strip()[:100]
        if not valid_order_key(old) or not valid_order_key(new) or old == new:
            self.reply(400, {"ok": False, "error": "Bad order numbers."})
            return
        moved = 0
        with lock:
            photos = self.photo_index()
            mine = [p for p in photos if p.get("order") == old]
            target = self.order_photo_folder(new) or os.path.join(self.photo_dir(), order_folder(new, name))
            for p in mine:
                src = self.photo_path(p)
                if src:
                    os.makedirs(target, exist_ok=True)
                    dest = unique_path(target, os.path.basename(src))
                    try:
                        os.replace(src, dest)
                    except OSError:
                        continue
                    p["file"] = os.path.relpath(dest, self.photo_dir()).replace("\\", "/")
                    moved += 1
                    try:
                        os.rmdir(os.path.dirname(src))  # only when it's empty now
                    except OSError:
                        pass
                p["order"] = new
            if mine:
                write_json(os.path.join(self.photo_dir(), "photos.json"), {"photos": photos})
            rekeys = read_json(self.rekeys_path(), {})
            rekeys = rekeys if isinstance(rekeys, dict) else {}
            rekeys[old] = new
            write_json(self.rekeys_path(), rekeys)
            links = self.links()
            for ln in links:
                if ln.get("order") == old:
                    ln["order"] = new
            write_json(self.links_path(), {"links": links})
        self.reply(200, {"ok": True, "moved": moved})

    def links_done(self):
        d = self.read_json_body(64 * 1024) or {}
        ids = {str(i) for i in d.get("ids", []) if isinstance(i, str)} if isinstance(d.get("ids"), list) else set()
        if not ids:
            self.reply(400, {"ok": False, "error": "No ids."})
            return
        with lock:
            links = self.links()
            for ln in links:
                if ln.get("id") in ids and not ln.get("applied"):
                    ln["applied"] = time.strftime("%Y-%m-%dT%H:%M:%S")
            write_json(self.links_path(), {"links": links})
        self.reply(200, {"ok": True})

    def replace_photo(self, pid, key):
        """The PC page turned a photo: save the turned JPEG over the old file (same name)."""
        data = self.body(MAX_PHOTO_BYTES)
        if not data or image_ext(data) != ".jpg":
            self.reply(400, {"ok": False, "error": "Not a JPEG."})
            return
        with lock:
            p = next((p for p in self.photo_index() if p.get("id") == pid and p.get("order") == key), None)
            path = p and self.photo_path(p)
            if not path or not path.lower().endswith(".jpg"):
                self.reply(404, {"ok": False, "error": "No such photo."})
                return
            tmp = path + ".tmp"
            with open(tmp, "wb") as f:
                f.write(data)
            for i in range(RETRIES):
                try:
                    os.replace(tmp, path)
                    break
                except PermissionError:
                    if i == RETRIES - 1:
                        raise
                    time.sleep(0.025)
        self.reply(200, {"ok": True})

    def send_photo(self, pid, key):
        p = next((p for p in self.photo_index() if p.get("id") == pid and p.get("order") == key), None)
        path = p and self.photo_path(p)
        if not path:
            self.send_error(404)
            return
        with open(path, "rb") as f:
            data = f.read()
        ctype = {".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".heic": "image/heic"}.get(
            os.path.splitext(path)[1].lower(), "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def read_text(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


class Server(http.server.ThreadingHTTPServer):
    request_queue_size = 64
    daemon_threads = True
    # On Windows, "reuse address" lets a second Ship Desk listen on the same port next to the first one (both
    # answer, Turn off stops only one). Claim the port for this one alone instead.
    allow_reuse_address = sys.platform != "win32"

    def server_bind(self):
        if sys.platform == "win32" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def make_server(port, handler=Handler):
    return Server(("127.0.0.1", port), functools.partial(handler, directory=ROOT))


# "Turn on" from the page: Windows starts Ship Desk for a shipdesk://start link (like mailto: opens mail). Registered
# for this Windows user only (HKCU, no admin). The command is fixed: the link's own text is never passed on.
LAUNCHER_URL = "shipdesk://start"
LAUNCHER_KEY = r"Software\Classes\shipdesk"


def pythonw():
    """The windowless Python (pythonw.exe) next to the one running this, or on PATH; None when there isn't one."""
    beside = os.path.join(os.path.dirname(sys.executable or ""), "pythonw.exe")
    return beside if os.path.isfile(beside) else shutil.which("pythonw")


def launcher_command():
    """What shipdesk://start runs: Ship Desk in the background (no window), or the .bat when there's no pythonw."""
    pyw = pythonw()
    if pyw:
        return f'"{pyw}" "{os.path.join(HERE, "serve.py")}" --no-browser'
    bat = os.path.join(HERE, "Start Ship Desk.bat")
    cmd = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "cmd.exe")
    return f'"{cmd}" /c start "Ship Desk" /D "{HERE}" "{bat}" --no-browser'


def launcher_registered():
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, LAUNCHER_KEY + r"\shell\open\command") as k:
            return winreg.QueryValueEx(k, "")[0] == launcher_command()
    except (ImportError, OSError):
        return False


AUTOSTART_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
AUTOSTART_NAME = "Ship Desk"


def autostart_enabled():
    """Does Ship Desk start (in the background) when this Windows user logs in?"""
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, AUTOSTART_KEY) as k:
            return bool(winreg.QueryValueEx(k, AUTOSTART_NAME)[0])
    except (ImportError, OSError):
        return False


def set_autostart(on):
    """Add or remove Ship Desk in this user's Windows startup list (Task Manager > Startup apps). Returns ok."""
    try:
        import winreg
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, AUTOSTART_KEY) as k:
            if on:
                winreg.SetValueEx(k, AUTOSTART_NAME, 0, winreg.REG_SZ, launcher_command())
            else:
                try:
                    winreg.DeleteValue(k, AUTOSTART_NAME)
                except FileNotFoundError:
                    pass
        return True
    except (ImportError, OSError):
        return False


def register_launcher():
    """Make shipdesk://start start Ship Desk (only when missing or pointing elsewhere). False when it can't."""
    if launcher_registered():
        return True
    try:
        import winreg
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, LAUNCHER_KEY) as k:
            winreg.SetValueEx(k, "", 0, winreg.REG_SZ, "URL:Ship Desk")
            winreg.SetValueEx(k, "URL Protocol", 0, winreg.REG_SZ, "")
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, LAUNCHER_KEY + r"\shell\open\command") as k:
            winreg.SetValueEx(k, "", 0, winreg.REG_SZ, launcher_command())
        return True
    except (ImportError, OSError):
        return False


# ---------- running in the background (pythonw: no window) ----------

LOG_FILE = os.path.join(SAVE_ROOT, "ship-desk.log")
MAX_LOG_BYTES = 1024 * 1024


def start_log():
    """With no window, what Ship Desk prints (and any error) goes to Saved/ship-desk.log."""
    os.makedirs(SAVE_ROOT, exist_ok=True)
    try:
        if os.path.getsize(LOG_FILE) > MAX_LOG_BYTES:
            os.replace(LOG_FILE, LOG_FILE + ".old")
    except OSError:
        pass
    f = open(LOG_FILE, "a", encoding="utf-8", buffering=1)
    sys.stdout = sys.stderr = f
    print(f"\n--- {time.strftime('%Y-%m-%d %H:%M:%S')} Ship Desk started in the background (pid {os.getpid()})")


def tell(message, hidden):
    """Show a problem: in the window, or (in the background) as a Windows message box, and in the log."""
    print(message)
    if hidden:
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, message, "Ship Desk", 0x30)
        except (ImportError, AttributeError, OSError):
            pass


def already_running(port):
    """Is Ship Desk itself answering on this port?"""
    import urllib.request
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}/api/ping", headers={"X-Ship-Desk": "1"})
        with urllib.request.urlopen(req, timeout=3) as r:
            return bool(json.loads(r.read().decode("utf-8")).get("ok"))
    except (OSError, ValueError):
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    hidden = sys.stdout is None  # started with pythonw: no window
    if hidden:
        start_log()
    url = f"http://127.0.0.1:{a.port}/"
    try:
        srv = make_server(a.port)
    except OSError:
        if already_running(a.port):
            # Started twice: the first one keeps running; just show the page.
            print("Ship Desk is already running.")
            if not a.no_browser:
                webbrowser.open(url)
            return
        tell(f"Ship Desk couldn't start: another program is using port {a.port}.", hidden)
        sys.exit(1)
    if hidden:
        print(f"Ship Desk is running in the background at {url}  (turn it off with the switch at the top of the page)")
    else:
        print(f"Ship Desk is running at {url}  (close this window to stop it)")
    print(f"Files it makes are saved in {SAVE_ROOT}")
    print("Phone photos: in Ship Desk click \"Phone photos\" at the top.")
    if a.port == DEFAULT_PORT and register_launcher():
        print("Turn off / Turn on: the switch at the top of the Ship Desk page.")
    if a.port == DEFAULT_PORT and autostart_enabled():
        set_autostart(True)  # keeps the startup entry pointing at this copy of Ship Desk
        print("Starts with Windows (untick \"Start with Windows\" at the top of the page to stop that).")
    if not a.no_browser:
        threading.Timer(0.5, webbrowser.open, [url]).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} Ship Desk stopped.")


if __name__ == "__main__":
    main()
