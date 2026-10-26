// phone.js: Ship Desk on the phone (phone.html). Pick the orders, say what the photo shows (contents, packed,
// post office) and take photos. Every photo first goes into this phone's own storage (IndexedDB) and stays
// there until Ship Desk on the PC says it saved it, so photos taken while the PC is off or out of reach
// (at the post office) are sent by themselves later. Talks to serve.py's /api/phone/* with the pairing code.
// Scan picks orders too: the order QR code Ship Desk prints on labels, envelopes and slips, or the tracking
// barcode on a bought shipping label (a tracking number Ship Desk doesn't know yet is linked to an order here
// and sent to the PC, which puts it in History and the TCGplayer import file).

export const KINDS = [
  { id: "contents", label: "Contents", hint: "What's inside: the cards" },
  { id: "packed", label: "Packed", hint: "Sealed and labelled, ready to go" },
  { id: "postoffice", label: "Post office", hint: "Handed in, or the receipt" },
];
const FILTERS = [{ id: "todo", label: "To do" }, { id: "open", label: "Not shipped" }, { id: "all", label: "All" }];
// To do: orders not shipped yet that are on the PC now, got a label in the last TODO_DAYS, or have photos waiting
// here, grouped by the photo they need next (contents -> packed -> post office; a skipped contents photo isn't asked
// for again). An older label that never got shipped isn't nagged about.
const TODO_DAYS = 14;
const LS = {
  code: "shipdesk.phone.code", orders: "shipdesk.phone.orders", kind: "shipdesk.phone.kind",
  pick: "shipdesk.phone.pick", recent: "shipdesk.phone.recent", filter: "shipdesk.phone.filter",
};
const MAX_SIDE = 2560;        // longest side of a saved photo, in pixels
const PING_MS = 8000;         // give up on a list request after this long
const UPLOAD_MS = 90000;      // ... and on one photo upload
const CHECK_MS = 15000;       // how often to try again while photos are waiting
const IDLE_MS = 60000;        // how often to refresh the order list otherwise
const MAX_RECENT = 40;
const MAX_SHOWN = 300;

// ---------- small helpers ----------

const $ = (sel) => document.querySelector(sel);

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (typeof v === "boolean") n[k] = v;
    else n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
  return n;
}

const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked: the page still works */ }
}

export const cleanCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Local time as YYYY-MM-DDTHH:MM:SS (what the file name on the PC uses). */
export function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const newId = () => Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);

let toastTimer = 0;
function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 4000);
}

// ---------- the waiting photos (IndexedDB) ----------
// photo = { qid, id, order, name, label, kind, taken, type, bytes (ArrayBuffer), created, error }
// link  = { qid: "link|<id>", link: true, id, order, name, label, tracking, carrier, taken, created, error }

let dbOpen = null;
function db() {
  dbOpen = dbOpen || new Promise((resolve, reject) => {
    const r = indexedDB.open("shipdesk-phone", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("queue", { keyPath: "qid" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbOpen;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction("queue", mode);
    const req = fn(t.objectStore("queue"));
    let out;
    if (req) req.onsuccess = () => { out = req.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const queueAll = async () => ((await tx("readonly", (s) => s.getAll())) || []).sort((a, b) => a.created - b.created);
const queuePut = (item) => tx("readwrite", (s) => s.put(item));
const queueDel = (qid) => tx("readwrite", (s) => s.delete(qid));

// ---------- state ----------

export const state = {
  code: "",
  orders: [],         // from the PC: { key, id, source, name, city, state, zip, labelled, format, shipped, inBatch, tracking }
  photos: {},         // order key -> { contents, packed, postoffice, total } already on the PC
  updated: "",
  kind: "contents",
  pick: new Set(),    // order keys
  filter: "todo",
  search: "",
  link: "checking",   // checking | ok | down | code
  queue: [],          // waiting photos, without their bytes
  recent: [],         // { id, kind, taken, thumb, labels, n }
  sending: false,
  lastCheck: 0,
};

function loadState() {
  const fromLink = /(?:^|[#&])k=([A-Za-z0-9-]+)/.exec(location.hash);
  if (fromLink) lsSet(LS.code, cleanCode(fromLink[1]));
  state.code = cleanCode(lsGet(LS.code, ""));
  const cached = lsGet(LS.orders, null);
  if (cached && Array.isArray(cached.orders)) Object.assign(state, { orders: cached.orders, photos: cached.photos || {}, updated: cached.updated || "" });
  const kind = lsGet(LS.kind, "contents");
  state.kind = KINDS.some((k) => k.id === kind) ? kind : "contents";
  const filter = lsGet(LS.filter, "todo");
  state.filter = FILTERS.some((f) => f.id === filter) ? filter : "todo";
  state.pick = new Set(Array.isArray(lsGet(LS.pick, [])) ? lsGet(LS.pick, []) : []);
  const recent = lsGet(LS.recent, []);
  state.recent = Array.isArray(recent) ? recent : [];
}

export function setCode(code) {
  state.code = cleanCode(code);
  lsSet(LS.code, state.code);
  state.link = "checking";
  render();
  return refresh(true);
}

// ---------- talking to the PC ----------

async function call(path, opts = {}, ms = PING_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(path, { ...opts, cache: "no-store", signal: ctl.signal,
      headers: { ...(opts.headers || {}), "X-Ship-Desk-Key": state.code } });
  } finally {
    clearTimeout(timer);
  }
}

/** Get the order list from the PC, then send any waiting photos. */
export async function refresh() {
  state.lastCheck = Date.now();
  if (!state.code) { state.link = "code"; render(); return state.link; }
  try {
    const r = await call("api/phone/orders");
    if (r.status === 403) state.link = "code";
    else if (r.ok) {
      const data = await r.json();
      const fresh = Array.isArray(data.orders) ? data.orders : [];
      // Entries made on this phone (a new mailer, a QR code the list didn't have) stay until the PC lists them.
      const known = new Set(fresh.map((o) => o.key));
      const byTracking = new Map(fresh.filter((o) => o.tracking).map((o) => [compact(o.tracking), o]));
      const keep = [];
      for (const o of state.orders) {
        if (known.has(o.key)) continue;
        const now = o.tracking && byTracking.get(compact(o.tracking));
        if (now) { // the PC gave this mailer its order #: pick that order instead
          if (state.pick.delete(o.key)) state.pick.add(now.key);
          continue;
        }
        if ((o.local || o.scanned) && (state.pick.has(o.key) || state.queue.some((q) => q.order === o.key))) keep.push(o);
      }
      state.orders = [...fresh, ...keep];
      lsSet(LS.pick, [...state.pick]);
      state.photos = data.photos || {};
      state.updated = data.updated || "";
      lsSet(LS.orders, { orders: state.orders, photos: state.photos, updated: state.updated });
      state.link = "ok";
    } else state.link = "down";
  } catch {
    state.link = "down";
  }
  render();
  if (state.link === "ok") await pump();
  return state.link;
}

/** Send the waiting photos, oldest first. Stops at the first sign the PC can't be reached. */
export async function pump() {
  if (state.sending || !state.code) return;
  state.sending = true;
  render();
  try {
    for (const item of await queueAll()) {
      let r;
      try {
        if (item.link) {
          const body = JSON.stringify({ id: item.id, order: item.order, name: item.name || "", tracking: item.tracking, carrier: item.carrier || "", taken: item.taken });
          r = await call("api/phone/link", { method: "POST", headers: { "Content-Type": "application/json" }, body });
        } else {
          const q = new URLSearchParams({ order: item.order, name: item.name || "", kind: item.kind, id: item.id, taken: item.taken });
          r = await call("api/phone/photo?" + q, { method: "POST", headers: { "Content-Type": item.type || "image/jpeg" }, body: new Blob([item.bytes], { type: item.type || "image/jpeg" }) }, UPLOAD_MS);
        }
      } catch {
        state.link = "down";
        break;
      }
      if (r.status === 403) { state.link = "code"; break; }
      if (r.ok && item.link) {
        await queueDel(item.qid);
        state.link = "ok";
      } else if (r.ok) {
        await queueDel(item.qid);
        const counts = state.photos[item.order] || (state.photos[item.order] = { contents: 0, packed: 0, postoffice: 0, total: 0 });
        counts[item.kind] = (counts[item.kind] || 0) + 1;
        counts.total = (counts.total || 0) + 1;
        state.link = "ok";
      } else if (r.status === 400) {
        // The PC refused this one photo (not a picture it can save): keep it, say why, carry on with the rest.
        let msg = item.link ? "The PC couldn't use this tracking number." : "The PC couldn't save this photo.";
        try { msg = (await r.json()).error || msg; } catch { /* keep the default */ }
        if (item.error !== msg) await queuePut({ ...item, error: msg });
      } else {
        state.link = "down";
        break;
      }
    }
  } finally {
    state.sending = false;
    await loadQueue();
    render();
  }
}

async function loadQueue() {
  try {
    state.queue = (await queueAll()).map(({ bytes, ...rest }) => ({ ...rest, size: bytes ? bytes.byteLength : 0 }));
  } catch {
    state.queue = [];
  }
}

// ---------- taking photos ----------

/** A JPEG no bigger than MAX_SIDE, plus a small preview. Pictures the browser can't draw go as they are. */
async function prepare(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth, h = img.naturalHeight;
    const s = Math.min(1, MAX_SIDE / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * s));
    c.height = Math.max(1, Math.round(h * s));
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((resolve) => c.toBlob(resolve, "image/jpeg", 0.85));
    const t = document.createElement("canvas");
    const ts = 200 / Math.max(w, h);
    t.width = Math.max(1, Math.round(w * ts));
    t.height = Math.max(1, Math.round(h * ts));
    t.getContext("2d").drawImage(img, 0, 0, t.width, t.height);
    if (!blob) throw new Error("no jpeg");
    return { blob, thumb: t.toDataURL("image/jpeg", 0.7) };
  } catch {
    if (/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type)) return { blob: file, thumb: "" };
    throw new Error("not a photo");
  } finally {
    URL.revokeObjectURL(url);
  }
}

const orderLabel = (o) => (!o ? "" : o.id ? o.id
  : o.source === "mailer" ? `${o.name || "Mailer"} (…${String(o.tracking || "").slice(-4)})` : `${o.name} (${o.zip})`);
const idText = (o) => o.id || (o.source === "mailer" ? "No order # yet" : "Pasted address");

/** Put photos in the queue for every picked order, then try to send them (wait = until sent or failed). */
export async function addFiles(files, { wait = true } = {}) {
  const orders = state.orders.filter((o) => state.pick.has(o.key));
  if (!orders.length) { toast("Tap the orders in the photo first."); return 0; }
  let added = 0;
  for (const file of [...(files || [])]) {
    let prepared;
    try { prepared = await prepare(file); } catch { toast(`${file.name || "That file"} isn't a photo.`); continue; }
    const bytes = await prepared.blob.arrayBuffer();
    const id = newId(), taken = localStamp(), now = Date.now();
    for (const [i, o] of orders.entries()) {
      await queuePut({ qid: `${id}|${o.key}`, id, order: o.key, name: o.name || "", label: orderLabel(o), kind: state.kind, taken,
        type: prepared.blob.type || "image/jpeg", bytes, created: now + i, error: "" });
    }
    state.recent.unshift({ id, kind: state.kind, taken, thumb: prepared.thumb, labels: orders.map(orderLabel).join(", "), n: orders.length });
    added++;
  }
  state.recent = state.recent.slice(0, MAX_RECENT);
  lsSet(LS.recent, state.recent.map((r, i) => (i < 20 ? r : { ...r, thumb: "" })));
  if (added && state.kind === "postoffice") {
    // Handed in: the PC marks these orders shipped when the photo arrives. Show it here already.
    for (const o of orders) if (!o.shipped) o.shipped = localStamp().slice(0, 10);
    lsSet(LS.orders, { orders: state.orders, photos: state.photos, updated: state.updated });
  }
  await loadQueue();
  render();
  if (added) toast(`${plural(added, "photo")} added for ${plural(orders.length, "order")}.`);
  if (wait) await pump(); else pump();
  return added;
}

async function forget(id) {
  for (const item of state.queue.filter((q) => q.id === id)) await queueDel(item.qid);
  state.recent = state.recent.filter((r) => r.id !== id);
  lsSet(LS.recent, state.recent);
  await loadQueue();
  render();
}

// ---------- scanning: order QR codes and tracking barcodes ----------

export const QR_PREFIX = "SHIPDESK:";   // render.js ORDER_QR_PREFIX
const ZXING = new URL("../vendor/zxing-library-0.21.3.min.js", import.meta.url).href;
const SCAN_MS = 90;                     // pause between two looks at the camera picture
const SCAN_SIDE = 1280;                 // longest side of a still picture's slow fallback look
const SAME_CODE_MS = 2500;              // the same code seen again within this long is the same scan
const KEEP_CAMERA_MS = 5 * 60 * 1000;   // after Done the camera stays ready this long: opening again doesn't ask again
const compact = (s) => String(s || "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();

/**
 * What a scanned code means: { type: "order", key } (Ship Desk's own QR), { type: "tracking", tracking, carrier }
 * (a shipping label's barcode; USPS labels hold "420" + ZIP in front of the number) or { type: "text", text }.
 */
export function parseScan(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  if (raw.toUpperCase().startsWith(QR_PREFIX)) {
    const key = raw.slice(QR_PREFIX.length).trim();
    // ("__proto__" & co. aren't order keys: the PC would read them as every order. Audit 2026-10-25.)
    return key && !["__proto__", "constructor", "prototype"].includes(key) ? { type: "order", key } : null;
  }
  const t = compact(raw.replace(/^\]C1/, "")); // "]C1" = some readers' GS1-128 marker
  const usps = /^420(?:\d{5}|\d{9})(9\d{19,21})$/.exec(t);
  if (usps) return { type: "tracking", tracking: usps[1], carrier: "USPS" };
  if (/^9\d{19,21}$/.test(t) || /^[A-Z]{2}\d{9}US$/.test(t)) return { type: "tracking", tracking: t, carrier: "USPS" };
  if (/^1Z[0-9A-Z]{16}$/.test(t)) return { type: "tracking", tracking: t, carrier: "UPS" };
  if (/^\d{12,34}$/.test(t)) return { type: "tracking", tracking: t, carrier: "" };
  return { type: "text", text: raw };
}

/** The order with this tracking number (either one may carry extra digits in front, as FedEx barcodes do). */
export function orderForTracking(tracking) {
  const t = compact(tracking);
  if (t.length < 10) return null;
  return state.orders.find((o) => {
    const ot = compact(o.tracking);
    return ot.length >= 10 && (ot === t || t.endsWith(ot) || ot.endsWith(t));
  }) || null;
}

let zxingLoad = null;
function loadZxing() {
  if (window.ZXing) return Promise.resolve(window.ZXing);
  zxingLoad = zxingLoad || new Promise((resolve, reject) => {
    const sc = document.createElement("script");
    sc.src = ZXING;
    sc.onload = () => (window.ZXing ? resolve(window.ZXing) : reject(new Error("no reader")));
    sc.onerror = () => { zxingLoad = null; reject(new Error("The barcode reader didn't load.")); };
    document.head.append(sc);
  });
  return zxingLoad;
}

let reader = null;
/**
 * The text of a QR code or Code 128 barcode in this canvas, or "" when there is none. turn: "no" looks only at
 * the picture as it is, "yes" only at it turned a quarter (a barcode held sideways), "both" at both.
 */
export async function decodeCanvas(canvas, turn = "both") {
  if (turn !== "yes") {
    const text = (await decodeFrame(canvas, canvas.width, canvas.height)) || (await decodeUseful(canvas));
    if (text || turn === "no") return text;
  }
  const t = document.createElement("canvas");
  t.width = canvas.height;
  t.height = canvas.width;
  const g = t.getContext("2d", { willReadFrequently: true });
  g.translate(t.width, 0);
  g.rotate(Math.PI / 2);
  g.drawImage(canvas, 0, 0);
  return decodeUseful(t);
}

// A code Ship Desk can use: its own order QR, a tracking number, or an order # it knows.
function useful(text) {
  const s = parseScan(text);
  if (!s) return false;
  if (s.type !== "text") return true;
  const id = compact(s.text);
  return state.orders.some((o) => o.id && compact(o.id) === id);
}

// The reader finds one code per look. A label can carry two (the order's and the shop link), so when the
// one found isn't useful, cover it with white and look again.
async function decodeUseful(canvas, tries = 3) {
  let first = "", work = canvas;
  for (let i = 0; i < tries; i++) {
    const r = await decodeOnce(work);
    if (!r) break;
    if (useful(r.text)) return r.text;
    first = first || r.text;
    if (!r.points.length) break;
    if (work === canvas) {
      work = document.createElement("canvas");
      work.width = canvas.width;
      work.height = canvas.height;
      work.getContext("2d", { willReadFrequently: true }).drawImage(canvas, 0, 0);
    }
    const xs = r.points.map((p) => p.x), ys = r.points.map((p) => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const pad = Math.max(12, (x1 - x0) * 0.3, (y1 - y0) * 0.3);
    const g = work.getContext("2d", { willReadFrequently: true });
    g.fillStyle = "#fff";
    g.fillRect(x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad);
  }
  return first;
}

async function decodeOnce(canvas) {
  const Z = await loadZxing();
  if (!reader) {
    const hints = new Map();
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.QR_CODE, Z.BarcodeFormat.CODE_128]);
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    reader = new Z.MultiFormatReader();
    reader.setHints(hints);
  }
  try {
    const bitmap = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas)));
    const r = reader.decodeWithState(bitmap);
    const points = (r.getResultPoints() || []).filter(Boolean).map((p) => ({ x: p.getX(), y: p.getY() }));
    return r.getText() ? { text: r.getText(), points } : null;
  } catch {
    return null; // nothing readable in this picture
  } finally {
    reader.reset();
  }
}

// ---------- one look at the camera picture ----------
// A tracking barcode only needs sharpness along its length, so it's read from two strips through the middle of
// the picture at full camera sharpness, squashed the other way (small, so quick): one across, one up and down
// for a barcode held sideways. The 1D reader also tries each strip backwards (upside down). A QR code is read
// from the whole picture made smaller.

const STRIP_ROWS = 192;   // a strip is squashed to this many rows
const STRIP_MAX = 2560;   // ...and at most this long
const QR_SIDE = 1024;     // longest side of the picture the QR reader looks at
const strips = { across: null, upDown: null, qr: null, frame: null };
let reader1D = null;

function strip(src, w, h, across) {
  const key = across ? "across" : "upDown";
  const c = strips[key] || (strips[key] = document.createElement("canvas"));
  const len = Math.min(across ? w : h, STRIP_MAX);
  if (c.width !== len) c.width = len;
  if (c.height !== STRIP_ROWS) c.height = STRIP_ROWS;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.setTransform(1, 0, 0, 1, 0, 0);
  if (across) {
    // The middle 80% of the picture's height, full width.
    g.drawImage(src, 0, h * 0.1, w, h * 0.8, 0, 0, len, STRIP_ROWS);
  } else {
    // The middle 80% of its width, full height, turned a quarter so the barcode runs along the strip.
    const sw = w * 0.8;
    g.setTransform(0, -STRIP_ROWS / sw, len / h, 0, 0, STRIP_ROWS);
    g.drawImage(src, w * 0.1, 0, sw, h, 0, 0, sw, h);
    g.setTransform(1, 0, 0, 1, 0, 0);
  }
  return c;
}

// The 1D reader normally decides black/white over a whole row at once, so a dark mailer beside the white label
// throws it off (it only read once the label filled the picture). Here each row comes from the picture
// thresholded patch by patch (HybridBinarizer's matrix) instead.
function localRows(Z, canvas) {
  const hb = new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas));
  let matrix = null;
  hb.getBlackRow = (y, row) => (matrix || (matrix = hb.getBlackMatrix())).getRow(y, row);
  return new Z.BinaryBitmap(hb);
}

function read1D(Z, canvas) {
  if (!reader1D) reader1D = new Z.Code128Reader();
  try {
    return reader1D.decode(localRows(Z, canvas), new Map([[Z.DecodeHintType.TRY_HARDER, true]])).getText() || "";
  } catch {
    return "";
  } finally {
    reader1D.reset();
  }
}

// The main reader: zxing-cpp compiled to WebAssembly (zxing-wasm). Measured on 96 phone-like pictures of a
// tracking barcode (small to large, soft, tilted, on white / grey / kraft mailers) it read 50, against 15 for
// the old JavaScript look and 24 for the JavaScript strips above, in less time. It finds every code in the
// picture at once and turns sideways ones itself. Phones where it can't start use the JavaScript reader.
const WASM_JS = new URL("../vendor/zxing-wasm-3.1.6/reader.js", import.meta.url).href;
const WASM_BIN = new URL("../vendor/zxing-wasm-3.1.6/zxing_reader.wasm", import.meta.url).href;
const FRAME_SIDE = 1920;  // longest side of the picture the main reader looks at
let wasmLoad = null;
// wasm: tests switch the main reader off to check the JavaScript one. used: which one read the last picture.
export const readers = { wasm: true, used: "" };

function loadWasm() {
  if (!readers.wasm || typeof WebAssembly !== "object") return Promise.resolve(null);
  wasmLoad = wasmLoad || new Promise((resolve, reject) => {
    if (window.ZXingWASM) { resolve(); return; }
    const sc = document.createElement("script");
    sc.src = WASM_JS;
    sc.onload = resolve;
    sc.onerror = reject;
    document.head.append(sc);
  }).then(async () => {
    await window.ZXingWASM.prepareZXingModule({ fireImmediately: true,
      overrides: { locateFile: (path, prefix) => (path.endsWith(".wasm") ? WASM_BIN : prefix + path) } });
    return window.ZXingWASM;
  }).catch(() => null);
  return wasmLoad;
}

// Every code the main reader finds in the picture, or null when it isn't available.
async function readAll(src, w, h) {
  const W = await loadWasm();
  if (!W) return null;
  const c = toCanvas(src, w, h, FRAME_SIDE, strips.frame || (strips.frame = document.createElement("canvas")));
  try {
    const found = await W.readBarcodes(c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, c.width, c.height),
      { formats: ["QRCode", "Code128"], tryHarder: true, maxNumberOfSymbols: 4 });
    return found.filter((r) => r.isValid !== false && r.text).map((r) => r.text);
  } catch {
    return null;
  }
}

/** The code in one picture (a video frame, photo or canvas of w x h): a tracking barcode or a QR code, or "". */
export async function decodeFrame(src, w, h) {
  const all = await readAll(src, w, h);
  readers.used = all ? "wasm" : "js";
  if (all) return all.find(useful) || all[0] || "";
  const Z = await loadZxing();
  for (const across of [true, false]) {
    const text = read1D(Z, strip(src, w, h, across));
    if (text && useful(text)) return text;
  }
  return decodeUseful(toCanvas(src, w, h, QR_SIDE, strips.qr || (strips.qr = document.createElement("canvas"))));
}

// Draw a picture (video frame or photo) onto a canvas no bigger than `side`.
function toCanvas(src, w, h, side = SCAN_SIDE, c = document.createElement("canvas")) {
  const s = Math.min(1, side / Math.max(w, h));
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  c.getContext("2d", { willReadFrequently: true }).drawImage(src, 0, 0, c.width, c.height);
  return c;
}

export const scan = {
  open: false,
  found: [],        // order keys picked by scanning, in order
  ask: null,        // { tracking, carrier }: a tracking number no order has yet
  askSearch: "",
  msg: "",
  stream: null,     // the camera, kept a while after Done (see KEEP_CAMERA_MS)
  timer: 0,
  keepTimer: 0,
  last: "", lastAt: 0,
};

function scanSay(msg) {
  scan.msg = msg;
  const m = $("#scan-msg");
  if (m) m.textContent = msg;
}

function hit() {
  const v = $("#scanner .scan-view");
  if (v) { v.classList.add("hit"); setTimeout(() => v.classList.remove("hit"), 450); }
  try { if (navigator.vibrate) navigator.vibrate(60); } catch { /* not on iPhone */ }
}

// An order the phone's list doesn't have yet (printed after the phone last heard from the PC).
function orderFromKey(key) {
  if (key.startsWith("paste:")) {
    const [who, zip] = key.slice(6).split("|");
    return { key, id: "", source: "paste", name: who.replace(/\b\w/g, (c) => c.toUpperCase()), city: "", state: "", zip: zip || "", scanned: true };
  }
  return { key, id: key, source: "csv", name: "", city: "", state: "", zip: "", scanned: true };
}

function addFound(o) {
  if (!state.orders.some((x) => x.key === o.key)) state.orders.push(o);
  if (scan.found.includes(o.key)) { scanSay(`${orderLabel(o)} is already scanned.`); return false; }
  scan.found.push(o.key);
  hit();
  scanSay(`Got ${orderLabel(o)}${o.name && o.id ? " · " + o.name : ""}. Scan the next one, or take the photo.`);
  renderScan();
  return true;
}

/** Act on one scanned code (from the camera, a photo, or a test). Returns what it was. */
export function handleScan(text) {
  const now = Date.now();
  if (text === scan.last && now - scan.lastAt < SAME_CODE_MS) return null;
  scan.last = text;
  scan.lastAt = now;
  const s = parseScan(text);
  if (!s) return null;
  if (s.type === "order") {
    addFound(state.orders.find((o) => o.key === s.key) || orderFromKey(s.key));
  } else if (s.type === "tracking") {
    const o = orderForTracking(s.tracking);
    if (o) addFound(o);
    else if (!scan.ask || scan.ask.tracking !== s.tracking) {
      scan.ask = { tracking: s.tracking, carrier: s.carrier };
      scan.askSearch = "";
      hit();
      scanSay("");
      renderScan();
    }
  } else {
    const id = compact(s.text);
    const o = id && state.orders.find((x) => x.id && compact(x.id) === id);
    if (o) addFound(o);
    else scanSay("That code isn't a Ship Desk QR code or a tracking barcode.");
  }
  return s;
}

/**
 * A mailer whose order isn't in the list: make a new entry from its tracking number and the buyer's name (the
 * TCGplayer order # can be added now or later in History on the PC). Returns the new entry's key.
 */
export async function newMailerEntry(tracking, carrier = "", name = "", orderId = "") {
  const id = String(orderId || "").trim().toUpperCase();
  const existing = id && state.orders.find((o) => o.id && compact(o.id) === compact(id));
  if (existing) { await linkTracking(existing.key, tracking, carrier); return existing.key; }
  const o = id
    ? { key: id, id, source: "csv", name: String(name || "").trim(), city: "", state: "", zip: "", local: true }
    : { key: "mailer:" + compact(tracking), id: "", source: "mailer", name: String(name || "").trim(), city: "", state: "", zip: "", local: true };
  if (!state.orders.some((x) => x.key === o.key)) state.orders.push(o);
  await linkTracking(o.key, tracking, carrier);
  return o.key;
}

/** Give a scanned tracking number to an order: kept on the phone until the PC has it, like a photo. */
export async function linkTracking(key, tracking, carrier = "") {
  const o = state.orders.find((x) => x.key === key);
  if (!o) return false;
  const id = newId();
  await queuePut({ qid: "link|" + id, link: true, id, order: key, name: o.name || "", label: orderLabel(o), tracking, carrier,
    taken: localStamp(), created: Date.now(), error: "" });
  o.tracking = tracking;
  o.shipped = o.shipped || localStamp().slice(0, 10);
  lsSet(LS.orders, { orders: state.orders, photos: state.photos, updated: state.updated });
  scan.ask = null;
  addFound(o);
  toast(`Tracking number added to ${orderLabel(o)}.`);
  await loadQueue();
  render();
  pump();
  return true;
}

const live = (s) => !!s && s.getVideoTracks().some((t) => t.readyState === "live");

async function startCamera() {
  const video = $("#scan-video");
  clearTimeout(scan.keepTimer);
  // iPhones ask for the camera on every request: keep using the stream we already have.
  let stream = live(scan.stream) ? scan.stream : null;
  if (!stream) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("no camera");
    stream = await navigator.mediaDevices.getUserMedia({ audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 2560 }, height: { ideal: 1920 } } });
  }
  if (!scan.open) { scan.stream = stream; stopCamera(); return; }
  scan.stream = stream;
  video.srcObject = stream;
  video.setAttribute("playsinline", "");
  video.muted = true;
  await video.play().catch(() => {});
  if (!(await loadWasm())) await loadZxing();
  const look = async () => {
    if (!scan.open || scan.stream !== stream) return;
    if (video.readyState >= 2 && video.videoWidth && !scan.ask) {
      const text = await decodeFrame(video, video.videoWidth, video.videoHeight);
      if (text && scan.open) handleScan(text);
    }
    scan.timer = setTimeout(look, SCAN_MS);
  };
  look();
}

/** Stop looking at the camera. now = switch it off; otherwise it stays ready for KEEP_CAMERA_MS. */
function stopCamera(now = false) {
  clearTimeout(scan.timer);
  clearTimeout(scan.keepTimer);
  const v = $("#scan-video");
  if (v) v.srcObject = null;
  const off = () => {
    if (scan.open) return;
    if (scan.stream) scan.stream.getTracks().forEach((t) => t.stop());
    scan.stream = null;
  };
  if (now) off(); else scan.keepTimer = setTimeout(off, KEEP_CAMERA_MS);
}

// ---------- the camera: several photos in a row, turned the way the phone is held ----------

const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const TURNS = { 0: "upright", 90: "turned right", 180: "upside down", 270: "turned left" };
export const turn = { auto: 0, manual: null, listening: false };

// The phone's tilt sensor says how it is held. Lying flat (shooting straight down at the desk) says nothing,
// so the last way it was held is kept, like the iPhone camera does.
export function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null || a.y == null) return;
  const gx = IOS ? a.x : -a.x, gy = IOS ? a.y : -a.y; // iPhones report gravity, Android the opposite
  if (Math.hypot(gx, gy) < 3.5) return;
  const theta = (Math.atan2(gx, -gy) * 180) / Math.PI;
  const q = Math.round(theta / 90);
  if (Math.abs(theta - q * 90) > 30) return;
  const rot = (((q * 90) % 360) + 360) % 360;
  if (rot !== turn.auto) { turn.auto = rot; renderTurn(); }
}

function startMotion() {
  if (turn.listening || !window.DeviceMotionEvent) return;
  const listen = () => { if (!turn.listening) { window.addEventListener("devicemotion", onMotion); turn.listening = true; } };
  try {
    // iPhones ask once; this has to run straight from the tap.
    if (typeof DeviceMotionEvent.requestPermission === "function") DeviceMotionEvent.requestPermission().then((r) => { if (r === "granted") listen(); }).catch(() => {});
    else listen();
  } catch { /* no tilt sensor: photos stay as the camera sees them */ }
}

/** How many degrees (clockwise) the next camera photo is turned. */
export function photoTurn() {
  if (turn.manual != null) return turn.manual;
  if (window.innerWidth > window.innerHeight) return 0; // the page turned with the phone: the picture already did
  return turn.auto;
}

function renderTurn() {
  const b = $("#cam-turn");
  if (!b) return;
  const t = photoTurn();
  b.textContent = `↻ Photo ${TURNS[t]}${turn.manual == null ? " (auto)" : ""}`;
}

// The camera picture as a still, at most MAX_SIDE, turned `deg` degrees clockwise.
function grab(video, deg) {
  const s = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
  const w = Math.round(video.videoWidth * s), h = Math.round(video.videoHeight * s);
  const c = document.createElement("canvas");
  c.width = deg % 180 ? h : w;
  c.height = deg % 180 ? w : h;
  const g = c.getContext("2d");
  g.translate(c.width / 2, c.height / 2);
  g.rotate((deg * Math.PI) / 180);
  g.drawImage(video, -w / 2, -h / 2, w, h);
  return c;
}

/** The shutter: one photo for every order on the camera screen, then straight back to the camera. */
export async function shoot() {
  const video = $("#scan-video");
  if (!scan.found.length) { scanSay("Scan a label first, or pick the orders on the main screen."); return 0; }
  if (!scan.stream || !video.videoWidth) { scanSay("The camera isn't ready yet."); return 0; }
  const deg = photoTurn();
  const blob = await new Promise((r) => grab(video, deg).toBlob(r, "image/jpeg", 0.92));
  const v = $("#scanner .scan-view");
  v.classList.add("flash");
  setTimeout(() => v.classList.remove("flash"), 120);
  if (!blob) return 0;
  state.pick = new Set(scan.found);
  lsSet(LS.pick, [...state.pick]);
  const added = await addFiles([new File([blob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" })], { wait: false });
  if (added) {
    const r = state.recent[0];
    scan.shots.unshift({ id: r.id, kind: r.kind, thumb: r.thumb });
    const k = KINDS.find((x) => x.id === state.kind);
    const n = scan.shots.filter((s) => s.kind === state.kind).length;
    scanSay(`${k.label} photo ${n} saved for ${r.labels}${state.kind === "postoffice" ? " (marked shipped)" : ""}. Take another, or switch the type above.`);
    renderScan();
  }
  return added;
}

/** Open the camera screen: it reads codes (which pick orders) and takes photos until Done. */
export async function openScanner(startWith = []) {
  startMotion();
  scan.open = true;
  scan.found = [...startWith];
  scan.shots = [];
  scan.ask = null;
  scan.last = "";
  $("#scanner").hidden = false;
  document.body.classList.add("scanning");
  $("#scan-still").hidden = true;
  scanSay("Starting the camera…");
  renderScan();
  renderTurn();
  try {
    await startCamera();
    if (scan.open) {
      scanSay(scan.found.length ? "Take the photos (as many as you like), or scan more labels."
        : "Point at the QR code on the label, envelope or slip, or at the tracking barcode. Then take the photos.");
      renderScan();
    }
  } catch {
    if (!scan.open) return;
    $("#scan-still").hidden = false;
    scanSay("The camera didn't start. Tap “Take a picture of the code” or “iPhone camera” instead, or allow the camera for this page.");
    renderScan();
  }
}

/** Close the scanner; the scanned orders become the picked ones. */
export function closeScanner(keep = true) {
  scan.open = false;
  stopCamera();
  $("#scanner").hidden = true;
  document.body.classList.remove("scanning");
  if (keep && scan.found.length) {
    state.pick = new Set(scan.found);
    lsSet(LS.pick, [...state.pick]);
    toast(`${plural(scan.found.length, "order")} picked. ${KINDS.find((k) => k.id === state.kind).label} photo next.`);
  }
  scan.ask = null;
  render();
}

/** Read a code from a still photo (when the live camera isn't available). */
export async function scanFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const text = await decodeCanvas(toCanvas(img, img.naturalWidth, img.naturalHeight, 2000));
    if (!text) { scanSay("No code found in that picture. Get closer, hold it flat and try again."); return null; }
    scan.last = "";
    return handleScan(text);
  } catch {
    scanSay("That picture couldn't be read.");
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function askChoices() {
  const q = scan.askSearch.trim().toLowerCase();
  const rank = (o) => (o.inBatch ? "2" : "1") + (o.labelled || "");
  return state.orders.filter((o) => !o.tracking && (q ? [o.id, o.name, o.city, o.zip].some((v) => String(v || "").toLowerCase().includes(q)) : !o.shipped))
    .sort((a, b) => rank(b).localeCompare(rank(a)) || String(a.id || a.name).localeCompare(String(b.id || b.name)))
    .slice(0, 60);
}

function renderScan() {
  if (!$("#scanner") || $("#scanner").hidden) return;
  const byKey = new Map(state.orders.map((o) => [o.key, o]));
  $("#scan-found").replaceChildren(...scan.found.map((k) => {
    const o = byKey.get(k) || { key: k, id: k };
    return el("li", { class: "chip" }, el("span", { text: orderLabel(o) }),
      el("button", { type: "button", class: "chip-x", "data-unscan": k, "aria-label": `Remove ${orderLabel(o)}`, text: "×" }));
  }));
  const n = scan.found.length;
  $("#scan-done").textContent = n ? `Done (${n})` : "Cancel";
  $("#scan-photo").disabled = !n;
  $("#cam-shutter").disabled = !n || !scan.stream;
  for (const b of document.querySelectorAll("#cam-kinds button")) b.setAttribute("aria-pressed", String(b.dataset.kind === state.kind));
  const short = { contents: "C", packed: "P", postoffice: "PO" };
  $("#cam-shots").replaceChildren(...(scan.shots || []).slice(0, 30).map((s) => el("li", {},
    s.thumb ? el("img", { src: s.thumb, alt: `${(KINDS.find((k) => k.id === s.kind) || {}).label} photo` }) : el("span", { class: "nothumb", text: "📷" }),
    el("span", { class: "k", "aria-hidden": "true", text: short[s.kind] || "" }))));
  const ask = $("#scan-ask");
  ask.hidden = !scan.ask;
  $("#scanner .scan-view").hidden = !!scan.ask;
  $("#scanner").classList.toggle("asking", !!scan.ask);
  if (!scan.ask) return;
  $("#scan-ask-text").textContent = `Tracking ${scan.ask.tracking} isn't on an order yet.`;
  if (scan.askFor !== scan.ask.tracking) {
    scan.askFor = scan.ask.tracking;
    $("#scan-new-name").value = "";
    $("#scan-new-order").value = "";
  }
  const list = askChoices();
  $("#scan-ask-list").replaceChildren(...list.map((o) => el("li", {},
    el("button", { type: "button", class: "order ask-pick", "data-link": o.key },
      el("span", { class: "o-main" },
        el("span", { class: "o-id", text: idText(o) }),
        el("span", { class: "o-who", text: [o.name, [o.city, o.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ") }))))));
  $("#scan-ask-none").hidden = list.length > 0;
}

// ---------- the page ----------

const searched = (o) => {
  const q = state.search.trim().toLowerCase();
  return !q || [o.id, o.name, o.city, o.zip, o.tracking].some((v) => String(v || "").toLowerCase().includes(q));
};

function visibleOrders() {
  const list = state.orders.filter((o) => (state.filter === "all" || !o.shipped || state.pick.has(o.key)) && searched(o));
  // Labelled most recently first, then the PC's current batch, then the rest.
  const rank = (o) => (o.labelled ? "2" + o.labelled : o.inBatch ? "1" : "0");
  return list.sort((a, b) => rank(b).localeCompare(rank(a)) || String(a.id || a.name).localeCompare(String(b.id || b.name)));
}

const waitingFor = (key) => state.queue.filter((q) => q.order === key && !q.link).length;

/** Photos of each kind an order has: saved on the PC plus waiting on this phone. */
function photoCounts(key) {
  const saved = state.photos[key] || {};
  const c = { contents: saved.contents || 0, packed: saved.packed || 0, postoffice: saved.postoffice || 0 };
  for (const q of state.queue) if (q.order === key && !q.link && q.kind in c) c[q.kind]++;
  return c;
}

/** The photo an order needs next ("contents" | "packed" | "postoffice"), or "" when it isn't on the to-do list. */
export function nextPhoto(o, now = new Date()) {
  if (!o || o.shipped) return "";
  const c = photoCounts(o.key);
  if (c.postoffice) return "";
  const cutoff = localStamp(new Date(now.getTime() - TODO_DAYS * 864e5)).slice(0, 10);
  if (!o.inBatch && !(o.labelled && String(o.labelled).slice(0, 10) >= cutoff) && !waitingFor(o.key)) return "";
  return c.packed ? "postoffice" : c.contents ? "packed" : "contents";
}

/** The to-do list: { contents: [orders], packed: [...], postoffice: [...] }, newest label first. */
export function todoGroups() {
  const groups = Object.fromEntries(KINDS.map((k) => [k.id, []]));
  for (const o of state.orders) {
    const next = nextPhoto(o);
    if (next && searched(o)) groups[next].push(o);
  }
  const rank = (o) => (o.labelled ? "2" + o.labelled : o.inBatch ? "1" : "0");
  for (const list of Object.values(groups)) list.sort((a, b) => rank(b).localeCompare(rank(a)) || String(a.id || a.name).localeCompare(String(b.id || b.name)));
  return groups;
}

const TODO_HEAD = { contents: "Contents photo next", packed: "Packed photo next", postoffice: "To the post office" };

function todoRows() {
  const groups = todoGroups();
  const rows = [];
  // Picked orders that aren't on the list (shipped, a mailer just scanned) stay in sight at the top.
  const listed = new Set(Object.values(groups).flat().map((o) => o.key));
  const picked = state.orders.filter((o) => state.pick.has(o.key) && !listed.has(o.key) && searched(o));
  if (picked.length) {
    rows.push(el("li", { class: "todo-head" }, el("h3", {}, "Picked ", el("span", { class: "count", text: String(picked.length) }))));
    for (const o of picked) rows.push(orderRow(o));
  }
  for (const k of KINDS) {
    const list = groups[k.id];
    if (!list.length) continue;
    rows.push(el("li", { class: "todo-head" },
      el("h3", {}, TODO_HEAD[k.id], " ", el("span", { class: "count", text: String(list.length) })),
      k.id === "postoffice" && list.length > 1
        ? el("button", { type: "button", class: "btn primary small shoot-all", "data-shoot-all": k.id, text: `📷 One photo for all ${list.length}` }) : null));
    for (const o of list) rows.push(orderRow(o, k.id));
  }
  return rows;
}

function orderRow(o, next = "") {
  const on = state.pick.has(o.key);
  const saved = (state.photos[o.key] || {}).total || 0;
  const waiting = waitingFor(o.key);
  const where = [o.city, o.state].filter(Boolean).join(", ");
  const tags = [
    o.shipped ? el("span", { class: "tag shipped", text: "Shipped " + String(o.shipped).slice(5, 10) }) : null,
    !o.shipped && o.labelled ? el("span", { class: "tag", text: "Label " + String(o.labelled).slice(5, 10) }) : null,
    !o.labelled && o.inBatch ? el("span", { class: "tag", text: "On the PC now" }) : null,
    o.tracking ? el("span", { class: "tag", text: "Tracking …" + String(o.tracking).slice(-6) }) : null,
    saved ? el("span", { class: "tag photos", text: `${saved} saved` }) : null,
    waiting ? el("span", { class: "tag waiting", text: `${waiting} waiting` }) : null,
  ];
  const kind = next && KINDS.find((k) => k.id === next);
  return el("li", { class: next ? "todo" : "" },
    el("label", { class: "order" + (on ? " on" : "") },
      el("input", { type: "checkbox", class: "pick", value: o.key, checked: on }),
      el("span", { class: "o-main" },
        el("span", { class: "o-id", text: idText(o) }),
        el("span", { class: "o-who", text: [o.name, where].filter(Boolean).join(" · ") }),
        el("span", { class: "tags" }, tags))),
    kind ? el("button", { type: "button", class: "btn secondary small shoot", "data-shoot": o.key, "data-next": next,
      "aria-label": `${kind.label} photo for ${idText(o)}` }, el("span", { "aria-hidden": "true", text: "📷" }), el("span", { text: kind.label })) : null);
}

// Photos waiting (one photo for three orders is one photo, sent three times).
const waitingPhotos = () => new Set(state.queue.filter((q) => !q.link).map((q) => q.id)).size;

function statusText() {
  const n = waitingPhotos();
  const wait = n ? ` · ${n} waiting` : "";
  // ("Sending" only while photos are actually going: a check with nothing waiting stays "Connected to PC".)
  const busy = state.sending && n > 0;
  if (state.link === "ok") return [busy ? "ok busy" : "ok", busy ? `Sending${wait}…` : n ? "Connected" + wait : "Connected to PC"];
  if (state.link === "code") return ["bad", state.code ? "Code out of date" : "Not connected"];
  if (state.link === "down") return ["down", "PC offline" + wait];
  return ["", "Checking…"];
}

export function render() {
  const [cls, txt] = statusText();
  const st = $("#status");
  st.className = "status " + cls;
  st.querySelector(".txt").textContent = txt;

  const paired = !!state.code && state.link !== "code";
  $("#pair").hidden = paired;
  $("#work").hidden = !paired && !state.orders.length;
  $("#bar").hidden = $("#work").hidden;

  for (const b of document.querySelectorAll("#kinds button, #cam-kinds button")) b.setAttribute("aria-pressed", String(b.dataset.kind === state.kind));
  for (const b of document.querySelectorAll("#filters button")) b.setAttribute("aria-pressed", String(b.dataset.filter === state.filter));

  const rows = state.filter === "todo" ? todoRows() : visibleOrders().map((o) => orderRow(o));
  $("#orders").replaceChildren(...rows.slice(0, MAX_SHOWN));
  const empty = $("#orders-empty");
  empty.hidden = rows.length > 0;
  empty.textContent = !state.orders.length
    ? "No orders yet. On the PC, load your TCGplayer file in Ship Desk (or download labels) and they show up here."
    : state.search ? "No orders match your search."
      : state.filter === "todo" ? "Nothing to do: every order with a recent label is shipped or has its post office photo."
        : "Every order is shipped. Tap All to see them.";

  const picked = state.orders.filter((o) => state.pick.has(o.key));
  const kind = KINDS.find((k) => k.id === state.kind);
  $("#picked").textContent = picked.length
    ? `${kind.label} photo for ${picked.length === 1 ? orderLabel(picked[0]) : plural(picked.length, "order")}`
    : "Tap the orders in the photo";
  $("#btn-clear").hidden = !picked.length;
  $("#btn-cam").disabled = $("#btn-lib").disabled = !picked.length;

  renderRecent();
}

function renderRecent() {
  const card = $("#recent-card");
  card.hidden = !state.recent.length && !waitingPhotos();
  const n = waitingPhotos();
  const failed = new Set(state.queue.filter((q) => q.error && !q.link).map((q) => q.id)).size;
  $("#queue-note").textContent = !n ? "All saved on your PC (Ship Desk → History → Photos)."
    : state.link === "ok" ? `${plural(n, "photo")} sending to your PC…`
      : `${plural(n, "photo")} kept on this phone. ${n === 1 ? "It goes" : "They go"} to your PC by ${n === 1 ? "itself" : "themselves"} when Ship Desk can be reached (open this page again then).`
        + (failed ? ` ${failed} couldn't be saved: see below.` : "");
  const kindLabel = (id) => (KINDS.find((k) => k.id === id) || {}).label || id;
  $("#recent").replaceChildren(...state.recent.map((r) => {
    const items = state.queue.filter((q) => q.id === r.id);
    const err = items.find((q) => q.error);
    const status = err ? "error" : items.length ? "waiting" : "saved";
    return el("li", { class: "shot " + status },
      r.thumb ? el("img", { src: r.thumb, alt: "" }) : el("span", { class: "nothumb", "aria-hidden": "true", text: "📷" }),
      el("span", { class: "s-txt" },
        el("strong", { text: kindLabel(r.kind) }),
        el("span", { text: r.labels }),
        el("span", { class: "s-state", text: err ? err.error : items.length ? "Waiting to send" : "Saved on PC ✓" })),
      items.length ? el("button", { type: "button", class: "link danger", "data-forget": r.id, text: "Delete" }) : null);
  }));
}

function build() {
  $("#kinds").replaceChildren(...KINDS.map((k) => el("button", { type: "button", class: "kind", "data-kind": k.id, "aria-pressed": "false" },
    el("strong", { text: k.label }), el("span", { text: k.hint }))));
  $("#cam-kinds").replaceChildren(...KINDS.map((k) => el("button", { type: "button", "data-kind": k.id, "aria-pressed": "false", text: k.label })));
  $("#filters").replaceChildren(...FILTERS.map((f) => el("button", { type: "button", class: "filter", "data-filter": f.id, "aria-pressed": "false", text: f.label })));
}

function bind() {
  $("#cam-kinds").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-kind]");
    if (!b) return;
    state.kind = b.dataset.kind;
    lsSet(LS.kind, state.kind);
    render();
    renderScan();
  });
  $("#cam-shutter").addEventListener("click", () => shoot());
  $("#cam-turn").addEventListener("click", () => {
    // Each tap turns the next photos a quarter more; back at what the sensor says, it's automatic again.
    const next = (photoTurn() + 90) % 360;
    turn.manual = next === turn.auto && window.innerWidth <= window.innerHeight ? null : next;
    renderTurn();
  });
  $("#kinds").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-kind]");
    if (!b) return;
    state.kind = b.dataset.kind;
    lsSet(LS.kind, state.kind);
    render();
  });
  $("#filters").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-filter]");
    if (!b) return;
    state.filter = b.dataset.filter;
    lsSet(LS.filter, state.filter);
    render();
  });
  $("#search").addEventListener("input", (e) => { state.search = e.target.value; render(); });
  $("#orders").addEventListener("change", (e) => {
    const box = e.target.closest("input.pick");
    if (!box) return;
    if (box.checked) state.pick.add(box.value); else state.pick.delete(box.value);
    lsSet(LS.pick, [...state.pick]);
    render();
  });
  $("#btn-clear").addEventListener("click", () => { state.pick.clear(); lsSet(LS.pick, []); render(); });
  // To do: a camera button on an order (or "One photo for all" at the post office) picks it, sets the kind of photo
  // it needs next and opens the camera.
  $("#orders").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-shoot], button[data-shoot-all]");
    if (!b) return;
    const kind = b.dataset.next || b.dataset.shootAll;
    state.pick = new Set(b.dataset.shoot ? [b.dataset.shoot] : todoGroups()[kind].map((o) => o.key));
    state.kind = kind;
    lsSet(LS.pick, [...state.pick]);
    lsSet(LS.kind, state.kind);
    render();
    $("#btn-cam").click();
  });
  $("#btn-cam").addEventListener("click", () => {
    // The camera screen takes several photos in a row; without a camera there, the iPhone camera takes one.
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) openScanner([...state.pick]);
    else $("#in-cam").click();
  });
  $("#btn-lib").addEventListener("click", () => $("#in-lib").click());
  for (const id of ["#in-cam", "#in-lib"]) {
    $(id).addEventListener("change", async (e) => {
      const files = [...e.target.files];
      e.target.value = "";
      if (files.length) await addFiles(files);
    });
  }
  $("#btn-scan").addEventListener("click", () => openScanner());
  $("#scan-done").addEventListener("click", () => closeScanner(true));
  $("#scan-photo").addEventListener("click", () => { closeScanner(true); if (state.pick.size) $("#in-cam").click(); });
  $("#scan-still").addEventListener("click", () => $("#in-scan").click());
  $("#in-scan").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (file) await scanFile(file);
  });
  $("#scan-found").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-unscan]");
    if (!b) return;
    scan.found = scan.found.filter((k) => k !== b.dataset.unscan);
    renderScan();
  });
  $("#scan-ask-list").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-link]");
    if (b && scan.ask) linkTracking(b.dataset.link, scan.ask.tracking, scan.ask.carrier);
  });
  $("#scan-ask-search").addEventListener("input", (e) => { scan.askSearch = e.target.value; renderScan(); });
  $("#scan-new").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!scan.ask) return;
    const name = $("#scan-new-name").value.trim();
    if (!name) { toast("Type the buyer's name from the label first."); $("#scan-new-name").focus(); return; }
    await newMailerEntry(scan.ask.tracking, scan.ask.carrier, name, $("#scan-new-order").value);
  });
  $("#scan-ask-skip").addEventListener("click", () => { scan.ask = null; scanSay("Skipped. Scan the next code."); renderScan(); });
  $("#recent").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-forget]");
    if (b && window.confirm("Delete this photo from the phone? It hasn't reached your PC yet.")) forget(b.dataset.forget);
  });
  $("#pair-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const code = cleanCode($("#pair-code").value);
    if (code.length < 12) { toast("The code has 12 letters and numbers."); return; }
    setCode(code);
  });
  // Try again when the phone is back online or the page comes back to the front, and every little while.
  window.addEventListener("online", () => refresh());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
    else {
      if (scan.open) closeScanner(true);
      stopCamera(true); // don't keep the camera on in the background
    }
  });
  window.addEventListener("pageshow", (e) => { if (e.persisted) refresh(); });
  setInterval(() => {
    if (document.visibilityState !== "visible" || state.sending) return;
    const due = state.queue.length || state.link !== "ok" ? CHECK_MS : IDLE_MS;
    if (Date.now() - state.lastCheck >= due - 500) refresh();
  }, CHECK_MS);
}

function registerWorker() {
  // Offline copy of this page, so it opens at the post office too. Needs https (the Tailscale address).
  if (!window.isSecureContext || !("serviceWorker" in navigator) || window.top !== window) return;
  navigator.serviceWorker.register("phone-sw.js", { scope: "./phone" }).catch(() => { /* a bonus, not needed */ });
}

let started = false;
export async function init() {
  if (started) return api;
  started = true;
  loadState();
  build();
  bind();
  await loadQueue();
  render();
  registerWorker();
  window.shipdeskPhone = api;
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch { /* optional */ }
  refresh();
  return api;
}

export const api = { state, scan, turn, stopCamera, init, refresh, pump, addFiles, queueAll, setCode, render, parseScan, handleScan, linkTracking, newMailerEntry,
  shoot, photoTurn, onMotion, nextPhoto, todoGroups,
  openScanner, closeScanner, scanFile, decodeCanvas, decodeFrame, readers };

if (document.querySelector("[data-shipdesk-phone]")) init();
