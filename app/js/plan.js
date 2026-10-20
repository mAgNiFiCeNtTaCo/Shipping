// Shipping plan per order: envelope / tracking / signature (TCGplayer thresholds), estimated packed
// weight, USPS stamped-letter postage and forever stamps. See CONTRACT.md "plan.js".

export const DEFAULT_PLAN_SETTINGS = {
  cardOz: 0.06, envelopeOz: 0.2, slipOz: 0.16, toploaderOz: 0.3, cardsPerToploader: 4,
  rigid: true, slips: true, foreverValue: 0.82,
};

export const TAG_LABELS = {
  signature: "Signature required",
  "tracking-required": "Tracking required",
  "tracking-recommended": "Tracking recommended",
  envelope: "Envelope OK",
};

// USPS stamped letter prices (Notice 123, effective 2026-10-04).
export const LETTER_RATES = { firstOz: 0.82, extraOz: 0.29, maxOz: 3.5, nonmachinable: 0.49 };
export const TOO_HEAVY_NOTE = "Too heavy for a letter: ship as a flat or package";

const EXPEDITED = /expedited|priority|express|tracked/i;
const cents = (n) => Math.round(n * 100);
const round = (n, places) => Math.round(n * 10 ** places) / 10 ** places;

/** Plan tag for an order value (dollars) and shipping method. */
export function planTag(value, shippingMethod = "") {
  const c = cents(Number(value) || 0);
  if (c >= 25000) return "signature";
  if (c >= 4999) return "tracking-required";
  if (c >= 2000 || EXPEDITED.test(shippingMethod || "")) return "tracking-recommended";
  return "envelope";
}

/** Stamped-letter postage for a weight in ounces: { letterOk, postage } (postage null when too heavy). */
export function letterPostage(oz, rigid) {
  const w = round(Math.max(0, Number(oz) || 0), 4);
  if (w > LETTER_RATES.maxOz) return { letterOk: false, postage: null };
  const extra = w <= 1 ? 0 : Math.ceil(w - 1);
  let p = LETTER_RATES.firstOz + LETTER_RATES.extraOz * extra;
  if (rigid) p += LETTER_RATES.nonmachinable;
  return { letterOk: true, postage: round(p, 2) };
}

/** Forever stamps needed to cover a postage amount (null when there is no letter postage). */
export function stampsFor(postage, foreverValue = DEFAULT_PLAN_SETTINGS.foreverValue) {
  if (postage == null || !(foreverValue > 0)) return null;
  return Math.ceil(round(postage / foreverValue, 6));
}

/** planOrder(order, settings) -> { tag, label, tracked, weightOz, postage, stamps, letterOk, note } */
export function planOrder(order, settings) {
  const s = { ...DEFAULT_PLAN_SETTINGS, ...(settings || {}) };
  const tag = planTag(order.value, order.shippingMethod);
  const count = Math.max(1, parseInt(order.itemCount, 10) || 1);
  const contents = order.weightOz == null || order.weightOz === "" || isNaN(order.weightOz)
    ? s.cardOz * count : Number(order.weightOz);
  const perToploader = Math.max(1, s.cardsPerToploader || 1);
  const weightOz = round(contents + s.envelopeOz + (s.slips ? s.slipOz : 0) +
    s.toploaderOz * Math.ceil(count / perToploader), 4);
  const { letterOk, postage } = letterPostage(weightOz, s.rigid);
  return {
    tag, label: TAG_LABELS[tag], tracked: tag !== "envelope", weightOz,
    postage, stamps: stampsFor(postage, s.foreverValue), letterOk,
    note: letterOk ? "" : TOO_HEAVY_NOTE,
  };
}

export const FILTERS = [
  { id: "all", label: "All orders" },
  { id: "envelope", label: "Envelopes only (under $20)" },
  { id: "tracked", label: "Tracked only ($20+ / expedited)" },
  { id: "unshipped", label: "Not yet marked shipped" },
];

const planOf = (o) => o.plan || planOrder(o);

/** True when an order has tracking (file or pasted) or was marked shipped. */
export function isShipped(order, shippedState) {
  const st = (shippedState || {})[order.id];
  return !!(order.tracking || (st && (st.tracking || st.shipped)));
}

/** filterOrders(orders, filterId, shippedState) -> Order[] in file order. Uses order.plan when set. */
export function filterOrders(orders, filterId, shippedState) {
  switch (filterId) {
    case "envelope": return orders.filter((o) => planOf(o).tag === "envelope");
    case "tracked": return orders.filter((o) => planOf(o).tracked);
    case "unshipped": return orders.filter((o) => !isShipped(o, shippedState));
    default: return orders.slice();
  }
}

/** summarize(orders, settings) -> { count, byTag, totalValue, totalPostage, totalStamps } */
export function summarize(orders, settings) {
  const byTag = { signature: 0, "tracking-required": 0, "tracking-recommended": 0, envelope: 0 };
  let value = 0, postage = 0, stamps = 0;
  for (const o of orders) {
    const p = planOrder(o, settings);
    byTag[p.tag]++;
    value += cents(Number(o.value) || 0);
    if (p.postage != null) { postage += cents(p.postage); stamps += p.stamps; }
  }
  return { count: orders.length, byTag, totalValue: value / 100, totalPostage: postage / 100, totalStamps: stamps };
}
