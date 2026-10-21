// render suite: label/slip PDFs (render.js) and reading TCGplayer packing slips (slips.js).
// Orders are built by hand here so this suite doesn't depend on the Data station's modules.
import { ok, eq, near, throws } from "./runner.js";
import { FORMATS, renderPdf, slipsInLabelOrderPdf } from "../js/render.js";
import { readSlipPdf, attachSlips, slipPagesFor, parseItemLine } from "../js/slips.js";

const pdfjs = window.pdfjsLib;
if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = "../vendor/pdf.worker.min.js";

const RETURN = { name: "Taco Card Shop", phone: "555-0100", street: "12 Return Rd", street2: "Suite 5", city: "Austin", state: "TX", zip: "78701" };

const PEOPLE = [
  ["Ash", "Example", "45 Example St", "Apt 2", "Los Angeles", "CA", "90012"],
  ["Brock", "Sample", "9 Granite Way", "", "Boston", "MA", "02134"],
  ["Misty", "Waters", "300 Cascade Blvd", "Unit 14B", "New York", "NY", "10001-1234"],
  ["Gary", "Oakwood", "1 Lab Lane", "", "Austin", "TX", "73301"],
  ["Dawn", "Berlitz", "77 Pine St", "", "Seattle", "WA", "98101"],
];

function makeOrder(i, extra = {}) {
  const [firstName, lastName, address1, address2, city, state, zip] = PEOPLE[i % PEOPLE.length];
  return {
    id: `T-${1000 + i}`, firstName, lastName, name: `${firstName} ${lastName}`, address1, address2, city, state, zip,
    country: "US", orderDate: "10/1/2026", weightOz: 0.12, shippingMethod: "Standard (7-10 days)", itemCount: 2,
    value: 9.99, shippingPaid: 0.99, tracking: "", carrier: "", items: [], row: { "Order #": `T-${1000 + i}` }, line: i + 2,
    ...extra,
  };
}
const orders = (n) => Array.from({ length: n }, (_, i) => makeOrder(i));

const LONG = makeOrder(0, {
  id: "LONG-0001-ABCDEF-123456",
  name: "Maximilian Bartholomew Montgomery-Fitzgerald Wolfeschlegelsteinhausen III",
  address1: "123456 North Extraordinarily Long Boulevard Name Parkway East Building C",
  address2: "Attention: Receiving Department, Loading Dock 7, Suite 1200-B Rear Entrance",
  city: "Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch Township", state: "NY", zip: "12345-6789",
  shippingMethod: "Expedited Shipping with a very long description that keeps going (3-5 business days)",
});

function labelPages(id, n) {
  const per = { letter1: 1, letter2: 2, letter3: 3, letter4: 4, avery5160: 30 }[id];
  return per ? Math.ceil(n / per) : n;
}
const slipSize = (id) => (id.startsWith("thermal") ? [4, 6] : [8.5, 11]);

// Read a jsPDF doc back with pdf.js: page sizes (inches), text, and text items (inches, from the top-left).
async function readBack(doc) {
  const pdf = await pdfjs.getDocument({ data: doc.output("arraybuffer") }).promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const w = vp.width / 72, h = vp.height / 72;
    const items = (await page.getTextContent()).items.filter((it) => it.str.trim()).map((it) => ({
      s: it.str, x: it.transform[4] / 72, base: h - it.transform[5] / 72, w: it.width / 72,
      size: Math.hypot(it.transform[2], it.transform[3]),
      // direction of the text along the page (1, 0 = normal; 0, 1 = turned clockwise, reading down the page)
      dx: it.transform[0] / Math.hypot(it.transform[0], it.transform[1]), dy: -it.transform[1] / Math.hypot(it.transform[0], it.transform[1]),
    }));
    pages.push({ w, h, items, text: items.map((i) => i.s).join(" "), page });
  }
  return { pdf, pages, text: pages.map((p) => p.text).join("\n") };
}

function checkSizes(pages, size, from = 0, to = pages.length, what = "") {
  for (let i = from; i < to; i++) {
    near(pages[i].w, size[0], 0.01, `${what} page ${i + 1} width`);
    near(pages[i].h, size[1], 0.01, `${what} page ${i + 1} height`);
  }
}

function inBounds(pages, what) {
  for (const [i, p] of pages.entries()) {
    for (const it of p.items) {
      const ex = it.x + it.dx * it.w, ey = it.base + it.dy * it.w; // where the text ends
      ok(Math.min(it.x, ex) >= -0.005 && Math.max(it.x, ex) <= p.w + 0.005, `${what} page ${i + 1}: "${it.s}" runs off the side (x ${it.x.toFixed(2)} to ${ex.toFixed(2)})`);
      ok(Math.min(it.base, ey) > 0 && Math.max(it.base, ey) <= p.h + 0.005, `${what} page ${i + 1}: "${it.s}" off the page vertically`);
    }
  }
}

function canvasImage(w, h, fill, type = "image/png") {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.fillStyle = fill; g.fillRect(0, 0, w, h);
  g.fillStyle = "#ffffff"; g.fillRect(w * 0.1, h * 0.1, w * 0.2, h * 0.2);
  return c.toDataURL(type, 0.9);
}

async function centerPixel(page) {
  const vp = page.getViewport({ scale: 0.5 });
  const c = document.createElement("canvas");
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const g = c.getContext("2d");
  await page.render({ canvasContext: g, viewport: vp }).promise;
  return Array.from(g.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data.slice(0, 3));
}

const tests = {
  "FORMATS has every contract format with label, page size and labels per page": async () => {
    eq(FORMATS.map((f) => f.id), ["thermal4x6", "thermal6x4", "letter1", "letter2", "letter3", "letter4", "labelSlip", "avery5160", "envelope10"]);
    for (const f of FORMATS) {
      ok(f.label && f.label.length > 5, f.id + " label");
      ok(Array.isArray(f.pageSize) && f.pageSize.length === 2, f.id + " pageSize");
      ok(f.perPage >= 1, f.id + " perPage");
    }
    eq(FORMATS.find((f) => f.id === "avery5160").perPage, 30);
    eq(FORMATS.find((f) => f.id === "envelope10").pageSize, [9.5, 4.125]);
  },

  "thermal6x4: an upright 4x6 page with the label turned sideways (printers cut a wide page off)": async () => {
    const list = orders(2);
    const { pages } = await readBack(renderPdf(list, { format: "thermal6x4", slips: true, returnAddress: RETURN }));
    eq(pages.length, 4);
    checkSizes(pages, [4, 6]);
    for (const p of pages.slice(0, 2)) {
      ok(p.items.length > 3, "label has text");
      for (const it of p.items) ok(Math.abs(it.dx) < 0.01 && Math.abs(it.dy - 1) < 0.01, `"${it.s}" is turned (reads down the page)`);
      // The label's top (return address) is on the right, its bottom (order #) on the left.
      const ret = p.items.find((it) => it.s.includes(RETURN.name)), ord = p.items.find((it) => it.s.startsWith("Order "));
      ok(ret && ord && ret.x > 3 && ord.x < 1, `return address right, order # left (${ret && ret.x}, ${ord && ord.x})`);
    }
    for (const p of pages.slice(2)) ok(p.items.every((it) => Math.abs(it.dx - 1) < 0.01), "packing slips stay upright");
    inBounds(pages, "thermal6x4");
  },
};

for (const f of FORMATS) {
  tests[`${f.id}: labels only: page count, page size, every name + ZIP + return address`] = async () => {
    const list = orders(5);
    const { pages, text } = await readBack(renderPdf(list, { format: f.id, slips: false, returnAddress: RETURN }));
    eq(pages.length, labelPages(f.id, 5), "page count");
    checkSizes(pages, f.pageSize);
    for (const o of list) {
      ok(text.includes(o.name), `name ${o.name} missing`);
      ok(text.includes(o.zip), `ZIP ${o.zip} missing`);
    }
    if (f.id !== "avery5160") {
      // Avery 5160 is ship-to only; every other label carries the return address.
      ok(text.includes(RETURN.name) && text.includes(RETURN.street) && text.includes("Austin, TX 78701"), "return address missing");
    }
  };

  tests[`${f.id}: packing slips on/off changes the page count; slips carry the order details`] = async () => {
    const list = orders(3);
    const off = await readBack(renderPdf(list, { format: f.id, slips: false, returnAddress: RETURN }));
    const on = await readBack(renderPdf(list, { format: f.id, slips: true, returnAddress: RETURN }));
    const labels = labelPages(f.id, 3);
    if (f.id === "labelSlip") {
      eq(on.pages.length, 3, "labelSlip: one page per order");
      eq(off.pages.length, 3);
      ok(!off.text.includes("PACKING SLIP") && on.text.includes("PACKING SLIP"), "slip half");
    } else {
      eq(on.pages.length, labels + 3, "labels + one slip per order");
      ok(on.pages.length !== off.pages.length, "slips changed the page count");
      checkSizes(on.pages, f.pageSize, 0, labels, "label");
      checkSizes(on.pages, slipSize(f.id), labels, on.pages.length, "slip");
    }
    for (const o of list) {
      ok(on.text.includes(o.name) && on.text.includes(o.zip), `${o.name} / ${o.zip}`);
      ok(on.text.includes(o.id), `order # ${o.id}`);
    }
    ok(on.text.includes(RETURN.name) && on.text.includes(RETURN.street), "return address on the slips");
    ok(on.text.includes("10/1/2026") && on.text.includes("Standard (7-10 days)"), "order date + shipping method");
    ok(on.text.includes("$9.99"), "value");
    inBounds(on.pages, f.id);
  };

  tests[`${f.id}: long names and addresses don't throw and stay on the page`] = async () => {
    const list = [LONG, makeOrder(1), { ...LONG, id: "LONG-2" }];
    const longReturn = { ...RETURN, name: "The Extremely Long Named Trading Card Emporium and Collectibles Warehouse LLC",
      street: "98765 Return Address Street That Goes On And On Forever Avenue" };
    for (const design of [{}, { font: "courier", logo: canvasImage(300, 100, "#c33"), qrUrl: "https://example.com/store/very/long/path?x=1", note: "N".repeat(80), slipMessage: "Thank you! ".repeat(30) }]) {
      const doc = renderPdf(list, { format: f.id, slips: true, returnAddress: longReturn, design, boldReturn: true });
      const { pages, text } = await readBack(doc);
      eq(pages.length, f.id === "labelSlip" ? 3 : labelPages(f.id, 3) + 3);
      inBounds(pages, f.id);
      ok(text.includes(makeOrder(1).name), "the normal order next to the long ones is intact");
    }
  };

  tests[`${f.id}: design options (accent, fonts, logo, darkness, note, QR, slip message, bold, no divider)`] = async () => {
    const list = orders(2);
    for (const font of ["helvetica", "times", "courier"]) {
      const design = { accent: "#c0392b", font, logo: canvasImage(240, 120, "#2a6"), darkness: 3,
        note: "Thanks for buying from us!", qrUrl: "https://example.com/shop", slipMessage: "Leave us a review, it helps a lot." };
      const doc = renderPdf(list, { format: f.id, slips: true, returnAddress: RETURN, design, boldReturn: true, noDivider: true,
        plan: { "T-1000": { tag: "tracking-required", label: "Tracking required", tracked: true, weightOz: 1.2, postage: 1.11, stamps: 2, letterOk: true } } });
      const { text, pages } = await readBack(doc);
      for (const o of list) ok(text.includes(o.name) && text.includes(o.zip), `${font}: ${o.name}`);
      if (f.id !== "avery5160") ok(text.includes("Thanks for buying from us!"), `${font}: label note`);
      ok(text.includes("Leave us a review"), `${font}: slip message`);
      ok(text.includes("Tracking required") && text.includes("2 stamps"), `${font}: plan on the slip`);
      inBounds(pages, `${f.id}/${font}`);
    }
  };
}

Object.assign(tests, {
  "avery5160: 31 orders -> 2 sheets; every line stays inside its 2-5/8 x 1 in label": async () => {
    const list = [...orders(30), LONG];
    const { pages, text } = await readBack(renderPdf(list, { format: "avery5160", slips: false, returnAddress: RETURN }));
    eq(pages.length, 2);
    ok(text.includes(LONG.zip), "31st label on sheet 2");
    for (const p of pages) {
      for (const it of p.items) {
        const col = Math.floor((it.x - 0.1875) / 2.75);
        const left = 0.1875 + col * 2.75;
        ok(col >= 0 && col <= 2 && it.x + it.w <= left + 2.625 + 0.002, `"${it.s}" spills out of its label`);
        const row = Math.floor(it.base - 0.5);
        ok(row >= 0 && row <= 9, `"${it.s}" outside the label rows`);
      }
    }
    eq(pages[0].items.filter((it) => /^T-|^[A-Z][a-z]+ [A-Z][a-z]+$/.test(it.s)).length, 30, "30 names on sheet 1");
  },

  "avery5160: labels follow the exact sheet geometry (3 x 10, 2.75 in column pitch, 1 in rows)": async () => {
    const { pages } = await readBack(renderPdf(orders(30), { format: "avery5160", slips: false }));
    const names = pages[0].items.filter((it) => PEOPLE.some((p) => it.s === `${p[0]} ${p[1]}`));
    eq(names.length, 30);
    const cols = [...new Set(names.map((n) => Math.floor((n.x - 0.1875) / 2.75)))].sort();
    eq(cols, [0, 1, 2]);
    const rows = [...new Set(names.map((n) => Math.floor(n.base - 0.5)))].sort((a, b) => a - b);
    eq(rows, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  },

  "thermal4x6: the ship-to name is the biggest text on the label": async () => {
    const { pages } = await readBack(renderPdf(orders(1), { format: "thermal4x6", slips: false, returnAddress: RETURN }));
    const items = pages[0].items;
    const name = items.find((i) => i.s === "Ash Example");
    const street = items.find((i) => i.s === "45 Example St");
    const ret = items.find((i) => i.s === RETURN.street);
    ok(name && name.size >= 16, "name at least 16 pt, got " + (name && name.size));
    ok(street.size >= 14, "address at least 14 pt");
    ok(name.size > ret.size * 1.5, "ship-to much bigger than the return address");
    ok(Math.max(...items.map((i) => i.size)) <= name.size + 0.01, "nothing bigger than the name");
  },

  "letter2/3/4: dashed cut lines are drawn": async () => {
    for (const id of ["letter2", "letter3", "letter4", "labelSlip"]) {
      const raw = renderPdf(orders(4), { format: id, slips: false, compress: false }).output();
      ok(/\[[\d. ]+\] [\d.]+ d/.test(raw), id + ": no dash pattern in the PDF");
    }
    const raw1 = renderPdf(orders(1), { format: "letter1", slips: false, compress: false }).output();
    ok(!/\[[\d. ]+\] [\d.]+ d/.test(raw1), "letter1 has no cut lines");
  },

  "noDivider removes the divider line": async () => {
    const count = (doc) => (doc.output().match(/ l\s*\n?S/g) || []).length;
    const withLine = count(renderPdf(orders(1), { format: "thermal4x6", slips: false, returnAddress: RETURN, compress: false }));
    const without = count(renderPdf(orders(1), { format: "thermal4x6", slips: false, returnAddress: RETURN, noDivider: true, compress: false }));
    ok(withLine >= 1 && without === withLine - 1, `lines: ${withLine} vs ${without}`);
  },

  "envelope10: the top-right stamp corner (1.75 x 1 in) stays empty": async () => {
    const design = { logo: canvasImage(200, 200, "#36c"), qrUrl: "https://example.com", note: "Hello" };
    const { pages } = await readBack(renderPdf([LONG, ...orders(3)], { format: "envelope10", slips: false, returnAddress: RETURN, design }));
    for (const p of pages) {
      for (const it of p.items) {
        const inCorner = it.x + it.w > 9.5 - 1.75 && it.base - it.size / 72 < 1.0;
        ok(!inCorner, `"${it.s}" is in the stamp corner`);
      }
      const big = Math.max(...p.items.map((i) => i.size));
      const name = p.items.find((i) => i.size === big);
      ok(name.x > 3.3, `ship-to sits right of the middle ("${name.s}" at x ${name.x.toFixed(2)})`);
    }
  },

  "darkness and bold return address add a text stroke on thermal only": async () => {
    const thermal = renderPdf(orders(1), { format: "thermal4x6", slips: false, returnAddress: RETURN, design: { darkness: 3 }, compress: false }).output();
    ok(/2 Tr/.test(thermal), "thermal darkness uses fill+stroke text");
    const plain = renderPdf(orders(1), { format: "thermal4x6", slips: false, returnAddress: RETURN, design: { darkness: 0 }, compress: false }).output();
    ok(!/2 Tr/.test(plain), "darkness 0: plain text");
    const bold = renderPdf(orders(1), { format: "thermal4x6", slips: false, returnAddress: RETURN, boldReturn: true, compress: false }).output();
    ok(/2 Tr/.test(bold), "bold return address is darker on thermal");
    const letter = renderPdf(orders(1), { format: "letter1", slips: false, returnAddress: RETURN, design: { darkness: 3 }, compress: false }).output();
    ok(!/2 Tr/.test(letter), "no stroke on letter paper");
  },

  "the label note is cut to 60 characters": async () => {
    const note = "A".repeat(50) + "BCDEFGHIJKLMNOP";
    const { text } = await readBack(renderPdf(orders(1), { format: "thermal4x6", slips: false, design: { note } }));
    ok(text.includes("A".repeat(50) + "BCDEFGHIJ"), "first 60 chars kept");
    ok(!text.includes("KLMNOP"), "rest dropped");
  },

  "slip items: order.items are listed with prices; many items never overflow": async () => {
    const items = [
      { qty: 1, name: "Dark Magician", detail: "LOB - Near Mint", price: 4.99 },
      { qty: 2, name: "Blue-Eyes White Dragon", detail: "SDK - Lightly Played", price: 12.5 },
    ];
    const one = await readBack(renderPdf([makeOrder(0, { items })], { format: "letter1", slips: true, returnAddress: RETURN }));
    ok(one.text.includes("Dark Magician") && one.text.includes("$4.99") && one.text.includes("LOB - Near Mint"), "item line");
    ok(one.text.includes("$12.50"), "second item");
    ok(one.text.includes("3 items"), "item count from the item quantities");
    const many = Array.from({ length: 90 }, (_, i) => ({ qty: 1, name: `Card number ${i + 1} with a fairly long name`, detail: "Set - Near Mint", price: 0.25 }));
    for (const id of ["thermal4x6", "letter1", "labelSlip"]) {
      const { pages, text } = await readBack(renderPdf([makeOrder(0, { items: many })], { format: id, slips: true, returnAddress: RETURN }));
      inBounds(pages, id);
      ok(/\+ \d+ more items/.test(text), id + ": says how many more items");
      ok(text.includes("Card number 1 with"), id + ": first items listed");
    }
  },

  "slip without items falls back to item count and value": async () => {
    const { text } = await readBack(renderPdf([makeOrder(0, { itemCount: 3, value: 24.5 })], { format: "letter1", slips: true }));
    ok(text.includes("3 items") && text.includes("$24.50"), text);
  },

  "slipPages (the user's own slips) replace the drawn slips, in label order": async () => {
    const list = orders(2);
    const red = canvasImage(170, 220, "#ff0000", "image/jpeg"), blue = canvasImage(170, 220, "#0000ff", "image/jpeg");
    // Given in the opposite order, plus two pages for order 1 and a page for an order that isn't printed.
    const slipPages = [{ orderId: "T-1001", pageImage: blue }, { orderId: "T-1000", pageImage: red },
      { orderId: "T-1001", pageImage: blue }, { orderId: "OTHER", pageImage: red }];
    const doc = renderPdf(list, { format: "letter2", slips: true, returnAddress: RETURN, slipPages });
    const { pages } = await readBack(doc);
    eq(pages.length, 1 + 3, "1 label page + 3 slip pages");
    const px = await centerPixel(pages[1].page);
    ok(px[0] > 180 && px[2] < 90, "first slip page is order T-1000's (red): " + px);
    const px2 = await centerPixel(pages[2].page);
    ok(px2[2] > 180 && px2[0] < 90, "then T-1001's (blue): " + px2);

    const ls = await readBack(renderPdf(list, { format: "labelSlip", slips: true, returnAddress: RETURN, slipPages }));
    eq(ls.pages.length, 2, "labelSlip stays one page per order");
    ok(!ls.text.includes("PACKING SLIP"), "own slip image used instead of a drawn slip");
  },

  "slipsInLabelOrderPdf: one page per slip image, in label order, at the chosen size": async () => {
    const list = [makeOrder(1), makeOrder(0)];
    const red = canvasImage(170, 220, "#ff0000"), blue = canvasImage(170, 220, "#0000ff");
    const slipPages = [{ orderId: "T-1000", pageImage: red }, { orderId: "T-1001", pageImage: blue }];
    for (const [size, want] of [["letter", [8.5, 11]], ["thermal4x6", [4, 6]], ["letter2", [8.5, 11]], [[4, 6], [4, 6]]]) {
      const { pages } = await readBack(slipsInLabelOrderPdf(list, slipPages, size));
      eq(pages.length, 2, "two pages for " + size);
      checkSizes(pages, want, 0, 2, String(size));
      const px = await centerPixel(pages[0].page);
      ok(px[2] > 180 && px[0] < 90, "T-1001 (blue) first, like the labels: " + px);
    }
    const none = await readBack(slipsInLabelOrderPdf(list, [], "letter"));
    eq(none.pages.length, 1);
    ok(none.text.includes("No packing slip pages"), "explains an empty result");
  },

  "odd input: accents, non-Latin text, empty fields, foreign country, no return address": async () => {
    const odd = makeOrder(0, { name: "Zoë Łukasz 東京 O’Brien", address2: "", country: "Canada", zip: "K1A 0B1", state: "ON" });
    for (const f of FORMATS) {
      const { text } = await readBack(renderPdf([odd], { format: f.id, slips: true }));
      ok(text.includes("Zoë") && text.includes("O'Brien") && text.includes("Lukasz"), f.id + ": cleaned name: " + text.slice(0, 80));
      ok(text.includes("K1A 0B1") && text.includes("CANADA"), f.id + ": postal code + country");
    }
  },

  "unknown format throws; no orders gives one page; inputs are not changed": async () => {
    await throws(() => renderPdf(orders(1), { format: "nope" }));
    await throws(() => renderPdf(null, { format: "letter1" }));
    eq((await readBack(renderPdf([], { format: "thermal4x6" }))).pages.length, 1);
    const list = orders(3);
    const before = JSON.stringify(list);
    renderPdf(list, { format: "labelSlip", slips: true, returnAddress: RETURN, plan: {} });
    eq(JSON.stringify(list), before);
  },

  // ---------- slips.js ----------

  "parseItemLine reads item lines and ignores totals and addresses": async () => {
    eq(parseItemLine("1  Dark Magician - LOB - Near Mint  $4.99"), { qty: 1, name: "Dark Magician", detail: "LOB - Near Mint", price: 4.99 });
    eq(parseItemLine("2 x Phoenix - Set Two - NM  $1.00  $2.00"), { qty: 2, name: "Phoenix", detail: "Set Two - NM", price: 1 });
    eq(parseItemLine("3 Lightning Bolt $1,234.50"), { qty: 3, name: "Lightning Bolt", detail: "", price: 1234.5 });
    eq(parseItemLine("2 Items  $9.98"), null);
    eq(parseItemLine("Subtotal: $9.98"), null);
    eq(parseItemLine("45 Example St"), null);
    eq(parseItemLine("90012 Los Angeles"), null);
  },

  "readSlipPdf: matches pages to orders, follows a 2-page slip, extracts items, keeps page images": async () => {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "in", format: "letter" });
    const header = (id) => {
      doc.setFontSize(16); doc.text("TCGplayer Packing Slip", 0.5, 0.8);
      doc.setFontSize(10);
      if (id) doc.text(`Order Number: ${id}`, 0.5, 1.2);
      doc.text("Qty   Description   Price", 0.5, 2.0);
    };
    // Page 1: order T-1000, item lines as single strings.
    header("T-1000");
    doc.text("Ship To: Ash Example, 45 Example St, Los Angeles, CA 90012", 0.5, 1.5);
    doc.text("1  Dark Magician - LOB - Near Mint  $4.99", 0.5, 2.3);
    doc.text("2  Blue-Eyes White Dragon - SDK - Lightly Played  $12.50", 0.5, 2.6);
    doc.text("Total: $29.99", 0.5, 3.2);
    // Page 2: order T-1001, items laid out in separate columns.
    doc.addPage("letter");
    header("T-1001");
    doc.text("3", 0.5, 2.3); doc.text("Pot of Greed - LOB - Near Mint", 1.0, 2.3); doc.text("$1.25", 7.0, 2.3);
    doc.text("1", 0.5, 2.6); doc.text("Raigeki - LOB - Moderately Played", 1.0, 2.6); doc.text("$8.00", 7.0, 2.6);
    // Page 3: the rest of T-1001's slip, no order number on it.
    doc.addPage("letter");
    doc.setFontSize(10);
    doc.text("1  Mirror Force - MRD - Damaged  $20.00", 0.5, 1.0);
    doc.text("Page 2 of 2", 0.5, 10.5);
    // Page 4: an order that isn't in this batch.
    doc.addPage("letter");
    header("Z-9999");
    doc.text("1  Kuriboh - MRD - Near Mint  $0.50", 0.5, 2.3);
    const buf = doc.output("arraybuffer");

    const res = await readSlipPdf(buf, ["T-1000", "T-1001", "T-1002"]);
    ok(buf.byteLength > 0, "caller's buffer is still usable");
    eq(Object.keys(res.byOrder).sort(), ["T-1000", "T-1001"]);
    eq(res.unmatchedPages, [4]);
    eq(res.byOrder["T-1000"].items, [
      { qty: 1, name: "Dark Magician", detail: "LOB - Near Mint", price: 4.99 },
      { qty: 2, name: "Blue-Eyes White Dragon", detail: "SDK - Lightly Played", price: 12.5 },
    ]);
    eq(res.byOrder["T-1001"].items.map((i) => [i.qty, i.name, i.price]), [[3, "Pot of Greed", 1.25], [1, "Raigeki", 8], [1, "Mirror Force", 20]]);
    eq(res.byOrder["T-1000"].pageImages.length, 1);
    eq(res.byOrder["T-1001"].pageImages.length, 2, "a slip that runs over two pages keeps both");
    const img = res.byOrder["T-1000"].pageImages[0];
    ok(/^data:image\/(jpeg|png);base64,/.test(img), "data URL");
    const el = new Image();
    await new Promise((r, j) => { el.onload = r; el.onerror = j; el.src = img; });
    near(el.width, 8.5 * 150, 3, "~150 dpi width");

    // Into the orders and back out as "Slips in label order".
    const list = [makeOrder(1), makeOrder(0), makeOrder(2)];
    attachSlips(list, res.byOrder);
    eq(list[1].items.length, 2);
    eq(list[0].items.length, 3);
    eq(list[2].items, [], "no slip: untouched");
    const sp = slipPagesFor(list, res.byOrder);
    eq(sp.map((p) => p.orderId), ["T-1001", "T-1001", "T-1000"]);
    const out = await readBack(slipsInLabelOrderPdf(list, sp, "letter1"));
    eq(out.pages.length, 3);
    const withItems = await readBack(renderPdf([list[1]], { format: "letter1", slips: true }));
    ok(withItems.text.includes("Blue-Eyes White Dragon") && withItems.text.includes("$12.50"), "attached items print on the drawn slip");
  },

  "readSlipPdf: without order ids, pages are keyed by the printed order number": async () => {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "in", format: "letter" });
    doc.text("Order #: ABC123-4567", 0.5, 1); doc.text("1  Sol Ring - C21 - Near Mint  $1.99", 0.5, 2);
    doc.addPage("letter");
    doc.text("Nothing useful here", 0.5, 1);
    const res = await readSlipPdf(doc.output("arraybuffer"));
    eq(Object.keys(res.byOrder), ["ABC123-4567"]);
    eq(res.byOrder["ABC123-4567"].items[0].name, "Sol Ring");
    eq(res.byOrder["ABC123-4567"].pageImages.length, 2, "page 2 continues the slip");
  },
});

export { tests };
