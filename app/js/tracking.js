// Tracking numbers: carrier detection, matching pasted numbers to orders, and the two output CSVs
// (TCGplayer "Import Shipping Info" and Pirate Ship). See CONTRACT.md "tracking.js".
import { toCsv, normalizeHeader, HEADER_ALIASES } from "./csv.js";
import { planOrder } from "./plan.js";

const compact = (s) => String(s ?? "").replace(/[\s-]/g, "").toUpperCase();

/** detectCarrier(trackingNo) -> "USPS" | "UPS" | "FedEx" | "DHL" | "" (spaces and dashes ignored). */
export function detectCarrier(trackingNo) {
  const t = compact(trackingNo);
  if (/^1Z[0-9A-Z]{16}$/.test(t)) return "UPS";
  if (/^9\d{19,21}$/.test(t)) return "USPS";
  if (/^420\d{5}(\d{4})?9\d{19,21}$/.test(t)) return "USPS";
  if (/^[A-Z]{2}\d{9}US$/.test(t)) return "USPS";
  if (/^(\d{12}|\d{15})$/.test(t)) return "FedEx";
  if (/^\d{10}$/.test(t)) return "DHL";
  return "";
}

// A pasted token that could be a tracking number: letters/digits only, at least 8 long, with a digit.
const looksLikeTracking = (t) => /^[0-9A-Z]{8,40}$/.test(t) && /\d/.test(t);

/**
 * matchTracking(pasted, orders, { skip, prefer }) -> { matches: [{orderId, tracking, carrier}], unmatched: [lines], warnings: [] }
 * Each line is "<tracking>" (given to the orders in label order) or "<order#> <tracking>".
 * A bare number never goes to an order skip(order) is true for (it has a tracking number already). With prefer, bare
 * numbers go to the orders prefer(order) is true for (the ones that need a tracked label); only when there are more
 * numbers than those do they go to every order without tracking, with a warning. (2026-11-27: five numbers bought
 * for five tracked orders used to land on the first five labels printed, envelopes included.)
 */
export function matchTracking(pasted, orders, { skip = null, prefer = null } = {}) {
  const byId = new Map(orders.map((o) => [String(o.id).trim().toUpperCase(), o]));
  const idsCompact = new Set(orders.map((o) => compact(o.id)));
  const lines = String(pasted ?? "").split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean);
  const warnings = [], unmatched = [];
  const assigned = new Map();   // orderId -> match
  const seenNumbers = new Set();
  const bare = [];              // [line, tracking] waiting for label-order assignment

  const take = (line, tracking) => {
    if (seenNumbers.has(tracking)) {
      warnings.push(`Tracking number ${tracking} is pasted more than once; only the first one was used.`);
      unmatched.push(line);
      return false;
    }
    seenNumbers.add(tracking);
    return true;
  };

  for (const line of lines) {
    const tokens = line.split(/[\s,;]+/).filter(Boolean);
    const order = tokens.length >= 2 ? byId.get(tokens[0].toUpperCase()) : null;
    if (order) {
      const tracking = compact(tokens.slice(1).join(""));
      if (!looksLikeTracking(tracking)) { unmatched.push(line); warnings.push(`No tracking number found after order ${order.id}.`); continue; }
      if (assigned.has(order.id)) {
        warnings.push(`Order ${order.id} is pasted more than once; only the first tracking number was used.`);
        unmatched.push(line);
        continue;
      }
      if (!take(line, tracking)) continue;
      assigned.set(order.id, { orderId: order.id, tracking, carrier: detectCarrier(tracking) });
      continue;
    }
    const tracking = compact(line.replace(/[,;]/g, ""));
    if (idsCompact.has(tracking)) {
      unmatched.push(line);
      warnings.push(`Order ${line} has no tracking number next to it.`);
      continue;
    }
    if (!looksLikeTracking(tracking)) {
      unmatched.push(line);
      warnings.push(`"${line}" doesn't look like a tracking number.`);
      continue;
    }
    if (take(line, tracking)) bare.push([line, tracking]);
  }

  // Bare numbers go to the orders that didn't get one by order #, in label order.
  const takes = orders.filter((o) => !assigned.has(o.id) && !(skip && skip(o)));
  const first = prefer ? takes.filter(prefer) : takes;
  const open = bare.length > first.length ? takes : first;
  if (bare.length && open !== first && takes.length > first.length) {
    warnings.push(`${bare.length === 1 ? "1 tracking number" : `${bare.length} tracking numbers`} for ${first.length === 1 ? "1 order" : `${first.length} orders`} that ${first.length === 1 ? "needs" : "need"} a tracked label: `
      + "they went to the orders without tracking in label order, envelopes too. Check them, or paste the order number in front of each one.");
  }
  bare.forEach(([line, tracking], i) => {
    if (i < open.length) assigned.set(open[i].id, { orderId: open[i].id, tracking, carrier: detectCarrier(tracking) });
    else unmatched.push(line);
  });
  if (bare.length > open.length) {
    const extra = bare.length - open.length;
    warnings.push(`There ${extra === 1 ? "is 1 more tracking number" : `are ${extra} more tracking numbers`} than orders; the extra ${extra === 1 ? "one was" : "ones were"} not used.`);
  } else if (bare.length && bare.length < open.length) {
    const left = open.length - bare.length;
    warnings.push(`Only ${bare.length} tracking number${bare.length === 1 ? "" : "s"} for ${open.length} orders${prefer ? " that need a tracked label" : ""}: the last ${left} order${left === 1 ? "" : "s"} got none.`);
  }

  const matches = orders.filter((o) => assigned.has(o.id)).map((o) => assigned.get(o.id));
  return { matches, unmatched, warnings };
}

export const TCG_HEADERS = ["Order #", "FirstName", "LastName", "Address1", "Address2", "City", "State", "PostalCode",
  "Country", "Order Date", "Product Weight", "Shipping Method", "Item Count", "Value Of Products",
  "Shipping Fee Paid", "Tracking #", "Carrier"];

const findHeader = (headers, key) => {
  const names = HEADER_ALIASES[key].map(normalizeHeader);
  return headers.find((h) => names.includes(normalizeHeader(h)));
};

/**
 * importFileCsv(orders, shippedState, { skipSent }) -> { csv, count, missingRequired: [orderId], included: [{ id, what }],
 *   already: [orderId] }
 * TCGplayer "Import Shipping Info" file: original columns and order, one row per shipped/tracked order. `what` is
 * the tracking number sent, or "Shipped". With skipSent, orders whose shippedState entry says they were already
 * sent with the same `what` (entry.sent = { at, what }), or that TCGplayer already shows shipped (entry.sent.tcg), are
 * left out and listed in `already`.
 */
export function importFileCsv(orders, shippedState, { skipSent = false } = {}) {
  const state = shippedState || {};
  const fileOrders = orders.filter((o) => o.row && Object.keys(o.row).length);
  const headers = [];
  for (const o of fileOrders) for (const h of Object.keys(o.row)) if (!headers.includes(h)) headers.push(h);
  if (!headers.length) headers.push(...TCG_HEADERS);
  const trackingCol = findHeader(headers, "tracking") || (headers.push("Tracking #"), "Tracking #");
  const carrierCol = findHeader(headers, "carrier") || (headers.push("Carrier"), "Carrier");

  const rows = [], missingRequired = [], included = [], already = [];
  for (const o of fileOrders) {
    const st = state[o.id] || {};
    let tracking = compact(st.tracking || o.tracking);
    if (!tracking && !st.shipped) continue;
    // TCGplayer's own tracked-slip barcode number: TCGplayer already has it on the order (its help, 2026-11), and
    // whether its import takes that number is unknown, so the row says "Shipped" as for any envelope.
    const barcode = compact(o.barcode || (o.imb && o.imb.tracking ? String(o.imb.tracking) + String(o.imb.routing || "") : ""));
    if (tracking && barcode && tracking === barcode) tracking = "";
    const what = tracking || "Shipped";
    if (skipSent && st.sent && (st.sent.what === what || st.sent.tcg)) { already.push(o.id); continue; }
    included.push({ id: o.id, what });
    const row = { ...o.row };
    if (tracking) {
      row[trackingCol] = tracking;
      row[carrierCol] = st.carrier || o.carrier || detectCarrier(tracking) || "USPS";
    } else {
      row[trackingCol] = "Shipped";
      // TCGplayer refuses a row whose carrier is empty ("Carrier is unrecognized", seen on a real upload
      // 2026-10-25); envelopes without tracking go with USPS stamps.
      row[carrierCol] = "USPS";
      if (Math.round((Number(o.value) || 0) * 100) >= 4999) missingRequired.push(o.id);
    }
    rows.push(headers.map((h) => row[h] ?? ""));
  }
  return { csv: toCsv([headers, ...rows]), count: rows.length, missingRequired, included, already };
}

/**
 * pirateShipCsv(orders, planned, shippedState?) -> CSV for Pirate Ship's spreadsheet import: tracked orders
 * without tracking yet. `planned` is { [orderId]: planOrder result } (or an array in order order); orders
 * without one use order.plan or a fresh planOrder.
 */
export function pirateShipCsv(orders, planned, shippedState) {
  const state = shippedState || {};
  const planFor = (o, i) => (Array.isArray(planned) ? planned[i] : planned && planned[o.id]) || o.plan || planOrder(o);
  const rows = [["Order ID", "Name", "Address", "Address Line 2", "City", "State", "Zipcode", "Country", "Ounces"]];
  orders.forEach((o, i) => {
    const p = planFor(o, i);
    const st = state[o.id] || {};
    if (!p.tracked || o.tracking || st.tracking || st.shipped) return; // (ticked Shipped: it went another way)
    const oz = Math.ceil(Math.round(p.weightOz * 1e4) / 1e3) / 10;
    rows.push([o.id, o.name, o.address1, o.address2 || "", o.city, o.state, o.zip, o.country || "US", oz.toFixed(1)]);
  });
  return toCsv(rows);
}
