// render.js: address labels, envelopes and packing slips as one PDF (jsPDF, all layout in inches).
// renderPdf(orders, opts) -> jsPDF doc; the caller saves it (doc.save(name) / doc.output("blob")).
import { historyKey } from "./history.js";

const LETTER = [8.5, 11];
const THERMAL = [4, 6];
const isThermal = (format) => format === "thermal4x6" || format === "thermal6x4";
const ENVELOPE = [9.5, 4.125];
const PT = 1 / 72; // one point in inches
const LH = 1.2; // line height, as a multiple of the font size

export const FORMATS = [
  { id: "thermal4x6", label: "Thermal label 4 x 6 in (Rollo, MUNBYN, Dymo)", pageSize: THERMAL, perPage: 1,
    slipSize: THERMAL, hint: "One 4x6 label per page. Print at 100% with zero margins." },
  // An upright 4x6 page with the label drawn a quarter turn: thermal printers don't rotate a wide page, they cut it off.
  { id: "thermal6x4", label: "Thermal label 6 x 4 in, landscape (sideways)", pageSize: THERMAL, perPage: 1, sideways: true,
    slipSize: THERMAL, hint: "Same 4x6 label with the address turned sideways. Print at 100% with zero margins, paper 4 x 6." },
  { id: "letter1", label: "Letter paper, 1 label per page (full sheet)", pageSize: LETTER, perPage: 1,
    slipSize: LETTER, hint: "Full-sheet labels or plain paper." },
  { id: "letter2", label: "Letter paper, 2 labels per page (half sheets)", pageSize: LETTER, perPage: 2,
    slipSize: LETTER, hint: "Half-sheet labels, or cut along the dashed line." },
  { id: "letter3", label: "Letter paper, 3 labels per page (thirds)", pageSize: LETTER, perPage: 3,
    slipSize: LETTER, hint: "Cut along the dashed lines." },
  { id: "letter4", label: "Letter paper, 4 labels per page (quarters)", pageSize: LETTER, perPage: 4,
    slipSize: LETTER, hint: "Quarter-sheet labels, or cut along the dashed lines." },
  { id: "labelSlip", label: "Letter paper, label + packing slip on one page", pageSize: LETTER, perPage: 1,
    slipSize: LETTER, hint: "Label on top, packing slip below. Cut or fold on the dashed line." },
  { id: "avery5160", label: "Avery 5160 / 8160 address labels (30 per sheet)", pageSize: LETTER, perPage: 30,
    slipSize: LETTER, hint: "Ship-to address only, 1 x 2-5/8 in labels." },
  { id: "envelope10", label: "#10 envelope (9.5 x 4.125 in)", pageSize: ENVELOPE, perPage: 1,
    slipSize: LETTER, hint: "Feed envelopes face up; the stamp corner stays empty." },
];
for (const f of FORMATS) { f.width = f.pageSize[0]; f.height = f.pageSize[1]; }

const DEFAULT_DESIGN = { accent: "#1f6feb", font: "helvetica", logo: null, darkness: 0, note: "", qrUrl: "", slipMessage: "", orderQr: true };

/** What an order's own QR code says: the phone page (phone.js parseScan) reads it to pick the order. */
export const ORDER_QR_PREFIX = "SHIPDESK:";
export const orderQrText = (order, source = "csv") => ORDER_QR_PREFIX + historyKey(order, source);
const INK = [17, 17, 17];
const MUTED = [90, 90, 90];
const RULE = [200, 200, 200];

// ---------- small helpers ----------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const str = (v) => (v == null ? "" : String(v));

// The standard PDF fonts only cover Latin-1: map typographic punctuation to ASCII, strip accents from
// letters outside Latin-1 (keeping Latin-1 ones such as e-acute), and print "?" for anything left.
const PUNCT = { "\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201c": '"', "\u201d": '"', "\u201e": '"',
  "\u2013": "-", "\u2014": "-", "\u2026": "...", "\u00a0": " ", "\u2022": "-", "\u2122": "TM" };
const EXTRA = { "\u0141": "L", "\u0142": "l", "\u0110": "D", "\u0111": "d", "\u0131": "i", "\u0152": "OE",
  "\u0153": "oe", "\u0126": "H", "\u0127": "h", "\u0166": "T", "\u0167": "t" };
export function cleanText(v) {
  let s = str(v).replace(/[\u2018\u2019\u201a\u201c\u201d\u201e\u2013\u2014\u2026\u00a0\u2022\u2122]/g, (c) => PUNCT[c]);
  s = s.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return s.replace(/[^\u0000-\u00ff]/g, (c) => EXTRA[c]
    || c.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\u0000-\u00ff]/g, "") || "?");
}

function parseHex(hex, fallback = [31, 111, 235]) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(str(hex).trim());
  if (!m) return fallback;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

const money = (v) => "$" + (Number(v) || 0).toFixed(2);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function cityLine(a) {
  const city = cleanText(a.city), st = cleanText(a.state), zip = cleanText(a.zip);
  return [city && (st || zip) ? city + "," : city, st, zip].filter(Boolean).join(" ");
}

function shipToLines(o) {
  const lines = [{ t: cleanText(o.name || [o.firstName, o.lastName].filter(Boolean).join(" ")), style: "bold", rel: 1.12 }];
  if (o.address1) lines.push({ t: cleanText(o.address1) });
  if (o.address2) lines.push({ t: cleanText(o.address2) });
  lines.push({ t: cityLine(o) });
  const c = cleanText(o.country).toUpperCase();
  if (c && !["US", "USA", "UNITED STATES", "UNITED STATES OF AMERICA"].includes(c)) lines.push({ t: cleanText(o.country).toUpperCase() });
  return lines.filter((l) => l.t);
}

function returnLines(r, bold) {
  if (!r) return [];
  const rest = bold ? "bold" : "normal";
  return [{ t: cleanText(r.name), style: "bold" }, { t: cleanText(r.street), style: rest }, { t: cleanText(r.street2), style: rest },
    { t: cityLine(r), style: rest }, { t: cleanText(r.phone), style: rest }].filter((l) => l.t);
}

// ---------- text measuring and fitting ----------

function setFont(doc, ctx, style, pt) {
  doc.setFont(ctx.font, style || "normal");
  doc.setFontSize(pt);
}

function width(doc, ctx, t, style, pt) {
  setFont(doc, ctx, style, pt);
  return doc.getTextWidth(t);
}

// Shorten text with "..." until it fits maxW at the given size.
function ellipsize(doc, ctx, t, style, pt, maxW) {
  if (width(doc, ctx, t, style, pt) <= maxW) return t;
  let lo = 0, hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (width(doc, ctx, t.slice(0, mid).trimEnd() + "...", style, pt) <= maxW) lo = mid; else hi = mid - 1;
  }
  return lo > 0 ? t.slice(0, lo).trimEnd() + "..." : "";
}

// Fit a block of lines ({t, style, rel}) into maxW x maxH: shrink the whole block from startPt down to
// floorPt; still too big -> wrap long lines (2 lines max) / ellipsize; as a last resort shrink below the floor.
// Returns { lines: [{t, style, pt}], width, height }.
function fitBlock(doc, ctx, lines, maxW, maxH, startPt, floorPt) {
  const measure = (ls) => {
    let w = 0, h = 0;
    for (const l of ls) { w = Math.max(w, width(doc, ctx, l.t, l.style, l.pt)); h += l.pt * LH * PT; }
    return { lines: ls, width: w, height: h };
  };
  if (!lines.length) return { lines: [], width: 0, height: 0 };
  const at = (pt) => lines.map((l) => ({ t: l.t, style: l.style || "normal", pt: pt * (l.rel || 1) }));
  for (let pt = startPt; pt >= floorPt - 1e-9; pt -= 0.25) {
    const m = measure(at(pt));
    if (m.width <= maxW && m.height <= maxH) return m;
  }
  const base = at(floorPt);
  // Wrap: each line may become two (the second ellipsized), if the height allows.
  const wrapped = [];
  for (const l of base) {
    if (width(doc, ctx, l.t, l.style, l.pt) <= maxW) { wrapped.push(l); continue; }
    setFont(doc, ctx, l.style, l.pt);
    const parts = doc.splitTextToSize(l.t, maxW);
    wrapped.push({ ...l, t: ellipsize(doc, ctx, parts[0], l.style, l.pt, maxW) });
    if (parts.length > 1) wrapped.push({ ...l, t: ellipsize(doc, ctx, parts.slice(1).join(" "), l.style, l.pt, maxW) });
  }
  let m = measure(wrapped);
  if (m.height <= maxH) return m;
  m = measure(base.map((l) => ({ ...l, t: ellipsize(doc, ctx, l.t, l.style, l.pt, maxW) })));
  if (m.height <= maxH) return m;
  // Too many lines for the box even at the floor: shrink further (to 3 pt), then drop what still won't fit.
  const k = Math.max(maxH / m.height, 3 / floorPt);
  const small = [];
  let used = 0;
  for (const l of base) {
    const pt = l.pt * k;
    if (small.length && used + pt * LH * PT > maxH + 1e-6) break;
    used += pt * LH * PT;
    small.push({ ...l, pt, t: ellipsize(doc, ctx, l.t, l.style, pt, maxW) });
  }
  return measure(small);
}

// Wrap a paragraph into at most maxLines lines: shrink from pt to floorPt until it fits, else cut the
// last line with "...". Returns [{t, style, pt}].
function wrapLines(doc, ctx, text, style, pt, floorPt, maxW, maxLines) {
  let size = pt, parts = [];
  for (; size >= floorPt - 1e-9; size -= 0.5) {
    setFont(doc, ctx, style, size);
    parts = doc.splitTextToSize(text, maxW);
    if (parts.length <= maxLines) break;
  }
  size = Math.max(size, floorPt);
  setFont(doc, ctx, style, size);
  parts = doc.splitTextToSize(text, maxW);
  const kept = parts.slice(0, maxLines);
  if (parts.length > maxLines) kept[maxLines - 1] = kept[maxLines - 1] + " " + parts.slice(maxLines).join(" ");
  return kept.map((t) => ({ t: ellipsize(doc, ctx, t, style, size, maxW), style, pt: size }));
}

// Draw text; on thermal labels a stroke around the glyphs makes it darker.
function put(doc, ctx, t, x, y, extraStroke = 0) {
  const sw = ctx.stroke + extraStroke;
  if (sw > 0) {
    doc.setLineWidth(sw);
    doc.text(t, x, y, { renderingMode: "fillThenStroke" });
  } else {
    doc.text(t, x, y);
  }
}

function color(doc, rgb) {
  doc.setTextColor(rgb[0], rgb[1], rgb[2]);
  doc.setDrawColor(rgb[0], rgb[1], rgb[2]);
}

// Draw a fitted block with its top-left at (x, y). align: "left" | "center" | "right" (within width w).
function drawBlock(doc, ctx, fit, x, y, { align = "left", w = 0, rgb = INK, extraStroke = 0 } = {}) {
  let cy = y;
  for (const l of fit.lines) {
    setFont(doc, ctx, l.style, l.pt);
    color(doc, rgb);
    const lw = doc.getTextWidth(l.t);
    const lx = align === "center" ? x + (w - lw) / 2 : align === "right" ? x + w - lw : x;
    put(doc, ctx, l.t, lx, cy + l.pt * PT * 0.86, extraStroke);
    cy += l.pt * LH * PT;
  }
  return cy;
}

// One line, shrunk to a floor then ellipsized; returns the size used.
function fitLine(doc, ctx, t, style, pt, floorPt, maxW) {
  const f = fitBlock(doc, ctx, [{ t: cleanText(t), style }], maxW, Infinity, pt, floorPt);
  const l = f.lines[0] || { t: "", pt };
  return { t: ellipsize(doc, ctx, l.t, style, l.pt, maxW), pt: l.pt };
}

function line1(doc, ctx, t, x, y, { style = "normal", pt, floor = pt, maxW, rgb = INK, align = "left", extraStroke = 0 }) {
  const f = fitLine(doc, ctx, t, style, pt, floor, maxW);
  if (!f.t) return;
  setFont(doc, ctx, style, f.pt);
  color(doc, rgb);
  const lw = doc.getTextWidth(f.t);
  const lx = align === "center" ? x + (maxW - lw) / 2 : align === "right" ? x + maxW - lw : x;
  put(doc, ctx, f.t, lx, y + f.pt * PT * 0.86, extraStroke);
}

// ---------- images and QR ----------

function imageInfo(doc, dataUrl) {
  try {
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) return null;
    const m = /^data:image\/(png|jpe?g|webp|gif|bmp)/i.exec(dataUrl);
    if (!m) return null;
    const fmt = { png: "PNG", jpg: "JPEG", jpeg: "JPEG", webp: "WEBP", gif: "GIF", bmp: "BMP" }[m[1].toLowerCase()];
    const p = doc.getImageProperties(dataUrl);
    if (!p || !p.width || !p.height) return null;
    return { data: dataUrl, fmt, ratio: p.width / p.height };
  } catch {
    return null;
  }
}

// Draw an image inside a box keeping its shape; returns the drawn width (0 if nothing drawn).
function drawImage(doc, img, x, y, maxW, maxH, alias, align = "left", valign = "top") {
  if (!img || maxW <= 0 || maxH <= 0) return 0;
  let w = maxW, h = maxW / img.ratio;
  if (h > maxH) { h = maxH; w = maxH * img.ratio; }
  const dx = align === "center" ? (maxW - w) / 2 : align === "right" ? maxW - w : 0;
  const dy = valign === "middle" ? (maxH - h) / 2 : valign === "bottom" ? maxH - h : 0;
  try {
    doc.addImage(img.data, img.fmt, x + dx, y + dy, w, h, alias, "FAST");
    return w;
  } catch {
    return 0;
  }
}

function qrMatrix(url) {
  const u = str(url).trim();
  if (!u || typeof window === "undefined" || typeof window.qrcode !== "function") return null;
  try {
    const qr = window.qrcode(0, "M");
    qr.addData(u);
    qr.make();
    const n = qr.getModuleCount();
    const rows = [];
    for (let r = 0; r < n; r++) {
      const row = [];
      for (let c = 0; c < n; c++) row.push(qr.isDark(r, c));
      rows.push(row);
    }
    return rows;
  } catch {
    return null; // too long for a QR code: leave it out
  }
}

function drawQr(doc, rows, x, y, size) {
  if (!rows) return;
  const n = rows.length, cell = size / n;
  doc.setFillColor(0, 0, 0);
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!rows[r][c]) { c++; continue; }
      const start = c;
      while (c < n && rows[r][c]) c++;
      doc.rect(x + start * cell, y + r * cell, (c - start) * cell + 0.001, cell + 0.001, "F");
    }
  }
}

function dashed(doc, x1, y1, x2, y2) {
  doc.setDrawColor(150, 150, 150);
  doc.setLineWidth(0.01);
  doc.setLineDashPattern([0.08, 0.06], 0);
  doc.line(x1, y1, x2, y2);
  doc.setLineDashPattern([], 0);
}

// ---------- the label ----------

// One shipping label inside box {x, y, w, h}.
function drawLabel(doc, ctx, o, box) {
  const { x, y, w, h } = box;
  const pad = box.pad;
  const u = clamp(Math.min(w / 4, h / 3.6), 0.62, 1.6);
  const ix = x + pad, iy = y + pad, iw = w - 2 * pad, ih = h - 2 * pad;
  const accent = ctx.mono ? INK : ctx.accent;
  const muted = ctx.mono ? INK : MUTED;
  const gap = 0.08 * u;

  // Top: return address (left) and logo (right; when there is no divider that corner is left for postage).
  const logoTop = ctx.logo && !ctx.noDivider;
  const logoW = logoTop ? Math.min(1.1 * u, iw * 0.3) : 0;
  const stampRoom = ctx.noDivider ? Math.min(1.8, iw * 0.45) : 0;
  const retW = iw - (logoW ? logoW + gap : 0) - stampRoom;
  const ret = returnLines(ctx.ret, ctx.boldReturn);
  const retFit = fitBlock(doc, ctx, ret, retW, ih * 0.3, 8.5 * u, 6);
  drawBlock(doc, ctx, retFit, ix, iy, { extraStroke: ctx.boldReturn && ctx.mono ? 0.004 : 0 });
  let headerH = retFit.height;
  if (logoW) headerH = Math.max(headerH, Math.min(0.6 * u, ih * 0.18));
  if (logoW) drawImage(doc, ctx.logo, ix + iw - logoW, iy, logoW, Math.min(0.6 * u, ih * 0.18), "shipdesk-logo", "right");

  let top = iy + headerH;
  if (headerH > 0) {
    top += gap;
    if (!ctx.noDivider) {
      doc.setDrawColor(accent[0], accent[1], accent[2]);
      doc.setLineWidth(clamp(0.025 * u, 0.02, 0.04));
      doc.line(ix, top, ix + iw, top);
    }
    top += gap * 1.5;
  }

  // Bottom row: [logo when no divider] [order QR] note + order # ... QR.
  const qrSize = ctx.qr ? clamp(0.75 * u, 0.6, 1.1) : 0;
  const orderQr = ctx.orderQr(o);
  const oqSize = orderQr ? clamp(0.62 * u, 0.55, 0.85) : 0;
  const smallPt = clamp(7.5 * u, 6.5, 10);
  const note = cleanText(ctx.note);
  const textH = (note ? smallPt * LH * PT : 0) + smallPt * LH * PT;
  const logoBottom = ctx.logo && ctx.noDivider ? Math.min(0.5 * u, iw * 0.25) : 0;
  const bottomH = Math.max(qrSize, oqSize, textH, logoBottom ? 0.4 * u : 0);
  const bottomTop = iy + ih - bottomH;
  let tx = ix;
  if (logoBottom) {
    const drawn = drawImage(doc, ctx.logo, ix, bottomTop + bottomH - 0.4 * u, logoBottom, 0.4 * u, "shipdesk-logo", "left", "bottom");
    if (drawn) tx += drawn + gap;
  }
  if (orderQr) {
    drawQr(doc, orderQr, tx, bottomTop + bottomH - oqSize, oqSize);
    tx += oqSize + gap * 1.5;
  }
  if (ctx.qr) drawQr(doc, ctx.qr, ix + iw - qrSize, bottomTop, qrSize);
  const textW = ix + iw - tx - (qrSize ? qrSize + gap : 0);
  let ty = bottomTop + bottomH - textH;
  if (note) {
    line1(doc, ctx, note, tx, ty, { style: "italic", pt: smallPt, floor: 5, maxW: textW, rgb: muted });
    ty += smallPt * LH * PT;
  }
  line1(doc, ctx, "Order " + cleanText(o.id), tx, ty, { pt: smallPt, floor: 5, maxW: textW, rgb: muted });

  // Ship-to: the big block, centred in what is left.
  const areaTop = top, areaBottom = bottomTop - gap;
  const tagPt = clamp(7 * u, 6, 10);
  const tagH = tagPt * LH * PT;
  const maxW = iw * 0.94;
  const maxH = Math.max(0.2, areaBottom - areaTop - tagH);
  const startPt = Math.min(19 * u, 28);
  const fit = fitBlock(doc, ctx, shipToLines(o), maxW, maxH, startPt, 7);
  const blockH = tagH + fit.height;
  const by = areaTop + Math.max(0, (areaBottom - areaTop - blockH) / 2);
  const bx = ix + (iw - fit.width) / 2;
  setFont(doc, ctx, "bold", tagPt);
  color(doc, accent);
  put(doc, ctx, "SHIP TO", bx, by + tagPt * PT * 0.86);
  drawBlock(doc, ctx, fit, bx, by + tagH);
}

// Avery 5160 cell: ship-to only, shrunk to fit.
function drawAveryCell(doc, ctx, o, x, y) {
  const padX = 0.12, padY = 0.07;
  const lines = shipToLines(o).map((l) => ({ ...l, rel: l.rel ? 1.05 : 1 }));
  const fit = fitBlock(doc, ctx, lines, 2.625 - 2 * padX, 1 - 2 * padY, 11, 5.5);
  const by = y + (1 - fit.height) / 2;
  drawBlock(doc, ctx, fit, x + padX, by);
}

// #10 envelope: return address top-left, ship-to right of the middle, the stamp corner left empty.
function drawEnvelope(doc, ctx, o) {
  const [W, H] = ENVELOPE;
  const accent = ctx.accent;
  let rx = 0.35;
  const logoH = 0.6;
  if (ctx.logo) {
    const drawn = drawImage(doc, ctx.logo, rx, 0.3, 0.9, logoH, "shipdesk-logo");
    if (drawn) rx += drawn + 0.12;
  }
  const retFit = fitBlock(doc, ctx, returnLines(ctx.ret, ctx.boldReturn), 3.6 - rx, 1.05, 10, 6.5);
  drawBlock(doc, ctx, retFit, rx, 0.3);

  // Ship-to area: x 3.6 .. 9.1, y 1.3 .. H - 0.7 (keeps the bottom barcode strip clear).
  const ax = 3.6, aw = W - 0.4 - ax, ay = 1.3, ah = H - 0.7 - ay;
  const tagPt = 7.5, tagH = tagPt * LH * PT;
  const fit = fitBlock(doc, ctx, shipToLines(o), aw, ah - tagH, 14, 8);
  const blockH = tagH + fit.height;
  const by = ay + Math.max(0, (ah - blockH) / 2);
  const bx = ax + (aw - fit.width) / 2;
  setFont(doc, ctx, "bold", tagPt);
  color(doc, accent);
  put(doc, ctx, "SHIP TO", bx, by + tagPt * PT * 0.86);
  drawBlock(doc, ctx, fit, bx, by + tagH);

  // Bottom-left: order QR, QR, note, order # (the bottom-right is kept clear for the post office's barcode).
  let tx = 0.35;
  const orderQr = ctx.orderQr(o);
  if (orderQr) { drawQr(doc, orderQr, tx, H - 0.3 - 0.65, 0.65); tx += 0.65 + 0.12; }
  const qrSize = ctx.qr ? 0.7 : 0;
  if (ctx.qr) { drawQr(doc, ctx.qr, tx, H - 0.3 - qrSize, qrSize); tx += qrSize + 0.12; }
  const tw = 3.4 - tx;
  let ty = H - 0.3 - 8 * LH * PT;
  line1(doc, ctx, "Order " + cleanText(o.id), tx, ty, { pt: 8, floor: 5.5, maxW: tw, rgb: MUTED });
  const note = cleanText(ctx.note);
  if (note) line1(doc, ctx, note, tx, ty - 8.5 * LH * PT, { style: "italic", pt: 8.5, floor: 5.5, maxW: tw, rgb: MUTED });
}

// ---------- the packing slip ----------

function itemRows(o) {
  if (Array.isArray(o.items) && o.items.length) {
    return o.items.map((it) => ({
      qty: str(it.qty == null ? 1 : it.qty),
      name: cleanText(it.name) || "Item",
      detail: cleanText(it.detail),
      price: it.price == null || it.price === "" ? "" : money(it.price),
    }));
  }
  const n = Number(o.itemCount) || 1;
  return [{ qty: str(n), name: plural(n, "item"), detail: "Card details are on your TCGplayer packing slip", price: money(o.value) }];
}

function planText(p) {
  if (!p) return "";
  const parts = [cleanText(p.label || p.tag)];
  if (p.stamps) parts.push(plural(p.stamps, "stamp") + (p.postage != null ? ` (${money(p.postage)})` : ""));
  if (p.weightOz != null && isFinite(p.weightOz)) parts.push(`about ${Number(p.weightOz).toFixed(2)} oz`);
  if (p.letterOk === false && p.note) parts.push(cleanText(p.note));
  return parts.filter(Boolean).join(", ");
}

// Lay the slip out at a given scale. draw=false only measures. Returns the y where content ends.
function slipPass(doc, ctx, o, box, scale, maxItems, draw) {
  const { x, y, w, h } = box;
  const pad = box.pad;
  const ix = x + pad, iw = w - 2 * pad;
  const base = clamp(7 + w * 0.5, 8, 11) * scale;
  const accent = ctx.mono ? INK : ctx.accent;
  const muted = ctx.mono ? INK : MUTED;
  const gap = base * PT * 0.7;
  let cy = y + pad;

  // Header: [logo] PACKING SLIP ............ Order #
  const headPt = base * 1.45;
  let hx = ix;
  const headH = headPt * LH * PT;
  if (ctx.logo) {
    const lh = Math.max(headH, base * 2.6 * PT);
    const drawn = draw ? drawImage(doc, ctx.logo, ix, cy, Math.min(1.2, iw * 0.25), lh, "shipdesk-logo", "left", "middle")
      : Math.min(1.2, iw * 0.25, lh * ctx.logo.ratio);
    if (drawn) hx += drawn + gap;
  }
  const titleW = Math.min(width(doc, ctx, "PACKING SLIP", "bold", headPt), iw * 0.45);
  if (draw) {
    line1(doc, ctx, "PACKING SLIP", hx, cy, { style: "bold", pt: headPt, floor: base, maxW: titleW + 0.01, rgb: accent });
    line1(doc, ctx, "Order " + cleanText(o.id), hx + titleW + gap, cy + (headPt - base * 1.1) * PT * 0.5,
      { style: "bold", pt: base * 1.1, floor: 5.5, maxW: ix + iw - hx - titleW - gap, align: "right" });
  }
  cy += Math.max(headH, ctx.logo ? base * 2.6 * PT : 0) + gap * 0.6;
  if (draw) {
    doc.setDrawColor(accent[0], accent[1], accent[2]);
    doc.setLineWidth(0.02);
    doc.line(ix, cy, ix + iw, cy);
  }
  cy += gap;

  // Ship to | From
  const colW = (iw - gap * 2) / 2;
  const labPt = base * 0.8;
  if (draw) {
    line1(doc, ctx, "SHIP TO", ix, cy, { style: "bold", pt: labPt, maxW: colW, rgb: accent });
    line1(doc, ctx, "FROM", ix + colW + gap * 2, cy, { style: "bold", pt: labPt, maxW: colW, rgb: accent });
  }
  cy += labPt * LH * PT;
  const shipFit = fitBlock(doc, ctx, shipToLines(o).map((l) => ({ ...l, rel: l.rel ? 1.05 : 1 })), colW, base * 7 * PT, base, 5.5);
  const retFit = fitBlock(doc, ctx, returnLines(ctx.ret, false), colW, base * 7 * PT, base * 0.95, 5.5);
  if (draw) {
    drawBlock(doc, ctx, shipFit, ix, cy);
    drawBlock(doc, ctx, retFit, ix + colW + gap * 2, cy, { rgb: muted });
  }
  cy += Math.max(shipFit.height, retFit.height) + gap;

  // Order facts.
  const facts = [["Order #", cleanText(o.id)], ["Order date", cleanText(o.orderDate)], ["Shipping", cleanText(o.shippingMethod)],
    ["Plan", planText(ctx.plan && ctx.plan[o.id])]].filter((f) => f[1]);
  const factPt = base * 0.9;
  const keyW = width(doc, ctx, "Order date  ", "bold", factPt);
  // The order's QR code sits right of the facts (scan it with the phone for photos of the contents).
  const orderQr = ctx.orderQr(o);
  const oqSize = orderQr ? clamp(w * 0.14, 0.55, 0.9) * Math.max(scale, 0.8) : 0;
  const factsTop = cy;
  if (draw && orderQr) drawQr(doc, orderQr, ix + iw - oqSize, cy, oqSize);
  for (const [k, v] of facts) {
    if (draw) {
      line1(doc, ctx, k, ix, cy, { style: "bold", pt: factPt, maxW: keyW, rgb: muted });
      line1(doc, ctx, v, ix + keyW, cy, { pt: factPt, floor: 5.5, maxW: iw - keyW - (oqSize ? oqSize + gap : 0) });
    }
    cy += factPt * LH * PT;
  }
  cy = Math.max(cy, factsTop + oqSize);
  cy += gap;

  // Items table.
  const rows = itemRows(o);
  const shown = rows.slice(0, maxItems);
  const more = rows.length - shown.length;
  const qtyW = width(doc, ctx, "Qty  ", "bold", base);
  const priceW = Math.max(width(doc, ctx, "Price", "bold", base), ...rows.map((r) => width(doc, ctx, r.price, "normal", base))) + gap;
  const nameW = iw - qtyW - priceW - gap;
  const rowPad = base * PT * 0.25;
  if (draw) {
    doc.setFillColor(...(ctx.mono ? [235, 235, 235] : [242, 244, 248]));
    doc.rect(ix, cy, iw, base * LH * PT + rowPad * 2, "F");
    line1(doc, ctx, "Qty", ix + rowPad, cy + rowPad, { style: "bold", pt: base, maxW: qtyW });
    line1(doc, ctx, "Item", ix + qtyW, cy + rowPad, { style: "bold", pt: base, maxW: nameW });
    line1(doc, ctx, "Price", ix + iw - priceW, cy + rowPad, { style: "bold", pt: base, maxW: priceW - rowPad, align: "right" });
  }
  cy += base * LH * PT + rowPad * 2;
  const detPt = base * 0.82;
  for (const r of shown) {
    const rowTop = cy + rowPad;
    if (draw) {
      line1(doc, ctx, r.qty, ix + rowPad, rowTop, { pt: base, floor: 5, maxW: qtyW - rowPad });
      line1(doc, ctx, r.name, ix + qtyW, rowTop, { pt: base, floor: 5.5, maxW: nameW });
      if (r.detail) line1(doc, ctx, r.detail, ix + qtyW, rowTop + base * LH * PT, { pt: detPt, floor: 5, maxW: nameW, rgb: muted });
      if (r.price) line1(doc, ctx, r.price, ix + iw - priceW, rowTop, { pt: base, floor: 5, maxW: priceW - rowPad, align: "right" });
    }
    cy += rowPad * 2 + base * LH * PT + (r.detail ? detPt * LH * PT : 0);
    if (draw) {
      doc.setDrawColor(...RULE);
      doc.setLineWidth(0.005);
      doc.line(ix, cy, ix + iw, cy);
    }
  }
  if (more > 0) {
    if (draw) line1(doc, ctx, `+ ${plural(more, "more item")} (see your TCGplayer order)`, ix + qtyW, cy + rowPad,
      { style: "italic", pt: base * 0.9, floor: 5, maxW: nameW, rgb: muted });
    cy += rowPad * 2 + base * 0.9 * LH * PT;
  }
  cy += gap * 0.6;

  // Totals.
  const count = Array.isArray(o.items) && o.items.length
    ? o.items.reduce((s, it) => s + (Number(it.qty) || 1), 0) : (Number(o.itemCount) || 1);
  if (draw) {
    line1(doc, ctx, plural(count, "item"), ix, cy, { pt: base, floor: 5.5, maxW: iw / 2, rgb: muted });
    line1(doc, ctx, `Total value ${money(o.value)}`, ix + iw / 2, cy, { style: "bold", pt: base, floor: 5.5, maxW: iw / 2, align: "right" });
  }
  cy += base * LH * PT + gap;

  // Footer: message (wrapped over up to three lines) + QR.
  const msg = cleanText(ctx.slipMessage);
  const qrSize = ctx.qr ? clamp(w * 0.16, 0.55, 1.0) * Math.max(scale, 0.8) : 0;
  if (msg || qrSize) {
    const msgW = iw - (qrSize ? qrSize + gap : 0);
    const msgLines = msg ? wrapLines(doc, ctx, msg, "italic", base, 6, msgW, 3) : [];
    const msgH = msgLines.reduce((s, l) => s + l.pt * LH * PT, 0);
    const footH = Math.max(qrSize, msgH);
    if (draw) {
      drawBlock(doc, ctx, { lines: msgLines }, ix, cy + (footH - msgH) / 2, { rgb: muted });
      if (qrSize) drawQr(doc, ctx.qr, ix + iw - qrSize, cy, qrSize);
    }
    cy += footH;
  }
  return cy;
}

function drawSlip(doc, ctx, o, box) {
  const limit = box.y + box.h - box.pad;
  const n = itemRows(o).length;
  for (const scale of [1, 0.92, 0.84, 0.76, 0.68]) {
    if (slipPass(doc, ctx, o, box, scale, n, false) <= limit) return slipPass(doc, ctx, o, box, scale, n, true);
  }
  for (let k = n - 1; k >= 1; k--) {
    if (slipPass(doc, ctx, o, box, 0.68, k, false) <= limit) return slipPass(doc, ctx, o, box, 0.68, k, true);
  }
  return slipPass(doc, ctx, o, box, 0.6, 1, true);
}

// ---------- pages ----------

function pageMaker(doc) {
  let first = true;
  return (size) => {
    const [w, h] = size;
    const orient = w > h ? "landscape" : "portrait";
    if (first) {
      first = false;
      // The doc was created with this size already; nothing to add.
      return;
    }
    doc.addPage([w, h], orient);
  };
}

// Draw a landscape layout (page height x page width) turned a quarter turn clockwise onto the upright page:
// the label's top edge ends up on the page's right side. draw(box) gets the landscape box.
function sideways(doc, pad, draw) {
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  const k = doc.internal.scaleFactor;
  // jsPDF writes (x, y from the top) as PDF point (X, Y) = (x, H - y). The landscape frame sits at Y - (H - W);
  // turning it clockwise sends (X, Y) to (Y - (H - W), H - X).
  doc.internal.write("q", 0, -1, 1, 0, +(-(H - W) * k).toFixed(4), +(H * k).toFixed(4), "cm");
  draw({ x: 0, y: 0, w: H, h: W, pad });
  doc.internal.write("Q");
}

function newDoc(size, compress = true) {
  const [w, h] = size;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "in", format: [w, h], orientation: w > h ? "landscape" : "portrait", compress });
  doc.setProperties({ title: "Shipping labels", creator: "Ship Desk" });
  return doc;
}

// The order's own QR code (null when switched off), made once per order for its label and slip.
function orderQrMaker(on, source) {
  const cache = new Map();
  return (o) => {
    if (!on || !o) return null;
    const text = orderQrText(o, source === "paste" ? "paste" : "csv");
    if (text === ORDER_QR_PREFIX || text === ORDER_QR_PREFIX + "paste:|") return null;
    if (!cache.has(text)) cache.set(text, qrMatrix(text));
    return cache.get(text);
  };
}

function makeCtx(doc, opts, format) {
  const d = { ...DEFAULT_DESIGN, ...(opts.design || {}) };
  const font = ["helvetica", "times", "courier"].includes(d.font) ? d.font : "helvetica";
  const mono = isThermal(format);
  const darkness = clamp(Number(d.darkness) || 0, 0, 3);
  return {
    font,
    mono,
    accent: parseHex(d.accent),
    stroke: mono ? darkness * 0.0025 : 0,
    logo: d.logo ? imageInfo(doc, d.logo) : null,
    note: cleanText(d.note).slice(0, 60),
    qr: qrMatrix(d.qrUrl),
    orderQr: orderQrMaker(d.orderQr !== false && format !== "avery5160", opts.source),
    slipMessage: d.slipMessage,
    ret: opts.returnAddress || null,
    boldReturn: !!opts.boldReturn,
    noDivider: !!opts.noDivider,
    plan: opts.plan || {},
  };
}

// The user's own slip page image, fitted to a page (or a box) at 100%.
function drawSlipImage(doc, info, box, alias) {
  drawImage(doc, info, box.x + box.pad, box.y + box.pad, box.w - 2 * box.pad, box.h - 2 * box.pad, alias, "center", "top");
}

function slipImagesFor(doc, slipPages, orderId, cache) {
  if (!Array.isArray(slipPages)) return [];
  const out = [];
  slipPages.forEach((p, i) => {
    if (!p || p.orderId !== orderId) return;
    if (!cache.has(i)) cache.set(i, imageInfo(doc, p.pageImage));
    const info = cache.get(i);
    if (info) out.push({ info, alias: "slip-page-" + i });
  });
  return out;
}

function cellsFor(format) {
  const [W, H] = LETTER;
  switch (format) {
    case "letter1": return [{ x: 0, y: 0, w: W, h: H }];
    case "letter2": return [0, 1].map((i) => ({ x: 0, y: i * H / 2, w: W, h: H / 2 }));
    case "letter3": return [0, 1, 2].map((i) => ({ x: 0, y: i * H / 3, w: W, h: H / 3 }));
    case "letter4": return [0, 1, 2, 3].map((i) => ({ x: (i % 2) * W / 2, y: Math.floor(i / 2) * H / 2, w: W / 2, h: H / 2 }));
    default: return null;
  }
}

function cutLines(doc, format) {
  const [W, H] = LETTER;
  if (format === "letter2") dashed(doc, 0.15, H / 2, W - 0.15, H / 2);
  if (format === "letter3") { dashed(doc, 0.15, H / 3, W - 0.15, H / 3); dashed(doc, 0.15, 2 * H / 3, W - 0.15, 2 * H / 3); }
  if (format === "letter4") { dashed(doc, 0.15, H / 2, W - 0.15, H / 2); dashed(doc, W / 2, 0.15, W / 2, H - 0.15); }
}

/**
 * Build the PDF. orders: Order[] in label order. opts: see CONTRACT.md (format, slips, returnAddress,
 * boldReturn, noDivider, design, slipPages, plan; extra: compress=false for a readable PDF). Returns the jsPDF doc.
 */
export function renderPdf(orders, opts = {}) {
  if (!Array.isArray(orders)) throw new Error("renderPdf: orders must be an array");
  const fmt = FORMATS.find((f) => f.id === (opts.format || "thermal4x6"));
  if (!fmt) throw new Error(`Unknown label format: ${opts.format}`);
  const format = fmt.id;
  const slips = opts.slips !== false;
  const doc = newDoc(fmt.pageSize, opts.compress !== false);
  const page = pageMaker(doc);
  const ctx = makeCtx(doc, opts, format);
  const imgCache = new Map();

  if (!orders.length) {
    page(fmt.pageSize);
    setFont(doc, ctx, "normal", 12);
    color(doc, MUTED);
    doc.text("No orders selected.", 0.3, 0.6);
    return doc;
  }

  if (format === "labelSlip") {
    const [W, H] = LETTER;
    for (const o of orders) {
      page(LETTER);
      drawLabel(doc, ctx, o, { x: 0, y: 0, w: W, h: H / 2, pad: 0.3 });
      dashed(doc, 0.15, H / 2, W - 0.15, H / 2);
      if (slips) {
        const box = { x: 0, y: H / 2, w: W, h: H / 2, pad: 0.3 };
        const imgs = slipImagesFor(doc, opts.slipPages, o.id, imgCache);
        if (imgs.length) drawSlipImage(doc, imgs[0].info, box, imgs[0].alias);
        else drawSlip(doc, ctx, o, box);
      }
    }
    return doc;
  }

  if (isThermal(format)) {
    const [w, h] = fmt.pageSize;
    for (const o of orders) {
      page(fmt.pageSize);
      if (fmt.sideways) sideways(doc, 0.16, (box) => drawLabel(doc, ctx, o, box));
      else drawLabel(doc, ctx, o, { x: 0, y: 0, w, h, pad: 0.16 });
    }
  } else if (format === "envelope10") {
    for (const o of orders) {
      page(ENVELOPE);
      drawEnvelope(doc, ctx, o);
    }
  } else if (format === "avery5160") {
    orders.forEach((o, i) => {
      const k = i % 30;
      if (k === 0) page(LETTER);
      drawAveryCell(doc, ctx, o, 0.1875 + (k % 3) * 2.75, 0.5 + Math.floor(k / 3) * 1);
    });
  } else {
    const cells = cellsFor(format);
    orders.forEach((o, i) => {
      const k = i % cells.length;
      if (k === 0) { page(LETTER); cutLines(doc, format); }
      drawLabel(doc, ctx, o, { ...cells[k], pad: 0.3 });
    });
  }

  if (slips) {
    const size = fmt.slipSize;
    const slipCtx = { ...ctx, stroke: isThermal(format) ? ctx.stroke : 0 };
    for (const o of orders) {
      const imgs = slipImagesFor(doc, opts.slipPages, o.id, imgCache);
      const box = { x: 0, y: 0, w: size[0], h: size[1], pad: size[0] < 5 ? 0.18 : 0.45 };
      if (imgs.length) {
        for (const im of imgs) { page(size); drawSlipImage(doc, im.info, { ...box, pad: size[0] < 5 ? 0.08 : 0 }, im.alias); }
      } else {
        page(size);
        drawSlip(doc, slipCtx, o, box);
      }
    }
  }
  return doc;
}

function sizeFrom(pageSize) {
  if (Array.isArray(pageSize) && pageSize.length === 2) return [Number(pageSize[0]), Number(pageSize[1])];
  if (pageSize && typeof pageSize === "object" && pageSize.w) return [Number(pageSize.w), Number(pageSize.h)];
  if (typeof pageSize === "string") {
    if (pageSize === "4x6") return THERMAL;
    const f = FORMATS.find((x) => x.id === pageSize);
    if (f) return f.slipSize;
  }
  return LETTER;
}

/**
 * "Slips in label order": the user's own packing-slip pages (images from slips.js), re-ordered to match
 * the labels, one per page. pageSize: a FORMATS id (thermal -> 4x6, others -> letter), "4x6", "letter",
 * [w, h] or {w, h} in inches.
 */
export function slipsInLabelOrderPdf(orders, slipPages, pageSize = "letter") {
  const size = sizeFrom(pageSize);
  const doc = newDoc(size);
  const page = pageMaker(doc);
  const cache = new Map();
  const pad = size[0] < 5 ? 0.08 : 0;
  let pages = 0;
  for (const o of orders || []) {
    for (const im of slipImagesFor(doc, slipPages, o.id, cache)) {
      page(size);
      drawSlipImage(doc, im.info, { x: 0, y: 0, w: size[0], h: size[1], pad }, im.alias);
      pages++;
    }
  }
  if (!pages) {
    page(size);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.setTextColor(...MUTED);
    doc.text("No packing slip pages matched these orders.", 0.3, 0.6);
  }
  return doc;
}
