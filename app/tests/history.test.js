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
  eq(saved.filter((s) => /^Labels? \d{4}-/.test(s.name)).length, 1, "PDF saved");
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
  const file = saved.find((s) => /^Ship Desk history \d{4}-\d{2}-\d{2} \d{2}-\d{2} - \d+ orders?\.csv$/.test(s.name));
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
  ok(/Labels[\\/]Labels \d{4}-\d{2}-\d{2} \d{2}-\d{2} - 10 orders - [^\\/]+ and \d+ more\.pdf$/.test(pdf.path), "labels path: " + pdf.path);
  eq(ascii(await savedBytes(pdf.path), 5), "%PDF-", "a real PDF was written");
  ok(doc.querySelector("#print-msg").textContent.includes(pdf.path), "message says where");
  ok(doc.querySelector("#print-msg .saved-where button"), "Open the folder button");
  // Same name again: kept, not overwritten.
  doc.querySelector("#btn-pdf").click();
  const again = await app.state.lastSave;
  ok(again.name !== pdf.name, "second copy kept under its own name: " + again.name);
  eq(ascii(await savedBytes(pdf.path), 5), "%PDF-", "the first copy is still there");
  // CSVs go to their own folders.
  app.matchPasted("SAMPLE-0005 9400100000000000000000");
  doc.querySelector("#btn-import").click();
  const imp = await app.state.lastSave;
  ok(/TCGplayer import files[\\/]TCGplayer import \d{4}-/.test(imp.path), "import path: " + imp.path);
  ok(ascii(await savedBytes(imp.path), 7) === "Order #", "import file starts with the header");
  doc.querySelector("#btn-pirate").click();
  ok(/Pirate Ship[\\/]Pirate Ship \d{4}-/.test((await app.state.lastSave).path), "Pirate Ship path");
  app.showView("history");
  doc.querySelector("#btn-history-csv").click();
  ok(/History[\\/]Ship Desk history \d{4}-/.test((await app.state.lastSave).path), "history path");
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

tests["security: the History CSV keeps buyer names that look like formulas as text (other files stay exact)"] = async () => {
  const h = {};
  recordPrinted(h, [order("F-1", { name: "=HYPERLINK(\"http://x\",\"hi\")" }), order("F-2", { name: "+1 Plus" }), order("F-3", { name: "@Pat" }),
    order("F-4", { name: "-Dash" }), order("F-5", { name: "Normal Name" })], { when: "2026-10-25 10:00" });
  const rows = parseCsv(historyCsv(historyList(h)));
  const names = Object.fromEntries(rows.slice(1).map((r) => [r[0], r[1]]));
  eq(names["F-1"], "'=HYPERLINK(\"http://x\",\"hi\")", "formula kept as text");
  eq([names["F-2"], names["F-3"], names["F-4"], names["F-5"]], ["'+1 Plus", "'@Pat", "'-Dash", "Normal Name"]);
  ok(rows.slice(1).every((r) => r[5] === "12.50"), "numbers untouched");
  const { toCsv } = await import("../js/csv.js");
  eq(toCsv([["=SUM(A1)", "-5", "x"]]), "=SUM(A1),-5,x\r\n", "files for TCGplayer / Pirate Ship stay exact");
};

tests["copy on the PC: a cleared browser is offered the saved History; a linked browser keeps the copy current"] = async () => {
  const PC = { "X-Ship-Desk": "1" };
  const copy = async () => (await fetch("/api/history-copy", { headers: PC })).json();
  const put = (history) => fetch("/api/history-copy", { method: "POST", headers: { ...PC, "Content-Type": "application/json" }, body: JSON.stringify({ history }) });
  eq((await fetch("/api/history-copy")).status, 403, "only Ship Desk's own page reads it");
  eq((await fetch("/api/history-copy", { method: "POST", body: "{}" })).status, 403, "or writes it");
  eq((await fetch("/api/history-copy", { method: "POST", headers: PC, body: "[]" })).status, 400, "not a History list: refused");
  eq((await fetch("/api/history-copy", { method: "POST", headers: PC, body: JSON.stringify({ history: { a: 1 } }) })).status, 400, "records must be objects");
  // A copy from before: two orders, one shipped with tracking.
  const h = {};
  recordPrinted(h, [order("C-1"), order("C-2")], { format: "thermal4x6", when: "2026-10-22 10:00" });
  recordShipped(h, order("C-2"), { tracking: "9400100000000000000222", carrier: "USPS", shipped: true }, { when: "2026-10-22 16:00" });
  ok((await put(h)).ok, "copy written");
  eq((await copy()).count, 2);
  // This browser lost its History (cleared): it's asked, and doesn't overwrite the copy meanwhile.
  clearStore();
  let { doc, app, win } = await openApp("#history");
  await waitFor(() => visible(doc.querySelector("#history-copy")), "the offer");
  ok(doc.querySelector("#history-copy-text").textContent.includes("2 orders"), doc.querySelector("#history-copy-text").textContent);
  app.loadCsvText(await sampleText(), "sample.csv");
  doc.querySelector("#btn-pdf").click(); // a change before answering
  await sleep(1200);
  eq((await copy()).count, 2, "the copy wasn't overwritten by the cleared browser");
  doc.querySelector("#btn-history-restore").click();
  await waitFor(() => !visible(doc.querySelector("#history-copy")) && app.state.history["C-2"], "the restore");
  ok(app.state.history["C-1"] && Object.keys(app.state.history).length === 12, "both: the copy's 2 + this browser's 10");
  eq(app.state.shipped["C-2"] && app.state.shipped["C-2"].tracking, "9400100000000000000222", "step 4's shipped list rebuilt");
  await waitFor(async () => (await copy()).count === 12, "the copy to follow");
  ok(doc.querySelector("#history-totals").textContent.includes("copy in Saved\\History"), "History says where the copy is");
  // Reopened: linked, nothing to ask.
  ({ doc, app, win } = await openApp("#history"));
  await sleep(600);
  ok(!visible(doc.querySelector("#history-copy")), "no offer for the linked browser");
  // Clear history: the copy follows (the dated backup of the day stays).
  win.confirm = () => true;
  doc.querySelector("#btn-clear-history").click();
  await waitFor(async () => (await copy()).count === 0, "the copy to be cleared too");
  // Another browser with its own, different History: Keep makes it the copy.
  ok((await put(h)).ok);
  clearStore();
  ({ doc, app, win } = await openApp("#history"));
  app.loadCsvText(await sampleText(), "sample.csv");
  app.setFilter("tracked");
  doc.querySelector("#btn-pdf").click();
  app.checkHistoryCopy();
  await waitFor(() => visible(doc.querySelector("#history-copy")), "the offer (different History)");
  win.confirm = () => true;
  doc.querySelector("#btn-history-keep").click();
  await waitFor(async () => (await copy()).count === 5, "this browser's 5 orders to become the copy");
  ok(!visible(doc.querySelector("#history-copy")), "offer gone");
  document.getElementById("history-frame").remove();
  clearStore();
};

tests["backup: the Saved folder is copied to the backup folder (OneDrive), only what's new, never the pairing code"] = async () => {
  clearStore();
  const H = { "X-Ship-Desk": "1" };
  eq((await fetch("/api/backup?on=1", { method: "POST" })).status, 403, "only Ship Desk's own page");
  eq((await fetch("/api/backup", { method: "POST", headers: H })).status, 400, "a POST that doesn't say what to do");
  const before = await (await fetch("/api/backup", { headers: H })).json();
  ok(before.available && !before.on, "available, off at first: " + JSON.stringify(before));
  // Something to back up: a label PDF, and the phone's pairing code (which must stay on this PC).
  const { doc, app, win } = await openApp("", { folder: true });
  app.loadCsvText(await sampleText(), "sample.csv");
  doc.querySelector("#btn-pdf").click();
  const pdf = await app.state.lastSave;
  await fetch("/api/phone-link", { headers: H });
  app.showView("history");
  await waitFor(() => visible(doc.querySelector("#backup-row")), "the backup row on the History page");
  ok(!doc.querySelector("#backup-on").checked && /Off/.test(doc.querySelector("#backup-text").textContent), "shows it's off");
  const box = doc.querySelector("#backup-on");
  box.checked = true;
  box.dispatchEvent(new win.Event("change", { bubbles: true }));
  await waitFor(() => /Last backup \d{4}-\d{2}-\d{2}/.test(doc.querySelector("#backup-text").textContent), "the first backup");
  const files = (await (await fetch("/__backup")).json()).files;
  ok(files.includes("Labels/" + pdf.name), "the label PDF is in the backup: " + JSON.stringify(files));
  ok(!files.some((f) => /pairing-code/.test(f)), "the pairing code is not");
  ok(!files.includes("backup.json") && !files.some((f) => /\.(tmp|part)$/.test(f)), "nor the backup's own note or half-written files");
  const on = await (await fetch("/api/backup", { headers: H })).json();
  ok(on.on && on.copied >= 1 && on.files === files.length, "status: " + JSON.stringify(on));
  // Again: nothing new.
  const again = await app.backupNow();
  eq(again.copied, 0, "only new or changed files are copied");
  ok(/nothing new/.test(doc.querySelector("#backup-text").textContent));
  // A changed file is copied again; a deleted one stays in the backup.
  await fetch("/api/history-copy", { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ history: { "X-1": { key: "X-1", id: "X-1", name: "A" } } }) });
  eq((await app.backupNow()).copied >= 1, true, "the new History copy is backed up");
  doc.querySelector("#btn-backup-open").click();
  await waitFor(async () => (await (await fetch("/__opened")).json()).opened.some((p) => /shipdesk-backup-/.test(p)), "the backup folder to open");
  box.checked = false;
  box.dispatchEvent(new win.Event("change", { bubbles: true }));
  await waitFor(async () => !(await (await fetch("/api/backup", { headers: H })).json()).on, "switched off");
  ok((await (await fetch("/__backup")).json()).files.includes("Labels/" + pdf.name), "switching off keeps what's backed up");
  clearStore();
  document.getElementById("history-frame").remove();
};

export { tests };
