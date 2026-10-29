// imb.js: the USPS Intelligent Mail barcode (IMb), the 65-bar code TCGplayer's tracked-envelope packing slips carry
// (from November 2026). Makes the bars from the numbers (to print them on Ship Desk's own label), reads the numbers
// back from the bars, and finds the bars in a picture of a page (a slip PDF drawn by pdf.js).
// Spec: USPS-B-3200 "Intelligent Mail Barcode 4-State" Rev H; tables made as its Appendix C says, bar order from its
// Appendix D Table IV (as in zint, BSD-3-Clause). Bars are written as letters: F full, A ascender, D descender, T tracker.

/** Appendix C: the 13-bit characters with n bars on (5 of 13: 1287 of them, 2 of 13: 78). */
function nOf13(n, length) {
  const table = new Array(length);
  let lo = 0, hi = length - 1;
  for (let c = 0; c < 8192; c++) {
    let bits = 0;
    for (let b = c; b; b >>= 1) bits += b & 1;
    if (bits !== n) continue;
    let rev = 0;
    for (let i = 0; i < 13; i++) if (c & (1 << i)) rev |= 1 << (12 - i);
    if (rev < c) continue;
    if (rev === c) table[hi--] = c;
    else { table[lo++] = c; table[lo++] = rev; }
  }
  return table;
}

const TABLE5 = nOf13(5, 1287), TABLE2 = nOf13(2, 78);
const INDEX5 = new Map(TABLE5.map((c, i) => [c, i])), INDEX2 = new Map(TABLE2.map((c, i) => [c, i]));

// Appendix D Table IV: for character i (A..J) bit j, the bar it drives is BAR_MAP[13 * i + j] - 1 (0-64 = the bar's
// descender, 65-129 = its ascender).
const BAR_MAP = [
  67, 6, 78, 16, 86, 95, 34, 40, 45, 113, 117, 121, 62, 87, 18, 104, 41, 76, 57, 119,
  115, 72, 97, 2, 127, 26, 105, 35, 122, 52, 114, 7, 24, 82, 68, 63, 94, 44, 77, 112,
  70, 100, 39, 30, 107, 15, 125, 85, 10, 65, 54, 88, 20, 106, 46, 66, 8, 116, 29, 61,
  99, 80, 90, 37, 123, 51, 25, 84, 129, 56, 4, 109, 96, 28, 36, 47, 11, 71, 33, 102,
  21, 9, 17, 49, 124, 79, 64, 91, 42, 69, 53, 60, 14, 1, 27, 103, 126, 75, 89, 50,
  120, 19, 32, 110, 92, 111, 130, 59, 31, 12, 81, 43, 55, 5, 74, 22, 101, 128, 58, 118,
  48, 108, 38, 98, 93, 23, 83, 13, 73, 3,
];

/** The 11-bit frame check sequence over the 102-bit value (USPS_MSB_Math_CRC11GenerateFrameCheckSequence). */
function crc11(value) {
  const bytes = [];
  for (let i = 12; i >= 0; i--) bytes.push(Number((value >> BigInt(8 * i)) & 0xffn));
  bytes[0] &= 0x3f;
  let fcs = 0x7ff;
  const step = (data, bits) => {
    for (let b = 0; b < bits; b++) {
      fcs = ((fcs ^ data) & 0x400) ? ((fcs << 1) ^ 0xf35) : (fcs << 1);
      fcs &= 0x7ff;
      data <<= 1;
    }
  };
  step(bytes[0] << 5, 6);
  for (let i = 1; i < 13; i++) step(bytes[i] << 3, 8);
  return fcs;
}

const ROUTING_BASE = { 0: 0n, 5: 1n, 9: 100001n, 11: 1000100001n };

/**
 * The parts of a 20-digit tracking code: { barcodeId, serviceType, mailerId, serial } (a mailer ID starting with 9
 * is 9 digits long, others 6).
 */
export function imbParts(tracking) {
  const t = String(tracking || "");
  const mid = t[5] === "9" ? 9 : 6;
  return { barcodeId: t.slice(0, 2), serviceType: t.slice(2, 5), mailerId: t.slice(5, 5 + mid), serial: t.slice(5 + mid) };
}

/**
 * encodeImb(tracking, routing) -> the 65 bars as "FADT..." letters. tracking = 20 digits (2nd digit 0-4), routing = the
 * delivery ZIP: "", 5, 9 or 11 digits. Throws on anything else.
 */
export function encodeImb(tracking, routing = "") {
  const t = String(tracking || "").replace(/\D/g, ""), z = String(routing || "").replace(/\D/g, "");
  if (t.length !== 20 || t[1] > "4") throw new Error("An IMb tracking code is 20 digits (the second one 0-4).");
  if (!(z.length in ROUTING_BASE)) throw new Error("An IMb routing code is a 5, 9 or 11 digit ZIP, or nothing.");
  let v = z ? BigInt(z) + ROUTING_BASE[z.length] : 0n;
  v = (v * 10n + BigInt(t[0])) * 5n + BigInt(t[1]);
  for (let i = 2; i < 20; i++) v = v * 10n + BigInt(t[i]);
  const fcs = crc11(v);
  const cw = new Array(10);
  cw[9] = Number(v % 636n); v /= 636n;
  for (let i = 8; i > 0; i--) { cw[i] = Number(v % 1365n); v /= 1365n; }
  cw[0] = Number(v);
  cw[9] *= 2;
  if (fcs & 0x400) cw[0] += 659;
  const chars = cw.map((c, i) => {
    const ch = c < 1287 ? TABLE5[c] : TABLE2[c - 1287];
    return fcs & (1 << i) ? ch ^ 0x1fff : ch;
  });
  const on = new Array(130).fill(false);
  for (let i = 0; i < 10; i++) for (let j = 0; j < 13; j++) on[BAR_MAP[13 * i + j] - 1] = !!((chars[i] >> j) & 1);
  let bars = "";
  for (let i = 0; i < 65; i++) bars += on[i] ? (on[i + 65] ? "F" : "D") : (on[i + 65] ? "A" : "T");
  return bars;
}

/**
 * decodeImb(bars) -> { tracking, routing } or null when the bars aren't a valid IMb (wrong count, a character that
 * isn't one, or the check fails). Also reads a barcode seen upside down (bars reversed, ascenders and descenders swapped).
 */
export function decodeImb(bars) {
  const b = String(bars || "").toUpperCase();
  if (!/^[FADT]{65}$/.test(b)) return null;
  return decodeOneWay(b) || decodeOneWay([...b].reverse().map((c) => ({ A: "D", D: "A" })[c] || c).join(""));
}

function decodeOneWay(b) {
  const chars = new Array(10).fill(0);
  for (let i = 0; i < 10; i++) {
    for (let j = 0; j < 13; j++) {
      const k = BAR_MAP[13 * i + j] - 1, bar = b[k % 65];
      const on = k < 65 ? bar === "F" || bar === "D" : bar === "F" || bar === "A";
      if (on) chars[i] |= 1 << j;
    }
  }
  let fcs = 0;
  const cw = chars.map((ch, i) => {
    let c = ch;
    if (!INDEX5.has(c) && !INDEX2.has(c)) { c ^= 0x1fff; fcs |= 1 << i; }
    return INDEX5.has(c) ? INDEX5.get(c) : INDEX2.has(c) ? 1287 + INDEX2.get(c) : -1;
  });
  if (cw.includes(-1) || cw[9] % 2) return null;
  cw[9] /= 2;
  if (cw[0] >= 659) { cw[0] -= 659; fcs |= 0x400; }
  if (cw[0] > 658 || cw[9] > 635 || cw.slice(1, 9).some((c) => c > 1364)) return null;
  let v = BigInt(cw[0]);
  for (let i = 1; i < 9; i++) v = v * 1365n + BigInt(cw[i]);
  v = v * 636n + BigInt(cw[9]);
  if (crc11(v) !== fcs) return null;
  let tail = "";
  for (let i = 0; i < 18; i++) { tail = String(v % 10n) + tail; v /= 10n; }
  const d2 = v % 5n; v /= 5n;
  const d1 = v % 10n; v /= 10n;
  let routing = "";
  if (v >= ROUTING_BASE[11]) routing = String(v - ROUTING_BASE[11]).padStart(11, "0");
  else if (v >= ROUTING_BASE[9]) routing = String(v - ROUTING_BASE[9]).padStart(9, "0");
  else if (v >= ROUTING_BASE[5]) routing = String(v - ROUTING_BASE[5]).padStart(5, "0");
  return { tracking: `${d1}${d2}${tail}`, routing };
}

/** The tracking number for an IMb as USPS's tracking page takes it: the 20 digits followed by the routing ZIP. */
export const imbNumber = (imb) => (imb ? imb.tracking + (imb.routing || "") : "");

// ---------- drawing (PDF) ----------

/** Sizes in inches, inside USPS's ranges: 22 bars per inch, bars 0.02 in wide, full bar 0.145 in, tracker 0.05 in. */
export const IMB_SIZE = { pitch: 1 / 22, bar: 0.02, full: 0.145, tracker: 0.05 };
export const imbWidth = (s = IMB_SIZE) => 64 * s.pitch + s.bar;

/**
 * Draw the bars with jsPDF: x, y = top-left of the barcode, in the document's unit (inches). USPS wants a clear space
 * of 0.125 in left and right and 0.04 in above and below (the caller keeps it).
 */
export function drawImb(doc, bars, x, y, s = IMB_SIZE) {
  const ext = (s.full - s.tracker) / 2;
  doc.setFillColor(0, 0, 0);
  [...bars].forEach((c, i) => {
    const top = c === "F" || c === "A" ? y : y + ext;
    const bottom = c === "F" || c === "D" ? y + s.full : y + ext + s.tracker;
    doc.rect(x + i * s.pitch, top, s.bar, bottom - top, "F");
  });
}

// ---------- finding the bars in a picture ----------

/**
 * findImb(image, dpi) -> [{ bars, x, y, imb }]: every valid IMb in a picture (an ImageData-like { width, height,
 * data: RGBA }), at any of the four quarter turns. dpi = pixels per inch of the picture (to know a bar's size).
 */
export function findImb(image, dpi) {
  const found = [];
  for (const turn of [0, 1, 2, 3]) {
    const img = turn ? rotate(image, turn) : image;
    for (const hit of findUpright(img, dpi)) {
      if (!found.some((f) => f.bars === hit.bars)) found.push({ ...hit, turn });
    }
    if (found.length) break;
  }
  return found;
}

function rotate(image, turn) {
  const { width: w, height: h, data } = image;
  const W = turn % 2 ? h : w, H = turn % 2 ? w : h;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [X, Y] = turn === 1 ? [h - 1 - y, x] : turn === 2 ? [w - 1 - x, h - 1 - y] : [y, w - 1 - x];
      const s = (y * w + x) * 4, d = (Y * W + X) * 4;
      out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = data[s + 3];
    }
  }
  return { width: W, height: H, data: out };
}

/** Dark blobs shaped like IMb bars (thin and upright), then rows of 65 evenly spaced ones that decode. */
function findUpright(image, dpi) {
  const { width: w, height: h, data } = image;
  const dark = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const a = data[p + 3] / 255;
    const lum = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) * a + 255 * (1 - a);
    dark[i] = lum < 140 ? 1 : 0;
  }
  // Connected dark blobs (4-neighbours), keeping only bar-shaped ones.
  const seen = new Uint8Array(w * h), stack = [], blobs = [];
  const maxW = 0.04 * dpi, minH = 0.025 * dpi, maxH = 0.25 * dpi;
  for (let start = 0; start < w * h; start++) {
    if (!dark[start] || seen[start]) continue;
    let x0 = w, x1 = 0, y0 = h, y1 = 0, n = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i - x) / w;
      n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && dark[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < w - 1 && dark[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && dark[i - w] && !seen[i - w]) { seen[i - w] = 1; stack.push(i - w); }
      if (y < h - 1 && dark[i + w] && !seen[i + w]) { seen[i + w] = 1; stack.push(i + w); }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (bw <= maxW && bh >= minH && bh <= maxH && bh >= 1.4 * bw && n >= 0.6 * bw * bh) {
      blobs.push({ x: (x0 + x1) / 2, top: y0, bottom: y1 });
    }
  }
  blobs.sort((a, b) => a.x - b.x);
  const out = [], used = new Set();
  for (let s = 0; s < blobs.length; s++) {
    if (used.has(s)) continue;
    const row = chain(blobs, s, dpi);
    if (row.length !== 65) continue;
    const bars = classify(row.map((i) => blobs[i]));
    const imb = bars && decodeImb(bars);
    if (!imb) continue;
    row.forEach((i) => used.add(i));
    out.push({ bars, x: blobs[row[0]].x, y: Math.min(...row.map((i) => blobs[i].top)), imb });
  }
  return out;
}

/** From blob s, the run of blobs to the right sharing one middle line at an even pitch (indexes into blobs). */
function chain(blobs, s, dpi) {
  const first = blobs[s];
  const shares = (a, b) => Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) >= 0.3 * Math.min(a.bottom - a.top, b.bottom - b.top);
  let next = -1;
  for (let j = s + 1; j < blobs.length && blobs[j].x - first.x < 0.08 * dpi; j++) {
    if (blobs[j].x > first.x && shares(first, blobs[j])) { next = j; break; }
  }
  if (next < 0) return [s];
  const pitch = blobs[next].x - first.x;
  const row = [s, next];
  let last = blobs[next];
  while (row.length < 65) {
    let pick = -1;
    for (let j = row[row.length - 1] + 1; j < blobs.length && blobs[j].x <= last.x + 1.3 * pitch; j++) {
      const gap = blobs[j].x - last.x;
      if (gap >= 0.7 * pitch && shares(first, blobs[j]) && shares(last, blobs[j])) { pick = j; break; }
    }
    if (pick < 0) break;
    row.push(pick);
    last = blobs[pick];
  }
  return row;
}

/** Four heights of bar -> letters: tops split into ascender/tracker, bottoms into descender/tracker. */
function classify(bars) {
  const tops = bars.map((b) => b.top), bottoms = bars.map((b) => b.bottom);
  const tMin = Math.min(...tops), tMax = Math.max(...tops), bMin = Math.min(...bottoms), bMax = Math.max(...bottoms);
  if (tMax - tMin < 2 || bMax - bMin < 2) return null;
  const tMid = (tMin + tMax) / 2, bMid = (bMin + bMax) / 2;
  return bars.map((b) => (b.top < tMid ? (b.bottom > bMid ? "F" : "A") : (b.bottom > bMid ? "D" : "T"))).join("");
}
