// Phone photos: the server's phone/PC split, the Phone photos window, the phone page (phone.html) with its
// waiting-photo queue, the photos in History, and scanning (order QR codes, mailer tracking barcodes). tools/test.py fakes Tailscale and saves into a temp folder.
import { ok, eq } from "./runner.js";
import { KEYS, remove } from "../js/store.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for " + what);
    await sleep(40);
  }
}

const PC = { "X-Ship-Desk": "1" };
const VIA_TAILSCALE = { "X-Forwarded-For": "100.111.33.25", "Tailscale-User-Login": "someone@example.com" };
const PHONE_LS = ["code", "orders", "kind", "pick", "recent", "filter"].map((k) => "shipdesk.phone." + k);

function clearAll() {
  for (const k of Object.values(KEYS)) remove(k);
  for (const k of PHONE_LS) localStorage.removeItem(k);
}

function dropFrames() {
  for (const f of document.querySelectorAll("iframe.phone-test")) f.remove();
}

async function clearQueue() {
  dropFrames();
  await sleep(50);
  await new Promise((resolve) => {
    const r = indexedDB.deleteDatabase("shipdesk-phone");
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  });
}

async function frame(src, id) {
  const f = document.createElement("iframe");
  f.className = "phone-test";
  f.id = id;
  f.style.cssText = "width:420px;height:860px;border:1px solid #999";
  f.src = src;
  document.body.append(f);
  await waitFor(() => f.contentDocument && f.contentDocument.readyState === "complete", src);
  return f;
}

async function openApp(hash = "") {
  const f = await frame("../index.html" + hash, "app-frame");
  const win = await waitFor(() => f.contentWindow.shipdesk && f.contentWindow, "the app to start");
  win.shipdesk.state.output.saveTo = "downloads";
  win.HTMLAnchorElement.prototype.click = function () {}; // no real downloads
  const Orig = win.jspdf.jsPDF;
  function Quiet(...args) { const d = new Orig(...args); d.save = () => d; return d; }
  Object.assign(Quiet, Orig);
  Quiet.API = Orig.API;
  win.jspdf = { ...win.jspdf, jsPDF: Quiet };
  return { win, doc: f.contentDocument, app: win.shipdesk };
}

const link = async () => (await fetch("/api/phone-link", { headers: PC })).json();

async function openPhone(code) {
  const f = await frame("../phone.html" + (code ? "#k=" + code : ""), "phone-frame-" + Math.random().toString(36).slice(2));
  const win = await waitFor(() => f.contentWindow.shipdeskPhone && f.contentWindow, "the phone page to start");
  return { win, doc: f.contentDocument, phone: win.shipdeskPhone };
}

async function photoFile(name = "IMG_0001.png", w = 1200, h = 800) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.fillStyle = "#c9e4dd"; g.fillRect(0, 0, w, h);
  g.fillStyle = "#136f63"; g.fillRect(w / 4, h / 4, w / 2, h / 2);
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  return new File([blob], name, { type: "image/png" });
}

/** Pick orders on the phone the way a finger does (tick their boxes). */
function pick(doc, win, keys) {
  for (const key of keys) {
    const box = doc.querySelector(`#orders input.pick[value="${key}"]`);
    if (!box) throw new Error("order not listed on the phone: " + key);
    box.checked = !box.checked;
    box.dispatchEvent(new win.Event("change", { bubbles: true }));
  }
}

const photosOnPc = async () => (await (await fetch("/api/photos", { headers: PC })).json()).orders;
const sampleText = async () => (await fetch("../samples/tcgplayer-sample.csv")).text();

const tests = {
  "server: through Tailscale only the phone page and the phone API answer": async () => {
    const get = (path, headers = {}) => fetch(path, { headers: { ...VIA_TAILSCALE, ...headers }, cache: "no-store" });
    eq((await get("/index.html")).status, 404, "PC app page");
    eq((await get("/js/app.js")).status, 404, "PC app script");
    eq((await get("/samples/tcgplayer-sample.csv")).status, 404, "sample file");
    eq((await get("/phone.html")).status, 200, "phone page");
    eq((await get("/js/phone.js")).status, 200, "phone script");
    eq((await get("/vendor/zxing-library-0.21.3.min.js")).status, 200, "barcode reader");
    eq((await get("/vendor/zxing-wasm-3.1.6/reader.js")).status, 200, "main barcode reader");
    const bin = await get("/vendor/zxing-wasm-3.1.6/zxing_reader.wasm");
    eq([bin.status, bin.headers.get("Content-Type")], [200, "application/wasm"], "its compiled part");
    eq((await get("/vendor/jspdf.umd.min.js")).status, 404, "other libraries");
    ok((await get("/")).url.endsWith("/phone.html"), "the bare address goes to the phone page");
    eq((await get("/api/phone-link", PC)).status, 403, "pairing code is PC-only");
    eq((await get("/api/photos", PC)).status, 403, "photo list is PC-only");
    eq((await fetch("/api/save?kind=labels&name=a.pdf", { method: "POST", headers: { ...VIA_TAILSCALE, ...PC }, body: "x" })).status, 403, "saving files is PC-only");
    eq((await get("/api/phone/orders")).status, 403, "no pairing code");
    eq((await get("/api/phone/orders", { "X-Ship-Desk-Key": "AAAABBBBCCCC" })).status, 403, "wrong pairing code");
    eq((await fetch("/api/phone-link")).status, 403, "PC page needs the X-Ship-Desk header too");
  },

  "PC: the Phone photos window switches phone access on and shows the QR code and pairing code": async () => {
    clearAll();
    const { win, doc } = await openApp();
    win.confirm = () => true;
    doc.querySelector("#btn-phone").click();
    ok(doc.querySelector("#phone-dialog").open, "window open");
    const on = await waitFor(() => doc.querySelector('#phone-body button[data-phone="on"]'), "Switch on button");
    ok(doc.querySelector("#phone-body").textContent.includes("only your own Tailscale devices"), "says who can open it");
    on.click();
    await waitFor(() => doc.querySelector("#phone-body svg.qr"), "QR code");
    const text = doc.querySelector("#phone-body").textContent;
    ok(/https:\/\/test-pc\.example\.ts\.net:\d+\/phone\.html/.test(text), "address shown");
    const code = doc.querySelector(".pair-code").textContent;
    ok(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code), "pairing code: " + code);
    eq((await link()).ready, true, "server says ready");
    doc.querySelector('#phone-body button[data-phone="newcode"]').click();
    await waitFor(() => doc.querySelector(".pair-code") && doc.querySelector(".pair-code").textContent !== code, "a new code");
    doc.querySelector('#phone-body button[data-phone="off"]').click();
    await waitFor(() => doc.querySelector('#phone-body button[data-phone="on"]'), "off again");
    doc.querySelector('#phone-body button[data-phone="on"]').click();
    await waitFor(() => doc.querySelector("#phone-body svg.qr"), "on again");
    doc.querySelector("#phone-dialog [data-close]").click();
    ok(!doc.querySelector("#phone-dialog").open, "closed");
    dropFrames();
  },

  "phone: lists the PC's orders; one photo goes to every picked order and is saved in Saved\\Photos": async () => {
    clearAll();
    await clearQueue();
    const { app, doc: pcDoc } = await openApp();
    app.loadCsvText(await sampleText(), "sample.csv");
    pcDoc.querySelector("#btn-pdf").click();
    ok(await app.syncPhoneOrders(true), "order list sent");
    const { code } = await link();
    const { win, doc, phone } = await openPhone(code.replace(/-/g, ""));
    await waitFor(() => phone.state.link === "ok" && phone.state.orders.length === 10, "the phone to get 10 orders");
    ok(doc.querySelector("#pair").hidden, "paired");
    ok(doc.querySelector("#status").textContent.includes("Connected"), "status says connected");
    ok(!/Example St|Larkspur/.test(JSON.stringify(phone.state.orders)), "no street addresses on the phone");
    ok(doc.querySelector("#btn-cam").disabled, "camera waits for an order");
    pick(doc, win, ["SAMPLE-0001", "SAMPLE-0002"]);
    doc.querySelector('#kinds button[data-kind="packed"]').click();
    ok(doc.querySelector("#picked").textContent.includes("Packed photo for 2 orders"), "bar says what happens");
    ok(!doc.querySelector("#btn-cam").disabled, "camera ready");
    const dt = new win.DataTransfer();
    dt.items.add(await photoFile());
    const input = doc.querySelector("#in-cam");
    input.files = dt.files;
    input.dispatchEvent(new win.Event("change", { bubbles: true }));
    await waitFor(async () => (await phone.queueAll()).length === 0 && doc.querySelector("#recent .shot.saved"), "the photo to reach the PC");
    ok(doc.querySelector("#recent").textContent.includes("Saved on PC"), "phone says saved");
    const pc = await photosOnPc();
    for (const key of ["SAMPLE-0001", "SAMPLE-0002"]) {
      eq([pc[key].packed, pc[key].total], [1, 1], key);
      const p = pc[key].photos[0];
      ok(new RegExp(`^${key} [^/]+/Packed \\d{4}-\\d{2}-\\d{2} \\d{2}-\\d{2}-\\d{2} [a-z0-9]{6}\\.jpg$`).test(p.file), "file name: " + p.file);
      const bytes = new Uint8Array(await (await fetch(`/api/photo?id=${p.id}&order=${key}`, { headers: PC })).arrayBuffer());
      eq([...bytes.slice(0, 3)], [0xff, 0xd8, 0xff], "saved as a JPEG");
    }
    eq(pc["SAMPLE-0001"].photos[0].id, pc["SAMPLE-0002"].photos[0].id, "same photo for both orders");
    ok(doc.querySelector('#orders input[value="SAMPLE-0001"]').closest("label").textContent.includes("1 saved"), "count on the order");
    dropFrames();
  },

  "phone: photos taken while the PC can't be reached wait on the phone and send themselves later": async () => {
    const { code } = await link();
    let { win, doc, phone } = await openPhone(code);
    await waitFor(() => phone.state.link === "ok", "connected first");
    win.fetch = () => Promise.reject(new TypeError("Failed to fetch")); // the PC is off / out of reach
    eq(await phone.refresh(), "down");
    ok(doc.querySelector("#status").textContent.includes("PC offline"), "status says so");
    ok(!doc.querySelector("#work").hidden, "orders still there from the phone's own copy");
    phone.state.pick = new Set();
    pick(doc, win, ["SAMPLE-0003"]);
    doc.querySelector('#kinds button[data-kind="postoffice"]').click();
    eq(await phone.addFiles([await photoFile("receipt.png", 600, 900)]), 1);
    eq((await phone.queueAll()).length, 1, "kept on the phone");
    ok(doc.querySelector("#recent .shot.waiting"), "shown as waiting");
    ok(doc.querySelector("#queue-note").textContent.includes("kept on this phone"), "explains it");
    ok(doc.querySelector("#status").textContent.includes("1 waiting"), "status counts it");
    ok(!(await photosOnPc())["SAMPLE-0003"], "nothing on the PC yet");
    // The page is closed and opened again later, with the PC back.
    dropFrames();
    ({ win, doc, phone } = await openPhone());
    ok(phone.state.code, "the phone remembered its code");
    await waitFor(async () => (await phone.queueAll()).length === 0, "the waiting photo to be sent");
    const pc = await photosOnPc();
    eq([pc["SAMPLE-0003"].postoffice, pc["SAMPLE-0003"].total], [1, 1], "post office photo saved");
    ok(/^SAMPLE-0003 [^/]+\/Post office /.test(pc["SAMPLE-0003"].photos[0].file), pc["SAMPLE-0003"].photos[0].file);
    await waitFor(() => doc.querySelector("#recent .shot.saved"), "phone shows it saved");
    dropFrames();
  },

  "phone: a wrong pairing code keeps photos waiting until the right code is entered": async () => {
    const { code } = await link();
    const { win, doc, phone } = await openPhone();
    await waitFor(() => phone.state.link === "ok", "connected");
    eq(await phone.setCode("WRONG-WRONG-WR"), "code");
    ok(!doc.querySelector("#pair").hidden, "asks for the code again");
    ok(doc.querySelector("#status").textContent.includes("Code out of date"), "status says why");
    phone.state.pick = new Set();
    pick(doc, win, ["SAMPLE-0004"]);
    doc.querySelector('#kinds button[data-kind="contents"]').click();
    await phone.addFiles([await photoFile("cards.png", 400, 400)]);
    eq((await phone.queueAll()).length, 1, "kept, not dropped");
    const box = doc.querySelector("#pair-code");
    box.value = code.toLowerCase();
    doc.querySelector("#pair-form").dispatchEvent(new win.Event("submit", { cancelable: true }));
    await waitFor(async () => (await phone.queueAll()).length === 0, "sent after the right code");
    eq((await photosOnPc())["SAMPLE-0004"].contents, 1);
    dropFrames();
  },

  "server: a photo sent twice is saved once; non-photos and bad details are refused": async () => {
    const key = (await link()).code;
    const H = { "X-Ship-Desk-Key": key };
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const send = (q, body = jpeg) => fetch("/api/phone/photo?" + new URLSearchParams(q), { method: "POST", headers: H, body });
    const q = { order: "SAMPLE-0005", name: "Test Buyer", kind: "contents", id: "dup123abc", taken: "2026-10-20T10:11:12" };
    const a = await (await send(q)).json();
    const b = await (await send(q)).json();
    ok(a.ok && b.ok && b.again, "second copy recognised");
    eq(a.file, b.file);
    eq((await photosOnPc())["SAMPLE-0005"].total, 1, "saved once");
    eq((await send({ ...q, id: "text12345" }, "hello")).status, 400, "not a picture");
    eq((await send({ ...q, kind: "selfie" })).status, 400, "unknown kind");
    eq((await send({ ...q, id: "../../x" })).status, 400, "bad id");
    eq((await send({ ...q, order: "" })).status, 400, "no order");
    const odd = await (await send({ ...q, id: "slash1234", order: "paste:a/b\\c|12345", name: 'A/B\\C:"*?' })).json();
    ok(odd.ok && !/[\\:*?"<>|]/.test(odd.file) && odd.file.split("/").length === 2, "unsafe characters left out of the folder: " + odd.file);
  },

  "PC: History shows each order's photos and opens them": async () => {
    const { win, doc, app } = await openApp("#history");
    await waitFor(() => doc.querySelector('#history-table tr[data-key="SAMPLE-0001"] .h-photos'), "photo count in History");
    const row = doc.querySelector('#history-table tr[data-key="SAMPLE-0001"]');
    ok(row.querySelector(".c-photos").textContent.includes("1 photo"), row.querySelector(".c-photos").textContent);
    ok(row.querySelector(".c-photos").textContent.includes("1 packed"), "says what kind");
    ok(doc.querySelector('#history-table tr[data-key="SAMPLE-0009"] .c-photos').textContent.includes("No photos"), "orders without photos");
    row.querySelector(".h-photos").click();
    const dlg = doc.querySelector("#photos-dialog");
    ok(dlg.open, "photos window open");
    ok(doc.querySelector("#photos-h").textContent.includes("SAMPLE-0001"), "title names the order");
    ok(dlg.textContent.includes("Packed, ready to ship (1)"), "grouped by kind");
    await waitFor(() => { const img = dlg.querySelector(".photo img"); return img && img.src.startsWith("blob:") && img.complete && img.naturalWidth > 0; }, "the photo to load");
    [...dlg.querySelectorAll("button")].find((b) => b.textContent.includes("photo folder")).click();
    await waitFor(async () => (await (await fetch("/__opened")).json()).opened.some((p) => /Photos[\\/]SAMPLE-0001 /.test(p)), "the order's folder to open");
    dlg.querySelector("[data-close]").click();
    ok(!dlg.open, "closed");
    eq(Object.keys(app.state.photos).length >= 4, true, "photo summary loaded");
    win.confirm = () => true;
    clearAll();
    await clearQueue();
  },
};

// ---------- scanning: order QR codes on what Ship Desk prints, tracking barcodes on bought labels ----------

const pdfjs = window.pdfjsLib;
if (pdfjs && !pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = "../vendor/pdf.worker.min.js";

// A page of a jsPDF doc as a picture, about as sharp as a phone camera sees a label (scale 2 = 144 dots per inch).
async function pagePicture(doc, n = 1, scale = 2) {
  const pdf = await pdfjs.getDocument({ data: doc.output("arraybuffer") }).promise;
  const page = await pdf.getPage(n);
  const vp = page.getViewport({ scale });
  const c = document.createElement("canvas");
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
  return c;
}

const ORDER = (id, extra = {}) => ({ id, name: "Ash Example", firstName: "Ash", lastName: "Example", address1: "45 Example St", address2: "",
  city: "Los Angeles", state: "CA", zip: "90012", country: "US", orderDate: "10/1/2026", itemCount: 2, value: 9.99, items: [], row: { "Order #": id }, ...extra });
const RETURN_ADDR = { name: "Taco Card Shop", street: "12 Return Rd", city: "Austin", state: "TX", zip: "78701" };

// Code 128 (set C, digits) with FNC1, the way USPS labels print their tracking barcode (GS1-128 "IMpb").
const C128 = ("212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 "
  + "123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 "
  + "131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 "
  + "213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 "
  + "112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 "
  + "421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112").split(" ");

function code128Canvas(groups, { module = 3, height = 140, turn = false } = {}) {
  // groups: digit strings; an FNC1 goes in front of each one (GS1 style).
  const values = [105];
  for (const g of groups) {
    values.push(102);
    for (let i = 0; i < g.length; i += 2) values.push(Number(g.slice(i, i + 2)));
  }
  values.push(values.reduce((s, v, i) => s + v * (i || 1), 0) % 103, 106);
  const widths = values.map((v) => C128[v]).join("").split("").map(Number);
  const quiet = 12;
  const total = widths.reduce((a, b) => a + b, 0) + quiet * 2;
  const c = document.createElement("canvas");
  c.width = (turn ? height + 40 : total * module);
  c.height = (turn ? total * module : height + 40);
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#000";
  let x = quiet * module;
  widths.forEach((w, i) => {
    if (i % 2 === 0) { if (turn) g.fillRect(20, x, height, w * module); else g.fillRect(x, 20, w * module, height); }
    x += w * module;
  });
  return c;
}

// A 1440 x 1920 phone camera picture of a mailer: the white label (with its tracking barcode, module px per bar
// unit) on a coloured mailer, tilted, a bit soft, grainy and unevenly lit. The old reader read 15 of 96 of these.
function cameraPicture({ module = 2.2, blur = 0.6, tilt = 0, sideways = false, mailer = "#6d5c48", digits = ["42090012", "9400111899223344550001"] } = {}) {
  const W = 1440, H = 1920;
  const bar = document.createElement("canvas");
  bar.width = W; bar.height = H;
  const g = bar.getContext("2d");
  g.fillStyle = mailer; g.fillRect(0, 0, W, H);
  g.translate(W / 2, H / 2);
  g.rotate(((sideways ? 90 : 0) + tilt) * Math.PI / 180);
  const values = [105];
  for (const d of digits) { values.push(102); for (let i = 0; i < d.length; i += 2) values.push(Number(d.slice(i, i + 2))); }
  values.push(values.reduce((s, v, i) => s + v * (i || 1), 0) % 103, 106);
  const widths = values.map((v) => C128[v]).join("").split("").map(Number);
  const bw = widths.reduce((a, b) => a + b, 0) * module, bh = Math.max(60, bw * 0.22);
  g.fillStyle = "#f4f2ec"; g.fillRect(-bw / 2 - 120, -bh * 2.5, bw + 240, bh * 5);
  g.fillStyle = "#222"; g.font = "bold 40px sans-serif"; g.fillText("USPS TRACKING # EP", -bw / 2, -bh / 2 - 30);
  let x = -bw / 2;
  widths.forEach((w, i) => { if (i % 2 === 0) g.fillRect(x, -bh / 2, w * module, bh); x += w * module; });
  const out = document.createElement("canvas");
  out.width = W; out.height = H;
  const o = out.getContext("2d");
  o.filter = `blur(${blur}px)`;
  o.drawImage(bar, 0, 0);
  o.filter = "none";
  const light = o.createLinearGradient(0, 0, W, H);
  light.addColorStop(0, "rgba(0,0,0,0)"); light.addColorStop(1, "rgba(0,0,0,0.35)");
  o.fillStyle = light; o.fillRect(0, 0, W, H);
  const img = o.getImageData(0, 0, W, H);
  let r = 7;
  for (let i = 0; i < img.data.length; i += 4) {
    r = (r * 9301 + 49297) % 233280;
    const n = (r / 233280 - 0.5) * 40;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  o.putImageData(img, 0, 0);
  return out;
}

async function phoneWithOrders() {
  clearAll();
  await clearQueue();
  const { app, doc: pcDoc } = await openApp();
  app.loadCsvText(await sampleText(), "sample.csv");
  ok(await app.syncPhoneOrders(true), "order list sent");
  const { code } = await link();
  const p = await openPhone(code.replace(/-/g, ""));
  await waitFor(() => p.phone.state.link === "ok" && p.phone.state.orders.length === 10, "the phone to get 10 orders");
  return { app, pcDoc, ...p };
}

Object.assign(tests, {
  "scan: what a scanned code means (order QR, USPS/UPS tracking, other text)": async () => {
    const { parseScan } = await import("../js/phone.js");
    eq(parseScan("SHIPDESK:SAMPLE-0001"), { type: "order", key: "SAMPLE-0001" });
    eq(parseScan("SHIPDESK:paste:ash example|90012"), { type: "order", key: "paste:ash example|90012" });
    eq(parseScan("420900129400111899223344556677"), { type: "tracking", tracking: "9400111899223344556677", carrier: "USPS" }, "420 + ZIP");
    eq(parseScan("42090012\u001d9400111899223344556677"), { type: "tracking", tracking: "9400111899223344556677", carrier: "USPS" }, "with the GS1 separator");
    eq(parseScan("420987651234" + "9400111899223344556677").tracking, "9400111899223344556677", "420 + ZIP+4");
    eq(parseScan("]C1420900129400111899223344556677").tracking, "9400111899223344556677", "GS1 symbology prefix");
    eq(parseScan("9400 1118 9922 3344 5566 77"), { type: "tracking", tracking: "9400111899223344556677", carrier: "USPS" });
    eq(parseScan("1Z999AA10123456784"), { type: "tracking", tracking: "1Z999AA10123456784", carrier: "UPS" });
    eq(parseScan("https://example.com/store").type, "text");
    eq(parseScan(""), null);
  },

  "scan: the order QR code on every printed format reads back as the order (sideways labels too)": async () => {
    const { renderPdf } = await import("../js/render.js");
    const { decodeCanvas } = await import("../js/phone.js");
    const list = [ORDER("QR-1001-ABCDEF"), ORDER("QR-1002", { name: "Misty Waters", zip: "10001" })];
    for (const format of ["thermal4x6", "thermal6x4", "letter1", "letter3", "letter4", "labelSlip", "envelope10"]) {
      const doc = renderPdf(list.slice(0, 1), { format, slips: true, returnAddress: RETURN_ADDR, design: { qrUrl: "" } });
      eq(await decodeCanvas(await pagePicture(doc, 1)), "SHIPDESK:QR-1001-ABCDEF", format + " label");
      if (format.startsWith("thermal")) eq(await decodeCanvas(await pagePicture(doc, 2)), "SHIPDESK:QR-1001-ABCDEF", format + " packing slip");
    }
    const pasted = renderPdf([ORDER("P-001")], { format: "thermal4x6", slips: false, source: "paste", returnAddress: RETURN_ADDR });
    eq(await decodeCanvas(await pagePicture(pasted)), "SHIPDESK:paste:ash example|90012", "pasted addresses: name + ZIP");
    const both = renderPdf(list.slice(0, 1), { format: "thermal4x6", slips: false, returnAddress: RETURN_ADDR, design: { qrUrl: "https://example.com/my-store" } });
    eq(await decodeCanvas(await pagePicture(both)), "SHIPDESK:QR-1001-ABCDEF", "a label with the shop-link QR too: the order's code wins");
    const off = renderPdf(list.slice(0, 1), { format: "thermal4x6", slips: false, returnAddress: RETURN_ADDR, design: { orderQr: false } });
    eq(await decodeCanvas(await pagePicture(off)), "", "switched off: no code");
  },

  "scan: a USPS tracking barcode reads back, upright or sideways": async () => {
    const { decodeCanvas, parseScan } = await import("../js/phone.js");
    for (const sum of C128.slice(0, 106)) eq(sum.split("").reduce((a, b) => a + Number(b), 0), 11, "Code 128 table");
    for (const turn of [false, true]) {
      const text = await decodeCanvas(code128Canvas(["42090012", "9400111899223344556677"], { turn }));
      eq(parseScan(text).tracking, "9400111899223344556677", (turn ? "sideways: " : "upright: ") + JSON.stringify(text));
    }
  },

  "scan: a tracking barcode on a darker mailer, a bit soft and tilted, reads in one look": async () => {
    const { decodeFrame, parseScan } = await import("../js/phone.js");
    const cases = [
      { mailer: "#6d5c48", module: 2.2, blur: 0.6, tilt: 4 },                 // kraft mailer, tilted
      { mailer: "#6d5c48", module: 2.2, blur: 0.6, tilt: 4, sideways: true }, // ...held sideways
      { mailer: "#9a9a9a", module: 3, blur: 1.2 },                            // grey mailer, soft
      { mailer: "#ffffff", module: 1.8, blur: 0.6, sideways: true },          // white mailer, small
    ];
    for (const c of cases) {
      const pic = cameraPicture(c);
      const t = performance.now();
      const text = await decodeFrame(pic, pic.width, pic.height);
      const ms = performance.now() - t;
      const s = parseScan(text);
      eq(s && s.tracking, "9400111899223344550001", JSON.stringify(c) + " read " + JSON.stringify(text));
      ok(ms < 1500, `${JSON.stringify(c)}: one look took ${ms.toFixed(0)} ms`);
    }
  },

  "scan: if the main reader can't start, the JavaScript reader still reads barcodes and QR codes": async () => {
    const { decodeFrame, parseScan, readers } = await import("../js/phone.js");
    readers.wasm = false;
    try {
      const pic = cameraPicture({ mailer: "#ffffff", module: 3, blur: 0.6 });
      eq(parseScan(await decodeFrame(pic, pic.width, pic.height)).tracking, "9400111899223344550001", "barcode");
      const side = cameraPicture({ mailer: "#9a9a9a", module: 3, blur: 0.6, sideways: true });
      eq(parseScan(await decodeFrame(side, side.width, side.height)).tracking, "9400111899223344550001", "sideways, grey mailer");
    } finally {
      readers.wasm = true;
    }
  },

  "scan: the live camera finds the order QR code on a label and picks the order": async () => {
    const { win, doc, phone } = await phoneWithOrders();
    const { renderPdf } = await import("../js/render.js");
    const label = await pagePicture(renderPdf([ORDER("SAMPLE-0007")], { format: "thermal4x6", slips: false, returnAddress: RETURN_ADDR }), 1, 2);
    // A fake camera: a canvas in the phone page showing the label, as a video stream.
    const cam = doc.createElement("canvas");
    cam.width = 1280; cam.height = 960;
    const paint = () => { const g = cam.getContext("2d"); g.fillStyle = "#7a6a55"; g.fillRect(0, 0, 1280, 960); g.drawImage(label, 340, 30, 600, 900); };
    paint();
    const painter = setInterval(paint, 100);
    win.navigator.mediaDevices.getUserMedia = async () => cam.captureStream(10);
    try {
      doc.querySelector("#btn-scan").click();
      ok(!doc.querySelector("#scanner").hidden, "scanner open");
      await waitFor(() => phone.scan.found.includes("SAMPLE-0007"), "the camera to read the label", 15000);
      ok(doc.querySelector("#scan-found").textContent.includes("SAMPLE-0007"), "shows what it found");
      ok(doc.querySelector("#scan-msg").textContent.includes("Got SAMPLE-0007"), doc.querySelector("#scan-msg").textContent);
      eq(doc.querySelector("#scan-done").textContent, "Done (1)");
      doc.querySelector("#scan-done").click();
      ok(doc.querySelector("#scanner").hidden, "closed");
      ok(phone.scan.stream && phone.scan.stream.getVideoTracks()[0].readyState === "live", "the camera stays ready for a while");
      let asked = 0;
      const ask = win.navigator.mediaDevices.getUserMedia;
      win.navigator.mediaDevices.getUserMedia = (...a) => { asked++; return ask(...a); };
      doc.querySelector("#btn-scan").click();
      await waitFor(() => phone.scan.open && !doc.querySelector("#scan-msg").textContent.startsWith("Starting"), "the camera screen again");
      eq(asked, 0, "opening the camera again doesn't ask for it again");
      phone.closeScanner(false);
      phone.stopCamera(true);
      ok(!phone.scan.stream, "switched off when the app goes to the background");
      eq([...phone.state.pick], ["SAMPLE-0007"], "the scanned order is picked");
      ok(doc.querySelector("#picked").textContent.includes("SAMPLE-0007"), "bar names it");
      ok(!doc.querySelector("#btn-cam").disabled, "ready for the photo");
    } finally {
      clearInterval(painter);
      phone.closeScanner(false);
    }
    dropFrames();
  },

  "scan: a mailer's unknown tracking number is given to an order, waits offline, and lands in History and the import file": async () => {
    const { app, win, doc, phone } = await phoneWithOrders();
    win.navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("no camera", "NotFoundError"));
    await phone.openScanner();
    ok(!doc.querySelector("#scan-still").hidden, "no camera: offers a still picture instead");
    // A picture of the mailer's label, through "Take a picture of the code".
    const blob = await new Promise((r) => code128Canvas(["42090012", "9400111899223344550001"]).toBlob(r, "image/png"));
    const realFetch = win.fetch;
    win.fetch = () => Promise.reject(new TypeError("Failed to fetch")); // at the post office: the PC can't be reached
    const s = await phone.scanFile(new win.File([blob], "label.png", { type: "image/png" }));
    eq(s && s.tracking, "9400111899223344550001", "read from the picture");
    ok(!doc.querySelector("#scan-ask").hidden, "asks which order");
    ok(doc.querySelector("#scan-ask-text").textContent.includes("9400111899223344550001"), "names the tracking number");
    const choice = doc.querySelector('#scan-ask-list button[data-link="SAMPLE-0006"]');
    ok(choice, "unshipped orders are offered");
    choice.click();
    await waitFor(() => phone.scan.found.includes("SAMPLE-0006"), "the order to be picked");
    ok(doc.querySelector("#scan-ask").hidden, "question answered");
    const waiting = await phone.queueAll();
    eq(waiting.length, 1, "kept on the phone");
    ok(waiting[0].link && waiting[0].tracking === "9400111899223344550001", "as a tracking link");
    // The same mailer scanned again is now known.
    phone.scan.found = [];
    phone.scan.last = ""; // (a repeat of the same code within 2.5 s counts as the same scan)
    phone.handleScan("420900129400111899223344550001");
    eq(phone.scan.found, ["SAMPLE-0006"], "known tracking number picks the order");
    phone.closeScanner(true);
    ok(doc.querySelector('#orders input[value="SAMPLE-0006"]').closest("label").textContent.includes("Tracking …550001"), "order shows the tracking");
    // Back home: the PC is reachable again.
    win.fetch = realFetch;
    await phone.refresh();
    await waitFor(async () => (await phone.queueAll()).length === 0, "the link to reach the PC");
    eq((await (await fetch("/api/links", { headers: PC })).json()).links.length, 1, "the PC has it");
    eq(await app.takePhoneLinks(), 1, "the PC page takes it");
    const r = app.state.history["SAMPLE-0006"];
    ok(r && r.shipped && r.tracking === "9400111899223344550001" && r.carrier === "USPS", "in History, shipped with tracking: " + JSON.stringify(r));
    eq(app.state.shipped["SAMPLE-0006"].tracking, "9400111899223344550001", "step 4 knows it");
    ok(app.importFile().csv.includes("9400111899223344550001"), "in the TCGplayer import file");
    eq((await (await fetch("/api/links", { headers: PC })).json()).links.length, 0, "taken once");
    eq(await app.takePhoneLinks(), 0, "nothing left to take");
    ok(app.phoneOrders().find((o) => o.key === "SAMPLE-0006").tracking === "9400111899223344550001", "the phone's list carries it");
    dropFrames();
  },

  "scan: a mailer whose order isn't listed becomes a new entry (name + tracking); its order # added on the PC later": async () => {
    const { app, pcDoc, win, doc, phone } = await phoneWithOrders();
    win.navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("no camera", "NotFoundError"));
    await phone.openScanner();
    phone.handleScan("420490009400111899223344550077");
    ok(!doc.querySelector("#scan-new").closest("#scan-ask").hidden, "offers a new entry");
    doc.querySelector("#scan-new").dispatchEvent(new win.Event("submit", { cancelable: true }));
    ok(!(await phone.queueAll()).length, "no name: nothing made yet");
    doc.querySelector("#scan-new-name").value = "Zackery Twork";
    doc.querySelector("#scan-new").dispatchEvent(new win.Event("submit", { cancelable: true }));
    const key = "mailer:9400111899223344550077";
    await waitFor(() => phone.scan.found.includes(key), "the new entry to be picked");
    phone.closeScanner(true);
    eq([...phone.state.pick], [key]);
    ok(doc.querySelector("#picked").textContent.includes("Zackery Twork"), doc.querySelector("#picked").textContent);
    doc.querySelector('#kinds button[data-kind="packed"]').click();
    await phone.addFiles([await photoFile("mailer.png", 800, 600)]);
    await waitFor(async () => (await phone.queueAll()).length === 0, "the tracking # and photo to reach the PC");
    let pc = await photosOnPc();
    ok(/^Zackery Twork 9400111899223344550077\/Packed /.test(pc[key].photos[0].file), "photo folder: " + pc[key].photos[0].file);
    await phone.refresh();
    ok(phone.state.orders.some((o) => o.key === key && o.tracking === "9400111899223344550077"), "the PC's list keeps the entry");
    ok(doc.querySelector("#orders").textContent.includes("No order # yet"), "shown without an order #");
    eq(await app.takePhoneLinks(), 1);
    const r = app.state.history[key];
    ok(r && r.name === "Zackery Twork" && r.tracking === "9400111899223344550077" && r.shipped && r.source === "mailer" && !r.id, JSON.stringify(r));
    // On the PC, type the TCGplayer order # into the entry in History.
    app.showView("history");
    const box = await waitFor(() => pcDoc.querySelector(`#history-table tr[data-key="${key}"] .h-oid`), "the order # box");
    ok(box.closest("td").textContent.includes("Mailer scanned on the phone"), "says where it came from");
    box.value = "TCG-ABC-123";
    box.dispatchEvent(new pcDoc.defaultView.Event("change", { bubbles: true }));
    await waitFor(() => app.state.history["TCG-ABC-123"] && !app.state.history[key], "the entry to become the order");
    const now = app.state.history["TCG-ABC-123"];
    ok(now.id === "TCG-ABC-123" && now.source === "csv" && now.name === "Zackery Twork" && now.tracking === "9400111899223344550077", JSON.stringify(now));
    eq(app.state.shipped["TCG-ABC-123"].tracking, "9400111899223344550077", "step 4 knows it");
    pc = await waitFor(async () => { const all = await photosOnPc(); return all["TCG-ABC-123"] && all; }, "the photo to move to the order");
    ok(!pc[key], "no photos left under the mailer");
    ok(/^TCG-ABC-123 Zackery Twork\/Packed /.test(pc["TCG-ABC-123"].photos[0].file), "photo moved: " + pc["TCG-ABC-123"].photos[0].file);
    // A photo the phone took before it heard about the order # still goes to the order.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const late = await (await fetch("/api/phone/photo?" + new URLSearchParams({ order: key, name: "Zackery Twork", kind: "contents", id: "late12345", taken: "2026-10-20T18:00:00" }),
      { method: "POST", headers: { "X-Ship-Desk-Key": (await link()).code }, body: jpeg })).json();
    ok(late.ok && late.file.startsWith("TCG-ABC-123 Zackery Twork/"), "late photo: " + late.file);
    await app.syncPhoneOrders(true);
    await phone.refresh();
    ok(!phone.state.orders.some((o) => o.key === key), "the phone drops the mailer entry");
    eq([...phone.state.pick], ["TCG-ABC-123"], "and picks the order instead");
    // With the order # typed on the phone, the entry is the order straight away.
    eq(await phone.newMailerEntry("9400111899223344550088", "USPS", "Pat Doe", "tcg-xyz-9"), "TCG-XYZ-9");
    await waitFor(async () => (await phone.queueAll()).length === 0, "sent");
    eq(await app.takePhoneLinks(), 1);
    const pat = app.state.history["TCG-XYZ-9"];
    ok(pat && pat.id === "TCG-XYZ-9" && pat.name === "Pat Doe" && pat.tracking === "9400111899223344550088" && pat.shipped, JSON.stringify(pat));
    eq(app.state.shipped["TCG-XYZ-9"].tracking, "9400111899223344550088");
    dropFrames();
  },

  "camera: several photos in a row without leaving it, switching the type, turned the way the phone is held": async () => {
    const { win, doc, phone } = await phoneWithOrders();
    // A fake camera, wider than tall, with a red mark in its top-left corner to see which way photos turn.
    const cam = doc.createElement("canvas");
    cam.width = 1280; cam.height = 960;
    const paint = () => { const g = cam.getContext("2d"); g.fillStyle = "#d8d2c4"; g.fillRect(0, 0, 1280, 960); g.fillStyle = "#e01010"; g.fillRect(0, 0, 200, 200); };
    paint();
    const painter = setInterval(paint, 100);
    win.navigator.mediaDevices.getUserMedia = async () => cam.captureStream(10);
    try {
      pick(doc, win, ["SAMPLE-0010"]);
      doc.querySelector('#kinds button[data-kind="contents"]').click();
      doc.querySelector("#btn-cam").click();
      ok(!doc.querySelector("#scanner").hidden, "the camera screen opens");
      await waitFor(() => !doc.querySelector("#cam-shutter").disabled, "the shutter to be ready");
      eq(phone.scan.found, ["SAMPLE-0010"], "the picked order comes along");
      // Held sideways (top of the phone to the left): photos are turned a quarter to the left.
      win.dispatchEvent(new win.DeviceMotionEvent("devicemotion", { accelerationIncludingGravity: { x: 9.8, y: 0, z: 0.5 } }));
      eq(phone.photoTurn(), 270, "turned left");
      ok(doc.querySelector("#cam-turn").textContent.includes("turned left (auto)"), doc.querySelector("#cam-turn").textContent);
      // Flat on the desk says nothing: the last way it was held stays.
      win.dispatchEvent(new win.DeviceMotionEvent("devicemotion", { accelerationIncludingGravity: { x: 0.3, y: 0.2, z: 9.8 } }));
      eq(phone.photoTurn(), 270, "kept while flat");
      doc.querySelector("#cam-shutter").click();
      await waitFor(() => phone.scan.shots.length === 1, "photo 1");
      doc.querySelector("#cam-shutter").click();
      await waitFor(() => phone.scan.shots.length === 2, "photo 2");
      doc.querySelector('#cam-kinds button[data-kind="packed"]').click();
      eq(phone.state.kind, "packed", "type switched on the camera screen");
      // A tap on the turn button: upright, by hand.
      doc.querySelector("#cam-turn").click();
      eq(phone.photoTurn(), 0, "turned by hand");
      ok(doc.querySelector("#cam-turn").textContent.includes("upright") && !doc.querySelector("#cam-turn").textContent.includes("auto"), "says so");
      doc.querySelector("#cam-shutter").click();
      await waitFor(() => phone.scan.shots.length === 3, "photo 3");
      ok(!doc.querySelector("#scanner").hidden, "still on the camera after 3 photos");
      eq(doc.querySelectorAll("#cam-shots li").length, 3, "3 photos shown");
      ok(doc.querySelector("#scan-msg").textContent.includes("Packed photo 1"), doc.querySelector("#scan-msg").textContent);
      await waitFor(async () => (await phone.queueAll()).length === 0, "the photos to reach the PC");
      doc.querySelector("#scan-done").click();
      ok(doc.querySelector("#scanner").hidden, "closed");
      const pc = (await photosOnPc())["SAMPLE-0010"];
      eq([pc.contents, pc.packed], [2, 1], "2 contents + 1 packed saved");
      const look = async (p) => {
        const blob = await (await fetch(`/api/photo?id=${p.id}&order=SAMPLE-0010`, { headers: PC })).blob();
        const bmp = await createImageBitmap(blob);
        const c = document.createElement("canvas");
        c.width = bmp.width; c.height = bmp.height;
        const g = c.getContext("2d");
        g.drawImage(bmp, 0, 0);
        const red = (x, y) => { const d = g.getImageData(x, y, 1, 1).data; return d[0] > 180 && d[1] < 90; };
        return { w: bmp.width, h: bmp.height, red };
      };
      const turned = await look(pc.photos.find((p) => p.kind === "contents"));
      eq([turned.w, turned.h], [960, 1280], "the sideways photo is saved tall");
      ok(turned.red(20, turned.h - 20) && !turned.red(20, 20), "turned left: the top-left mark is now bottom-left");
      const upright = await look(pc.photos.find((p) => p.kind === "packed"));
      eq([upright.w, upright.h], [1280, 960], "the upright photo stays wide");
      ok(upright.red(20, 20), "mark still top-left");
    } finally {
      clearInterval(painter);
      phone.closeScanner(false);
      phone.turn.manual = null;
    }
    dropFrames();
  },

  "post office photo: the order is marked shipped on the PC, unless it already was": async () => {
    const { app, win, doc, phone } = await phoneWithOrders();
    app.matchPasted("SAMPLE-0005 9400111899223344559999");
    const before = { ...app.state.history["SAMPLE-0005"] };
    ok(before.shipped && before.tracking === "9400111899223344559999", "SAMPLE-0005 already shipped with tracking");
    ok(!app.state.history["SAMPLE-0008"] || !app.state.history["SAMPLE-0008"].shipped, "SAMPLE-0008 not shipped yet");
    await app.syncPhoneOrders(true);
    await phone.refresh();
    phone.state.pick = new Set(["SAMPLE-0005", "SAMPLE-0008"]); // (SAMPLE-0005 is shipped, so not in the "Not shipped" list)
    phone.render();
    doc.querySelector('#kinds button[data-kind="postoffice"]').click();
    await phone.addFiles([await photoFile("counter.png", 600, 800)]);
    ok(phone.state.orders.find((o) => o.key === "SAMPLE-0008").shipped, "shown as shipped on the phone straight away");
    await waitFor(async () => (await phone.queueAll()).length === 0, "the photo to reach the PC");
    eq(await app.takePhoneLinks(), 2, "a shipped note for each order");
    const r = app.state.history["SAMPLE-0008"];
    ok(r && r.shipped && !r.tracking, "SAMPLE-0008 marked shipped: " + JSON.stringify(r));
    ok(app.state.shipped["SAMPLE-0008"] && app.state.shipped["SAMPLE-0008"].shipped, "step 4 knows it");
    ok(/SAMPLE-0008[^\n]*Shipped/.test(app.importFile().csv), "in the import file as Shipped");
    const after = app.state.history["SAMPLE-0005"];
    eq([after.tracking, after.shippedAt, after.carrier], [before.tracking, before.shippedAt, before.carrier], "the already shipped order is left as it was");
    eq(app.state.shipped["SAMPLE-0005"].tracking, "9400111899223344559999", "its tracking is kept");
    eq(await app.takePhoneLinks(), 0, "taken once");
    dropFrames();
  },

  "PC: the turn buttons in the photos window turn the saved photo": async () => {
    const { doc, app } = await openApp("#history");
    await app.refreshPhotos();
    const key = "SAMPLE-0010";
    const p = app.state.photos[key].photos.find((x) => x.kind === "packed");
    const size = async () => { const b = await createImageBitmap(await (await fetch(`/api/photo?id=${p.id}&order=${key}`, { headers: PC })).blob()); return [b.width, b.height]; };
    eq(await size(), [1280, 960], "wide before");
    await app.openPhotos(key);
    const dlg = doc.querySelector("#photos-dialog");
    const fig = await waitFor(() => [...dlg.querySelectorAll(".photo")].find((f) => f.querySelector("img").naturalWidth === 1280), "the photo to load");
    const right = fig.querySelector('button.turn[aria-label="Turn this photo right"]');
    ok(right && fig.querySelector('button.turn[aria-label="Turn this photo left"]'), "turn left/right buttons");
    right.click();
    await waitFor(async () => (await size())[0] === 960, "the saved file to turn");
    eq(await size(), [960, 1280], "tall now");
    dlg.querySelector("[data-close]").click();
    dropFrames();
  },

  "scan: the PC adds a scanned order to History even when its batch isn't loaded": async () => {
    const key = (await link()).code;
    const H = { "X-Ship-Desk-Key": key, "Content-Type": "application/json" };
    const send = (body, headers = H) => fetch("/api/phone/link", { method: "POST", headers, body: JSON.stringify(body) });
    const body = { id: "lnk-0009-a", order: "SAMPLE-0009", name: "", tracking: "9400111899223344550009", carrier: "USPS", taken: "2026-10-20T15:00:00" };
    eq((await send(body, { "Content-Type": "application/json" })).status, 403, "needs the pairing code");
    eq((await send({ ...body, tracking: "12" })).status, 400, "not a tracking number");
    eq((await send({ ...body, carrier: "Pony Express" })).status, 400, "unknown carrier");
    ok((await (await send(body)).json()).ok, "saved");
    ok((await (await send(body)).json()).again, "sent twice, kept once");
    const { app } = await openApp(); // a fresh page: no batch loaded, SAMPLE-0009 not in History
    await waitFor(() => app.state.history["SAMPLE-0009"], "History to get the order");
    const r = app.state.history["SAMPLE-0009"];
    ok(r.name && r.city && r.zip && r.tracking === "9400111899223344550009" && r.shipped, "name, place and tracking from the phone list: " + JSON.stringify(r));
    eq(app.state.shipped["SAMPLE-0009"].tracking, "9400111899223344550009");
    dropFrames();
    clearAll();
    await clearQueue();
  },
});

export { tests };
