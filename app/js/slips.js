// slips.js: read TCGplayer's packing-slip PDF with pdf.js. Each page is matched to an order by the order
// number in its text; item lines are picked out heuristically; every page is kept as an image (~150 dpi)
// so "Slips in label order" can reprint the user's own slips in the same order as the labels.

const DPI = 150;
const ORDER_LABEL = /order\s*(?:#|number|no\.?|id)\s*:?\s*([A-Z0-9][A-Z0-9-]{3,})/i;
const PRICE = /\$?\s?(\d{1,6}(?:,\d{3})*\.\d{2})/;
const NOT_ITEM = /^(items?|total|subtotal|sub-total|shipping|tax|sales tax|discount|order|qty|quantity|page)\b/i;

function lib() {
  const pdfjs = typeof window !== "undefined" ? window.pdfjsLib : null;
  if (!pdfjs) throw new Error("pdf.js is not loaded (vendor/pdf.min.js)");
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdf.worker.min.js", import.meta.url).href;
  }
  return pdfjs;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Rebuild text lines from pdf.js items: group by baseline, sort left to right, and put two spaces
// where there is a visible gap between items (separate table columns).
export function pageLines(items) {
  const parts = items
    .filter((it) => it.str && it.str.trim())
    .map((it) => ({ s: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0, h: Math.abs(it.transform[3]) || it.height || 10 }));
  parts.sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const p of parts) {
    const row = rows.find((r) => Math.abs(r.y - p.y) <= Math.max(2, p.h * 0.35));
    if (row) row.parts.push(p); else rows.push({ y: p.y, parts: [p] });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => {
    r.parts.sort((a, b) => a.x - b.x);
    let out = "", end = null;
    for (const p of r.parts) {
      if (end !== null) {
        const gap = p.x - end;
        out += gap > p.h * 0.8 ? "  " : gap > p.h * 0.1 ? " " : "";
      }
      out += p.s;
      end = p.x + p.w;
    }
    return out.replace(/\s+$/, "");
  });
}

// "1  Dark Magician - LOB - Near Mint  $4.99" (or with more columns) -> { qty, name, detail, price }.
export function parseItemLine(line) {
  const m = /^\s*(\d{1,3})\s*[xX]?\s+(.+)$/.exec(line);
  if (!m) return null;
  let rest = m[2];
  const prices = [];
  let pm;
  while ((pm = new RegExp(PRICE.source + "\\s*$").exec(rest))) {
    prices.unshift(parseFloat(pm[1].replace(/,/g, "")));
    rest = rest.slice(0, pm.index).replace(/(?:\s+(?:@|x))?\s*$/i, "");
  }
  if (!prices.length) return null;
  rest = rest.replace(/\s{2,}/g, " ").trim();
  if (!rest || NOT_ITEM.test(rest) || !/[A-Za-z]/.test(rest)) return null;
  const qty = parseInt(m[1], 10);
  if (!qty) return null;
  const bits = rest.split(/\s+-\s+/);
  return { qty, name: bits[0].trim(), detail: bits.slice(1).join(" - ").trim(), price: prices[0] };
}

function findOrder(text, ids) {
  let best = null, bestAt = Infinity;
  const compact = text.replace(/\s+/g, "");
  for (const id of ids) {
    const re = new RegExp("(?<![A-Za-z0-9])" + escapeRe(id) + "(?![A-Za-z0-9])", "i");
    let at = text.search(re);
    if (at < 0) {
      // The number may have been split into several text pieces.
      const c = compact.search(new RegExp(escapeRe(id.replace(/\s+/g, "")), "i"));
      if (c >= 0) at = text.length + c;
    }
    if (at >= 0 && at < bestAt) { best = id; bestAt = at; }
  }
  return best;
}

async function pageImage(page) {
  const viewport = page.getViewport({ scale: DPI / 72 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const c2d = canvas.getContext("2d");
  c2d.fillStyle = "#ffffff";
  c2d.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: c2d, viewport }).promise;
  const url = canvas.toDataURL("image/jpeg", 0.88);
  canvas.width = canvas.height = 0; // free the memory now
  return url;
}

/**
 * readSlipPdf(arrayBuffer, orderIds) -> { byOrder: { [orderId]: { items, pageImages } }, unmatchedPages: [n] }
 * Page numbers in unmatchedPages are 1-based. A page with no order number continues the order of the page
 * before it (slips that run over a page); a page naming an order that isn't in orderIds is unmatched.
 * With no orderIds, pages are keyed by the order number printed after "Order #" / "Order Number".
 */
export async function readSlipPdf(arrayBuffer, orderIds = []) {
  const pdfjs = lib();
  const ids = [...new Set((orderIds || []).map((s) => String(s).trim()).filter(Boolean))];
  // pdf.js takes ownership of the bytes it is given: pass a copy so the caller's buffer stays usable.
  const data = new Uint8Array(arrayBuffer instanceof ArrayBuffer ? arrayBuffer.slice(0) : arrayBuffer);
  const pdf = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const byOrder = {};
  const unmatchedPages = [];
  let current = null;
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const lines = pageLines(content.items);
      const text = lines.join("\n");
      let id = ids.length ? findOrder(text, ids) : null;
      const label = ORDER_LABEL.exec(text);
      if (!id && !ids.length && label) id = label[1];
      if (!id) {
        // No known order on this page. If it names some other order, it is not ours; otherwise it is
        // the next page of the previous order's slip.
        id = label || !current ? null : current;
      }
      current = id;
      if (!id) {
        unmatchedPages.push(n);
        page.cleanup();
        continue;
      }
      const entry = byOrder[id] || (byOrder[id] = { items: [], pageImages: [] });
      for (const l of lines) {
        const it = parseItemLine(l);
        if (it) entry.items.push(it);
      }
      entry.pageImages.push(await pageImage(page));
      page.cleanup();
    }
  } finally {
    pdf.destroy();
  }
  return { byOrder, unmatchedPages };
}

/** attachSlips(orders, byOrder) -> orders, with order.items set from the slip PDF where items were found. */
export function attachSlips(orders, byOrder) {
  for (const o of orders || []) {
    const e = byOrder && byOrder[o.id];
    if (e && Array.isArray(e.items) && e.items.length) o.items = e.items.map((it) => ({ ...it }));
  }
  return orders;
}

/** The slip pages in a form renderPdf / slipsInLabelOrderPdf take: [{ orderId, pageImage }], in label order. */
export function slipPagesFor(orders, byOrder) {
  const out = [];
  for (const o of orders || []) {
    const e = byOrder && byOrder[o.id];
    if (e) for (const img of e.pageImages || []) out.push({ orderId: o.id, pageImage: img });
  }
  return out;
}
