// orderlist.js: TCGplayer's Order List export (TCGplayer_OrderList_<date>_<time>.csv: Order #, Buyer Name, Order Date,
// Status, Shipping Type, ..., Carrier Information). It says what TCGplayer itself shows for each order, so Ship Desk can
// spot an import file that never got uploaded, orders nobody shipped, and orders TCGplayer already has as shipped.

import { parseCsv } from "./csv.js";
import { nameKey } from "./pirate.js";

const norm = (h) => String(h || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const has = (obj, k) => typeof k === "string" && k !== "" && k !== "__proto__" && Object.prototype.hasOwnProperty.call(obj || {}, k);

/** Is this header row TCGplayer's Order List (order #, buyer name and status; not the Export Shipping file)? */
export function isOrderListHeader(headers) {
  const h = (headers || []).map(norm);
  return h.includes("order") && h.includes("buyername") && h.includes("status") && !h.includes("firstname");
}

/** TCGplayer's status words -> "open" (still to ship), "shipped" or "canceled". */
export function statusKind(status) {
  const s = String(status || "").trim();
  if (/^shipped|delivered/i.test(s)) return "shipped";
  if (/cancel|refund/i.test(s)) return "canceled";
  return s ? "open" : "";
}

/** "TCGplayer_OrderList_20261026_000845.csv" -> "2026-10-26 00:08" ("" when the name has no date). */
export function listTime(fileName) {
  const m = /(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})\d{2}/.exec(String(fileName || ""));
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : "";
}

/** readOrderList(rows) -> { orders: [{ id, name, date, status, kind }] } (rows = parseCsv's, header row first). */
export function readOrderList(rows) {
  const [head = [], ...body] = rows || [];
  const h = head.map(norm);
  const col = { id: h.indexOf("order"), name: h.indexOf("buyername"), date: h.indexOf("orderdate"), status: h.indexOf("status") };
  const cell = (r, k) => (col[k] >= 0 ? String(r[col[k]] ?? "").trim() : "");
  const orders = [], seen = new Set();
  for (const r of body) {
    const id = cell(r, "id");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    orders.push({ id, name: cell(r, "name"), date: cell(r, "date"), status: cell(r, "status"), kind: statusKind(cell(r, "status")) });
  }
  return { orders };
}

/** The Order List in a dropped file's text, or null when it isn't one. */
export function orderListFromCsv(text) {
  const rows = parseCsv(String(text || ""));
  return rows.length && isOrderListHeader(rows[0]) ? readOrderList(rows) : null;
}

/**
 * compareOrderList(list, history, shipped) -> { forgotten, missed, canceled, tcgShipped, unknown }
 *   forgotten: still to ship on TCGplayer, shipped in Ship Desk (an import file not made or not uploaded)
 *   missed: still to ship on TCGplayer, not shipped in Ship Desk ({ label: last labels made here, mailer: a scanned
 *           mailer without an order # to the same buyer })
 *   canceled: canceled on TCGplayer, labelled or shipped in Ship Desk
 *   tcgShipped: shipped on TCGplayer and in Ship Desk, never in an import file (they no longer need one)
 * history = app.js state.history, shipped = state.shipped, at = when the list was exported ("YYYY-MM-DD HH:MM"): an
 * import file made since (the same minute too) is newer news than the list.
 */
export function compareOrderList(list, history, shipped, at = "") {
  const out = { forgotten: [], missed: [], canceled: [], tcgShipped: [] };
  const mailers = new Map();
  for (const r of Object.values(history || {})) {
    if (r && r.source === "mailer" && !r.id && r.name) mailers.set(nameKey(r.name), r);
  }
  for (const o of (list && list.orders) || []) {
    const r = has(history, o.id) ? history[o.id] : null;
    const s = has(shipped, o.id) ? shipped[o.id] : null;
    const done = !!((r && r.shipped) || (s && (s.shipped || s.tracking)));
    const sentAt = (s && s.sent && s.sent.at) || (r && r.sentAt) || "";
    const x = { id: o.id, name: o.name || (r && r.name) || "", status: o.status };
    if (o.kind === "open") {
      if (done && sentAt && at && String(sentAt) >= at) continue;
      if (done) out.forgotten.push({ ...x, shippedAt: (r && r.shippedAt) || (s && s.at) || "", sentAt });
      else out.missed.push({ ...x, label: (r && r.printCount && r.lastPrintedAt) || "", mailer: mailers.get(nameKey(o.name)) || null });
    } else if (o.kind === "canceled") {
      if (done || (r && r.printCount)) out.canceled.push(x);
    } else if (o.kind === "shipped" && done && !sentAt) out.tcgShipped.push(x);
  }
  return out;
}
