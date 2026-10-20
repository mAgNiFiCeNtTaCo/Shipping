// History: history.js on its own, then the History page in the real app (iframe).
import { ok, eq } from "./runner.js";
import { parseCsv } from "../js/csv.js";
import { KEYS, load, remove } from "../js/store.js";
import { historyKey, recordPrinted, recordShipped, historyCounts, historyList, historyCsv, trackingUrl,
  HISTORY_CSV_HEADER, MAX_RECORDS } from "../js/history.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for " + what);
    await sleep(25);
  }
}

const order = (id, extra = {}) => ({ id, name: "Buyer " + id, city: "Austin", state: "TX", zip: "78701", value: 12.5,
  itemCount: 2, orderDate: "10/20/2026", plan: { tag: "envelope" }, address1: "1 Secret St", ...extra });

const tests = {
  "printing records each order once, counts reprints and keeps no street address": async () => {
    const h = {};
    recordPrinted(h, [order("A-1"), order("A-2")], { format: "thermal4x6", when: "2026-10-20 09:00" });
    recordPrinted(h, [order("A-1")], { format: "avery5160", when: "2026-10-21 10:00" });
    eq(Object.keys(h).sort(), ["A-1", "A-2"]);
    eq(h["A-1"].printCount, 2);
    eq(h["A-1"].printedAt, "2026-10-20 09:00", "first time kept");
    eq(h["A-1"].lastPrintedAt, "2026-10-21 10:00");
    eq(h["A-1"].format, "avery5160");
    ok(!JSON.stringify(h).includes("Secret St"), "street address must not be stored");
    eq(h["A-2"].shipped, false);
  },
  "shipping updates the record, and works for orders never printed here": async () => {
    const h = {};
    recordPrinted(h, [order("B-1")], { when: "2026-10-20 09:00" });
    recordShipped(h, order("B-1"), { tracking: "9400100000000000000000", carrier: "USPS", shipped: true }, { when: "2026-10-20 15:00" });
    eq([h["B-1"].shipped, h["B-1"].tracking, h["B-1"].carrier, h["B-1"].shippedAt], [true, "9400100000000000000000", "USPS", "2026-10-20 15:00"]);
    recordShipped(h, order("B-2"), { shipped: true }, { when: "2026-10-20 16:00" });
    eq([h["B-2"].shipped, h["B-2"].printCount, h["B-2"].tracking], [true, 0, ""]);
    recordShipped(h, order("B-1"), null);
    eq([h["B-1"].shipped, h["B-1"].tracking, h["B-1"].shippedAt], [false, "", ""], "unmarked");
  },
  "pasted orders are keyed by name + ZIP, not P-001": async () => {
    eq(historyKey({ id: "P-001", name: "Ann Lee ", zip: "02127" }, "paste"), "paste:ann lee|02127");
    const h = {};
    recordPrinted(h, [{ id: "P-001", name: "Ann Lee", zip: "02127" }], { source: "paste" });
    recordPrinted(h, [{ id: "P-001", name: "Bo Kim", zip: "10001" }], { source: "paste" });
    eq(Object.keys(h).length, 2, "two different people, both P-001");
    eq(h["paste:ann lee|02127"].id, "", "pasted orders have no order number");
  },
  "filters, search, counts and newest-first order": async () => {
    const h = {};
    recordPrinted(h, [order("C-1")], { when: "2026-10-18 09:00" });
    recordPrinted(h, [order("C-2", { name: "Zed Quill", city: "Boston" })], { when: "2026-10-19 09:00" });
    recordPrinted(h, [order("C-3")], { when: "2026-10-20 09:00" });
    recordShipped(h, order("C-1"), { tracking: "1Z999AA10123456784", carrier: "UPS", shipped: true }, { when: "2026-10-21 09:00" });
    eq(historyCounts(h), { all: 3, printed: 3, waiting: 2, shipped: 1 });
    eq(historyList(h).map((r) => r.id), ["C-1", "C-3", "C-2"], "C-1 shipped last, so newest");
    eq(historyList(h, { filter: "shipped" }).map((r) => r.id), ["C-1"]);
    eq(historyList(h, { filter: "waiting" }).map((r) => r.id), ["C-3", "C-2"]);
    eq(historyList(h, { search: "quill" }).map((r) => r.id), ["C-2"]);
    eq(historyList(h, { search: "boston" }).map((r) => r.id), ["C-2"]);
    eq(historyList(h, { search: "1z999" }).map((r) => r.id), ["C-1"]);
  },
  "history CSV has a header row and one row per record": async () => {
    const h = {};
    recordPrinted(h, [order("D-1", { name: "O'Hara, Pat" })], { format: "thermal6x4", when: "2026-10-20 09:00" });
    const rows = parseCsv(historyCsv(historyList(h), { envelope: "Envelope OK" }));
    eq(rows[0], HISTORY_CSV_HEADER);
    eq(rows.length, 2);
    eq(rows[1][0], "D-1");
    eq(rows[1][1], "O'Hara, Pat", "comma kept inside quotes");
    eq(rows[1][7], "Envelope OK");
    eq(rows[1][11], "6x4 thermal (landscape)");
    eq(rows[1][12], "No");
  },
  "tracking links per carrier": async () => {
    eq(trackingUrl("9400 1000 0000", "USPS"), "https://tools.usps.com/go/TrackConfirmAction?tLabels=940010000000");
    ok(trackingUrl("1Z999AA10123456784", "UPS").includes("ups.com"));
    eq(trackingUrl("123", ""), "");
    eq(trackingUrl("", "USPS"), "");
  },
  "the oldest records are dropped past the limit": async () => {
    const h = {};
    const many = Array.from({ length: MAX_RECORDS + 3 }, (_, i) => order("E-" + String(i).padStart(5, "0")));
    many.forEach((o, i) => recordPrinted(h, [o], { when: `2026-10-20 ${String(Math.floor(i / 60) % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}` }));
    eq(Object.keys(h).length, MAX_RECORDS);
  },
};

// ---------- the History page in the real app ----------

const clearStore = () => { for (const k of Object.values(KEYS)) remove(k); };

async function openApp(hash = "", { folder = false } = {}) {
  const old = document.getElementById("history-frame");
  if (old) old.remove();
  const f = document.createElement("iframe");
  f.id = "history-frame";
  f.style.cssText = "width:1200px;height:900px;border:1px solid #999";
  f.src = "../index.html" + hash;
  document.body.append(f);
  const win = await waitFor(() => f.contentWindow && f.contentWindow.shipdesk && f.contentWindow, "the app to start");
  const saved = [];
  const Orig = win.jspdf.jsPDF;
  function Spy(...args) { const d = new Orig(...args); d.save = (name) => { saved.push({ name }); return d; }; return d; }
  Object.assign(Spy, Orig);
  Spy.API = Orig.API;
  win.jspdf = { ...win.jspdf, jsPDF: Spy };
  const click = win.HTMLAnchorElement.prototype.click;
  win.HTMLAnchorElement.prototype.click = function () { if (this.download) saved.push({ name: this.download, href: this.href }); else click.call(this); };
  if (!folder) win.shipdesk.state.output.saveTo = "downloads";
  return { win, doc: f.contentDocument, app: win.shipdesk, saved };
}

const sampleText = async () => (await fetch("../samples/tcgplayer-sample.csv")).text();
const visible = (n) => n && !n.hidden && !n.closest("[hidden]");

tests["app: Download PDF puts the printed orders in History; the header switch shows it"] = async () => {
  clearStore();
  const { doc, app, saved } = await openApp();
  ok(visible(doc.querySelector("#main")) && !visible(doc.querySelector("#history-view")), "starts on the main page");
  ok(doc.querySelector("#history-count").hidden, "no badge while the history is empty");
  app.loadCsvText(await sampleText(), "sample.csv");
  app.setFilter("tracked");
  doc.querySelector("#btn-pdf").click();
  eq(saved.filter((s) => /^labels-/.test(s.name)).length, 1, "PDF saved");
  eq(Object.keys(app.state.history).length, 5, "5 tracked orders recorded");
  eq(doc.querySelector("#history-count").textContent, "5");
  eq(Object.keys(load(KEYS.history, {})).length, 5, "saved in browser storage");
  doc.querySelector("#view-history").click();
  await waitFor(() => visible(doc.querySelector("#history-view")), "History page");
  ok(!visible(doc.querySelector("#main")) && !visible(doc.querySelector(".steps")), "main page hidden");
  eq(doc.querySelectorAll("#history-table tbody tr[data-key]").length, 5);
  ok(doc.querySelector("#history-totals").textContent.includes("5 not shipped yet"));
  doc.querySelector("#view-ship").click();
  await waitFor(() => visible(doc.querySelector("#main")), "back to the main page");
};

tests["app: marking shipped in step 4 shows in History, and ticking in History updates step 4"] = async () => {
  clearStore();
  const { doc, app } = await openApp();
  app.loadCsvText(await sampleText(), "sample.csv");
  doc.querySelector("#btn-pdf").click();
  eq(Object.keys(app.state.history).length, 10);
  app.matchPasted("SAMPLE-0005 9400100000000000000000");
  const r5 = app.state.history["SAMPLE-0005"];
  eq([r5.shipped, r5.tracking, r5.carrier], [true, "9400100000000000000000", "USPS"]);
  app.showView("history");
  const row1 = doc.querySelector('#history-table tr[data-key="SAMPLE-0001"]');
  const box = row1.querySelector(".h-shipped");
  box.checked = true;
  box.dispatchEvent(new Event("change", { bubbles: true }));
  ok(app.state.history["SAMPLE-0001"].shipped, "history record shipped");
  ok(app.state.shipped["SAMPLE-0001"] && app.state.shipped["SAMPLE-0001"].shipped, "step 4 shipped list updated too");
  const csv = parseCsv(app.importFile().csv);
  ok(csv.some((row) => row[0] === "SAMPLE-0001" && row.includes("Shipped")), "import file includes it");
  // A tracking number typed in History.
  const row2 = doc.querySelector('#history-table tr[data-key="SAMPLE-0002"]');
  const trk = row2.querySelector(".h-trk");
  trk.value = "1Z999AA10123456784";
  trk.dispatchEvent(new Event("change", { bubbles: true }));
  eq([app.state.history["SAMPLE-0002"].carrier, app.state.shipped["SAMPLE-0002"].tracking], ["UPS", "1Z999AA10123456784"]);
  ok(doc.querySelector('#history-table tr[data-key="SAMPLE-0002"] a[href*="ups.com"]'), "track link shown");
  // Filters and search.
  doc.querySelector('#history-filters button[data-filter="shipped"]').click();
  eq(doc.querySelectorAll("#history-table tbody tr[data-key]").length, 3, "3 shipped");
  doc.querySelector('#history-filters button[data-filter="all"]').click();
  const s = doc.querySelector("#history-search");
  s.value = "SAMPLE-0007";
  s.dispatchEvent(new Event("input", { bubbles: true }));
  eq([...doc.querySelectorAll("#history-table tbody tr[data-key]")].map((t) => t.dataset.key), ["SAMPLE-0007"]);
  s.value = "";
  s.dispatchEvent(new Event("input", { bubbles: true }));
};

tests["app: History survives a reload, opens from #history, downloads CSV, removes and clears"] = async () => {
  // Uses the history left by the previous test.
  ok(Object.keys(load(KEYS.history, {})).length >= 10, "history saved by the previous test");
  const { doc, app, saved, win } = await openApp("#history");
  ok(visible(doc.querySelector("#history-view")), "#history opens the History page");
  eq(doc.querySelectorAll("#history-table tbody tr[data-key]").length, 10);
  doc.querySelector("#btn-history-csv").click();
  const file = saved.find((s) => /^ship-desk-history-\d{4}-\d{2}-\d{2}\.csv$/.test(s.name));
  ok(file, "history CSV saved");
  const rows = parseCsv(await (await fetch(file.href)).text());
  eq(rows.length, 11, "header + 10 orders");
  win.confirm = () => true;
  doc.querySelector('#history-table tr[data-key="SAMPLE-0003"] .h-del').click();
  ok(!app.state.history["SAMPLE-0003"], "removed one");
  eq(doc.querySelectorAll("#history-table tbody tr[data-key]").length, 9);
  doc.querySelector("#btn-clear-history").click();
  eq(Object.keys(app.state.history).length, 0, "cleared");
  ok(visible(doc.querySelector("#history-empty")), "empty note shown");
  ok(doc.querySelector("#history-count").hidden, "badge hidden");
  clearStore();
  document.getElementById("history-frame").remove();
};

// ---------- files saved into Ship Desk's Saved folder (tools/test.py points it at a throwaway folder) ----------

const savedBytes = async (rel) => {
  const r = await fetch("/__saved?rel=" + encodeURIComponent(rel));
  return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
};
const ascii = (bytes, n) => String.fromCharCode(...bytes.slice(0, n));

tests["saved folder: every file goes to its own subfolder, not to the browser's downloads"] = async () => {
  clearStore();
  const { doc, app, saved } = await openApp("", { folder: true });
  eq(app.state.output.saveTo, "folder", "the Saved folder is the default");
  ok(doc.querySelector('input[name="saveTo"][value="folder"]').checked, "radio shows it");
  app.loadCsvText(await sampleText(), "sample.csv");
  doc.querySelector("#btn-pdf").click();
  const pdf = await app.state.lastSave;
  eq(pdf.where, "folder");
  ok(/Labels[\\/]labels-\d{4}-\d{2}-\d{2}\.pdf$/.test(pdf.path), "labels path: " + pdf.path);
  eq(ascii(await savedBytes(pdf.path), 5), "%PDF-", "a real PDF was written");
  ok(doc.querySelector("#print-msg").textContent.includes(pdf.path), "message says where");
  ok(doc.querySelector("#print-msg .saved-where button"), "Open the folder button");
  // Same name again: kept, not overwritten.
  doc.querySelector("#btn-pdf").click();
  const again = await app.state.lastSave;
  ok(/labels-\d{4}-\d{2}-\d{2} \(2\)\.pdf$/.test(again.name), "second copy numbered: " + again.name);
  // CSVs go to their own folders.
  app.matchPasted("SAMPLE-0005 9400100000000000000000");
  doc.querySelector("#btn-import").click();
  const imp = await app.state.lastSave;
  ok(/TCGplayer import files[\\/]tcgplayer-import-/.test(imp.path), "import path: " + imp.path);
  ok(ascii(await savedBytes(imp.path), 7) === "Order #", "import file starts with the header");
  doc.querySelector("#btn-pirate").click();
  ok(/Pirate Ship[\\/]pirate-ship-/.test((await app.state.lastSave).path), "Pirate Ship path");
  app.showView("history");
  doc.querySelector("#btn-history-csv").click();
  ok(/History[\\/]ship-desk-history-/.test((await app.state.lastSave).path), "history path");
  eq(saved.length, 0, "nothing went through the browser's downloads");
  // Open the folder (the test server only records it).
  ok(await app.openSavedFolder("labels"), "open folder answered");
  const opened = (await (await fetch("/__opened")).json()).opened;
  ok(opened.some((p) => /Labels$/.test(p)), "asked to open the Labels folder");
  clearStore();
  document.getElementById("history-frame").remove();
};

tests["saved folder: switching to My Downloads uses the browser again, and it's remembered"] = async () => {
  clearStore();
  const { doc, app, saved, win } = await openApp("", { folder: true });
  const radio = doc.querySelector('input[name="saveTo"][value="downloads"]');
  radio.checked = true;
  radio.dispatchEvent(new win.Event("change", { bubbles: true }));
  eq(app.state.output.saveTo, "downloads");
  ok(doc.querySelector("#btn-open-folder").hidden, "no open-folder button for Downloads");
  eq(load(KEYS.output, {}).saveTo, "downloads", "saved setting");
  app.loadCsvText(await sampleText(), "sample.csv");
  doc.querySelector("#btn-pdf").click();
  eq((await app.state.lastSave).where, "downloads");
  eq(saved.length, 1, "browser download used");
  clearStore();
  document.getElementById("history-frame").remove();
};

tests["saved folder: the server refuses other websites and bad file names"] = async () => {
  const post = (url, headers = { "X-Ship-Desk": "1" }) => fetch(url, { method: "POST", headers, body: "x" });
  eq((await post("/api/save?kind=labels&name=a.pdf", {})).status, 403, "no X-Ship-Desk header");
  eq((await post("/api/save?kind=labels&name=..%2F..%2Fevil.pdf")).status, 400, "path in the name");
  eq((await post("/api/save?kind=labels&name=evil.exe")).status, 400, "only .pdf / .csv");
  eq((await post("/api/save?kind=windows&name=a.pdf")).status, 400, "unknown kind");
  eq((await post("/api/open-folder?kind=..")).status, 400, "unknown folder");
};

export { tests };
