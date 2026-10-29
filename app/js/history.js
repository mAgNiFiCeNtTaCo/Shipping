// history.js: the list of every order Ship Desk made labels for or marked shipped.
// Kept by app.js in localStorage (KEYS.history) as { [key]: record }. Only what's needed to recognise an
// order is kept (buyer name, city, state, ZIP; no street address).
//
// record = { key, id, source: "csv" | "paste" | "mailer", name, city, state, zip, value, items, tag, orderDate,
//            printedAt, lastPrintedAt, printCount, format,          // labels ("" / 0 when never printed here)
//            shipped, tracking, carrier, shippedAt,                   // shipping
//            sentAt,                                                  // in a TCGplayer import file
//            tcg: { status: "open" | "shipped" | "canceled", text, at } } // what TCGplayer's Order List said (orderlist.js)

import { toCsv } from "./csv.js";

export const MAX_RECORDS = 5000;

export const HISTORY_FILTERS = [
  { id: "all", label: "All" },
  { id: "waiting", label: "Labels made, not shipped" },
  { id: "shipped", label: "Shipped" },
  { id: "notsent", label: "Not sent to TCGplayer yet" },
];

const FORMAT_NAMES = {
  thermal4x6: "4x6 thermal",
  thermal6x4: "6x4 thermal (landscape)",
  letter1: "Letter, 1 per page",
  letter2: "Letter, 2 per page",
  letter3: "Letter, 3 per page",
  letter4: "Letter, 4 per page",
  labelSlip: "Label + slip",
  avery5160: "Avery 5160",
  envelope10: "#10 envelope",
};

export const formatName = (id) => FORMAT_NAMES[id] || id || "";

/** Local date and time as "YYYY-MM-DD HH:MM". */
export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * TCGplayer order numbers are unique; pasted orders (P-001...) restart every paste, so use name + ZIP; a mailer
 * scanned on the phone before its order # is known uses its tracking number.
 */
export function historyKey(order, source) {
  if (source === "mailer") return "mailer:" + String(order.tracking || "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  if (source === "paste") return `paste:${String(order.name || "").trim().toLowerCase()}|${String(order.zip || "").trim()}`;
  return String(order.id || "");
}

function base(order, source) {
  return {
    key: historyKey(order, source),
    id: source === "paste" || source === "mailer" ? "" : String(order.id || ""),
    source: source === "paste" || source === "mailer" ? source : "csv",
    name: order.name || "",
    city: order.city || "",
    state: order.state || "",
    zip: order.zip || "",
    value: Number(order.value) || 0,
    items: Number(order.itemCount) || 0,
    tag: (order.plan && order.plan.tag) || "",
    orderDate: order.orderDate || "",
    printedAt: "", lastPrintedAt: "", printCount: 0, format: "",
    shipped: false, tracking: "", carrier: "", shippedAt: "",
  };
}

// Refresh the descriptive fields from the order (a re-upload may correct a name), keep the history fields.
function upsert(hist, order, source) {
  const key = historyKey(order, source);
  if (!key || key === "paste:|" || key === "mailer:") return null;
  const fresh = base(order, source);
  const cur = hist[key];
  hist[key] = cur ? { ...cur, name: fresh.name || cur.name, city: fresh.city || cur.city, state: fresh.state || cur.state,
    zip: fresh.zip || cur.zip, value: fresh.value || cur.value, items: fresh.items || cur.items, tag: fresh.tag || cur.tag,
    orderDate: fresh.orderDate || cur.orderDate } : fresh;
  return hist[key];
}

/** Labels were downloaded for these orders. Mutates and returns hist. */
export function recordPrinted(hist, orders, { source = "csv", format = "", when = stamp() } = {}) {
  for (const o of orders || []) {
    const r = upsert(hist, o, source);
    if (!r) continue;
    if (!r.printedAt) r.printedAt = when;
    r.lastPrintedAt = when;
    r.printCount = (r.printCount || 0) + 1;
    r.format = format;
  }
  return prune(hist);
}

/** The order has photos from the phone: list it (without changing its labels or shipped state). */
export function recordSeen(hist, order, { source = "csv" } = {}) {
  upsert(hist, order, source);
  return prune(hist);
}

/**
 * The order's shipped state changed (entry = the app's shippedState entry, or null when unmarked).
 * Records orders marked shipped without labels from Ship Desk too. Mutates and returns hist.
 */
export function recordShipped(hist, order, entry, { source = "csv", when = stamp() } = {}) {
  const r = upsert(hist, order, source);
  if (!r) return hist;
  applyShipped(r, entry, when);
  return prune(hist);
}

/** Set a record's shipped fields from a shippedState-style entry ({ tracking, carrier, shipped }) or null. */
export function applyShipped(r, entry, when = stamp()) {
  const tracking = entry ? String(entry.tracking || "").trim() : "";
  const shipped = !!(entry && (entry.shipped || tracking));
  if (shipped && !r.shipped) r.shippedAt = when;
  if (!shipped) r.shippedAt = "";
  r.shipped = shipped;
  r.tracking = tracking;
  r.carrier = tracking ? (entry.carrier || "") : "";
  return r;
}

/** Drop the oldest records past MAX_RECORDS. */
function prune(hist, max = MAX_RECORDS) {
  const keys = Object.keys(hist);
  if (keys.length <= max) return hist;
  keys.sort((a, b) => lastActivity(hist[a]).localeCompare(lastActivity(hist[b])));
  for (const k of keys.slice(0, keys.length - max)) delete hist[k];
  return hist;
}

const lastActivity = (r) => [r.lastPrintedAt || "", r.shippedAt || ""].sort().pop();

/**
 * What TCGplayer's Order List last said that still holds: "open" (still to ship there, and no import file made since),
 * "shipped", "canceled", or "".
 */
export function tcgSays(r) {
  const t = r && r.tcg;
  if (!t || !t.status) return "";
  if (t.status === "open" && r.sentAt && String(r.sentAt) >= String(t.at || "")) return "";
  return t.status;
}

/**
 * When this browser's first import file was made (History's earliest sentAt): TCGplayer orders shipped before it
 * were sent to TCGplayer some other way.
 */
export function firstSentAt(hist) {
  return Object.values(hist || {}).filter((r) => r && r.source === "csv").map((r) => r.sentAt).filter(Boolean).sort()[0] || "";
}

/** A shipped TCGplayer order TCGplayer doesn't know is shipped yet (no import file, or its Order List says so). */
export function notSentYet(r, firstSent = "") {
  if (!r || r.source !== "csv" || !r.shipped) return false;
  const says = tcgSays(r);
  if (says === "open") return true;
  if (r.sentAt || says) return false;
  return !firstSent || String(r.shippedAt || "") >= firstSent;
}

export function historyCounts(hist) {
  const list = Object.values(hist || {});
  const first = firstSentAt(hist);
  return {
    all: list.length,
    printed: list.filter((r) => r.printCount > 0).length,
    waiting: list.filter((r) => !r.shipped).length,
    shipped: list.filter((r) => r.shipped).length,
    notsent: list.filter((r) => notSentYet(r, first)).length,
  };
}

/** Records matching a HISTORY_FILTERS id and a search text, newest activity first. */
export function historyList(hist, { filter = "all", search = "" } = {}) {
  const q = String(search || "").trim().toLowerCase();
  const first = filter === "notsent" ? firstSentAt(hist) : "";
  return Object.values(hist || {})
    .filter((r) => (filter === "shipped" ? r.shipped : filter === "waiting" ? !r.shipped : filter === "notsent" ? notSentYet(r, first) : true))
    .filter((r) => !q || [r.id, r.name, r.city, r.state, r.zip, r.tracking].some((v) => String(v || "").toLowerCase().includes(q)))
    .sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)) || String(b.id).localeCompare(String(a.id)));
}

/** A carrier's public tracking page for this number, or "" when unknown. */
export function trackingUrl(tracking, carrier) {
  const t = encodeURIComponent(String(tracking || "").replace(/[\s-]/g, ""));
  if (!t) return "";
  switch (String(carrier || "").toUpperCase()) {
    case "USPS": return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t}`;
    case "UPS": return `https://www.ups.com/track?tracknum=${t}`;
    case "FEDEX": return `https://www.fedex.com/fedextrack/?trknbr=${t}`;
    case "DHL": return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${t}`;
    default: return "";
  }
}

export const HISTORY_CSV_HEADER = ["Order #", "Buyer", "City", "State", "ZIP", "Value", "Items", "Plan", "Labels made",
  "Last labels", "Times printed", "Label format", "Shipped", "Shipped date", "Tracking #", "Carrier", "Source"];

/** The records as a CSV (for a spreadsheet). */
export function historyCsv(records, tagLabels = {}) {
  return toCsv([HISTORY_CSV_HEADER, ...records.map((r) => [
    r.id || (r.source === "mailer" ? "(not added yet)" : "(pasted)"), r.name, r.city, r.state, r.zip, (Number(r.value) || 0).toFixed(2), String(r.items || ""),
    tagLabels[r.tag] || r.tag || "", r.printedAt, r.lastPrintedAt, String(r.printCount || 0), formatName(r.format),
    r.shipped ? "Yes" : "No", r.shippedAt, r.tracking, r.carrier, r.source === "paste" ? "Pasted addresses" : r.source === "mailer" ? "Mailer scanned on the phone" : "TCGplayer file",
  ])], { spreadsheetSafe: true }); // opened in Excel: a buyer name like "=..." must stay text
}
