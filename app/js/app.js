// Ship Desk: the page. Wires the drop zone, return address, plan table, print options, label design
// and tracking panels to the Data modules (csv / plan / tracking / paste) and the PDF modules
// (render / slips). See CONTRACT.md "app.js / store.js / UI".

import { load, save, remove, KEYS } from "./store.js";
import { parseOrders } from "./csv.js";
import { planOrder, DEFAULT_PLAN_SETTINGS, FILTERS, filterOrders, summarize, TAG_LABELS } from "./plan.js";
import { detectCarrier, matchTracking, importFileCsv, pirateShipCsv } from "./tracking.js";
import { parseAddresses } from "./paste.js";
import { renderPdf, FORMATS, slipsInLabelOrderPdf, cleanText } from "./render.js";
import { readSlipPdf, attachSlips } from "./slips.js";
import { readXlsx, isShipmentsHeader, readShipments, shipmentsFromCsv, matchShipments, isoDate } from "./pirate.js";
import { HISTORY_FILTERS, recordPrinted, recordShipped, applyShipped, historyCounts, historyList, historyCsv,
  trackingUrl, formatName, historyKey, recordSeen, stamp } from "./history.js";

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
// Lists keyed by order (History, shipped): look up only the list's own entries. A key such as "__proto__" would
// otherwise give every record's shared base object (security audit 2026-10-25, SHIP-20261025-01).
const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const safeKey = (k) => typeof k === "string" && k !== "" && !BAD_KEYS.has(k);
const own = (obj, k) => (safeKey(k) && Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : undefined);
const oz = (v) => (v == null ? "" : Number(v).toFixed(2) + " oz");

/** Today's date on this PC as YYYY-MM-DD. */
export function today(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * A file name that says what's inside: "Labels 2026-10-21 14-05 - 3 orders - Zackery Twork, Ash Example, Pat Doe.pdf",
 * "Label 2026-10-21 14-05 - Zackery Twork - 1A2B3C4D.pdf", or with no orders given "TCGplayer import 2026-10-21 14-05 - 5 orders.csv".
 * what = [one, several] words; count = how many orders when `orders` isn't the list.
 */
export function fileName(what, ext, orders = [], count = orders.length, d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const when = `${today(d)} ${p(d.getHours())}-${p(d.getMinutes())}`;
  const clean = (t) => String(t || "").normalize("NFC").replace(/[^\p{L}\p{N} ,.'&()+-]/gu, " ").replace(/\s+/g, " ").trim();
  const names = [...new Set(orders.map((o) => clean(o.name)).filter(Boolean))];
  let who;
  if (orders.length === 1) who = [names[0], clean(orders[0].id)].filter(Boolean).join(" - ");
  else if (names.length) who = `${count} orders - ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}`;
  else who = plural(count, "order");
  let base = `${count === 1 ? what[0] : what[1]} ${when}${who ? " - " + who : ""}`;
  if (base.length > 140) base = base.slice(0, 140).replace(/[\s,.-]+\S*$/, "") + " and more";
  return `${base.replace(/^[.\s]+|[.\s]+$/g, "")}.${ext}`;
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

/** Ask serve.py to open the Saved folder (or one kind's subfolder, or one order's photo folder) in Explorer. */
export async function openSavedFolder(kind = "", order = "") {
  try {
    const r = await fetch(`api/open-folder?kind=${encodeURIComponent(kind)}&order=${encodeURIComponent(order)}`, { method: "POST", headers: { "X-Ship-Desk": "1" } });
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

const DEFAULT_DESIGN = { accent: "#136f63", font: "helvetica", logo: null, darkness: 0, note: "", qrUrl: "", slipMessage: "", orderQr: true };
const DEFAULT_OUTPUT = { format: "", slips: true, boldReturn: false, noDivider: false, slipsInLabelOrder: false, saveTo: "folder" };
const ADDRESS_FIELDS = ["name", "phone", "street", "street2", "city", "state", "zip"];
const formatList = asList(FORMATS);
const filterList = asList(FILTERS);

export const state = {
  source: "",          // "csv" (TCGplayer file) or "paste"
  fileName: "",
  batchText: "",       // the file / pasted text the orders came from (kept in KEYS.batch)
  batchAt: "",         // when it was loaded (ISO time)
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
  importAgain: false,    // step 4: put orders already sent to TCGplayer in the next import file too
  historyCopy: null,     // the saved copy in Saved\History when this browser should be asked about it
  historySavedAt: "",    // when the copy was last written
  photos: {},          // order key -> { contents, packed, postoffice, total, photos: [{ id, kind, taken, file }] } from serve.py
  phone: null,         // serve.py's /api/phone-link answer while the Phone photos window is open
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

/** Make `orders` the batch. text = what they were read from (kept for reloads); kept = a restored KEYS.batch. */
function setBatch(source, orders, fileName, text, kept = null) {
  state.source = source;
  state.fileName = fileName;
  state.batchText = String(text || "");
  state.batchAt = (kept && kept.at) || new Date().toISOString();
  state.orders = orders;
  state.filter = "all";
  state.slips = null;
  state.lastPrinted = [];
  state.done = { 3: false, 4: false };
  replan();
  const fresh = orders.filter((o) => !isShippedNow(o));
  state.selected = new Set((fresh.length ? fresh : orders).map((o) => o.id));
  if (kept) {
    const ids = new Set(orders.map((o) => o.id));
    if (Array.isArray(kept.selected)) state.selected = new Set(kept.selected.filter((id) => ids.has(id)));
    if (filterList.some((f) => f.id === kept.filter)) state.filter = kept.filter;
    if (Array.isArray(kept.lastPrinted)) state.lastPrinted = kept.lastPrinted.filter((id) => ids.has(id));
  }
  keepBatch();
  renderAll();
}

// ---------- keeping the batch ----------
// The loaded orders stay in this browser (KEYS.batch: the file's text plus what is ticked), so a reload or a
// restart of the PC still has them and the TCGplayer import file can be made later without dropping the CSV
// again. They hold buyers' addresses, so they are forgotten after BATCH_DAYS, when a new batch replaces them,
// or with "Clear these orders". Packing-slip pages are not kept (too big): the PDF is added again if needed.
const BATCH_DAYS = 14;

function keepBatch() {
  if (!state.batchText) return;
  save(KEYS.batch, { source: state.source, fileName: state.fileName, text: state.batchText, at: state.batchAt,
    selected: [...state.selected], filter: state.filter, lastPrinted: state.lastPrinted });
}

/** "2026-10-25 14:05" for an ISO time. */
function whenText(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${today(d)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Bring back the batch kept by keepBatch (on start). True when there was one. */
export function restoreBatch() {
  const b = load(KEYS.batch, null);
  if (!b || typeof b !== "object" || typeof b.text !== "string" || !b.text) return false;
  if (!(Date.now() - Date.parse(b.at) < BATCH_DAYS * 864e5)) { remove(KEYS.batch); return false; }
  const source = b.source === "paste" ? "paste" : "csv";
  let res;
  try { res = source === "paste" ? parseAddresses(b.text) : parseOrders(b.text); } catch { res = null; }
  if (!res || !res.orders.length) { remove(KEYS.batch); return false; }
  const name = typeof b.fileName === "string" && b.fileName ? b.fileName : "your file";
  setBatch(source, res.orders, name, b.text, b);
  if (source === "paste") $("#paste-text").value = b.text;
  showMsg($("#load-msg"), "info", `Your orders are still here: ${plural(res.orders.length, "order")} from ${name}, loaded ${whenText(b.at)}.`,
    ["Drop a new file to replace them, or press Clear these orders when you're done with them."]);
  return true;
}

/** Forget the loaded orders (the "Clear these orders" button). History and shipped marks stay. */
export function clearBatch() {
  remove(KEYS.batch);
  Object.assign(state, { source: "", fileName: "", batchText: "", batchAt: "", orders: [], selected: new Set(), filter: "all",
    slips: null, lastPrinted: [], done: { 3: false, 4: false } });
  for (const id of ["#load-msg", "#slip-msg", "#print-msg", "#match-msg", "#ship-msg"]) showMsg($(id), "", "");
  $("#paste-text").value = "";
  renderAll();
  toast("Orders cleared. Your History is still there.");
}

/** Load the text of a TCGplayer shipping CSV (what a drop or "Try the sample" does). */
export function loadCsvText(text, fileName = "your file") {
  const box = $("#load-msg");
  const res = parseOrders(String(text || ""));
  if (!res.orders.length) {
    showLoadProblem(res, fileName);
    return res;
  }
  setBatch("csv", res.orders, fileName, text);
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
  setBatch("paste", res.orders, "pasted addresses", text);
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
    if (/\.xlsx$/i.test(f.name)) {
      await loadSpreadsheet(f);
    } else if (/\.(xls|numbers|ods)$/i.test(f.name)) {
      showMsg($("#load-msg"), "error", `${f.name} is a spreadsheet, not a CSV.`, ["Use the .csv file from TCGplayer's Export Shipping button, or in Excel use File → Save As → CSV."]);
    } else {
      let text = "";
      try { text = await f.text(); } catch { showMsg($("#load-msg"), "error", `${f.name} couldn't be read.`); return; }
      const shipments = text.startsWith("%PDF") ? null : shipmentsFromCsv(text);
      if (text.startsWith("%PDF")) pdfs.push(f);
      else if (shipments) applyShipments(shipments, f.name);
      else { const res = loadCsvText(text, f.name); if (res.orders.length && !pdfs.length) jumpTo("#step2"); }
    }
  }
  if (pdfs.length) await loadSlipFile(pdfs[0]);
}

function jumpTo(sel) {
  const t = $(sel);
  if (t && t.scrollIntoView) t.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

// ---------- Pirate Ship's Shipments export ----------

/** A dropped .xlsx: Pirate Ship's Shipments export gives tracking numbers; anything else gets told what to use. */
async function loadSpreadsheet(f) {
  let rows = null;
  try { rows = await readXlsx(await f.arrayBuffer()); } catch { rows = null; }
  if (rows && rows.length && isShipmentsHeader(rows[0])) return applyShipments(readShipments(rows), f.name);
  const heads = rows && rows[0] ? rows[0].filter((h) => String(h).trim()) : [];
  const payments = heads.some((h) => /balance/i.test(h)) && heads.some((h) => /description/i.test(h));
  showMsg($("#load-msg"), "error", payments ? `${f.name} is Pirate Ship's Transactions list (payments), not the Shipments list.` : `${f.name} isn't a file Ship Desk can use.`, [
    payments ? "In Pirate Ship open Reports → View All Shipments, then Export: that file has the tracking numbers."
      : "For orders, use the .csv file from TCGplayer's Export Shipping button. For tracking numbers, use Pirate Ship's Shipments export (Reports → View All Shipments → Export).",
    heads.length ? el("div", { class: "found" }, el("span", { class: "small muted", text: "Columns in your file: " }), heads.map((h) => el("code", { text: h }))) : null]);
  return null;
}

/**
 * Orders a Pirate Ship label can go to: this batch's TCGplayer orders and History's, one per order #. History
 * entries of other kinds (mailers) that carry a tracking number come along so their labels count as already there.
 */
function shipmentCandidates() {
  const out = new Map();
  for (const o of fileOrders()) {
    const s = own(state.shipped, o.id) || {};
    out.set(o.id, { id: o.id, name: o.name, zip: o.zip, date: isoDate(o.orderDate), tracking: s.tracking || o.tracking || "", shipped: !!s.shipped });
  }
  for (const r of Object.values(state.history)) {
    if (!r || typeof r !== "object") continue;
    const id = r.source === "csv" ? r.id : r.key;
    if (!safeKey(id) || out.has(id) || (r.source !== "csv" && !r.tracking)) continue;
    const s = (r.source === "csv" && own(state.shipped, id)) || {};
    out.set(id, { id, name: r.name, zip: r.zip, date: isoDate(r.orderDate) || String(r.printedAt || "").slice(0, 10),
      tracking: s.tracking || r.tracking || "", shipped: !!(s.shipped || r.shipped) });
  }
  return [...out.values()];
}

/** Put the tracking numbers from Pirate Ship's Shipments export on their orders (readShipments' result). */
export function applyShipments(res, fileName = "the Pirate Ship file") {
  const box = state.orders.length ? $("#match-msg") : $("#load-msg");
  if (!res || !res.shipments.length) {
    showMsg(box, "warn", `${fileName} has no labels with tracking numbers.`, [res && res.voided ? `${plural(res.voided, "voided label")} left out.` : null]);
    return null;
  }
  const m = matchShipments(res.shipments, shipmentCandidates());
  const inBatch = new Set(fileOrders().map((o) => o.id));
  for (const x of m.matches) {
    const entry = { tracking: x.tracking, carrier: x.carrier, shipped: true, at: today() };
    state.shipped[x.orderId] = withSent(x.orderId, entry);
    if (inBatch.has(x.orderId)) noteShipped(x.orderId);
    else { const r = own(state.history, x.orderId); if (r) applyShipped(r, entry); }
  }
  if (m.matches.length) { saveShipped(); saveHistory(); }
  const list = (items, text) => (items.length ? el("ul", { class: "plain" }, items.slice(0, 12).map((x) => el("li", {}, ...text(x))),
    items.length > 12 ? el("li", { text: `…and ${items.length - 12} more.` }) : null) : null);
  const lines = [
    list(m.matches, (x) => [`${x.orderId} (${x.name}): `, el("code", { text: x.tracking })]),
    m.already.length ? `${plural(m.already.length, "label was", "labels were")} already on ${m.already.length === 1 ? "its order" : "their orders"}.` : null,
    m.matches.some((x) => !inBatch.has(x.orderId))
      ? `${plural(m.matches.filter((x) => !inBatch.has(x.orderId)).length, "order isn't", "orders aren't")} in the orders loaded now: marked in History. Drop that day's TCGplayer CSV to put ${m.matches.length === 1 ? "it" : "them"} in an import file.` : null,
    m.conflicts.length ? "These buyers' orders already have a different tracking number (left as they are):" : null,
    list(m.conflicts, (x) => [`${x.name}: `, el("code", { text: x.tracking }), x.has ? ` (order ${x.orderId} has ${x.has})` : ` (order ${x.orderId})`]),
    m.unmatched.length ? "Not matched (type these on the order in the list if they're yours):" : null,
    list(m.unmatched, (x) => [`${x.name || "No name"}: `, el("code", { text: x.tracking }), ` (${x.why})`]),
    m.older.length ? `${plural(m.older.length, "label is", "labels are")} older than any order Ship Desk knows (left out).` : null,
    res.voided ? `${plural(res.voided, "voided label")} left out.` : null,
  ];
  showMsg(box, m.conflicts.length || m.unmatched.length ? "warn" : m.matches.length ? "ok" : "info",
    m.matches.length ? `Added ${plural(m.matches.length, "tracking number")} from ${fileName}.` : `No new tracking numbers in ${fileName}.`, lines);
  renderAll();
  if (state.orders.length) jumpTo("#step4");
  return m;
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
    source: state.source,
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
  const name = fileName(["Label", "Labels"], "pdf", orders);
  state.lastSave = savePdf(doc, name, "labels").then((res) => {
    showMsg(box, "ok", `Saved ${res.name} with ${plural(orders.length, "order")}.`,
      [...savedLines(res), "Open it and print at 100% scale (Actual size).", "These orders are now in your History."]);
    return res;
  });
  state.lastPrinted = orders.map((o) => o.id);
  keepBatch();
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
  const name = fileName(["Packing slip", "Packing slips"], "pdf", orders);
  state.lastSave = savePdf(doc, name, "slips").then((res) => {
    showMsg(box, "ok", `Saved ${res.name}: ${plural(pages.length, "slip page")} in label order.`, savedLines(res));
    return res;
  });
  return doc;
}

// ---------- tracking / shipped ----------

function saveShipped() { save(KEYS.shipped, state.shipped); }
function saveHistory() { save(KEYS.history, state.history); scheduleHistoryCopy(); }

// ---------- History's copy on this PC (Saved\History\ship-desk-history.json) ----------
// The browser holds History; Ship Desk keeps a copy so clearing the browser (or another browser) doesn't lose it.
// A browser only writes the copy once it is "linked" (KEYS.historyCopy): a browser that lost its History is
// offered the copy instead of overwriting it. Clearing the browser's storage clears that mark too.

let historyCopyTimer = 0;
function scheduleHistoryCopy() {
  clearTimeout(historyCopyTimer);
  historyCopyTimer = setTimeout(copyHistory, 800);
}

/** Write this browser's History to Saved\History (only when this browser is the linked one). */
export async function copyHistory() {
  clearTimeout(historyCopyTimer);
  if (load(KEYS.historyCopy, "") !== "on") return false;
  try {
    const r = await shipdeskFetch("api/history-copy", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ history: state.history }) });
    if (!r.ok) return false;
    state.historySavedAt = (await r.json()).savedAt || "";
    if (!$("#history-view").hidden) renderHistory();
    return true;
  } catch {
    return false; // Ship Desk is off: copied with the next change
  }
}

const sameRecords = (a, b) => {
  const ka = Object.keys(a || {}), kb = Object.keys(b || {});
  if (ka.length !== kb.length) return false;
  const sig = (r) => JSON.stringify([r.id, r.name, r.lastPrintedAt, r.printCount, r.shipped, r.shippedAt, r.tracking]);
  return ka.every((k) => b[k] && sig(a[k]) === sig(b[k]));
};

/** At start: link this browser to the copy, or (when it differs and this browser isn't linked) offer it. */
export async function checkHistoryCopy() {
  let copy;
  try {
    const r = await shipdeskFetch("api/history-copy");
    if (!r.ok) return null;
    copy = await r.json();
  } catch {
    return null;
  }
  state.historyCopy = null;
  state.historySavedAt = copy.savedAt || "";
  const linked = load(KEYS.historyCopy, "") === "on";
  if (linked || !copy.count || sameRecords(state.history, copy.history)) {
    save(KEYS.historyCopy, "on");
    if (!sameRecords(state.history, copy.history)) await copyHistory();
  } else {
    state.historyCopy = copy; // this browser lost its History, or is another browser: ask
  }
  renderHistory();
  return state.historyCopy ? "offer" : "linked";
}

/** The saved copy's records back into this browser (records this browser has win), plus step 4's shipped list. */
export async function restoreHistoryCopy() {
  const copy = state.historyCopy;
  if (!copy || !copy.history) return 0;
  state.history = { ...copy.history, ...state.history };
  for (const r of Object.values(state.history)) {
    if (r.source === "csv" && r.id && r.shipped && !state.shipped[r.id]) {
      state.shipped[r.id] = { tracking: r.tracking || "", carrier: r.carrier || "", shipped: true, at: String(r.shippedAt || "").slice(0, 10) };
    }
  }
  state.historyCopy = null;
  save(KEYS.historyCopy, "on");
  saveShipped();
  saveHistory();
  await copyHistory();
  renderAll();
  toast(`History restored: ${plural(Object.keys(state.history).length, "order")}.`);
  return Object.keys(state.history).length;
}

/** Keep this browser's History and make it the copy from now on (the earlier copy stays in Saved\History\Backups). */
export async function keepThisHistory() {
  state.historyCopy = null;
  save(KEYS.historyCopy, "on");
  renderHistory();
  await copyHistory();
  toast("This browser's History is the saved copy now.");
}

function renderHistoryCopy() {
  const box = $("#history-copy");
  const c = state.historyCopy;
  box.hidden = !c;
  if (!c) return;
  $("#history-copy-text").textContent = `Ship Desk has a saved copy of your History: ${plural(c.count, "order")}, last saved ${c.savedAt || "earlier"}. `
    + "This browser's History is different (it may have been cleared). Restore the saved copy?";
}

// Copy an order's shipped state (from this batch) into the history.
function noteShipped(id) {
  const o = state.orders.find((x) => x.id === id);
  if (!o) return;
  recordShipped(state.history, o, state.shipped[id] || null, { source: state.source });
  saveHistory();
}

// A new shipped entry for an order, keeping the note of what was already sent to TCGplayer (entry.sent).
const withSent = (id, entry) => (state.shipped[id] && state.shipped[id].sent ? { ...entry, sent: state.shipped[id].sent } : entry);

function setTracking(id, tracking) {
  const t = String(tracking || "").trim();
  if (t) state.shipped[id] = withSent(id, { tracking: t, carrier: detectCarrier(t) || "USPS", shipped: true, at: today() });
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
    state.shipped[m.orderId] = withSent(m.orderId, { tracking: m.tracking, carrier: m.carrier || detectCarrier(m.tracking) || "USPS", shipped: true, at: today() });
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

/**
 * The TCGplayer import file for this batch: { csv, count, missingRequired, included, already }. Orders already
 * sent in an earlier import file (with the same tracking number or "Shipped") are left out, unless "Put them in
 * again" is ticked.
 */
export function importFile() {
  return importFileCsv(fileOrders(), state.shipped, { skipSent: !state.importAgain });
}

export function downloadImportFile() {
  const box = $("#ship-msg");
  if (state.source !== "csv") { showMsg(box, "warn", "The import file only works with orders from a TCGplayer CSV.", ["Pasted addresses aren't TCGplayer orders, so there's nothing to mark shipped there."]); return null; }
  const r = importFile();
  if (!r.count) {
    showMsg(box, "warn", "Nothing to import yet.", [r.already.length
      ? `The ${plural(r.already.length, "shipped order")} ${r.already.length === 1 ? "was" : "were"} already in an earlier import file. Tick "Put them in again" to send ${r.already.length === 1 ? "it" : "them"} again.`
      : "Add a tracking number or tick Shipped for at least one order."]);
    return null;
  }
  const name = fileName(["TCGplayer import", "TCGplayer import"], "csv", [], r.count);
  // Remember what went in, so the next import file only has what's new (or changed).
  const at = stamp();
  for (const { id, what } of r.included) {
    state.shipped[id] = { ...(state.shipped[id] || { tracking: "", carrier: "", shipped: true, at: today() }), sent: { at, what } };
    if (state.history[id]) state.history[id].sentAt = at;
  }
  state.importAgain = false;
  saveShipped();
  saveHistory();
  state.lastSave = saveBlob(name, "import", new Blob([r.csv], { type: "text/csv" })).then((res) => {
    showMsg(box, r.missingRequired.length ? "warn" : "ok", `Saved ${res.name} with ${plural(r.count, "order")}.`,
      [...savedLines(res), r.missingRequired.length ? `TCGplayer will refuse ${r.missingRequired.join(", ")} without a tracking number.` : null,
        r.already.length ? `Left out ${plural(r.already.length, "order")} already in an earlier import file.` : null,
        "Upload it in the Seller Portal: Orders → Import Shipping Info."]);
    return res;
  });
  state.done[4] = true;
  renderSteps();
  renderShip();
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
  const name = fileName(["Pirate Ship", "Pirate Ship"], "csv", [], rows);
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
      el("div", { class: "who" }, el("span", { class: "oid", text: o.id }), el("span", { class: "muted", text: o.name }), chip(o.plan),
        s.sent ? el("span", { class: "sent small", title: `In the import file of ${s.sent.at} (${s.sent.what})`, text: `Sent to TCGplayer ${String(s.sent.at).slice(5, 10)}` }) : null),
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
  // Orders already sent in an earlier import file (same tracking number or "Shipped").
  const sent = state.source === "csv" ? importFileCsv(fileOrders(), state.shipped, { skipSent: true }).already : [];
  $("#ship-sent").hidden = !sent.length;
  if (sent.length) {
    const last = sent.map((id) => state.shipped[id].sent.at).sort().pop();
    $("#ship-sent-text").textContent = `${plural(sent.length, "shipped order")} ${sent.length === 1 ? "was" : "were"} already in an import file (last ${last}) and ${state.importAgain ? "will go in again" : "will be left out"}.`;
    $("#import-again").checked = state.importAgain;
  }
  $("#btn-import").textContent = state.source === "csv" && r.count ? `Download TCGplayer import file (${plural(r.count, "order")})` : "Download TCGplayer import file";
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
    r.source === "mailer" && !r.id
      ? el("td", { class: "c-id" },
        el("label", { class: "sr", for: "hoid-" + tid, text: `TCGplayer order number for ${label}` }),
        el("input", { id: "hoid-" + tid, class: "trk-input h-oid", type: "text", placeholder: "Add order #", autocomplete: "off", spellcheck: "false" }),
        el("span", { class: "sub muted", text: "Mailer scanned on the phone" }))
      : el("td", { class: "c-id" }, el("span", { class: "oid", text: r.id || "Pasted" }), r.orderDate ? el("span", { class: "sub muted", text: r.orderDate }) : null),
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
        link ? el("a", { href: link, target: "_blank", rel: "noopener noreferrer", class: "small", text: `Track on ${r.carrier} ↗` }) : null,
        r.sentAt ? el("span", { class: "sent small", text: `Sent to TCGplayer ${String(r.sentAt).slice(0, 10)}` }) : null)),
    photoCell(r, label),
    el("td", { class: "c-del" }, el("button", { type: "button", class: "link danger h-del", "aria-label": `Remove ${label} from the history`, text: "Remove" })));
}

function photoCell(r, label) {
  const ph = state.photos[r.key];
  if (!ph || !ph.total) return el("td", { class: "c-photos" }, el("span", { class: "muted", text: "No photos" }));
  return el("td", { class: "c-photos" },
    el("button", { type: "button", class: "link h-photos", "aria-label": `See the ${plural(ph.total, "photo")} for ${label}`, text: plural(ph.total, "photo") }),
    PHOTO_KINDS.filter((k) => ph[k.id]).map((k) => el("span", { class: "sub muted", text: `${ph[k.id]} ${k.short}` })));
}

export function renderHistory() {
  schedulePhoneSync();
  renderHistoryCopy();
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
  $("#history-totals").textContent = `${plural(counts.all, "order")} · ${counts.printed} with labels made here · ${counts.shipped} shipped · ${counts.waiting} not shipped yet`
    + (state.historySavedAt && load(KEYS.historyCopy, "") === "on" ? ` · copy in Saved\\History (${state.historySavedAt})` : "");
  const rows = historyList(state.history, { filter: state.historyFilter, search: state.historySearch });
  const body = $("#history-table tbody");
  body.replaceChildren(...(rows.length ? rows.map(historyRow)
    : [el("tr", { class: "none" }, el("td", { colspan: "9", text: state.historySearch ? "No orders match your search." : "No orders here." }))]));
}

// A Shipped tick or tracking number changed on the History page. TCGplayer orders also update the
// shipped list used by step 4, so the import file and a re-uploaded file agree with the history.
function updateHistoryShipped(key, entry) {
  const r = state.history[key];
  if (!r) return;
  applyShipped(r, entry);
  saveHistory();
  if (r.source === "csv" && r.id) {
    if (r.shipped) state.shipped[r.id] = withSent(r.id, { tracking: r.tracking, carrier: r.carrier, shipped: true, at: today() });
    else delete state.shipped[r.id];
    saveShipped();
  }
  renderAll();
}

/**
 * A mailer entry (scanned on the phone, no order # yet) gets its TCGplayer order #: it becomes that order's
 * record (merged with one already in History), counts as shipped with its tracking in step 4, and its photos
 * move to the order's folder.
 */
export async function setOrderNumber(oldKey, value) {
  const id = String(value || "").trim();
  const r = state.history[oldKey];
  if (!r || !id || id === oldKey) return null;
  const cur = state.history[id];
  const rec = { ...r, ...(cur || {}), key: id, id, source: "csv", name: (cur && cur.name) || r.name };
  if (!rec.tracking) Object.assign(rec, { tracking: r.tracking, carrier: r.carrier });
  rec.shipped = true;
  rec.shippedAt = (cur && cur.shippedAt) || r.shippedAt;
  delete state.history[oldKey];
  state.history[id] = rec;
  state.shipped[id] = withSent(id, { tracking: rec.tracking, carrier: rec.carrier, shipped: true, at: today() });
  saveHistory();
  saveShipped();
  try {
    await shipdeskFetch("api/photos-rekey", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: oldKey, to: id, name: rec.name }) });
  } catch { /* Ship Desk's window is closed: the photos stay under the mailer for now */ }
  await refreshPhotos();
  renderAll();
  toast(`${r.name || "The mailer"} is now order ${id}.`);
  return rec;
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
    } else if (e.target.classList.contains("h-oid")) {
      setOrderNumber(key, e.target.value);
    } else if (e.target.classList.contains("h-trk")) {
      const t = e.target.value.trim();
      const r = state.history[key];
      updateHistoryShipped(key, t ? { tracking: t, carrier: detectCarrier(t) || "USPS", shipped: true } : (r && r.shipped ? { shipped: true } : null));
    }
  });
  body.addEventListener("click", (e) => {
    const pb = e.target.closest(".h-photos");
    if (pb) { openPhotos(pb.closest("tr[data-key]").dataset.key); return; }
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
    const n = historyList(state.history, { filter: state.historyFilter, search: state.historySearch }).length;
    state.lastSave = saveBlob(fileName(["Ship Desk history", "Ship Desk history"], "csv", [], n), "history", new Blob([historyFile()], { type: "text/csv" })).then((res) => {
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
  $("#btn-history-restore").addEventListener("click", () => restoreHistoryCopy());
  $("#btn-history-keep").addEventListener("click", () => {
    if (window.confirm("Keep this browser's History and replace the saved copy with it? (The earlier copy stays in Saved\\History\\Backups.)")) keepThisHistory();
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
  if (hist) { renderHistory(); refreshPhotos(); loadBackup(); }
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

// ---------- phone photos ----------
// The phone page (phone.html) takes photos for orders and serve.py saves them in Saved\Photos. The PC
// page sends serve.py the order list the phone picks from, shows the pairing QR code, and shows each
// order's photos in History.

export const PHOTO_KINDS = [
  { id: "contents", label: "Contents", short: "contents" },
  { id: "packed", label: "Packed, ready to ship", short: "packed" },
  { id: "postoffice", label: "At the post office", short: "post office" },
];

const shipdeskFetch = (path, opts = {}) => fetch(path, { ...opts, headers: { ...(opts.headers || {}), "X-Ship-Desk": "1" } });

// ---------- backup of the Saved folder ----------
// serve.py copies what's new in Saved\ to <Dropbox or OneDrive>\Ship Desk backup every hour while it's switched on;
// the History page shows the switch, where it goes, the last backup and "Back up now".

const backup = { status: null, busy: false };

/** How the backup stands, from Ship Desk ({ on, to, name, available, places, folder, at, copied, files, error }; null when it's off). */
export async function loadBackup() {
  try {
    const r = await shipdeskFetch("api/backup");
    backup.status = r.ok ? await r.json() : null;
  } catch { backup.status = null; }
  renderBackup();
  return backup.status;
}

async function backupCall(query) {
  backup.busy = true;
  renderBackup();
  try {
    const data = await (await shipdeskFetch(`api/backup?${query}`, { method: "POST" })).json();
    if (data && "on" in data) backup.status = data;
    return data;
  } catch {
    toast("Ship Desk isn't running, so the backup can't be changed now.");
    return null;
  } finally {
    backup.busy = false;
    renderBackup();
  }
}

const backupWhat = (s) => (s.copied ? `${plural(s.copied, "new or changed file")} copied` : "nothing new to copy");

/** Switch the hourly backup on (it backs up right away) or off (what's already backed up stays). */
export async function setBackup(on) {
  const d = await backupCall(`on=${on ? 1 : 0}`);
  if (d) toast(d.error || (on ? `Backed up to ${d.name}: ${backupWhat(d)}. From now on every hour.` : `Backup switched off. What's in ${d.name} stays there.`));
  return d;
}

/** Back up to "dropbox" or "onedrive" from now on (right away when it's on). The old place keeps its copy. */
export async function setBackupPlace(to) {
  const d = await backupCall(`to=${encodeURIComponent(to)}`);
  if (d) toast(d.error || (d.on ? `Backed up to ${d.name}: ${backupWhat(d)}. From now on every hour.` : `The backup will go to ${d.name}.`));
  return d;
}

export async function backupNow() {
  const d = await backupCall("now=1");
  if (d) toast(d.error || `Backed up to ${d.name}: ${backupWhat(d)}.`);
  return d;
}

function renderBackup() {
  const s = backup.status;
  $("#backup-row").hidden = !s;
  if (!s) return;
  const can = s.available && !backup.busy;
  $("#backup-on").checked = !!s.on;
  $("#backup-on").disabled = !can;
  const to = $("#backup-to");
  for (const o of to.options) o.disabled = !(s.places && s.places[o.value]);
  to.value = s.to;
  to.disabled = backup.busy;
  $("#btn-backup-now").hidden = $("#btn-backup-open").hidden = !s.available;
  $("#btn-backup-now").disabled = !can;
  $("#backup-text").textContent = !s.available ? `${s.name} isn't set up on this PC.`
    : backup.busy ? "Backing up…"
    : s.error ? s.error
    : s.at ? `Last backup ${s.at}: ${plural(s.files, "file")}${s.copied ? `, ${s.copied} new or changed` : ", nothing new"}.`
    : s.on ? "The first backup runs soon." : "Off.";
}

function bindBackup() {
  $("#backup-on").addEventListener("change", (e) => setBackup(e.target.checked));
  $("#backup-to").addEventListener("change", (e) => setBackupPlace(e.target.value));
  $("#btn-backup-now").addEventListener("click", backupNow);
  $("#btn-backup-open").addEventListener("click", () => backupCall("open=1"));
}

// ---------- turning Ship Desk off and on ----------
// Off: the page asks serve.py (running in the background) to stop. On: the shipdesk://start link, which serve.py
// registers with Windows, starts it again. The page itself still opens when Ship Desk is off (sw.js).

const POWER_TEXT = { checking: "Checking…", on: "Ship Desk on", stopping: "Turning off…", off: "Ship Desk is off", starting: "Starting…" };
const POWER_CHECK_MS = 10000;   // how often the header checks while nothing is happening
const POWER_WAIT_MS = 40000;    // how long turning on/off may take before the header gives up
export const power = { state: "checking", since: 0, timer: 0, autostart: null }; // autostart: null = not known

async function ping() {
  try {
    const r = await shipdeskFetch("api/ping", { cache: "no-store" });
    return r.ok ? await r.json() : null;
  } catch {
    return null; // not running
  }
}

function renderPower() {
  const box = $("#power");
  if (!box) return;
  box.dataset.state = power.state;
  $("#power-text").textContent = POWER_TEXT[power.state];
  $("#btn-power-off").hidden = power.state !== "on";
  $("#btn-power-on").hidden = power.state !== "off";
  $("#power-auto-wrap").hidden = power.state !== "on" || power.autostart == null;
  if (document.activeElement !== $("#power-auto")) $("#power-auto").checked = !!power.autostart;
}

/** "Start with Windows": add Ship Desk to this Windows user's startup list, or take it off. */
export async function setAutostart(on) {
  try {
    const r = await shipdeskFetch(`api/autostart?on=${on ? 1 : 0}`, { method: "POST" });
    const data = await r.json();
    power.autostart = !!data.autostart;
    toast(data.ok ? (power.autostart ? "Ship Desk now starts with Windows (in the background)." : "Ship Desk won't start with Windows any more.")
      : "Windows didn't accept that change.");
  } catch {
    toast("Ship Desk isn't running, so that can't be changed now.");
  }
  renderPower();
  return power.autostart;
}

/** Ask whether Ship Desk is running and show it; while turning on/off, keep asking until it has. */
export async function checkPower() {
  clearTimeout(power.timer);
  const info = await ping();
  const up = !!info;
  if (info) power.autostart = typeof info.autostart === "boolean" ? info.autostart : null;
  const waited = Date.now() - power.since;
  if (power.state === "stopping") {
    if (!up) power.state = "off";
    else if (waited > POWER_WAIT_MS) { power.state = "on"; toast("Ship Desk didn't turn off. Double-click \"Stop Ship Desk\" in the Shipping folder."); }
  } else if (power.state === "starting") {
    if (up) { power.state = "on"; toast("Ship Desk is on."); refreshPhotos(); takePhoneLinks(); checkHistoryCopy(); }
    else if (waited > POWER_WAIT_MS) { power.state = "off"; toast("Ship Desk didn't start. Double-click \"Start Ship Desk\" in the Shipping folder."); }
  } else {
    power.state = up ? "on" : "off";
  }
  renderPower();
  const busy = power.state === "stopping" || power.state === "starting";
  power.timer = setTimeout(checkPower, busy ? 700 : POWER_CHECK_MS);
  return power.state;
}

/** The header's Turn off. */
export async function turnOff() {
  if (!window.confirm("Turn off Ship Desk?\n\nWhile it's off, files save to your Downloads folder, and photos from your phone wait on the phone until it's on again.")) return false;
  power.state = "stopping";
  power.since = Date.now();
  renderPower();
  try { await shipdeskFetch("api/shutdown", { method: "POST" }); } catch { /* already off */ }
  checkPower();
  return true;
}

function bindPower() {
  $("#btn-power-off").addEventListener("click", () => turnOff());
  $("#power-auto").addEventListener("change", (e) => setAutostart(e.target.checked));
  // The link itself asks Windows to start Ship Desk (the browser asks first); the page then waits for it.
  $("#btn-power-on").addEventListener("click", () => {
    power.state = "starting";
    power.since = Date.now();
    renderPower();
    setTimeout(checkPower, 1500);
  });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkPower(); });
  checkPower();
}

/** The orders the phone can pick from: the History list plus the batch loaded now (name, city, ZIP; no street). */
export function phoneOrders() {
  const out = new Map();
  for (const r of Object.values(state.history)) {
    out.set(r.key, { key: r.key, id: r.id, source: r.source, name: r.name, city: r.city, state: r.state, zip: r.zip,
      labelled: r.lastPrintedAt || r.printedAt || "", format: formatName(r.format), shipped: r.shipped ? (r.shippedAt || today()) : "",
      inBatch: false, tracking: r.tracking || "" });
  }
  for (const o of state.orders) {
    const key = historyKey(o, state.source);
    if (!key || key === "paste:|") continue;
    const cur = out.get(key);
    const tracking = (state.shipped[o.id] || {}).tracking || o.tracking || "";
    out.set(key, cur ? { ...cur, inBatch: true, tracking: cur.tracking || tracking } : { key, id: state.source === "paste" ? "" : String(o.id || ""),
      source: state.source === "paste" ? "paste" : "csv", name: o.name || "", city: o.city || "", state: o.state || "", zip: o.zip || "",
      labelled: "", format: "", shipped: isShippedNow(o) ? today() : "", inBatch: true, tracking });
  }
  return [...out.values()];
}

let phoneSyncTimer = 0;
let phoneSynced = "";
function schedulePhoneSync() {
  clearTimeout(phoneSyncTimer);
  phoneSyncTimer = setTimeout(syncPhoneOrders, 400);
}

/** Send the order list to serve.py for the phone (only kept once a phone has been set up). */
export async function syncPhoneOrders(force = false) {
  clearTimeout(phoneSyncTimer);
  const body = JSON.stringify({ orders: phoneOrders() });
  if (!force && body === phoneSynced) return true;
  try {
    const r = await shipdeskFetch("api/phone-orders", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    if (r.ok) { phoneSynced = body; return true; }
  } catch { /* Ship Desk's window is closed: nothing to sync with */ }
  return false;
}

/** Ask serve.py which orders have photos, then redraw History. Orders of this batch with photos join History. */
export async function refreshPhotos() {
  try {
    const r = await shipdeskFetch("api/photos");
    if (r.ok) state.photos = (await r.json()).orders || {};
  } catch { /* not running: keep what we had */ }
  let added = 0;
  for (const o of state.orders) {
    const key = historyKey(o, state.source);
    if (state.photos[key] && !state.history[key]) { recordSeen(state.history, o, { source: state.source }); added++; }
  }
  if (added) saveHistory();
  if (!$("#history-view").hidden || added) renderHistory();
  return state.photos;
}

/**
 * Notes from the phone: a tracking number scanned off a mailer and given to an order, or (no tracking number)
 * "shipped", left by a post office photo. They go on the order in History and, for TCGplayer orders, in the
 * shipped list step 4 uses for the import file. A "shipped" note leaves an order that is already shipped as it
 * is. Returns how many notes were taken.
 */
export async function takePhoneLinks() {
  let links = [];
  try {
    const r = await shipdeskFetch("api/links");
    if (r.ok) links = (await r.json()).links || [];
  } catch { return 0; }
  if (!links.length) return 0;
  let tracked = 0, shipped = 0;
  for (const ln of links) {
    // A note for "__proto__" & co. would reach every record at once: skip anything that isn't an order key.
    if (!safeKey(ln.order) || (ln.orderId && !safeKey(ln.orderId))) continue;
    const o = state.orders.find((x) => historyKey(x, state.source) === ln.order);
    const source = o ? state.source : ["paste", "mailer"].includes(ln.source) ? ln.source : "csv";
    const order = o || { id: ln.orderId || "", name: ln.name, city: ln.city, state: ln.state, zip: ln.zip, tracking: ln.tracking };
    const r = own(state.history, ln.order);
    const now = (source === "csv" && order.id && own(state.shipped, order.id)) || {};
    let entry;
    if (ln.tracking) {
      entry = { tracking: ln.tracking, carrier: ln.carrier || detectCarrier(ln.tracking) || "USPS", shipped: true };
      tracked++;
    } else {
      if ((r && r.shipped) || (o && isShippedNow(o)) || now.shipped) continue;
      const tracking = now.tracking || (r && r.tracking) || "";
      entry = { tracking, carrier: tracking ? now.carrier || (r && r.carrier) || "" : "", shipped: true };
      shipped++;
    }
    if (r && !o) applyShipped(r, entry, String(ln.taken || "").replace("T", " ").slice(0, 16) || undefined);
    else recordShipped(state.history, order, entry, { source, when: String(ln.taken || "").replace("T", " ").slice(0, 16) || undefined });
    if (source === "csv" && order.id) state.shipped[order.id] = { ...now, ...entry, at: today() };
  }
  saveHistory();
  saveShipped();
  try {
    await shipdeskFetch("api/links-done", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: links.map((l) => l.id) }) });
  } catch { /* taken again next time: applying twice gives the same result */ }
  renderAll();
  const said = [tracked ? `${plural(tracked, "tracking number")} added` : "", shipped ? `${plural(shipped, "order")} marked shipped (post office photo)` : ""].filter(Boolean);
  if (said.length) toast(`From your phone: ${said.join(", ")}.`);
  return links.length;
}

const svgNode = (tag, attrs) => {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

function qrSvg(text) {
  const qr = window.qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
  const svg = svgNode("svg", { viewBox: `0 0 ${n + 8} ${n + 8}`, class: "qr", role: "img", "aria-label": "QR code with the phone link" });
  svg.append(svgNode("rect", { width: n + 8, height: n + 8, fill: "#fff" }), svgNode("path", { d, fill: "#000", "shape-rendering": "crispEdges" }));
  return svg;
}

async function loadPhoneLink(method = "GET", path = "api/phone-link") {
  try {
    const r = await shipdeskFetch(path, { method });
    const data = await r.json();
    state.phone = data;
    return data;
  } catch {
    state.phone = { ok: false, error: "Ship Desk isn't running. Turn it on with the switch at the top (or \"Start Ship Desk.bat\")." };
    return state.phone;
  }
}

function renderPhone() {
  const box = $("#phone-body");
  const body = { replaceChildren: (...kids) => box.replaceChildren(...kids.filter(Boolean)) };
  const p = state.phone;
  if (!p) { body.replaceChildren(el("p", { class: "muted", text: "Checking…" })); return; }
  const ts = p.tailscale || {};
  const err = p.error ? el("div", { class: "msg error" }, el("p", { class: "msg-title", text: "That didn't work." }), el("p", { text: p.error })) : null;
  const again = el("button", { type: "button", class: "btn secondary", "data-phone": "check", text: "Check again" });
  if (!p.tailscale) { body.replaceChildren(err || el("p", { text: "Ship Desk's window isn't running." }), el("div", { class: "row" }, again)); return; }
  if (!ts.installed) {
    body.replaceChildren(el("p", { text: "Your phone reaches this PC through Tailscale, and Tailscale isn't installed here." }),
      el("p", { class: "muted", text: "Install Tailscale on this PC and on your phone, log in to the same account on both, then click Check again." }),
      el("div", { class: "row" }, again));
    return;
  }
  if (!ts.running) {
    body.replaceChildren(el("p", { text: "Tailscale isn't connected on this PC." }),
      el("p", { class: "muted", text: "Click the Tailscale icon by the clock and choose Connect (log in if it asks), then click Check again." }),
      err, el("div", { class: "row" }, again));
    return;
  }
  if (!p.ready) {
    body.replaceChildren(
      el("p", { text: "Phone access is off." }),
      el("p", { class: "muted" }, "Switching it on gives Ship Desk's phone page an address that only your own Tailscale devices can open (not the internet): ",
        el("code", { text: p.address || "" }), ". The rest of Ship Desk stays on this PC only."),
      err,
      el("div", { class: "row" }, el("button", { type: "button", class: "btn primary", "data-phone": "on", text: "Switch on phone access" })));
    return;
  }
  body.replaceChildren(
    el("div", { class: "phone-grid" },
      el("div", { class: "qr-box" }, qrSvg(p.link)),
      el("ol", { class: "phone-steps" },
        el("li", {}, "On your iPhone, open the ", el("strong", { text: "Tailscale" }), " app and check it says Connected."),
        el("li", {}, "Open the ", el("strong", { text: "Camera" }), " app, point it at this code and tap the link that pops up."),
        el("li", {}, "In Safari tap ", el("strong", { text: "Share → Add to Home Screen" }), ". Next time it's one tap, and it opens even with no signal."))),
    el("dl", { class: "phone-facts" },
      el("dt", { text: "Address" }), el("dd", {}, el("code", { text: p.address })),
      el("dt", { text: "Pairing code" }), el("dd", {}, el("code", { class: "pair-code", text: p.code }), el("span", { class: "muted small", text: " (type it on the phone if the QR code doesn't work)" }))),
    el("p", { class: "muted small", text: "Photos taken where the PC can't be reached (at the post office, or with the PC off) wait on the phone and are sent when Ship Desk is running again and you open the page." }),
    err,
    el("div", { class: "row" },
      el("button", { type: "button", class: "btn secondary", "data-phone": "folder", text: "Open the Photos folder" }),
      el("button", { type: "button", class: "link", "data-phone": "newcode", text: "New pairing code" }),
      el("button", { type: "button", class: "link danger", "data-phone": "off", text: "Switch off phone access" })));
}

export async function openPhone() {
  const dlg = $("#phone-dialog");
  state.phone = null;
  renderPhone();
  if (!dlg.open) dlg.showModal();
  await loadPhoneLink();
  renderPhone();
  if (state.phone && state.phone.code) syncPhoneOrders(true);
  return state.phone;
}

async function phoneAction(what) {
  if (what === "check") { state.phone = null; renderPhone(); await loadPhoneLink(); }
  else if (what === "on" || what === "off") {
    if (what === "off" && !window.confirm("Switch off phone access? The phone can't send photos until you switch it on again (photos it takes meanwhile wait on the phone).")) return;
    state.phone = null;
    renderPhone();
    await loadPhoneLink("POST", `api/phone-access?on=${what === "on" ? 1 : 0}`);
  } else if (what === "newcode") {
    if (!window.confirm("Make a new pairing code? Phones that were set up must scan the new QR code (their waiting photos are kept).")) return;
    await loadPhoneLink("POST", "api/phone-key");
  } else if (what === "folder") { openSavedFolder("photos"); return; }
  renderPhone();
}

let photoUrls = [];
function closePhotos() {
  for (const u of photoUrls) URL.revokeObjectURL(u);
  photoUrls = [];
}

// ---------- proof pack: one PDF per order for a claim or a buyer's question ----------

// A saved photo as a JPEG the PDF can hold (at most 2000 px), or null (missing, or a kind the browser can't draw).
async function photoForPdf(p, key) {
  try {
    const res = await shipdeskFetch(`api/photo?id=${encodeURIComponent(p.id)}&order=${encodeURIComponent(key)}`);
    if (!res.ok) return null;
    const bmp = await createImageBitmap(await res.blob());
    const s = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * s);
    c.height = Math.round(bmp.height * s);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return { data: c.toDataURL("image/jpeg", 0.85), w: c.width, h: c.height };
  } catch {
    return null;
  }
}

/**
 * The proof pack for one order: page 1 = the order, where it went, when its label was made and it shipped, the
 * tracking number (with its tracking page), when it went to TCGplayer; then every photo (contents, packed,
 * post office), one per page with the time it was taken. Saved in Saved\Proof packs. Returns the jsPDF doc.
 */
export async function proofPack(key) {
  const box = $("#proof-msg");
  const r = state.history[key] || { key, id: key.startsWith("paste:") || key.startsWith("mailer:") ? "" : key, name: "" };
  const ph = state.photos[key] || { photos: [] };
  if (box) showMsg(box, "info", "Making the proof pack…");
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "in", format: "letter", compress: true });
  doc.setProperties({ title: `Proof of shipment ${r.id || r.name}`, creator: "Ship Desk" });
  const W = 8.5, M = 0.75;
  const t = (s) => cleanText(s);
  let y = M + 0.2;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(22);
  doc.text("Proof of shipment", M, y);
  y += 0.45;
  doc.setFontSize(14);
  doc.text(t(r.id ? `Order ${r.id}` : r.source === "mailer" ? "Mailer (no order # yet)" : "Pasted address"), M, y);
  y += 0.5;
  const kinds = PHOTO_KINDS.map((k) => ({ ...k, list: ph.photos.filter((p) => p.kind === k.id).sort((a, b) => String(a.taken).localeCompare(String(b.taken))) }));
  const link = trackingUrl(r.tracking, r.carrier);
  const facts = [
    ["Buyer", r.name],
    ["Ships to", `${r.city || ""}${r.city && r.state ? ", " : ""}${r.state || ""} ${r.zip || ""}`.trim()],
    ["Order date", r.orderDate],
    ["Value", r.value ? money(r.value) : ""],
    ["Items", r.items ? String(r.items) : ""],
    ["Label made", r.printedAt ? `${r.lastPrintedAt || r.printedAt}${r.format ? ` (${formatName(r.format)})` : ""}` : ""],
    ["Shipped", r.shipped ? (r.shippedAt || "yes") : "not marked shipped"],
    ["Tracking", r.tracking ? `${r.tracking}${r.carrier ? ` (${r.carrier})` : ""}` : "none"],
    ["Sent to TCGplayer", r.sentAt || ""],
    ["Photos", ph.photos.length ? kinds.filter((k) => k.list.length).map((k) => `${k.list.length} ${k.short}`).join(", ") : "none"],
  ].filter(([, v]) => v);
  doc.setFontSize(11);
  for (const [k, v] of facts) {
    doc.setFont("helvetica", "bold");
    doc.text(t(k), M, y);
    doc.setFont("helvetica", "normal");
    const lines = doc.splitTextToSize(t(v), W - M - 2.6);
    doc.text(lines, M + 1.9, y);
    y += 0.3 * lines.length;
  }
  if (link) {
    y += 0.1;
    doc.setTextColor(19, 111, 99);
    doc.textWithLink(t(`Tracking page: ${link}`.slice(0, 110)), M, y, { url: link });
    doc.setTextColor(0, 0, 0);
    y += 0.3;
  }
  doc.setFontSize(9);
  doc.setTextColor(90, 90, 90);
  doc.text(doc.splitTextToSize(t(`Made by Ship Desk on ${stamp()}. Photos were taken with Ship Desk Photos and saved on the seller's PC; `
    + "times are the phone's clock when each photo was taken."), W - 2 * M), M, 10.4);
  doc.setTextColor(0, 0, 0);
  const shots = [];
  let skipped = 0;
  for (const k of kinds) {
    for (const p of k.list) {
      const img = await photoForPdf(p, key);
      if (img) shots.push({ k, p, img }); else skipped++;
    }
  }
  // Page 1 also shows every photo small, with what and when, so the first page tells the whole story.
  if (shots.length) {
    y += 0.25;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text("Photos (each one full size on the next pages)", M, y);
    y += 0.2;
    const cols = 4, gap = 0.15, cw = (W - 2 * M - gap * (cols - 1)) / cols, ch = cw * 1.1;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    shots.forEach(({ k, p, img }, i) => {
      const cx = M + (i % cols) * (cw + gap), cy = y + Math.floor(i / cols) * (ch + 0.4);
      if (cy + ch > 10.1) return; // more than fit: they're on the pages after
      const s = Math.min(cw / img.w, ch / img.h);
      doc.addImage(img.data, "JPEG", cx + (cw - img.w * s) / 2, cy, img.w * s, img.h * s, undefined, "FAST");
      doc.text(t(`${k.label}, ${String(p.taken).replace("T", " ").slice(0, 16)}`), cx, cy + ch + 0.15, { maxWidth: cw });
    });
  }
  // One photo per page, largest that fits under its caption.
  let shown = 0;
  for (const { k, p, img } of shots) {
    doc.addPage("letter", "portrait");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text(t(`${k.label} photo`), M, M + 0.1);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.text(t(`${r.id ? `Order ${r.id}` : r.name} - taken ${String(p.taken).replace("T", " ")}`), M, M + 0.38);
    const bw = W - 2 * M, bh = 11 - 2 * M - 0.6;
    const s = Math.min(bw / img.w, bh / img.h);
    doc.addImage(img.data, "JPEG", M + (bw - img.w * s) / 2, M + 0.6, img.w * s, img.h * s, undefined, "FAST");
    shown++;
  }
  const name = fileName(["Proof pack", "Proof pack"], "pdf", [{ id: r.id, name: r.name }]);
  state.lastSave = savePdf(doc, name, "proof").then((res) => {
    if (box) showMsg(box, "ok", `Saved ${res.name}: the order and ${plural(shown, "photo")}.`,
      [...savedLines(res), skipped ? `${plural(skipped, "photo")} couldn't be put in the PDF (not a picture this browser can show).` : null]);
    return res;
  });
  return doc;
}

/** Turn a saved photo a quarter turn (deg = 90 right, -90 left) and save it over the old file. */
export async function rotatePhoto(p, key, img, deg) {
  if (!img.naturalWidth) return false;
  const c = document.createElement("canvas");
  c.width = img.naturalHeight;
  c.height = img.naturalWidth;
  const g = c.getContext("2d");
  g.translate(c.width / 2, c.height / 2);
  g.rotate((deg * Math.PI) / 180);
  g.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.92));
  if (!blob) return false;
  try {
    const r = await shipdeskFetch(`api/photo-rotate?id=${encodeURIComponent(p.id)}&order=${encodeURIComponent(key)}`,
      { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob });
    if (!r.ok) { toast("Couldn't turn that photo."); return false; }
  } catch { toast("Ship Desk's window isn't running, so the photo can't be turned."); return false; }
  return true;
}

/** The photos window for one order (History → Photos). */
export async function openPhotos(key) {
  const r = state.history[key] || {};
  const ph = state.photos[key] || { photos: [] };
  const dlg = $("#photos-dialog");
  closePhotos();
  $("#photos-h").textContent = `Photos · ${r.id || r.name || key}${r.id && r.name ? " · " + r.name : ""}`;
  const groups = PHOTO_KINDS.map((k) => {
    const list = ph.photos.filter((p) => p.kind === k.id).sort((a, b) => String(a.taken).localeCompare(String(b.taken)));
    if (!list.length) return null;
    return el("section", { class: "photo-group" }, el("h3", { text: `${k.label} (${list.length})` }),
      el("div", { class: "photo-grid" }, list.map((p) => {
        const when = String(p.taken).replace("T", " ").slice(0, 16);
        const img = el("img", { alt: `${k.label} photo, ${when}`, loading: "lazy" });
        const a = el("a", { class: "photo-link", target: "_blank", rel: "noopener" }, img);
        const load = () => shipdeskFetch(`api/photo?id=${encodeURIComponent(p.id)}&order=${encodeURIComponent(key)}&t=${Date.now()}`)
          .then((res) => (res.ok ? res.blob() : null)).then((blob) => {
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            photoUrls.push(url);
            img.src = url;
            a.href = url;
          }).catch(() => {});
        load();
        const turnable = /\.jpe?g$/i.test(String(p.file || ""));
        const turn = (deg) => el("button", { type: "button", class: "link turn", "aria-label": `Turn this photo ${deg < 0 ? "left" : "right"}`,
          title: `Turn ${deg < 0 ? "left" : "right"}`, text: deg < 0 ? "\u21ba" : "\u21bb",
          onclick: async (e) => {
            e.currentTarget.disabled = true;
            try { if (await rotatePhoto(p, key, img, deg)) load(); } finally { e.currentTarget.disabled = false; }
          } });
        return el("figure", { class: "photo" }, a,
          el("figcaption", { class: "small muted" }, el("span", { text: when }), turnable ? el("span", { class: "turns" }, turn(-90), turn(90)) : null));
      })));
  }).filter(Boolean);
  $("#photos-body").replaceChildren(...(groups.length ? groups : [el("p", { class: "muted", text: "No photos for this order yet." })]),
    el("div", { class: "row" },
      el("button", { type: "button", class: "btn primary", text: "Make proof pack (PDF)", title: "One PDF with the order, its tracking and every photo, for a claim or a buyer question", onclick: () => proofPack(key) }),
      el("button", { type: "button", class: "btn secondary", text: "Open this order's photo folder", onclick: () => openSavedFolder("photos", key) })),
    el("div", { id: "proof-msg", class: "msg", role: "status", "aria-live": "polite", hidden: true }));
  if (!dlg.open) dlg.showModal();
  return groups.length;
}

function bindPhone() {
  $("#btn-phone").addEventListener("click", () => openPhone());
  $("[data-open-phone]").addEventListener("click", () => openPhone());
  $("#phone-body").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-phone]");
    if (b) phoneAction(b.dataset.phone);
  });
  for (const dlg of [$("#phone-dialog"), $("#photos-dialog")]) {
    dlg.addEventListener("click", (e) => { if (e.target === dlg || e.target.closest("[data-close]")) dlg.close(); });
  }
  $("#phone-dialog").addEventListener("close", () => { state.phone = null; refreshPhotos(); });
  $("#photos-dialog").addEventListener("close", closePhotos);
  // Pick up tracking numbers the phone scans, and (while History is on screen) the photos it sends.
  setInterval(() => {
    if (document.visibilityState !== "visible") return;
    takePhoneLinks();
    if (!$("#history-view").hidden) refreshPhotos();
  }, 20000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") takePhoneLinks(); });
  takePhoneLinks();
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
  f.elements.orderQr.checked = d.orderQr !== false;
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

function renderBatchRow() {
  $("#batch-row").hidden = !state.orders.length;
  $("#batch-info").textContent = state.orders.length
    ? `${plural(state.orders.length, "order")} from ${state.fileName}, loaded ${whenText(state.batchAt)}. They stay here until you clear them or load new ones (${BATCH_DAYS} days at most).`
    : "";
}

export function renderAll() {
  renderSteps();
  renderBatchRow();
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
    keepBatch();
    e.target.closest("tr").classList.toggle("off", !e.target.checked);
    const rows = visibleOrders();
    const n = rows.filter((o) => state.selected.has(o.id)).length;
    $("#check-all").checked = n === rows.length;
    $("#check-all").indeterminate = n > 0 && n < rows.length;
    renderOutput();
  });
  $("#check-all").addEventListener("change", (e) => {
    for (const o of visibleOrders()) { if (e.target.checked) state.selected.add(o.id); else state.selected.delete(o.id); }
    keepBatch();
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
  keepBatch();
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
    state.design[k] = k === "darkness" ? Number(e.target.value) : e.target.type === "checkbox" ? e.target.checked : e.target.value;
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
  $("#btn-clear-batch").addEventListener("click", clearBatch);
  $("#btn-match").addEventListener("click", () => matchPasted($("#track-text").value));
  $("#import-again").addEventListener("change", (e) => { state.importAgain = e.target.checked; renderShipWarn(); });
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
  bindPhone();
  bindPower();
  bindBackup();
  bindViews();
  renderPlanForm();
  renderDesign();
  renderAll();
  registerWorker();
  checkHistoryCopy();
  window.shipdesk = api;
  // index.html?sample opens with the sample loaded (handy for a quick look and for screenshots).
  if (new URLSearchParams(location.search).has("sample")) loadSample(false);
  else restoreBatch();
  return api;
}

export const api = {
  state, init, loadCsvText, loadPastedText, setFilter, visibleOrders, printOrders, returnAddress, planSettings,
  pdfOptions, buildPdf, downloadPdf, matchPasted, importFile, downloadImportFile, pirateFile, downloadPirateShip,
  clearShipped, renderAll, handleFiles, loadSlipFile, today, restoreBatch, clearBatch, applyShipments,
  renderHistory, historyFile, clearHistory, showView, openSavedFolder,
  phoneOrders, syncPhoneOrders, refreshPhotos, takePhoneLinks, setOrderNumber, openPhone, openPhotos, rotatePhoto,
  power, checkPower, turnOff, setAutostart, loadBackup, setBackup, setBackupPlace, backupNow,
  copyHistory, checkHistoryCopy, restoreHistoryCopy, keepThisHistory, proofPack,
};

if (document.querySelector("[data-shipdesk]")) init();
