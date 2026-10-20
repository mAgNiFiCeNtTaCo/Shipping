// QA station: the whole app end to end. The real page (../index.html) runs in an iframe; files go in the way a
// drop does, PDFs come out through the same function the Download PDF button calls and are read back with pdf.js.
import { ok, eq, near } from "./runner.js";
import { parseCsv, parseOrders } from "../js/csv.js";
import { FORMATS } from "../js/render.js";
import { KEYS, remove } from "../js/store.js";

const pdfjs = window.pdfjsLib;
if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = "../vendor/pdf.worker.min.js";

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

const clearStore = () => { for (const k of Object.values(KEYS)) remove(k); };

const RETURN = { name: "Taco Cards", street: "12 Return Rd", city: "Austin", state: "tx", zip: "78701" };

/**
 * Open the app in an iframe. Saves are caught instead of downloaded: `saved` collects
 * { name, doc } for PDFs (jsPDF .save) and { name, href } for files saved through a download link.
 */
async function openApp({ width = 1200, returnAddress = true } = {}) {
  clearStore();
  const old = document.getElementById("e2e-frame");
  if (old) old.remove();
  const f = document.createElement("iframe");
  f.id = "e2e-frame";
  f.style.cssText = `width:${width}px;height:900px;border:1px solid #999`;
  f.src = "../index.html";
  document.body.append(f);
  const win = await waitFor(() => f.contentWindow && f.contentWindow.shipdesk && f.contentWindow, "the app to start");
  const saved = [];
  const Orig = win.jspdf.jsPDF;
  function Spy(...args) {
    const d = new Orig(...args);
    d.save = (name) => { saved.push({ name, doc: d }); return d; };
    return d;
  }
  Object.assign(Spy, Orig);
  Spy.API = Orig.API;
  win.jspdf = { ...win.jspdf, jsPDF: Spy };
  const click = win.HTMLAnchorElement.prototype.click;
  win.HTMLAnchorElement.prototype.click = function () {
    if (this.download) saved.push({ name: this.download, href: this.href });
    else click.call(this);
  };
  const doc = f.contentDocument, app = win.shipdesk;
  // These tests catch browser downloads; the Saved-folder route is tested in history.test.js.
  app.state.output.saveTo = "downloads";
  if (returnAddress) {
    const form = doc.querySelector("#return-form");
    for (const [k, v] of Object.entries(RETURN)) {
      form.elements[k].value = v;
      form.elements[k].dispatchEvent(new win.Event("input", { bubbles: true }));
    }
  }
  return { frame: f, win, doc, app, saved };
}

/** Drop a file on the page the way the browser does when the user drags one in. */
async function dropFile(win, text, name, type = "text/csv") {
  const dt = new win.DataTransfer();
  dt.items.add(new win.File([text], name, { type }));
  const target = win.document.querySelector("#dropzone");
  for (const kind of ["dragenter", "dragover", "drop"]) {
    target.dispatchEvent(new win.DragEvent(kind, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }
}

function setOutput(win, doc, name, value) {
  const el = doc.querySelector(`#output-form [name="${name}"]`);
  if (el.type === "checkbox") el.checked = value; else el.value = value;
  el.dispatchEvent(new win.Event("change", { bubbles: true }));
}

async function readBack(jsdoc) {
  const pdf = await pdfjs.getDocument({ data: jsdoc.output("arraybuffer") }).promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const text = (await page.getTextContent()).items.map((i) => i.str).join(" ");
    pages.push({ w: vp.width / 72, h: vp.height / 72, text });
  }
  return { pages, text: pages.map((p) => p.text).join("\n") };
}

const savedText = async (s) => (await fetch(s.href)).text();
const sampleText = async () => (await fetch("../samples/tcgplayer-sample.csv")).text();
const SAMPLE_HEADER = "Order #,FirstName,LastName,Address1,Address2,City,State,PostalCode,Country,Order Date,Product Weight,Shipping Method,Item Count,Value Of Products,Shipping Fee Paid,Tracking #,Carrier";

const labelPages = (f, n) => (f.id === "labelSlip" ? n : Math.ceil(n / f.perPage));
const slipSize = (f) => (f.id.startsWith("thermal") ? [4, 6] : [8.5, 11]);

// A real-shaped export: BOM, CRLF, a quoted address with a comma, a 4-digit ZIP, a blank line and a row of empty
// cells, extra columns TCGplayer may add, a "$1,234.50" value, a ZIP+4, an accent and a quoted "" escape.
const MESSY = "﻿" + [
  "Order #,FirstName,LastName,Address1,Address2,City,State,PostalCode,Country,Order Date,Product Weight,Shipping Method,Item Count,Value Of Products,Shipping Fee Paid,Tracking #,Carrier,Buyer Notes,Direct Order",
  'REAL-1001,Noor,Haddad,"88 Elm St, Building 4",,Cambridge,MA,2139,US,10/18/2026,0.12,Standard (7-10 days),2,8.50,0.99,,,"Please ""no bends""",No',
  "",
  'REAL-1002,José,Peña,5 Mesa Rd,Apt 7,Santa Fe,NM,87501-1234,US,10/18/2026,0.30,Standard (7-10 days),5,"$1,234.50",0.00,,,,Yes',
  ",,,,,,,,,,,,,,,,,,",
  "REAL-1003,Kit,Lowe,19 Bay St,,Newport,RI,02840,US,10/19/2026,0.06,Expedited (1-5 days),1,4.00,4.99,,,,No",
  "",
].join("\r\n");

export const tests = {
  "dropping the sample CSV gives every order, the right plan tags and stamp counts": async () => {
    const { win, doc, app } = await openApp();
    await dropFile(win, await sampleText(), "TCGplayer_ShippingExport.csv");
    await waitFor(() => app.state.orders.length, "orders from the drop");
    eq(app.state.orders.length, 10, "10 sample orders");
    eq(app.state.source, "csv");
    eq(doc.querySelectorAll("#orders-table tbody tr[data-id]").length, 10, "10 table rows");
    ok(/Loaded 10 orders from TCGplayer_ShippingExport\.csv/.test(doc.querySelector("#load-msg").textContent), "load message names the file");
    const by = Object.fromEntries(app.state.orders.map((o) => [o.id, o]));
    eq(by["SAMPLE-0004"].zip, "08540", "4-digit ZIP gets its leading 0");
    eq(by["SAMPLE-0003"].zip, "02127", "leading-0 ZIP kept");
    eq(by["SAMPLE-0004"].address1, "310 Commerce Blvd, Suite 210", "quoted comma address");
    const tags = Object.fromEntries(app.state.orders.map((o) => [o.id, o.plan.tag]));
    eq(tags, {
      "SAMPLE-0001": "envelope", "SAMPLE-0002": "envelope", "SAMPLE-0003": "envelope", "SAMPLE-0004": "envelope",
      "SAMPLE-0005": "tracking-recommended", "SAMPLE-0006": "tracking-recommended", "SAMPLE-0007": "tracking-required",
      "SAMPLE-0008": "tracking-required", "SAMPLE-0009": "signature", "SAMPLE-0010": "envelope",
    }, "plan tags by TCGplayer thresholds");
    // SAMPLE-0001: 0.12 + 0.2 envelope + 0.16 slip + 0.3 toploader = 0.78 oz -> $0.82 + $0.49 rigid = $1.31 = 2 stamps.
    near(by["SAMPLE-0001"].plan.weightOz, 0.78, 0.001, "SAMPLE-0001 weight");
    near(by["SAMPLE-0001"].plan.postage, 1.31, 0.001, "SAMPLE-0001 postage");
    eq(by["SAMPLE-0001"].plan.stamps, 2, "SAMPLE-0001 stamps");
    // SAMPLE-0007: 0.48 + 0.2 + 0.16 + 0.6 (2 toploaders) = 1.44 oz -> $1.11 + $0.49 = $1.60 = 2 stamps.
    near(by["SAMPLE-0007"].plan.postage, 1.60, 0.001, "SAMPLE-0007 postage");
    eq(by["SAMPLE-0007"].plan.stamps, 2, "SAMPLE-0007 stamps");
    // Slips off: one slip lighter. SAMPLE-0001 = 0.62 oz, still $1.31.
    setOutput(win, doc, "slips", false);
    near(app.state.orders[0].plan.weightOz, 0.62, 0.001, "weight without a slip");
    ok(/10 orders/.test(doc.querySelector("#totals").textContent), "totals line counts 10 orders");
  },

  "every output format: the Download PDF path holds each buyer's name and ZIP, with the right page count": async () => {
    const { win, doc, app, saved } = await openApp();
    await dropFile(win, await sampleText(), "export.csv");
    await waitFor(() => app.state.orders.length === 10, "orders");
    const orders = app.state.orders;
    const offered = [...doc.querySelectorAll("#format option")].map((o) => o.value);
    eq(offered, FORMATS.map((f) => f.id), "the picker offers every format");
    for (const f of FORMATS) {
      for (const slips of [false, true]) {
        setOutput(win, doc, "format", f.id);
        setOutput(win, doc, "slips", slips);
        saved.length = 0;
        doc.querySelector("#btn-pdf").click();
        eq(saved.length, 1, `${f.id}: one PDF saved`);
        ok(/^labels-\d{4}-\d{2}-\d{2}\.pdf$/.test(saved[0].name), `${f.id}: file name ${saved[0].name}`);
        const r = await readBack(saved[0].doc);
        const labels = labelPages(f, orders.length);
        const expected = slips && f.id !== "labelSlip" ? labels + orders.length : labels;
        eq(r.pages.length, expected, `${f.id} slips=${slips}: page count`);
        for (let i = 0; i < labels; i++) {
          near(r.pages[i].w, f.pageSize[0], 0.01, `${f.id} page ${i + 1} width`);
          near(r.pages[i].h, f.pageSize[1], 0.01, `${f.id} page ${i + 1} height`);
        }
        for (let i = labels; i < r.pages.length; i++) near(r.pages[i].w, slipSize(f)[0], 0.01, `${f.id} slip page ${i + 1} width`);
        const labelText = r.pages.slice(0, labels).map((p) => p.text).join("\n");
        for (const o of orders) {
          ok(labelText.includes(o.name), `${f.id}: ${o.name} on the labels`);
          ok(labelText.includes(o.zip), `${f.id}: ZIP ${o.zip} on the labels`);
        }
        if (f.id !== "avery5160") ok(labelText.includes("Taco Cards") && labelText.includes("78701"), `${f.id}: return address`);
        if (slips) for (const o of orders) ok(r.text.includes(o.id), `${f.id}: order # ${o.id} on a slip`);
      }
    }
    ok(/Saved labels-/.test(doc.querySelector("#print-msg").textContent), "the page says the file was saved");
  },

  "the print selection and filters decide what goes in the PDF": async () => {
    const { win, doc, app, saved } = await openApp();
    await dropFile(win, await sampleText(), "export.csv");
    await waitFor(() => app.state.orders.length === 10, "orders");
    setOutput(win, doc, "format", "thermal4x6");
    setOutput(win, doc, "slips", false);
    doc.querySelector('#filters button[data-filter="tracked"]').click();
    doc.querySelector("#btn-pdf").click();
    const r = await readBack(saved.pop().doc);
    eq(r.pages.length, 5, "5 tracked orders = 5 labels");
    ok(r.text.includes("Rafael Ito-Brandt") && !r.text.includes("Ash Example"), "only tracked orders printed");
    doc.querySelector('#filters button[data-filter="all"]').click();
    doc.querySelector('#orders-table tbody tr[data-id="SAMPLE-0001"] input[type=checkbox]').click();
    doc.querySelector("#btn-pdf").click();
    const r2 = await readBack(saved.pop().doc);
    eq(r2.pages.length, 9, "unticked order left out");
    ok(!r2.text.includes("Ash Example"), "SAMPLE-0001 not printed");
  },

  "a messy real-shaped export (BOM, CRLF, quoted comma, 4-digit ZIP, blank rows, extra columns) loads cleanly": async () => {
    const { win, doc, app, saved } = await openApp();
    await dropFile(win, MESSY, "TCGplayer_ShippingExport_20261019.csv");
    await waitFor(() => app.state.orders.length, "orders");
    eq(app.state.orders.map((o) => o.id), ["REAL-1001", "REAL-1002", "REAL-1003"], "3 orders, blank rows dropped");
    ok(doc.querySelector("#load-msg").classList.contains("ok"), "no warning for blank rows");
    const [a, b, c] = app.state.orders;
    eq(a.id, "REAL-1001", "BOM stripped from the first header");
    eq(a.address1, "88 Elm St, Building 4");
    eq(a.zip, "02139", "4-digit ZIP fixed");
    eq(b.name, "José Peña");
    eq(b.zip, "87501-1234", "ZIP+4 kept");
    eq(b.value, 1234.5, "$1,234.50 read as a number");
    eq(b.plan.tag, "signature");
    eq(c.plan.tag, "tracking-recommended", "expedited");
    eq(a.row["Buyer Notes"], 'Please "no bends"', "quoted \"\" escape");
    setOutput(win, doc, "format", "letter4");
    doc.querySelector("#btn-pdf").click();
    const r = await readBack(saved.pop().doc);
    for (const o of app.state.orders) ok(r.text.includes(o.name) && r.text.includes(o.zip), `${o.name} ${o.zip} on the PDF`);
    // Mark them shipped and check the import file keeps the extra columns in their places.
    app.matchPasted("REAL-1002 9400111899223344556677");
    const box = doc.querySelector('#ship-list input[type=checkbox][data-id="REAL-1001"]');
    box.click();
    doc.querySelector("#btn-import").click();
    const file = saved.pop();
    const rows = parseCsv(await savedText(file));
    eq(rows[0], MESSY.slice(1).split("\r\n")[0].split(","), "original columns, original order");
    eq(rows.length, 3, "header + 2 shipped orders");
    eq(rows[1][0], "REAL-1001");
    eq(rows[1][15], "Shipped");
    eq(rows[1][17], 'Please "no bends"', "extra column kept");
    eq(rows[2][3], "5 Mesa Rd");
    eq(rows[2][15], "9400111899223344556677");
    eq(rows[2][16], "USPS");
    eq(rows[2][18], "Yes");
  },

  "pasted addresses print labels for every format": async () => {
    const { win, doc, app, saved } = await openApp();
    doc.querySelector("#tab-paste").click();
    doc.querySelector("#paste-text").value = [
      "Ship to:", "Jamie Sample", "12 Maple Ave", "Springfield, IL 62701", "(555) 010-0199", "",
      "Robin Test", "400 Harbor Rd", "Unit 3", "Portland, ME 04101", "United States", "",
      "Casey Demo", "77 Sunset Blvd", "Los Angeles, California 90028-7001", "casey@example.com",
    ].join("\n");
    doc.querySelector("#btn-paste").click();
    await waitFor(() => app.state.orders.length === 3, "3 pasted addresses");
    eq(app.state.source, "paste");
    eq(app.state.orders.map((o) => o.id), ["P-001", "P-002", "P-003"]);
    eq(app.state.orders[1].address2, "Unit 3");
    eq(app.state.orders[2].state, "CA", "full state name to code");
    ok(doc.querySelector("#btn-import").disabled, "no TCGplayer import file for pasted addresses");
    for (const f of FORMATS) {
      setOutput(win, doc, "format", f.id);
      doc.querySelector("#btn-pdf").click();
      const r = await readBack(saved.pop().doc);
      for (const o of app.state.orders) ok(r.text.includes(o.name) && r.text.includes(o.zip), `${f.id}: ${o.name} ${o.zip}`);
    }
  },

  "tracking paste -> import file -> parseCsv round trip with the original columns": async () => {
    const { win, doc, app, saved } = await openApp();
    await dropFile(win, await sampleText(), "export.csv");
    await waitFor(() => app.state.orders.length === 10, "orders");
    // Print first so bare tracking numbers follow the label order.
    setOutput(win, doc, "format", "thermal4x6");
    doc.querySelector('#filters button[data-filter="tracked"]').click();
    doc.querySelector("#btn-pdf").click();
    saved.length = 0;
    doc.querySelector("#track-text").value = [
      "9400 1118 9922 3344 5566 77",            // bare -> 1st printed label (SAMPLE-0005)
      "SAMPLE-0009\t1Z999AA10123456784",        // order # + tab
      "9405511899223344556611",                 // bare -> next label without one (SAMPLE-0006)
    ].join("\n");
    doc.querySelector("#btn-match").click();
    eq(app.state.shipped["SAMPLE-0005"].tracking, "9400111899223344556677", "bare number to the first label, spaces removed");
    eq(app.state.shipped["SAMPLE-0006"].tracking, "9405511899223344556611");
    eq(app.state.shipped["SAMPLE-0009"].carrier, "UPS");
    ok(/Matched 3 tracking numbers/.test(doc.querySelector("#match-msg").textContent), "match message");
    doc.querySelector("#btn-import").click();
    eq(saved.length, 1, "one file saved");
    ok(/^tcgplayer-import-\d{4}-\d{2}-\d{2}\.csv$/.test(saved[0].name), saved[0].name);
    const text = await savedText(saved[0]);
    ok(text.includes("\r\n"), "CRLF line ends");
    const rows = parseCsv(text);
    eq(rows[0].join(","), SAMPLE_HEADER, "same columns as the export, same order");
    eq(rows.length, 4, "header + 3 orders");
    const back = parseOrders(text);
    eq(back.errors, [], "the import file reads back as orders");
    const t = Object.fromEntries(back.orders.map((o) => [o.id, [o.tracking, o.carrier]]));
    eq(t, { "SAMPLE-0005": ["9400111899223344556677", "USPS"], "SAMPLE-0006": ["9405511899223344556611", "USPS"], "SAMPLE-0009": ["1Z999AA10123456784", "UPS"] });
    const src = parseCsv(await sampleText());
    const orig = src.find((r) => r[0] === "SAMPLE-0009"), out = rows.find((r) => r[0] === "SAMPLE-0009");
    eq(out.slice(0, 15), orig.slice(0, 15), "every other cell unchanged");
    ok(/Import Shipping Info/.test(doc.querySelector("#ship-msg").textContent), "says where to upload it");
  },

  "untracked orders ticked Shipped go in the import file with the Shipped keyword": async () => {
    const { win, doc, app, saved } = await openApp();
    await dropFile(win, await sampleText(), "export.csv");
    await waitFor(() => app.state.orders.length === 10, "orders");
    for (const id of ["SAMPLE-0001", "SAMPLE-0002", "SAMPLE-0008"]) doc.querySelector(`#ship-list input[type=checkbox][data-id="${id}"]`).click();
    ok(/SAMPLE-0008/.test(doc.querySelector("#ship-warn").textContent), "$49.99+ order without tracking is flagged");
    ok(/Shipped/.test(doc.querySelector('#orders-table tr[data-id="SAMPLE-0001"] .c-status').textContent), "table shows Shipped");
    doc.querySelector("#btn-import").click();
    const rows = parseCsv(await savedText(saved.pop()));
    eq(rows.slice(1).map((r) => [r[0], r[15], r[16]]), [["SAMPLE-0001", "Shipped", ""], ["SAMPLE-0002", "Shipped", ""], ["SAMPLE-0008", "Shipped", ""]]);
    ok(/refuse SAMPLE-0008/.test(doc.querySelector("#ship-msg").textContent), "warning repeated after saving");
    // A tracking number typed in the box replaces the keyword and clears the warning.
    const box = doc.querySelector('#ship-list .trk-input[data-id="SAMPLE-0008"]');
    box.value = "9400111899223344550008";
    box.dispatchEvent(new win.Event("change", { bubbles: true }));
    ok(!/SAMPLE-0008/.test(doc.querySelector("#ship-warn").textContent), "warning gone");
    doc.querySelector("#btn-import").click();
    const rows2 = parseCsv(await savedText(saved.pop()));
    eq(rows2.find((r) => r[0] === "SAMPLE-0008").slice(15), ["9400111899223344550008", "USPS"]);
    // Shipped orders are remembered: dropping the same file again leaves them unticked for printing.
    await dropFile(win, await sampleText(), "export.csv");
    await sleep(100);
    eq(app.printOrders().length, 7, "3 shipped orders not ticked again");
  },

  "Pirate Ship CSV lists tracked orders that have no tracking yet": async () => {
    const { win, doc, app, saved } = await openApp();
    await dropFile(win, await sampleText(), "export.csv");
    await waitFor(() => app.state.orders.length === 10, "orders");
    app.matchPasted("SAMPLE-0007 9400111899223344556677");
    doc.querySelector("#btn-pirate").click();
    const s = saved.pop();
    ok(/^pirate-ship-\d{4}-\d{2}-\d{2}\.csv$/.test(s.name), s.name);
    const rows = parseCsv(await savedText(s));
    eq(rows[0], ["Order ID", "Name", "Address", "Address Line 2", "City", "State", "Zipcode", "Country", "Ounces"]);
    eq(rows.slice(1).map((r) => r[0]), ["SAMPLE-0005", "SAMPLE-0006", "SAMPLE-0008", "SAMPLE-0009"], "tracked orders minus the one with tracking");
    const r9 = rows.find((r) => r[0] === "SAMPLE-0009");
    eq(r9, ["SAMPLE-0009", "Rafael Ito-Brandt", "1400 Lakeshore Dr", "Suite 900", "Chicago", "IL", "60611", "US", "0.9"], "0.18 + 0.2 + 0.16 + 0.3 = 0.84 oz, rounded up to 0.9");
  },

  "offline: the service worker caches every file the app loads": async () => {
    // Every file: the page's src/href, every module import (followed through the modules), the pdf.js worker,
    // the manifest's icons and the sample.
    const need = new Set(["index.html", "vendor/pdf.worker.min.js", "samples/tcgplayer-sample.csv"]);
    const html = await (await fetch("../index.html")).text();
    for (const m of html.matchAll(/(?:src|href)="([^"#:?]+)/g)) need.add(m[1].replace(/^\.\//, ""));
    const queue = [...need].filter((p) => p.endsWith(".js") && p.startsWith("js/"));
    while (queue.length) {
      const p = queue.shift();
      const src = await (await fetch("../" + p)).text();
      for (const m of src.matchAll(/(?:from|import)\s*\(?\s*"\.\/([\w.-]+\.js)"/g)) {
        const q = "js/" + m[1];
        if (!need.has(q)) { need.add(q); queue.push(q); }
      }
    }
    const manifest = await (await fetch("../manifest.webmanifest")).json();
    for (const i of manifest.icons || []) need.add(i.src.replace(/^\.\//, ""));
    const sw = await (await fetch("../sw.js")).text();
    for (const p of need) ok(sw.includes(`"${p}"`), "sw.js lists " + p);
    // And it really caches them: register it, let it install, look in the cache.
    const version = sw.match(/const VERSION = "([^"]+)"/)[1];
    const reg = await navigator.serviceWorker.register("../sw.js", { scope: "../" });
    try {
      await waitFor(() => reg.active, "the service worker to activate", 15000);
      const cache = await caches.open(version);
      for (const p of need) ok(await cache.match(new URL("../" + p, location.href).href), "cached: " + p);
      ok(await cache.match(new URL("../", location.href).href), "cached: the start page ./");
    } finally {
      await reg.unregister();
      await caches.delete(version);
    }
    document.getElementById("e2e-frame")?.remove();
    clearStore();
  },
};
