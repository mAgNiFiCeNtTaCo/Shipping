// UI station tests: store.js on its own, then the real app page (../index.html) in an iframe.
import { ok, eq } from "./runner.js";
import { load, save, remove, KEYS } from "../js/store.js";
import { parseOrders } from "../js/csv.js";
import { filterOrders } from "../js/plan.js";

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

function clearStore() {
  for (const k of Object.values(KEYS)) remove(k);
}

/** Open the app in an iframe (width in px) and wait until it has started. */
async function openApp(width = 1200) {
  const old = document.getElementById("ui-frame");
  if (old) old.remove();
  const f = document.createElement("iframe");
  f.id = "ui-frame";
  f.style.cssText = `width:${width}px;height:900px;border:1px solid #999`;
  f.src = "../index.html";
  document.body.append(f);
  await waitFor(() => f.contentWindow && f.contentWindow.shipdesk, "the app to start");
  return { frame: f, win: f.contentWindow, doc: f.contentDocument, app: f.contentWindow.shipdesk };
}

async function reload(frame) {
  frame.contentWindow.shipdesk = null;
  frame.contentWindow.location.reload();
  await waitFor(() => frame.contentWindow.shipdesk && frame.contentDocument.readyState === "complete", "the app to restart");
  return { frame, win: frame.contentWindow, doc: frame.contentDocument, app: frame.contentWindow.shipdesk };
}

const sampleText = async () => (await fetch("../samples/tcgplayer-sample.csv")).text();
const bodyRows = (doc) => [...doc.querySelectorAll("#orders-table tbody tr[data-id]")];

function setField(win, input, value) {
  input.value = value;
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  input.dispatchEvent(new win.Event("change", { bubbles: true }));
}

export const tests = {
  "store: saves and loads values, fallback for missing or broken ones": async () => {
    clearStore();
    eq(load(KEYS.design, { a: 1 }), { a: 1 }, "missing key gives the fallback");
    ok(save(KEYS.design, { accent: "#123456", n: [1, 2] }), "save reaches localStorage");
    eq(load(KEYS.design, null), { accent: "#123456", n: [1, 2] });
    localStorage.setItem("shipdesk.broken", "{not json");
    eq(load("shipdesk.broken", "fb"), "fb", "corrupt JSON gives the fallback");
    localStorage.removeItem("shipdesk.broken");
    const fresh = await import("../js/store.js?fresh=" + Date.now());
    eq(fresh.load(KEYS.design, null), { accent: "#123456", n: [1, 2] }, "a fresh copy of the store reads the saved value");
    clearStore();
  },

  "store: keeps working when localStorage throws": async () => {
    const proto = Storage.prototype;
    const orig = { getItem: proto.getItem, setItem: proto.setItem, removeItem: proto.removeItem };
    const boom = () => { throw new DOMException("blocked", "SecurityError"); };
    proto.getItem = boom; proto.setItem = boom; proto.removeItem = boom;
    try {
      const s = await import("../js/store.js?blocked=" + Date.now());
      eq(s.load(s.KEYS.profiles, []), [], "load gives the fallback");
      eq(s.save(s.KEYS.profiles, [{ name: "A" }]), false, "save reports it only kept the value in memory");
      eq(s.load(s.KEYS.profiles, []), [{ name: "A" }], "the value is still there for this visit");
      s.remove(s.KEYS.profiles);
      eq(s.load(s.KEYS.profiles, "gone"), "gone", "remove works too");
    } finally {
      Object.assign(proto, orig);
    }
  },

  "app: the page starts with the drop zone, sample button and empty plan": async () => {
    clearStore();
    const { doc, app } = await openApp();
    ok(doc.querySelector("#dropzone"), "drop zone");
    ok(/Drop your TCGplayer shipping CSV/.test(doc.querySelector("#dropzone").textContent), "drop zone wording");
    ok(doc.querySelector("#btn-sample"), "Try the sample button");
    ok(!doc.querySelector("#plan-empty").hidden, "empty plan note shown");
    ok(doc.querySelector("#plan-area").hidden, "table hidden before a file");
    ok(doc.querySelectorAll("#format option").length >= 8, "every output format is offered");
    ok(doc.querySelectorAll("#filters button").length >= 4, "filter buttons");
    eq(app.state.orders.length, 0);
  },

  "app: Try the sample fills the table with every order": async () => {
    clearStore();
    const { doc } = await openApp();
    const expected = parseOrders(await sampleText()).orders.length;
    ok(expected >= 8, "the sample has orders");
    doc.querySelector("#btn-sample").click();
    await waitFor(() => bodyRows(doc).length, "rows to appear");
    eq(bodyRows(doc).length, expected, "one row per order");
    ok(doc.querySelector("#plan-empty").hidden, "empty note hidden");
    ok(/Loaded/.test(doc.querySelector("#load-msg").textContent), "success message");
    const chips = doc.querySelectorAll("#orders-table tbody .chip");
    eq(chips.length, expected, "a plan chip per row");
    const tags = new Set([...chips].map((c) => c.className.match(/tag-([\w-]+)/)[1]));
    for (const t of ["envelope", "tracking-recommended", "tracking-required", "signature"]) ok(tags.has(t), "sample shows tag " + t);
    ok(/order/.test(doc.querySelector("#totals").textContent), "totals line");
  },

  "app: filter buttons change the visible rows": async () => {
    clearStore();
    const { doc, app } = await openApp();
    app.loadCsvText(await sampleText(), "sample.csv");
    const all = bodyRows(doc).length;
    const envelopes = filterOrders(app.state.orders, "envelope", {}).length;
    ok(envelopes > 0 && envelopes < all, "sample has some envelope orders");
    doc.querySelector('#filters button[data-filter="envelope"]').click();
    eq(bodyRows(doc).length, envelopes, "envelope filter");
    eq(doc.querySelector('#filters button[data-filter="envelope"]').getAttribute("aria-pressed"), "true", "pressed state");
    doc.querySelector('#filters button[data-filter="tracked"]').click();
    eq(bodyRows(doc).length, all - envelopes, "tracked filter");
    doc.querySelector('#filters button[data-filter="all"]').click();
    eq(bodyRows(doc).length, all, "back to all");
  },

  "app: unticking rows changes what gets printed": async () => {
    clearStore();
    const { doc, app } = await openApp();
    app.loadCsvText(await sampleText(), "sample.csv");
    const n = app.printOrders().length;
    eq(n, bodyRows(doc).length, "every order ticked after loading");
    const box = doc.querySelector("#orders-table tbody input[type=checkbox]");
    box.click();
    eq(app.printOrders().length, n - 1, "one fewer to print");
    ok(doc.querySelector("#check-all").indeterminate, "tick-all shows a partial state");
    doc.querySelector("#check-all").click();
    eq(app.printOrders().length, n, "tick all");
    ok(/Download PDF \(\d+ orders\)/.test(doc.querySelector("#btn-pdf").textContent), "button shows the count");
  },

  "app: a CSV with the wrong columns shows the headers it found": async () => {
    clearStore();
    const { doc, app } = await openApp();
    const res = app.loadCsvText("Customer,Street Name,Town\nAsh,1 Main St,Austin\n", "wrong.csv");
    eq(res.orders.length, 0);
    const msg = doc.querySelector("#load-msg");
    ok(!msg.hidden && msg.classList.contains("error"), "error shown");
    const text = msg.textContent;
    for (const h of ["Customer", "Street Name", "Town"]) ok(text.includes(h), "found header listed: " + h);
    ok(/Export Shipping/.test(text), "says how to get the right file");
    ok(doc.querySelector("#plan-area").hidden, "no table");
  },

  "app: pasted addresses fill the table": async () => {
    clearStore();
    const { doc, app } = await openApp();
    app.loadPastedText("Jamie Sample\n12 Maple Ave\nSpringfield, IL 62701\n\nRobin Test\n400 Harbor Rd\nPortland, ME 04101\n");
    eq(bodyRows(doc).length, 2);
    eq(app.state.source, "paste");
    ok(doc.querySelector("#btn-import").disabled, "no TCGplayer import for pasted addresses");
  },

  "app: the return address survives a reload": async () => {
    clearStore();
    let { frame, win, doc, app } = await openApp();
    const f = doc.querySelector("#return-form");
    setField(win, f.elements.name, "Card Corner");
    setField(win, f.elements.street, "9 Test Lane");
    setField(win, f.elements.city, "Dayton");
    setField(win, f.elements.state, "oh");
    setField(win, f.elements.zip, "45402");
    eq(app.returnAddress().state, "OH", "state is upper-cased");
    ({ win, doc, app } = await reload(frame));
    const g = doc.querySelector("#return-form");
    eq(g.elements.name.value, "Card Corner", "name kept");
    eq(g.elements.zip.value, "45402", "ZIP kept");
    eq(app.returnAddress().street, "9 Test Lane");
    // A second profile, then switch back.
    doc.querySelector("#profile-new").click();
    eq(app.state.profiles.length, 2);
    eq(g.elements.name.value, "", "new profile starts empty");
    const pick = doc.querySelector("#profile-pick");
    pick.value = app.state.profiles[0].id;
    pick.dispatchEvent(new win.Event("change", { bubbles: true }));
    eq(g.elements.name.value, "Card Corner", "first profile picked again");
    clearStore();
  },

  "app: the loaded orders survive a reload until cleared": async () => {
    clearStore();
    let { frame, win, doc, app } = await openApp();
    ok(doc.querySelector("#batch-row").hidden, "no Clear button before a file");
    app.loadCsvText(await sampleText(), "sample.csv");
    const [a, b] = app.state.orders;
    const box = doc.querySelector(`#orders-table input[data-id="${a.id}"]`);
    box.checked = false;
    box.dispatchEvent(new win.Event("change", { bubbles: true }));
    app.matchPasted(`${b.id} 9400111899223344556677`);
    const count = app.state.orders.length;
    ({ win, doc, app } = await reload(frame));
    eq(app.state.orders.length, count, "orders back after a reload");
    eq(app.state.source, "csv");
    eq(app.state.fileName, "sample.csv");
    ok(!app.state.selected.has(a.id) && app.state.selected.has(b.id), "ticks kept");
    eq(bodyRows(doc).length, count, "table filled");
    ok(!doc.querySelector("#batch-row").hidden, "Clear button shown");
    ok(/still here/.test(doc.querySelector("#load-msg").textContent), "says the orders are back");
    eq(app.importFile().count, 1, "import file made without dropping the CSV again");

    doc.querySelector("#btn-clear-batch").click();
    eq(app.state.orders.length, 0, "cleared");
    eq(localStorage.getItem(KEYS.batch), null, "forgotten in the browser");
    ok(doc.querySelector("#batch-row").hidden && !doc.querySelector("#plan-empty").hidden, "page back to empty");
    ok(app.state.shipped[b.id], "shipped marks stay");
    ({ win, doc, app } = await reload(frame));
    eq(app.state.orders.length, 0, "still empty after a reload");

    app.loadPastedText("Jamie Sample\n12 Maple Ave\nSpringfield, IL 62701\n\nRobin Test\n400 Harbor Rd\nPortland, ME 04101\n");
    ({ win, doc, app } = await reload(frame));
    eq(app.state.source, "paste", "pasted addresses come back too");
    eq(bodyRows(doc).length, 2);
    ok(/Robin Test/.test(doc.querySelector("#paste-text").value), "pasted text back in the box");

    const kept = JSON.parse(localStorage.getItem(KEYS.batch));
    kept.at = new Date(Date.now() - 15 * 864e5).toISOString();
    localStorage.setItem(KEYS.batch, JSON.stringify(kept));
    ({ win, doc, app } = await reload(frame));
    eq(app.state.orders.length, 0, "a batch older than 14 days is forgotten");
    eq(localStorage.getItem(KEYS.batch), null, "and removed");
    clearStore();
  },

  "app: the PDF builds for the ticked orders": async () => {
    clearStore();
    const { app } = await openApp();
    app.loadCsvText(await sampleText(), "sample.csv");
    const opts = app.pdfOptions();
    eq(Object.keys(opts.plan).length, app.printOrders().length, "plan for every printed order");
    const doc = app.buildPdf();
    ok(doc && doc.getNumberOfPages() >= 1, "pages made");
    ok(/^\d{4}-\d{2}-\d{2}$/.test(app.today()), "date for the file name");
  },

  "app: tracking paste marks orders shipped and builds the import file": async () => {
    clearStore();
    const { doc, app } = await openApp();
    app.loadCsvText(await sampleText(), "sample.csv");
    const [a, b] = app.state.orders;
    app.matchPasted(`${a.id} 9400111899223344556677\n${b.id} 1Z999AA10123456784`);
    eq(app.state.shipped[a.id].tracking, "9400111899223344556677");
    eq(app.state.shipped[b.id].carrier, "UPS");
    ok(/Shipped/.test(doc.querySelector(`#orders-table tr[data-id="${a.id}"] .c-status`).textContent), "status column updated");
    const r = app.importFile();
    eq(r.count, 2, "two rows in the import file");
    ok(r.csv.includes("9400111899223344556677"), "tracking in the file");
    eq(load(KEYS.shipped, {})[a.id].tracking, "9400111899223344556677", "shipped state saved");
    app.clearShipped();
    eq(load(KEYS.shipped, null), {}, "history cleared");
    clearStore();
  },

  "app: no sideways scrolling at phone width": async () => {
    clearStore();
    const { doc, app } = await openApp(500);
    app.loadCsvText(await sampleText(), "sample.csv");
    await sleep(50);
    const root = doc.documentElement;
    ok(root.scrollWidth <= root.clientWidth + 1, `page is ${root.scrollWidth}px wide in a ${root.clientWidth}px window`);
    document.getElementById("ui-frame").remove();
  },

  "service worker caches every file the app loads": async () => {
    const sw = await (await fetch("../sw.js")).text();
    const html = await (await fetch("../index.html")).text();
    const app = await (await fetch("../js/app.js")).text();
    const used = new Set();
    for (const m of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) used.add(m[1]);
    for (const m of app.matchAll(/from "\.\/([\w.-]+\.js)"/g)) used.add("js/" + m[1]);
    used.add("vendor/pdf.worker.min.js");
    used.add("samples/tcgplayer-sample.csv");
    for (const u of used) ok(sw.includes(`"${u}"`), "sw.js caches " + u);
    ok(/const VERSION = "/.test(sw), "version constant");
  },
};
