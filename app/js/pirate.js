// Pirate Ship's Shipments export (Reports -> View All Shipments -> Export) -> tracking numbers for orders.
// The export is an .xlsx (a .csv works too). A real one (2026-10-25) has Created Date, Recipient, Email,
// Tracking Number, Cost, Status, Batch, Label Size, Saved Package, Ship From, Tracking Status, Source: no
// order number and no ZIP, so labels are matched to orders by the buyer's name (and the dates). Order ID /
// ZIP columns are used when an export has them.

import { parseCsv, normalizeZip } from "./csv.js";
import { detectCarrier } from "./tracking.js";

// ---------- .xlsx ----------

/** The first sheet of an .xlsx file as rows of text cells. Throws when it isn't a readable .xlsx. */
export async function readXlsx(buffer) {
  const files = await unzip(buffer);
  const text = (name) => (files.has(name) ? new TextDecoder().decode(files.get(name)) : "");
  const xml = (name) => new DOMParser().parseFromString(text(name), "application/xml");
  const tags = (node, name) => [...node.getElementsByTagNameNS("*", name)];
  const shared = files.has("xl/sharedStrings.xml")
    ? tags(xml("xl/sharedStrings.xml"), "si").map((si) => tags(si, "t").map((t) => t.textContent).join("")) : [];
  const sheet = firstSheet(files, xml, tags);
  if (!sheet) throw new Error("No worksheet in the file.");
  const rows = [];
  for (const r of tags(xml(sheet), "row")) {
    const row = [];
    for (const c of tags(r, "c")) {
      const col = columnIndex(c.getAttribute("r")) ?? row.length;
      const v = tags(c, "v")[0], t = c.getAttribute("t");
      let val = v ? v.textContent : "";
      if (t === "s") val = shared[Number(val)] ?? "";
      else if (t === "inlineStr") val = tags(c, "t").map((x) => x.textContent).join("");
      while (row.length < col) row.push("");
      row[col] = val;
    }
    rows.push(row);
  }
  return rows;
}

function firstSheet(files, xml, tags) {
  try {
    const sheet = tags(xml("xl/workbook.xml"), "sheet")[0];
    const id = sheet && (sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") || sheet.getAttribute("r:id"));
    const rel = id && tags(xml("xl/_rels/workbook.xml.rels"), "Relationship").find((x) => x.getAttribute("Id") === id);
    if (rel) {
      const target = rel.getAttribute("Target").replace(/^\/?(xl\/)?/, "xl/");
      if (files.has(target)) return target;
    }
  } catch { /* fall back to the first worksheet file */ }
  return [...files.keys()].filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n)).sort()[0] || "";
}

/** "C12" -> 2 (column C), or null. */
function columnIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || "");
  if (!m) return null;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

/** A .zip's files (name -> bytes), read with the browser's own deflate. */
async function unzip(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error("Not an .xlsx file.");
  const count = view.getUint16(end + 10, true);
  let p = view.getUint32(end + 16, true);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("The .xlsx file is damaged.");
    const method = view.getUint16(p + 10, true), size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true), extraLen = view.getUint16(p + 30, true), noteLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + noteLen;
    if (!/\.(xml|rels)$/.test(name)) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    if (method === 0) files.set(name, data);
    else if (method === 8) files.set(name, new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer()));
  }
  return files;
}

// ---------- the shipments ----------

const norm = (h) => String(h || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const COLUMNS = {
  tracking: ["trackingnumber", "tracking", "trackingno", "trackingnum"],
  name: ["recipient", "recipientname", "name", "shiptoname"],
  created: ["createddate", "created", "date", "shipdate", "labelcreated"],
  status: ["status", "labelstatus"],
  orderId: ["orderid", "order", "ordernumber", "orderno"],
  zip: ["zipcode", "zip", "postalcode", "recipientzip"],
};

/** Is this header row Pirate Ship's Shipments export (a tracking column and a recipient column)? */
export function isShipmentsHeader(headers) {
  const h = (headers || []).map(norm);
  return COLUMNS.tracking.some((c) => h.includes(c)) && COLUMNS.name.some((c) => h.includes(c));
}

/** "10/19/26 3:04 PM EDT" / "2026-10-19" -> "2026-10-19" ("" when it can't be read). */
export function isoDate(text) {
  const s = String(text || "").trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/.exec(s);
  if (m) return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return "";
}

/**
 * readShipments(rows) -> { shipments: [{ name, tracking, carrier, created, status, orderId, zip }], voided, headers }
 * rows = the export's rows (header row first), from readXlsx or parseCsv. Voided / refunded labels are left out
 * (counted in `voided`); so are rows without a tracking number.
 */
export function readShipments(rows) {
  const [head = [], ...body] = rows || [];
  const h = head.map(norm);
  const at = (key) => { for (const c of COLUMNS[key]) { const i = h.indexOf(c); if (i >= 0) return i; } return -1; };
  const col = Object.fromEntries(Object.keys(COLUMNS).map((k) => [k, at(k)]));
  const cell = (r, k) => (col[k] >= 0 ? String(r[col[k]] ?? "").trim() : "");
  const shipments = [];
  let voided = 0;
  for (const r of body) {
    const tracking = cell(r, "tracking").replace(/[^0-9A-Za-z]/g, "").toUpperCase();
    if (!tracking) continue;
    const status = cell(r, "status");
    if (/void|refund|cancel/i.test(status)) { voided++; continue; }
    shipments.push({ name: cell(r, "name").replace(/[\s,]+$/, ""), tracking, carrier: detectCarrier(tracking) || "USPS",
      created: isoDate(cell(r, "created")), status, orderId: cell(r, "orderId"), zip: cell(r, "zip") ? normalizeZip(cell(r, "zip")) : "" });
  }
  return { shipments, voided, headers: head };
}

/** The shipments in a dropped file's text (.csv), or null when it isn't a Shipments export. */
export function shipmentsFromCsv(text) {
  const rows = parseCsv(String(text || ""));
  return rows.length && isShipmentsHeader(rows[0]) ? readShipments(rows) : null;
}

// ---------- matching ----------

/** A name for comparing: no accents, case, punctuation or extra spaces. */
export function nameKey(name) {
  return String(name || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
// A label is bought within days of the order: older orders of the same buyer are not its order.
export const MATCH_DAYS = 21;
const daysBefore = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const firstLast = (key) => { const w = key.split(" "); return w.length > 1 ? `${w[0]} ${w[w.length - 1]}` : key; };

/**
 * matchShipments(shipments, candidates) -> { matches, already, conflicts, unmatched }
 * candidates = [{ id, name, zip, date (YYYY-MM-DD order date), tracking, shipped }] (TCGplayer orders). A label
 * goes to the buyer's one order without tracking from the MATCH_DAYS before the label (an Order ID column, when
 * there is one, decides first; orders ticked Shipped without tracking only when nothing else fits). Labels already
 * on an order -> already; a buyer whose orders have other tracking -> conflicts; no order or several -> unmatched
 * with the reason (never guessed); labels with no order that are older than every order known -> older (an
 * export of all time reaches back before Ship Desk).
 *   matches: [{ orderId, tracking, carrier, name }], already: [{ orderId, tracking }],
 *   conflicts: [{ name, tracking, orderId, has }], unmatched: [{ name, tracking, why }], older: [{ name, tracking }]
 */
export function matchShipments(shipments, candidates) {
  const list = (candidates || []).filter((c) => c && c.id);
  const out = { matches: [], already: [], conflicts: [], unmatched: [], older: [] };
  const first = list.map((c) => c.date).filter(Boolean).sort()[0] || "";
  const taken = new Set();
  const trackingOf = new Map(list.filter((c) => c.tracking).map((c) => [String(c.tracking).toUpperCase(), c.id]));
  // Oldest labels first, so a repeat buyer's labels go to their orders in date order.
  const sorted = [...(shipments || [])].sort((a, b) => (a.created || "").localeCompare(b.created || ""));
  for (const s of sorted) {
    const has = trackingOf.get(s.tracking);
    if (has) { out.already.push({ orderId: has, tracking: s.tracking }); continue; }
    let pool = s.orderId ? list.filter((c) => c.id === s.orderId) : [];
    if (!pool.length) {
      const key = nameKey(s.name);
      pool = list.filter((c) => nameKey(c.name) === key);
      if (!pool.length && key) pool = list.filter((c) => firstLast(nameKey(c.name)) === firstLast(key));
      if (s.zip) { const z = pool.filter((c) => !c.zip || normalizeZip(c.zip).slice(0, 5) === s.zip.slice(0, 5)); if (z.length) pool = z; }
    }
    if (!pool.length) {
      if (first && s.created && s.created < first) out.older.push({ name: s.name, tracking: s.tracking });
      else out.unmatched.push({ name: s.name, tracking: s.tracking, why: "no order for this buyer" });
      continue;
    }
    const inTime = (c) => !s.created || !c.date || (c.date <= s.created && c.date >= daysBefore(s.created, MATCH_DAYS));
    let open = pool.filter((c) => !c.tracking && !taken.has(c.id) && inTime(c));
    if (open.length > 1 && open.some((c) => !c.shipped)) open = open.filter((c) => !c.shipped); // envelopes ticked Shipped go last
    if (open.length === 1) {
      taken.add(open[0].id);
      out.matches.push({ orderId: open[0].id, tracking: s.tracking, carrier: s.carrier, name: s.name });
    } else if (open.length > 1) {
      out.unmatched.push({ name: s.name, tracking: s.tracking, why: `${open.length} orders without tracking for this buyer` });
    } else {
      const other = pool.find((c) => (c.tracking || taken.has(c.id)) && inTime(c));
      if (other) out.conflicts.push({ name: s.name, tracking: s.tracking, orderId: other.id, has: other.tracking || "" });
      else out.unmatched.push({ name: s.name, tracking: s.tracking, why: `no order for this buyer in the ${MATCH_DAYS} days before the label` });
    }
  }
  return out;
}
