// Ship Desk: the page. Wires the drop zone, return address, plan table, print options, label design
// and tracking panels to the Data modules (csv / plan / tracking / paste) and the PDF modules
// (render / slips). See CONTRACT.md "app.js / store.js / UI".

import { load, save, KEYS } from "./store.js";
import { parseOrders } from "./csv.js";
import { planOrder, DEFAULT_PLAN_SETTINGS, FILTERS, filterOrders, summarize, TAG_LABELS } from "./plan.js";
import { detectCarrier, matchTracking, importFileCsv, pirateShipCsv } from "./tracking.js";
import { parseAddresses } from "./paste.js";
import { renderPdf, FORMATS, slipsInLabelOrderPdf } from "./render.js";
import { readSlipPdf, attachSlips } from "./slips.js";
import { HISTORY_FILTERS, recordPrinted, recordShipped, applyShipped, historyCounts, historyList, historyCsv,
  trackingUrl, formatName } from "./history.js";

// ---------- small helpers ----------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

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
const money = (v) => "$" + (Number(v) || 0).toFixed(2);
const oz = (v) => (v == null ? "" : Number(v).toFixed(2) + " oz");

/** Today's date on this PC as YYYY-MM-DD. */
export function today(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function asList(x) {
  if (Array.isArray(x)) return x;
  return Object.entries(x || {}).map(([id, v]) => (typeof v === "string" ? { id, label: v } : { id, ...v }));
}

/** A message box: kind = ok | warn | error | info; lines are strings or nodes. */
function showMsg(box, kind, title, lines = []) {
  if (!box) return;
  if (!title) { box.hidden = true; box.replaceChildren(); return; }
  box.className = `msg ${kind}`;
  box.replaceChildren(el("p", { class: "msg-title", text: title }), ...lines.filter(Boolean).map((l) => (l instanceof Node ? l : el("p", { text: l }))));
  box.hidden = false;
}

let toastTimer = 0;
function toast(text) {
  const t = $("#toast");
  if (!t) return;
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 4500);
}

function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/**
 * Save a file the app made. With saveTo "folder" (the default) serve.py writes it into Ship Desk's Saved
 * folder (Saved\<kind folder>\name); with "downloads", or when that fails (server not running), the browser
 * downloads it. kind: labels | slips | import | pirate | history. getBlob() makes the file; download() is the
 * browser way (jsPDF's doc.save or a download link). The browser download happens before any await, so a
 * click handler still counts as the user's action. Resolves to { where: "folder" | "downloads", name, path?, fellBack? }.
 */
function deliver(name, kind, getBlob, download) {
  if (state.output.saveTo === "downloads") {
    download();
    return Promise.resolve({ where: "downloads", name });
  }
  return (async () => {
    try {
      const r = await fetch(`api/save?kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(name)}`, {
        method: "POST", headers: { "X-Ship-Desk": "1", "Content-Type": "application/octet-stream" }, body: getBlob(),
      });
      const info = r.ok ? await r.json() : null;
      if (info && info.ok) return { where: "folder", name: info.name, path: info.path, folder: info.folder, kind };
    } catch { /* server not running: fall back to a normal download */ }
    download();
    return { where: "downloads", name, fellBack: true };
  })();
}

const saveBlob = (name, kind, blob) => deliver(name, kind, () => blob, () => downloadBlob(name, blob));
const savePdf = (doc, name, kind) => deliver(name, kind, () => doc.output("blob"), () => doc.save(name));

/** Ask serve.py to open the Saved folder (or one kind's subfolder) in Explorer. */
export async function openSavedFolder(kind = "") {
  try {
    const r = await fetch(`api/open-folder?kind=${encodeURIComponent(kind)}`, { method: "POST", headers: { "X-Ship-Desk": "1" } });
    if (r.ok) return true;
  } catch { /* not running */ }
  toast("The Saved folder couldn't be opened. Start Ship Desk with \"Start Ship Desk.bat\".");
  return false;
}

// The lines of a "Saved ..." message: where the file went, and a button to open that folder.
function savedLines(res) {
  if (res.where === "folder") {
    return [el("p", { class: "saved-where" }, "In ", el("code", { text: res.path }), " ",
      el("button", { type: "button", class: "link", text: "Open the folder", onclick: () => openSavedFolder(res.kind) }))];
  }
  return [res.fellBack ? "Ship Desk's Saved folder couldn't be reached (is the Ship Desk window still open?), so it went to your Downloads folder." : "In your Downloads folder."];
}

// ---------- state ----------

const DEFAULT_DESIGN = { accent: "#136f63", font: "helvetica", logo: null, darkness: 0, note: "", qrUrl: "", slipMessage: "" };
const DEFAULT_OUTPUT = { format: "", slips: true, boldReturn: false, noDivider: false, slipsInLabelOrder: false, saveTo: "folder" };
const ADDRESS_FIELDS = ["name", "phone", "street", "street2", "city", "state", "zip"];
const formatList = asList(FORMATS);
const filterList = asList(FILTERS);

export const state = {
  source: "",          // "csv" (TCGplayer file) or "paste"
  fileName: "",
  orders: [],
  selected: new Set(), // order ids ticked for printing
  filter: "all",
  slips: null,         // { byOrder, unmatchedPages, fileName } from readSlipPdf
  lastPrinted: [],     // order ids in the order they were last printed (label order for tracking)
  done: { 3: false, 4: false },
  profiles: [],
  activeProfile: "",
  design: { ...DEFAULT_DESIGN },
  output: { ...DEFAULT_OUTPUT },
  plan: { ...DEFAULT_PLAN_SETTINGS },
  shipped: {},
  history: {},         // history.js records, by key
  historyFilter: "all",
  historySearch: "",
};

function newProfile(label = "My store") {
  return { id: "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), label, ...Object.fromEntries(ADDRESS_FIELDS.map((f) => [f, ""])) };
}

function loadSettings() {
  const profiles = load(KEYS.profiles, []);
  state.profiles = Array.isArray(profiles) && profiles.length ? profiles : [newProfile()];
  const active = load(KEYS.activeProfile, "");
  state.activeProfile = state.profiles.some((p) => p.id === active) ? active : state.profiles[0].id;
  state.design = { ...DEFAULT_DESIGN, ...load(KEYS.design, {}) };
  state.output = { ...DEFAULT_OUTPUT, ...load(KEYS.output, {}) };
  if (!formatList.some((f) => f.id === state.output.format)) state.output.format = formatList[0] ? formatList[0].id : "";
  state.plan = { ...DEFAULT_PLAN_SETTINGS, ...load(KEYS.plan, {}) };
  const shipped = load(KEYS.shipped, {});
  state.shipped = shipped && typeof shipped === "object" ? shipped : {};
  const history = load(KEYS.history, {});
  state.history = history && typeof history === "object" && !Array.isArray(history) ? history : {};
}

const activeProfile = () => state.profiles.find((p) => p.id === state.activeProfile) || state.profiles[0];

/** The return address in the shape render.js wants. */
export function returnAddress() {
  const p = activeProfile() || {};
  return Object.fromEntries(ADDRESS_FIELDS.map((f) => [f, (p[f] || "").trim()]));
}

const hasReturnAddress = () => { const r = returnAddress(); return !!(r.name && r.street && r.city && r.state && r.zip); };

export function planSettings() {
  return { ...DEFAULT_PLAN_SETTINGS, ...state.plan, slips: !!state.output.slips };
}

function replan() {
  const s = planSettings();
  for (const o of state.orders) o.plan = planOrder(o, s);
}

/** Orders shown in the table (filter applied), in file order. */
export function visibleOrders() {
  return filterOrders(state.orders, state.filter, state.shipped);
}

/** Orders that go into the PDF: shown and ticked, in table order. */
export function printOrders() {
  return visibleOrders().filter((o) => state.selected.has(o.id));
}

const isShippedNow = (o) => { const s = state.shipped[o.id]; return !!(o.tracking || (s && (s.tracking || s.shipped))); };

// ---------- loading orders ----------

function setBatch(source, orders, fileName) {
  state.source = source;
  state.fileName = fileName;
  state.orders = orders;
  state.filter = "all";
  state.slips = null;
  state.lastPrinted = [];
  state.done = { 3: false, 4: false };
  replan();
  const fresh = orders.filter((o) => !isShippedNow(o));
  state.selected = new Set((fresh.length ? fresh : orders).map((o) => o.id));
  renderAll();
}

/** Load the text of a TCGplayer shipping CSV (what a drop or "Try the sample" does). */
export function loadCsvText(text, fileName = "your file") {
  const box = $("#load-msg");
  const res = parseOrders(String(text || ""));
  if (!res.orders.length) {
    showLoadProblem(res, fileName);
    return res;
  }
  setBatch("csv", res.orders, fileName);
  const already = res.orders.filter(isShippedNow).length;
  const lines = [];
  if (res.skipped.length) lines.push(skippedList(res.skipped));
  if (already) lines.push(`${plural(already, "order was", "orders were")} already marked shipped, so ${already === 1 ? "it is" : "they are"} not ticked for printing.`);
  showMsg(box, res.skipped.length ? "warn" : "ok",
    `Loaded ${plural(res.orders.length, "order")} from ${fileName}.` + (res.skipped.length ? ` ${plural(res.skipped.length, "row")} could not be used:` : ""), lines);
  return res;
}

function skippedList(skipped) {
  return el("ul", { class: "plain" }, skipped.slice(0, 12).map((s) => el("li", { text: `Line ${s.line}: ${s.reason}` })),
    skipped.length > 12 ? el("li", { text: `…and ${skipped.length - 12} more.` }) : null);
}

function showLoadProblem(res, fileName) {
  const box = $("#load-msg");
  if (res.errors && res.errors.length) {
    const lines = [res.errors[0]];
    if (res.headers && res.headers.length) {
      lines.push(el("div", { class: "found" }, el("span", { class: "small muted", text: "Columns in your file: " }),
        res.headers.filter((h) => String(h).trim()).map((h) => el("code", { text: h }))));
    }
    lines.push("Make sure you used Export Shipping in the TCGplayer Seller Portal (Orders → tick orders → Export Shipping). The Packing Slip button makes a PDF, not this file.");
    showMsg(box, "error", `${fileName} doesn't look like TCGplayer's shipping export.`, lines);
  } else if (res.skipped && res.skipped.length) {
    showMsg(box, "error", `None of the rows in ${fileName} could be used.`, [skippedList(res.skipped)]);
  } else {
    showMsg(box, "error", `${fileName} has no orders in it.`, ["Open the file to check it has rows under the header line, or export it again from TCGplayer."]);
  }
}

/** Use pasted addresses as the batch (step 1, Paste tab). */
export function loadPastedText(text) {
  const box = $("#load-msg");
  const res = parseAddresses(String(text || ""));
  const probs = (res.problems || []).map((p) => el("li", { text: `${p.reason}: "${String(p.text).replace(/\s+/g, " ").slice(0, 80)}"` }));
  if (!res.orders.length) {
    showMsg(box, "error", "No addresses found in what you pasted.", ["Put each address on its own lines (name, street, city ST ZIP) with a blank line between addresses.",
      probs.length ? el("ul", { class: "plain" }, probs) : null]);
    return res;
  }
  setBatch("paste", res.orders, "pasted addresses");
  showMsg(box, probs.length ? "warn" : "ok", `Got ${plural(res.orders.length, "address", "addresses")}.` + (probs.length ? ` ${plural(probs.length, "part")} could not be read:` : ""),
    [probs.length ? el("ul", { class: "plain" }, probs) : null]);
  return res;
}

async function loadSample(jump = true) {
  try {
    const r = await fetch("samples/tcgplayer-sample.csv");
    if (!r.ok) throw new Error("status " + r.status);
    loadCsvText(await r.text(), "the sample file");
    if (jump) jumpTo("#step2");
  } catch {
    showMsg($("#load-msg"), "error", "The sample file couldn't be opened.", ["Start Ship Desk with \"Start Ship Desk.bat\" and try again."]);
  }
}

async function handleFiles(files) {
  const list = [...(files || [])];
  if (!list.length) return;
  const isPdf = (f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf";
  const csvs = list.filter((f) => !isPdf(f)), pdfs = list.filter(isPdf);
  if (!$("#history-view").hidden) {
    // A file dropped on the History page goes to the main page.
    if (location.hash) window.history.pushState(null, "", location.pathname + location.search);
    showView("ship");
  }
  if (csvs.length) {
    const f = csvs[0];
    if (/\.(xlsx?|numbers|ods)$/i.test(f.name)) {
      showMsg($("#load-msg"), "error", `${f.name} is a spreadsheet, not a CSV.`, ["Use the .csv file from TCGplayer's Export Shipping button, or in Excel use File → Save As → CSV."]);
    } else {
      let text = "";
      try { text = await f.text(); } catch { showMsg($("#load-msg"), "error", `${f.name} couldn't be read.`); return; }
      if (text.startsWith("%PDF")) pdfs.push(f);
      else { const res = loadCsvText(text, f.name); if (res.orders.length && !pdfs.length) jumpTo("#step2"); }
    }
  }
  if (pdfs.length) await loadSlipFile(pdfs[0]);
}

function jumpTo(sel) {
  const t = $(sel);
  if (t && t.scrollIntoView) t.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

// ---------- packing slips ----------

async function loadSlipFile(file) {
  const box = $("#slip-msg");
  if (!state.orders.length) {
    showMsg(box, "warn", "Add your orders first.", ["Drop the shipping CSV in step 1, then add the packing-slip PDF."]);
    showMsg($("#load-msg"), "warn", "That's the packing-slip PDF. Add your orders CSV first, then the slips.");
    return;
  }
  showMsg(box, "info", `Reading ${file.name}…`);
  try {
    const buf = await file.arrayBuffer();
    const res = await readSlipPdf(buf, state.orders.map((o) => o.id));
    attachSlips(state.orders, res.byOrder || {});
    state.slips = { byOrder: res.byOrder || {}, unmatchedPages: res.unmatchedPages || [], fileName: file.name };
    const matched = state.orders.filter((o) => state.slips.byOrder[o.id]).length;
    const lines = [];
    if (state.slips.unmatchedPages.length) lines.push(`${plural(state.slips.unmatchedPages.length, "page")} didn't mention any of your orders (page ${state.slips.unmatchedPages.join(", ")}).`);
    if (matched < state.orders.length) lines.push(`No slip found for: ${state.orders.filter((o) => !state.slips.byOrder[o.id]).map((o) => o.id).join(", ")}.`);
    showMsg(box, matched ? (lines.length ? "warn" : "ok") : "error",
      matched ? `Found slips for ${matched} of ${plural(state.orders.length, "order")}.` : "None of the pages matched your orders.",
      matched ? lines : ["Check that the PDF is for the same orders as your CSV."]);
    if (matched) { state.output.slipsInLabelOrder = true; save(KEYS.output, state.output); }
  } catch (e) {
    showMsg(box, "error", `${file.name} couldn't be read as a packing-slip PDF.`, [e && e.message ? `Details: ${e.message}` : null]);
  }
  renderAll();
}

/** The user's own slip pages for these orders, in the same order as the labels. */
function slipPagesFor(orders) {
  if (!state.slips) return [];
  const pages = [];
  for (const o of orders) {
    const s = state.slips.byOrder[o.id];
    for (const img of (s && s.pageImages) || []) pages.push({ orderId: o.id, pageImage: img });
  }
  return pages;
}

// ---------- PDF ----------

const currentFormat = () => formatList.find((f) => f.id === state.output.format) || formatList[0] || {};

/** The options passed to renderPdf for these orders. */
export function pdfOptions(orders = printOrders()) {
  const useOwnSlips = !!(state.output.slipsInLabelOrder && state.slips);
  const pages = useOwnSlips ? slipPagesFor(orders) : [];
  return {
    format: state.output.format,
    slips: !!state.output.slips || pages.length > 0, // "Slips in label order" prints them even with slips off
    returnAddress: returnAddress(),
    boldReturn: !!state.output.boldReturn,
    noDivider: !!state.output.noDivider,
    design: { ...state.design, darkness: Number(state.design.darkness) || 0, note: (state.design.note || "").slice(0, 60) },
    slipPages: pages.length ? pages : null,
    plan: Object.fromEntries(orders.map((o) => [o.id, o.plan])),
  };
}

/** Build the labels PDF for the ticked orders (what "Download PDF" saves). Returns the jsPDF doc. */
export function buildPdf(orders = printOrders()) {
  if (!orders.length) throw new Error("Tick at least one order in step 2 to print.");
  return renderPdf(orders, pdfOptions(orders));
}

export function downloadPdf() {
  const box = $("#print-msg");
  const orders = printOrders();
  if (!orders.length) {
    showMsg(box, "warn", state.orders.length ? "No orders are ticked." : "Add your orders first.",
      [state.orders.length ? "Tick the orders you want to print in step 2." : "Drop your TCGplayer CSV in step 1, or try the sample."]);
    return null;
  }
  let doc;
  try { doc = buildPdf(orders); } catch (e) {
    showMsg(box, "error", "The PDF couldn't be made.", [e && e.message ? `Details: ${e.message}` : null]);
    return null;
  }
  const name = `labels-${today()}.pdf`;
  state.lastSave = savePdf(doc, name, "labels").then((res) => {
    showMsg(box, "ok", `Saved ${res.name} with ${plural(orders.length, "order")}.`,
      [...savedLines(res), "Open it and print at 100% scale (Actual size).", "These orders are now in your History."]);
    return res;
  });
  state.lastPrinted = orders.map((o) => o.id);
  state.done[3] = true;
  recordPrinted(state.history, orders, { source: state.source, format: state.output.format });
  saveHistory();
  renderSteps();
  renderHistory();
  return doc;
}

function downloadSlipsOnly() {
  const box = $("#print-msg");
  const orders = printOrders();
  const pages = slipPagesFor(orders);
  if (!pages.length) { showMsg(box, "warn", "No packing slips to print for the ticked orders."); return null; }
  const f = currentFormat();
  let doc;
  try { doc = slipsInLabelOrderPdf(orders, pages, f.slipSize || f.pageSize); } catch (e) {
    showMsg(box, "error", "The slips PDF couldn't be made.", [e && e.message ? `Details: ${e.message}` : null]);
    return null;
  }
  const name = `slips-${today()}.pdf`;
  state.lastSave = savePdf(doc, name, "slips").then((res) => {
    showMsg(box, "ok", `Saved ${res.name}: ${plural(pages.length, "slip page")} in label order.`, savedLines(res));
    return res;
  });
  return doc;
}

// ---------- tracking / shipped ----------

function saveShipped() { save(KEYS.shipped, state.shipped); }
function saveHistory() { save(KEYS.history, state.history); }

// Copy an order's shipped state (from this batch) into the history.
function noteShipped(id) {
  const o = state.orders.find((x) => x.id === id);
  if (!o) return;
  recordShipped(state.history, o, state.shipped[id] || null, { source: state.source });
  saveHistory();
}

function setTracking(id, tracking) {
  const t = String(tracking || "").trim();
  if (t) state.shipped[id] = { tracking: t, carrier: detectCarrier(t) || "USPS", shipped: true, at: today() };
  else if (state.shipped[id]) state.shipped[id] = { ...state.shipped[id], tracking: "", carrier: "" };
  saveShipped();
  noteShipped(id);
}

function setShipped(id, on) {
  const cur = state.shipped[id];
  if (on) state.shipped[id] = { tracking: "", carrier: "", ...cur, shipped: true, at: today() };
  else delete state.shipped[id];
  saveShipped();
  noteShipped(id);
}

/** Orders in label order: as last printed, else the ticked ones, else all. */
function labelOrder() {
  const byId = new Map(state.orders.map((o) => [o.id, o]));
  const printed = state.lastPrinted.map((id) => byId.get(id)).filter(Boolean);
  if (printed.length) return printed;
  const ticked = printOrders();
  return ticked.length ? ticked : state.orders;
}

/** Match pasted tracking numbers to orders and remember them. */
export function matchPasted(text) {
  const box = $("#match-msg");
  if (!String(text || "").trim()) { showMsg(box, "warn", "Paste some tracking numbers first."); return null; }
  const res = matchTracking(String(text), labelOrder());
  for (const m of res.matches) {
    state.shipped[m.orderId] = { tracking: m.tracking, carrier: m.carrier || detectCarrier(m.tracking) || "USPS", shipped: true, at: today() };
  }
  saveShipped();
  for (const m of res.matches) noteShipped(m.orderId);
  const lines = [...(res.warnings || [])];
  if (res.unmatched && res.unmatched.length) lines.push(el("div", {}, "Not matched: ", res.unmatched.map((u) => el("code", { text: u }))));
  showMsg(box, res.matches.length ? (lines.length ? "warn" : "ok") : "error",
    res.matches.length ? `Matched ${plural(res.matches.length, "tracking number")}.` : "No tracking numbers matched your orders.", lines);
  renderAll();
  return res;
}

const fileOrders = () => (state.source === "csv" ? state.orders : []);

/** The TCGplayer import file for this batch: { csv, count, missingRequired }. */
export function importFile() {
  return importFileCsv(fileOrders(), state.shipped);
}

export function downloadImportFile() {
  const box = $("#ship-msg");
  if (state.source !== "csv") { showMsg(box, "warn", "The import file only works with orders from a TCGplayer CSV.", ["Pasted addresses aren't TCGplayer orders, so there's nothing to mark shipped there."]); return null; }
  const r = importFile();
  if (!r.count) { showMsg(box, "warn", "Nothing to import yet.", ["Add a tracking number or tick Shipped for at least one order."]); return null; }
  const name = `tcgplayer-import-${today()}.csv`;
  state.lastSave = saveBlob(name, "import", new Blob([r.csv], { type: "text/csv" })).then((res) => {
    showMsg(box, r.missingRequired.length ? "warn" : "ok", `Saved ${res.name} with ${plural(r.count, "order")}.`,
      [...savedLines(res), r.missingRequired.length ? `TCGplayer will refuse ${r.missingRequired.join(", ")} without a tracking number.` : null,
        "Upload it in the Seller Portal: Orders → Import Shipping Info."]);
    return res;
  });
  state.done[4] = true;
  renderSteps();
  return r;
}

export function pirateFile() {
  return pirateShipCsv(state.orders, Object.fromEntries(state.orders.map((o) => [o.id, o.plan])), state.shipped);
}

export function downloadPirateShip() {
  const box = $("#ship-msg");
  const csv = pirateFile();
  const rows = csv.trim().split(/\r?\n/).length - 1;
  if (rows < 1) { showMsg(box, "info", "No orders need a tracked label right now.", ["Pirate Ship is for orders of $20 or more, or with paid faster shipping, that don't have tracking yet."]); return null; }
  const name = `pirate-ship-${today()}.csv`;
  state.lastSave = saveBlob(name, "pirate", new Blob([csv], { type: "text/csv" })).then((res) => {
    showMsg(box, "ok", `Saved ${res.name} with ${plural(rows, "order")}.`, [...savedLines(res), "In Pirate Ship choose Import → Spreadsheet and pick this file."]);
    return res;
  });
  return csv;
}

// ---------- rendering ----------

function chip(p) {
  if (!p) return "";
  return el("span", { class: `chip tag-${p.tag}`, text: p.label });
}

function shipStatus(o) {
  const s = state.shipped[o.id];
  if (s && s.tracking) return { kind: "done", text: `Shipped · ${s.carrier || "tracked"} …${s.tracking.replace(/\s/g, "").slice(-4)}`, title: s.tracking };
  if (s && s.shipped) return { kind: "done", text: "Shipped" };
  if (o.tracking) return { kind: "info", text: "Tracking in file", title: o.tracking };
  return { kind: "todo", text: "Not shipped yet" };
}

function weightCell(o) {
  const p = o.plan || {};
  const w = el("span", { class: "w", text: oz(p.weightOz) });
  if (!p.letterOk) return [w, el("span", { class: "sub warn-text", text: p.note || "Too heavy for a letter" })];
  if (p.tracked) return [w, el("span", { class: "sub muted", text: "tracked label" })];
  return [w, el("span", { class: "sub", text: `${plural(p.stamps, "stamp")} · ${money(p.postage)}` })];
}

function rowFor(o) {
  const sel = state.selected.has(o.id);
  const st = shipStatus(o);
  const items = o.items && o.items.length
    ? el("span", { title: o.items.map((i) => `${i.qty} × ${i.name}`).join("\n"), text: String(o.itemCount) + " ✓" })
    : String(o.itemCount);
  return el("tr", { "data-id": o.id, class: sel ? "" : "off" },
    el("td", { class: "c-check" }, el("input", { type: "checkbox", checked: sel, "data-id": o.id, "aria-label": `Print order ${o.id} for ${o.name}` })),
    el("td", { class: "c-id" }, el("span", { class: "oid", text: o.id }), o.orderDate ? el("span", { class: "sub muted", text: o.orderDate }) : null),
    el("td", { class: "c-buyer", text: o.name }),
    el("td", { class: "c-dest", text: `${o.city}, ${o.state} ${o.zip}` }),
    el("td", { class: "c-items num", "data-label": "Items" }, items),
    el("td", { class: "c-value num", "data-label": "Value" }, money(o.value)),
    el("td", { class: "c-plan" }, chip(o.plan)),
    el("td", { class: "c-weight" }, weightCell(o)),
    el("td", { class: "c-status" }, el("span", { class: `status ${st.kind}`, title: st.title || null, text: st.text })));
}

function renderTable() {
  const has = state.orders.length > 0;
  $("#plan-empty").hidden = has;
  $("#plan-area").hidden = !has;
  if (!has) return;
  for (const b of $$("#filters button")) {
    const id = b.dataset.filter;
    b.setAttribute("aria-pressed", String(id === state.filter));
    b.querySelector(".count").textContent = filterOrders(state.orders, id, state.shipped).length;
  }
  const rows = visibleOrders();
  const tbody = $("#orders-table tbody");
  tbody.replaceChildren(...rows.map(rowFor));
  if (!rows.length) tbody.append(el("tr", { class: "none" }, el("td", { colspan: "9", text: "No orders match this filter." })));
  const n = rows.filter((o) => state.selected.has(o.id)).length;
  const all = $("#check-all");
  all.checked = rows.length > 0 && n === rows.length;
  all.indeterminate = n > 0 && n < rows.length;
  renderTotals(rows);
}

function renderTotals(rows) {
  const s = planSettings();
  const sum = summarize(rows, s);
  const env = summarize(rows.filter((o) => o.plan && o.plan.tag === "envelope"), s);
  const tagNames = { envelope: "envelope OK", "tracking-recommended": "tracking recommended", "tracking-required": "tracking required", signature: "signature" };
  const parts = Object.entries(tagNames).filter(([t]) => sum.byTag[t]).map(([t, name]) => el("span", { class: `dot tag-${t}`, text: `${sum.byTag[t]} ${name}` }));
  const box = $("#totals");
  box.replaceChildren(
    el("strong", { text: plural(sum.count, "order") }), " · ", money(sum.totalValue), " in cards",
    parts.length ? el("span", { class: "tags" }, parts) : null,
    env.count ? el("span", { class: "stamps", text: `Envelopes need about ${plural(env.totalStamps, "stamp")} (${money(env.totalPostage)})` }) : null);
}

function renderOutput() {
  const f = $("#output-form");
  f.elements.format.value = state.output.format;
  for (const k of ["slips", "boldReturn", "noDivider", "slipsInLabelOrder"]) f.elements[k].checked = !!state.output[k];
  for (const r of f.elements.saveTo) r.checked = r.value === (state.output.saveTo === "downloads" ? "downloads" : "folder");
  $("#btn-open-folder").hidden = state.output.saveTo === "downloads";
  const slipOrder = $("#slip-order");
  slipOrder.disabled = !state.slips;
  $("#slip-order-wrap").classList.toggle("disabled", !state.slips);
  if (!state.slips) slipOrder.checked = false;
  $("#btn-slip-pdf").hidden = !state.slips;

  const orders = printOrders();
  const count = $("#print-count");
  if (!state.orders.length) count.textContent = "Add orders in step 1 to print.";
  else if (!orders.length) count.textContent = "No orders ticked. Tick the ones to print in step 2.";
  else {
    const fmt = currentFormat();
    const own = state.output.slipsInLabelOrder && state.slips;
    const what = own ? "labels + your TCGplayer slips" : state.output.slips ? "labels + packing slips" : "labels only";
    count.replaceChildren(el("strong", { text: plural(orders.length, "order") }), ` ready: ${what}`, el("span", { class: "fmt-hint muted small", text: fmt.hint || "" }));
  }
  const warn = $("#print-warn");
  warn.hidden = hasReturnAddress();
  warn.textContent = "Your return address isn't filled in yet, so labels will print without it.";
  $("#btn-pdf").textContent = orders.length ? `Download PDF (${plural(orders.length, "order")})` : "Download PDF";
}

function renderShip() {
  const has = state.orders.length > 0;
  $("#ship-empty").hidden = has;
  $("#ship-area").hidden = !has;
  if (!has) return;
  const list = $("#ship-list");
  list.replaceChildren(...state.orders.map((o) => {
    const s = state.shipped[o.id] || {};
    const id = `trk-${o.id.replace(/[^\w-]/g, "_")}`;
    return el("li", { class: "ship-row", "data-id": o.id },
      el("div", { class: "who" }, el("span", { class: "oid", text: o.id }), el("span", { class: "muted", text: o.name }), chip(o.plan)),
      el("label", { class: "sr", for: id, text: `Tracking number for order ${o.id}` }),
      el("input", { id, class: "trk-input", type: "text", value: s.tracking || "", placeholder: o.tracking || "Tracking #", "data-id": o.id, autocomplete: "off", spellcheck: "false" }),
      el("label", { class: "check ship-check" }, el("input", { type: "checkbox", "data-id": o.id, checked: !!(s.shipped || s.tracking), disabled: !!s.tracking }), " Shipped"));
  }));
  renderShipWarn();
  $("#btn-import").disabled = state.source !== "csv";
  $("#btn-import").title = state.source !== "csv" ? "Only for orders from a TCGplayer CSV" : "";
}

function renderShipWarn() {
  const r = state.source === "csv" ? importFile() : { count: 0, missingRequired: [] };
  const box = $("#ship-warn");
  if (r.missingRequired.length) {
    showMsg(box, "warn", "These orders need a tracking number before TCGplayer will accept them:",
      [r.missingRequired.join(", "), "Orders of $49.99 or more must have tracking. Type it in above, or leave them out of this upload by unticking Shipped."]);
  } else showMsg(box, "", "");
}

// ---------- history ----------

function historyRow(r) {
  const tid = "htrk-" + r.key.replace(/[^\w-]/g, "_");
  const link = trackingUrl(r.tracking, r.carrier);
  const label = r.id || r.name;
  return el("tr", { "data-key": r.key },
    el("td", { class: "c-printed" },
      r.printCount ? el("span", { text: String(r.lastPrintedAt).slice(0, 10) }) : el("span", { class: "muted", text: "Not made here" }),
      r.printCount ? el("span", { class: "sub muted", text: formatName(r.format) + (r.printCount > 1 ? ` · ${r.printCount} times` : "") }) : null),
    el("td", { class: "c-id" }, el("span", { class: "oid", text: r.id || "Pasted" }), r.orderDate ? el("span", { class: "sub muted", text: r.orderDate }) : null),
    el("td", { class: "c-buyer", text: r.name }),
    el("td", { class: "c-dest", text: `${r.city}${r.city && r.state ? ", " : ""}${r.state} ${r.zip}`.trim() }),
    el("td", { class: "num c-value", text: money(r.value) }),
    el("td", { class: "c-plan" }, r.tag ? chip({ tag: r.tag, label: TAG_LABELS[r.tag] || r.tag }) : null),
    el("td", { class: "c-ship" },
      el("div", { class: "hship" },
        el("label", { class: "check ship-check" },
          el("input", { type: "checkbox", class: "h-shipped", checked: !!r.shipped, disabled: !!r.tracking }),
          r.shipped ? ` Shipped ${String(r.shippedAt).slice(0, 10)}` : " Shipped"),
        el("label", { class: "sr", for: tid, text: `Tracking number for ${label}` }),
        el("input", { id: tid, class: "trk-input h-trk", type: "text", value: r.tracking || "", placeholder: "Tracking #", autocomplete: "off", spellcheck: "false" }),
        link ? el("a", { href: link, target: "_blank", rel: "noopener noreferrer", class: "small", text: `Track on ${r.carrier} ↗` }) : null)),
    el("td", { class: "c-del" }, el("button", { type: "button", class: "link danger h-del", "aria-label": `Remove ${label} from the history`, text: "Remove" })));
}

export function renderHistory() {
  const counts = historyCounts(state.history);
  const badge = $("#history-count");
  badge.hidden = !counts.all;
  badge.textContent = String(counts.all);
  const has = counts.all > 0;
  $("#history-empty").hidden = has;
  $("#history-area").hidden = !has;
  if (!has) return;
  for (const b of $$("#history-filters button")) {
    b.setAttribute("aria-pressed", String(b.dataset.filter === state.historyFilter));
    b.querySelector(".count").textContent = String(counts[b.dataset.filter] ?? 0);
  }
  $("#history-totals").textContent = `${plural(counts.all, "order")} · ${counts.printed} with labels made here · ${counts.shipped} shipped · ${counts.waiting} not shipped yet`;
  const rows = historyList(state.history, { filter: state.historyFilter, search: state.historySearch });
  const body = $("#history-table tbody");
  body.replaceChildren(...(rows.length ? rows.map(historyRow)
    : [el("tr", { class: "none" }, el("td", { colspan: "8", text: state.historySearch ? "No orders match your search." : "No orders here." }))]));
}

// A Shipped tick or tracking number changed on the History page. TCGplayer orders also update the
// shipped list used by step 4, so the import file and a re-uploaded file agree with the history.
function updateHistoryShipped(key, entry) {
  const r = state.history[key];
  if (!r) return;
  applyShipped(r, entry);
  saveHistory();
  if (r.source === "csv" && r.id) {
    if (r.shipped) state.shipped[r.id] = { tracking: r.tracking, carrier: r.carrier, shipped: true, at: today() };
    else delete state.shipped[r.id];
    saveShipped();
  }
  renderAll();
}

export function historyFile() {
  return historyCsv(historyList(state.history, { filter: state.historyFilter, search: state.historySearch }), TAG_LABELS);
}

function bindHistory() {
  $("#history-filters").replaceChildren(...HISTORY_FILTERS.map((f) =>
    el("button", { type: "button", class: "filter", "data-filter": f.id, "aria-pressed": "false" }, f.label, " ", el("span", { class: "count" }))));
  $("#history-filters").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-filter]");
    if (!b) return;
    state.historyFilter = b.dataset.filter;
    renderHistory();
  });
  $("#history-search").addEventListener("input", (e) => { state.historySearch = e.target.value; renderHistory(); });
  const body = $("#history-table tbody");
  body.addEventListener("change", (e) => {
    const tr = e.target.closest("tr[data-key]");
    if (!tr) return;
    const key = tr.dataset.key;
    if (e.target.classList.contains("h-shipped")) {
      const r = state.history[key];
      updateHistoryShipped(key, e.target.checked ? { shipped: true, tracking: r && r.tracking, carrier: r && r.carrier } : null);
    } else if (e.target.classList.contains("h-trk")) {
      const t = e.target.value.trim();
      const r = state.history[key];
      updateHistoryShipped(key, t ? { tracking: t, carrier: detectCarrier(t) || "USPS", shipped: true } : (r && r.shipped ? { shipped: true } : null));
    }
  });
  body.addEventListener("click", (e) => {
    const b = e.target.closest(".h-del");
    if (!b) return;
    const key = b.closest("tr[data-key]").dataset.key;
    const r = state.history[key];
    if (!r || !window.confirm(`Remove ${r.id || r.name} from the history? (Nothing changes on TCGplayer.)`)) return;
    delete state.history[key];
    saveHistory();
    renderHistory();
  });
  $("#btn-history-csv").addEventListener("click", () => {
    state.lastSave = saveBlob(`ship-desk-history-${today()}.csv`, "history", new Blob([historyFile()], { type: "text/csv" })).then((res) => {
      showMsg($("#history-msg"), "ok", `Saved ${res.name}.`, savedLines(res));
      return res;
    });
  });
  $("#btn-clear-history").addEventListener("click", () => {
    if (!Object.keys(state.history).length) { toast("The history is already empty."); return; }
    if (!window.confirm("Forget the whole history list? This doesn't change anything on TCGplayer.")) return;
    clearHistory();
    toast("History cleared.");
  });
}

export function clearHistory() {
  state.history = {};
  saveHistory();
  renderHistory();
}

/** Show the main page ("ship") or the History page ("history"). */
export function showView(name) {
  const hist = name === "history";
  $("#main").hidden = hist;
  $(".steps").hidden = hist;
  $("#history-view").hidden = !hist;
  for (const [id, on] of [["#view-ship", !hist], ["#view-history", hist]]) {
    if (on) $(id).setAttribute("aria-current", "page"); else $(id).removeAttribute("aria-current");
  }
  if (hist) renderHistory();
}

function bindViews() {
  const sync = () => showView(location.hash === "#history" ? "history" : "ship");
  window.addEventListener("hashchange", sync);
  $("#view-ship").addEventListener("click", (e) => {
    e.preventDefault();
    if (location.hash) window.history.pushState(null, "", location.pathname + location.search);
    showView("ship");
    window.scrollTo(0, 0);
  });
  sync();
}

function renderProfiles() {
  const pick = $("#profile-pick");
  pick.replaceChildren(...state.profiles.map((p) => el("option", { value: p.id, text: p.label || p.name || "Unnamed address" })));
  pick.value = state.activeProfile;
  $("#profile-del").disabled = state.profiles.length < 2;
  const p = activeProfile();
  const f = $("#return-form");
  for (const k of ["label", ...ADDRESS_FIELDS]) if (document.activeElement !== f.elements[k]) f.elements[k].value = p[k] || "";
}

function renderDesign() {
  const f = $("#design-form");
  const d = state.design;
  for (const k of ["accent", "font", "darkness", "note", "qrUrl", "slipMessage"]) if (document.activeElement !== f.elements[k]) f.elements[k].value = d[k] ?? "";
  $("#note-count").textContent = `${(d.note || "").length} / 60`;
  const img = $("#logo-preview");
  img.hidden = !d.logo;
  if (d.logo) img.src = d.logo; else img.removeAttribute("src");
  $("#logo-remove").hidden = !d.logo;
  $("#btn-logo").textContent = d.logo ? "Change logo" : "Choose a logo";
}

function renderPlanForm() {
  const f = $("#plan-form");
  for (const k of Object.keys(DEFAULT_PLAN_SETTINGS)) {
    const input = f.elements[k];
    if (!input || document.activeElement === input) continue;
    if (input.type === "checkbox") input.checked = !!state.plan[k]; else input.value = state.plan[k];
  }
}

function renderSteps() {
  const done = { 1: state.orders.length > 0, 2: state.orders.length > 0, 3: state.done[3], 4: state.done[4] };
  const current = [1, 2, 3, 4].find((n) => !done[n]) || 4;
  for (const li of $$(".steps li")) {
    const n = Number(li.dataset.step);
    li.classList.toggle("done", !!done[n]);
    const a = li.querySelector("a");
    if (n === current) a.setAttribute("aria-current", "step"); else a.removeAttribute("aria-current");
  }
}

export function renderAll() {
  renderSteps();
  renderProfiles();
  renderTable();
  renderOutput();
  renderShip();
  renderHistory();
}

// ---------- wiring ----------

function buildStatic() {
  $("#filters").replaceChildren(...filterList.map((f) =>
    el("button", { type: "button", class: "filter", "data-filter": f.id, "aria-pressed": "false" }, f.label, " ", el("span", { class: "count" }))));
  $("#format").replaceChildren(...formatList.map((f) => el("option", { value: f.id, text: f.label || f.id })));
}

function bindTabs() {
  const tabs = $$('[role="tab"]');
  const pick = (tab) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      $("#" + t.getAttribute("aria-controls")).hidden = !on;
    }
  };
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => pick(t));
    t.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const next = tabs[(i + d + tabs.length) % tabs.length];
      pick(next);
      next.focus();
    });
  });
}

function bindDrop() {
  const overlay = $("#drop-overlay");
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");
  window.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; overlay.hidden = false; });
  window.addEventListener("dragover", (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
  window.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) overlay.hidden = true; });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    handleFiles(e.dataTransfer.files);
  });
  const input = $("#file-input");
  $("#dropzone").addEventListener("click", () => input.click());
  input.addEventListener("change", () => { handleFiles(input.files); input.value = ""; });
}

function bindReturn() {
  const f = $("#return-form");
  let savedTimer = 0;
  f.addEventListener("input", (e) => {
    const p = activeProfile();
    const k = e.target.name;
    if (!k) return;
    p[k] = k === "state" ? e.target.value.toUpperCase() : e.target.value;
    if (k === "state" && e.target.value !== p[k]) e.target.value = p[k];
    const stored = save(KEYS.profiles, state.profiles);
    if (k === "label" || k === "name") {
      const opt = $("#profile-pick").selectedOptions[0];
      if (opt) opt.textContent = p.label || p.name || "Unnamed address";
    }
    const msg = $("#return-saved");
    msg.textContent = stored ? "Saved on this PC." : "Saved for now. This browser blocks saving, so it will be gone next time.";
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => { msg.textContent = ""; }, 2500);
    renderOutput();
  });
  $("#profile-pick").addEventListener("change", (e) => {
    state.activeProfile = e.target.value;
    save(KEYS.activeProfile, state.activeProfile);
    renderProfiles();
    renderOutput();
  });
  $("#profile-new").addEventListener("click", () => {
    const p = newProfile(`Address ${state.profiles.length + 1}`);
    state.profiles.push(p);
    state.activeProfile = p.id;
    save(KEYS.profiles, state.profiles);
    save(KEYS.activeProfile, p.id);
    renderProfiles();
    renderOutput();
    f.elements.label.focus();
    f.elements.label.select();
  });
  $("#profile-del").addEventListener("click", () => {
    if (state.profiles.length < 2) return;
    const p = activeProfile();
    if (!window.confirm(`Delete the return address "${p.label || p.name || "Unnamed"}"?`)) return;
    state.profiles = state.profiles.filter((x) => x.id !== p.id);
    state.activeProfile = state.profiles[0].id;
    save(KEYS.profiles, state.profiles);
    save(KEYS.activeProfile, state.activeProfile);
    renderProfiles();
    renderOutput();
  });
}

function bindTable() {
  $("#filters").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-filter]");
    if (!b) return;
    setFilter(b.dataset.filter);
  });
  $("#orders-table tbody").addEventListener("change", (e) => {
    const id = e.target.dataset.id;
    if (!id) return;
    if (e.target.checked) state.selected.add(id); else state.selected.delete(id);
    e.target.closest("tr").classList.toggle("off", !e.target.checked);
    const rows = visibleOrders();
    const n = rows.filter((o) => state.selected.has(o.id)).length;
    $("#check-all").checked = n === rows.length;
    $("#check-all").indeterminate = n > 0 && n < rows.length;
    renderOutput();
  });
  $("#check-all").addEventListener("change", (e) => {
    for (const o of visibleOrders()) { if (e.target.checked) state.selected.add(o.id); else state.selected.delete(o.id); }
    renderTable();
    renderOutput();
  });
  const pf = $("#plan-form");
  pf.addEventListener("change", (e) => {
    const k = e.target.name;
    if (!k) return;
    if (e.target.type === "checkbox") state.plan[k] = e.target.checked;
    else {
      const v = parseFloat(e.target.value);
      if (!(v >= 0) || (k === "cardsPerToploader" && v < 1) || (k === "foreverValue" && v <= 0)) { e.target.value = state.plan[k]; return; }
      state.plan[k] = k === "cardsPerToploader" ? Math.round(v) : v;
    }
    save(KEYS.plan, state.plan);
    replan();
    renderAll();
  });
  $("#plan-reset").addEventListener("click", () => {
    state.plan = { ...DEFAULT_PLAN_SETTINGS };
    save(KEYS.plan, state.plan);
    renderPlanForm();
    replan();
    renderAll();
  });
}

/** Show only the orders matching a FILTERS id. */
export function setFilter(id) {
  state.filter = filterList.some((f) => f.id === id) ? id : "all";
  renderTable();
  renderOutput();
}

function bindOutput() {
  const f = $("#output-form");
  f.addEventListener("change", (e) => {
    const k = e.target.name;
    if (!k) return;
    state.output[k] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    save(KEYS.output, state.output);
    if (k === "slips") replan();
    renderAll();
  });
  const slipInput = $("#slip-input");
  $("#btn-slips").addEventListener("click", () => slipInput.click());
  slipInput.addEventListener("change", () => { if (slipInput.files[0]) loadSlipFile(slipInput.files[0]); slipInput.value = ""; });
  $("#btn-pdf").addEventListener("click", downloadPdf);
  $("#btn-open-folder").addEventListener("click", () => openSavedFolder());
  // The "Where files go" choice sits below the print bar, outside the form, so it has its own listener.
  $(".save-to").addEventListener("change", (e) => {
    if (e.target.name !== "saveTo") return;
    state.output.saveTo = e.target.value === "downloads" ? "downloads" : "folder";
    save(KEYS.output, state.output);
    renderOutput();
  });
  $("#btn-slip-pdf").addEventListener("click", downloadSlipsOnly);

  const d = $("#design-form");
  const onDesign = (e) => {
    const k = e.target.name;
    if (!k) return;
    state.design[k] = k === "darkness" ? Number(e.target.value) : e.target.value;
    if (k === "note") $("#note-count").textContent = `${e.target.value.length} / 60`;
    save(KEYS.design, state.design);
  };
  d.addEventListener("input", onDesign);
  d.addEventListener("change", onDesign);
  const logoInput = $("#logo-input");
  $("#btn-logo").addEventListener("click", () => logoInput.click());
  logoInput.addEventListener("change", async () => {
    const file = logoInput.files[0];
    logoInput.value = "";
    if (!file) return;
    try {
      state.design.logo = await shrinkImage(file, 600);
      if (!save(KEYS.design, state.design)) toast("Logo added for now. This browser blocks saving, so it won't be kept.");
    } catch {
      toast("That picture couldn't be opened. Try a PNG or JPG.");
    }
    renderDesign();
  });
  $("#logo-remove").addEventListener("click", () => { state.design.logo = null; save(KEYS.design, state.design); renderDesign(); });
}

/** Read an image file and scale it down so it fits in storage: a PNG data URL. */
function shrinkImage(file, max) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = el("canvas", { width: String(Math.max(1, Math.round(img.naturalWidth * k))), height: String(Math.max(1, Math.round(img.naturalHeight * k))) });
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/png"));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("bad image")); };
    img.src = url;
  });
}

function bindShip() {
  $("#btn-paste").addEventListener("click", () => { const r = loadPastedText($("#paste-text").value); if (r.orders.length) jumpTo("#step2"); });
  $("#btn-sample").addEventListener("click", loadSample);
  $("#btn-match").addEventListener("click", () => matchPasted($("#track-text").value));
  const list = $("#ship-list");
  list.addEventListener("change", (e) => {
    const id = e.target.dataset.id;
    if (!id) return;
    const row = e.target.closest(".ship-row");
    const box = row.querySelector('.ship-check input');
    if (e.target.classList.contains("trk-input")) {
      setTracking(id, e.target.value);
      const has = !!(state.shipped[id] && state.shipped[id].tracking);
      box.checked = has || !!(state.shipped[id] && state.shipped[id].shipped);
      box.disabled = has;
    } else {
      setShipped(id, e.target.checked);
    }
    renderTable();
    renderShipWarn();
  });
  $("#btn-import").addEventListener("click", downloadImportFile);
  $("#btn-pirate").addEventListener("click", downloadPirateShip);
  $("#btn-clear-shipped").addEventListener("click", () => {
    if (!Object.keys(state.shipped).length) { toast("There's no shipped history to clear."); return; }
    if (!window.confirm("Forget which orders you marked shipped, and the tracking numbers typed here?")) return;
    clearShipped();
    toast("Shipped history cleared.");
  });
}

export function clearShipped() {
  state.shipped = {};
  saveShipped();
  renderAll();
}

function registerWorker() {
  if (!/^https?:$/.test(location.protocol) || !("serviceWorker" in navigator) || window.top !== window) return;
  navigator.serviceWorker.register("sw.js").catch(() => { /* offline mode is a bonus; the app works without it */ });
}

let started = false;

/** Start the app on index.html. Returns the test/automation API (also window.shipdesk). */
export function init() {
  if (started) return api;
  started = true;
  if (window.pdfjsLib && window.pdfjsLib.GlobalWorkerOptions) window.pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
  loadSettings();
  buildStatic();
  bindTabs();
  bindDrop();
  bindReturn();
  bindTable();
  bindOutput();
  bindShip();
  bindHistory();
  bindViews();
  renderPlanForm();
  renderDesign();
  renderAll();
  registerWorker();
  window.shipdesk = api;
  // index.html?sample opens with the sample loaded (handy for a quick look and for screenshots).
  if (new URLSearchParams(location.search).has("sample")) loadSample(false);
  return api;
}

export const api = {
  state, init, loadCsvText, loadPastedText, setFilter, visibleOrders, printOrders, returnAddress, planSettings,
  pdfOptions, buildPdf, downloadPdf, matchPasted, importFile, downloadImportFile, pirateFile, downloadPirateShip,
  clearShipped, renderAll, handleFiles, loadSlipFile, today,
  renderHistory, historyFile, clearHistory, showView, openSavedFolder,
};

if (document.querySelector("[data-shipdesk]")) init();
