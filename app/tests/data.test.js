// Data station tests: csv.js, plan.js, tracking.js, paste.js and the sample CSV.
import { ok, eq, near } from "./runner.js";
import { parseCsv, HEADER_ALIASES, parseOrders, toCsv, normalizeZip } from "../js/csv.js";
import { planOrder, DEFAULT_PLAN_SETTINGS, FILTERS, filterOrders, summarize, letterPostage } from "../js/plan.js";
import { detectCarrier, matchTracking, importFileCsv, pirateShipCsv } from "../js/tracking.js";
import { parseAddresses } from "../js/paste.js";
import { readXlsx, readShipments, shipmentsFromCsv, matchShipments, nameKey, isoDate } from "../js/pirate.js";

const TCG_HEADER = "Order #,FirstName,LastName,Address1,Address2,City,State,PostalCode,Country,Order Date,Product Weight,Shipping Method,Item Count,Value Of Products,Shipping Fee Paid,Tracking #,Carrier";
const row = (id, first, last, value, more = {}) => {
  const m = { a1: "1 Main St", a2: "", city: "Springfield", st: "IL", zip: "62701", w: "0.06", ship: "Standard (7-10 days)", n: "1", track: "", car: "", ...more };
  return [id, first, last, m.a1, m.a2, m.city, m.st, m.zip, "US", "10/1/2026", m.w, m.ship, m.n, value, "0.99", m.track, m.car].join(",");
};
const csvOf = (...rows) => [TCG_HEADER, ...rows].join("\r\n") + "\r\n";
const order = (over = {}) => ({
  id: "X-1", firstName: "Ash", lastName: "Example", name: "Ash Example", address1: "1 Main St", address2: "",
  city: "Springfield", state: "IL", zip: "62701", country: "US", orderDate: "", weightOz: null,
  shippingMethod: "Standard", itemCount: 1, value: 1, shippingPaid: 0, tracking: "", carrier: "", items: [],
  row: {}, line: 2, ...over,
});
// Only the contents weigh something: makes the stamp table exact.
const BARE = { ...DEFAULT_PLAN_SETTINGS, envelopeOz: 0, slipOz: 0, toploaderOz: 0 };
const sample = async () => (await fetch("../samples/tcgplayer-sample.csv")).text();

export const tests = {
  // ---------- parseCsv ----------
  "parseCsv: plain rows": async () => {
    eq(parseCsv("a,b,c\n1,2,3"), [["a", "b", "c"], ["1", "2", "3"]]);
  },
  "parseCsv: quoted commas, newlines and doubled quotes": async () => {
    const rows = parseCsv('id,addr,note\r\n1,"10 Elm St, Apt 2","say ""hi""\nline two"\r\n2,"",x');
    eq(rows.length, 3);
    eq(rows[1], ["1", "10 Elm St, Apt 2", 'say "hi"\nline two']);
    eq(rows[2], ["2", "", "x"]);
  },
  "parseCsv: strips BOM, handles CRLF / LF / CR": async () => {
    eq(parseCsv("﻿a,b\r\n1,2\n3,4\r5,6"), [["a", "b"], ["1", "2"], ["3", "4"], ["5", "6"]]);
  },
  "parseCsv: drops blank rows (empty and all-commas) and trailing newline": async () => {
    eq(parseCsv("a,b\r\n\r\n1,2\r\n,,\r\n  ,\r\n3,4\r\n\r\n"), [["a", "b"], ["1", "2"], ["3", "4"]]);
  },
  "parseCsv: empty input, quoted field at end of file, trailing empty cell": async () => {
    eq(parseCsv(""), []);
    eq(parseCsv('a,"b'), [["a", "b"]]);
    eq(parseCsv("a,b,\n1,2,"), [["a", "b", ""], ["1", "2", ""]]);
  },

  // ---------- toCsv ----------
  "toCsv: quotes only when needed, CRLF ends": async () => {
    const out = toCsv([["a", "b,c", 'd"e', "f\ng", 5, null], ["x"]]);
    eq(out, 'a,"b,c","d""e","f\ng",5,\r\nx\r\n');
  },
  "toCsv -> parseCsv round trip": async () => {
    const rows = [["Order #", "Name"], ["1", 'O\'Brien, "Jr"'], ["2", "two\r\nlines"]];
    eq(parseCsv(toCsv(rows)), rows);
  },

  // ---------- parseOrders ----------
  "parseOrders: TCGplayer export -> Order objects": async () => {
    const r = parseOrders(csvOf(row("A-1", "Ash", "Example", "9.99", { a2: "Apt 2", w: "0.12", n: "2" })));
    eq(r.errors, []); eq(r.missing, []); eq(r.skipped, []);
    eq(r.headers, TCG_HEADER.split(","));
    eq(r.orders.length, 1);
    const o = r.orders[0];
    eq([o.id, o.firstName, o.lastName, o.name, o.address1, o.address2, o.city, o.state, o.zip, o.country],
      ["A-1", "Ash", "Example", "Ash Example", "1 Main St", "Apt 2", "Springfield", "IL", "62701", "US"]);
    eq([o.orderDate, o.weightOz, o.shippingMethod, o.itemCount, o.value, o.shippingPaid, o.tracking, o.carrier],
      ["10/1/2026", 0.12, "Standard (7-10 days)", 2, 9.99, 0.99, "", ""]);
    eq(o.items, []); eq(o.line, 2);
    eq(o.row["Order #"], "A-1"); eq(o.row["Value Of Products"], "9.99");
    eq(Object.keys(o.row), TCG_HEADER.split(","));
  },
  "parseOrders: real-shaped export (BOM, CRLF, quoted commas, blank rows)": async () => {
    const text = "﻿" + TCG_HEADER + "\r\n" +
      'B-1,"Mary Kate",O\'Neil,"12 Oak Rd, Unit 4",,Newark,NJ,7102,US,10/2/2026,0.06,Standard,1,"$1,250.00",0,,\r\n' +
      "\r\n,,,,,,,,,,,,,,,,\r\n" +
      row("B-2", "Lee", "Park", "5") + "\r\n";
    const r = parseOrders(text);
    eq(r.errors, []); eq(r.orders.length, 2);
    eq(r.orders[0].address1, "12 Oak Rd, Unit 4");
    eq(r.orders[0].zip, "07102");
    eq(r.orders[0].value, 1250);
    eq(r.orders[0].name, "Mary Kate O'Neil");
    eq(r.orders[1].line, 5);
  },
  "parseOrders: header variants (spacing, case, # vs number, full name)": async () => {
    const variants = [
      "Order Number,First Name,Last Name,Address 1,Address 2,City,State,Zip,Value",
      "order_no,buyer first name,buyer last name,ship to address 1,ship to address 2,ship to city,province,zip code,product value",
      "ORDER #,Full Name,Address Line 1,Address Line 2,City,State,Postal Code,Order Value",
      "Order No.,Name,Street Address,Apt,Town,State,Zipcode,Value Of Products",
      "Order ID,Buyer Name,Address1,Address2,City,State Code,Postcode,Subtotal",
    ];
    for (const h of variants) {
      const hasSplit = /first name/i.test(h);
      const data = hasSplit ? "7,Ash,Example,1 Main St,Apt 2,Springfield,IL,62701,25" : "7,Ash B. Example,1 Main St,Apt 2,Springfield,IL,62701,25";
      const r = parseOrders(h + "\n" + data);
      eq(r.errors, [], h);
      const o = r.orders[0];
      eq([o.id, o.lastName, o.address1, o.address2, o.city, o.state, o.zip, o.value], ["7", "Example", "1 Main St", "Apt 2", "Springfield", "IL", "62701", 25], h);
      ok(o.firstName === (hasSplit ? "Ash" : "Ash B."), h + ": first name " + o.firstName);
      eq(o.itemCount, 1, h + " default item count");
      eq(o.weightOz, null, h + " no weight column");
    }
  },
  "HEADER_ALIASES: covers TCGplayer headers and the contract's variants": async () => {
    const all = Object.values(HEADER_ALIASES).flat();
    for (const h of TCG_HEADER.split(",").concat(["First Name", "Buyer First Name", "Ship To Address 1", "Address 1", "Zip", "Zip Code", "Postal Code", "Order Number", "Buyer Name", "Full Name", "Name", "Province"])) {
      ok(all.includes(h), "alias missing: " + h);
    }
    for (const k of ["id", "firstName", "lastName", "name", "address1", "address2", "city", "state", "zip", "country", "orderDate", "weightOz", "shippingMethod", "itemCount", "value", "shippingPaid", "tracking", "carrier"]) {
      ok(Array.isArray(HEADER_ALIASES[k]), "key " + k);
    }
  },
  "parseOrders: missing columns -> no orders, error lists missing and found headers": async () => {
    const r = parseOrders("Order,Buyer,Street,Town\n1,Ash,1 Main St,Springfield");
    eq(r.orders, []);
    eq(r.missing, ["State", "Postal Code"]);
    ok(/State, Postal Code/.test(r.errors[0]), r.errors[0]);
    ok(r.errors[0].includes("Order, Buyer, Street, Town"), "found headers listed: " + r.errors[0]);
    const r2 = parseOrders("Foo,Bar\n1,2");
    eq(r2.missing, ["Order #", "First Name", "Last Name", "Address 1", "City", "State", "Postal Code"]);
    ok(r2.errors[0].includes("Foo, Bar"), r2.errors[0]);
    const r3 = parseOrders("");
    ok(r3.errors.length === 1 && r3.orders.length === 0);
  },
  "parseOrders: rows missing a required value are skipped with a reason": async () => {
    const r = parseOrders(csvOf(row("", "Ash", "Example", "1"), row("C-2", "", "", "1"), row("C-3", "Bo", "Lee", "1", { a1: "", zip: "" }), row("C-4", "Cy", "Moe", "1")));
    eq(r.orders.map((o) => o.id), ["C-4"]);
    eq(r.skipped.map((s) => s.line), [2, 3, 4]);
    ok(/Order #/.test(r.skipped[0].reason), r.skipped[0].reason);
    ok(/Name/.test(r.skipped[1].reason), r.skipped[1].reason);
    ok(/Address 1/.test(r.skipped[2].reason) && /Postal Code/.test(r.skipped[2].reason) && /C-3/.test(r.skipped[2].reason), r.skipped[2].reason);
  },
  "parseOrders: duplicate Order # keeps the first": async () => {
    const r = parseOrders(csvOf(row("D-1", "Ash", "One", "1"), row("D-2", "Bo", "Two", "1"), row("D-1", "Cy", "Three", "1")));
    eq(r.orders.map((o) => o.lastName), ["One", "Two"]);
    eq(r.skipped.length, 1); eq(r.skipped[0].line, 4);
    ok(/[Dd]uplicate/.test(r.skipped[0].reason) && /D-1/.test(r.skipped[0].reason) && /line 2/.test(r.skipped[0].reason), r.skipped[0].reason);
  },
  "parseOrders: line numbers count quoted newlines": async () => {
    const r = parseOrders(TCG_HEADER + '\nE-1,Ash,Ex,"1 Main St\nRear",,Springfield,IL,62701,US,,,,1,1,0,,\nE-2,Bo,Ex,2 Main St,,Springfield,IL,62701,US,,,,1,1,0,,');
    eq(r.orders.map((o) => o.line), [2, 4]);
  },
  "ZIP: 4-digit fix, ZIP+4 kept, 9 digits get a dash, non-US untouched": async () => {
    eq(normalizeZip("2134"), "02134");
    eq(normalizeZip("02134"), "02134");
    eq(normalizeZip("501"), "00501");
    eq(normalizeZip("12345-6789"), "12345-6789");
    eq(normalizeZip("2134-0001"), "02134-0001");
    eq(normalizeZip("123456789"), "12345-6789");
    eq(normalizeZip(" 62701 ", "USA"), "62701");
    eq(normalizeZip("1234", "CA"), "1234");
    const r = parseOrders(csvOf(row("Z-1", "A", "B", "1", { zip: "7302" }), row("Z-2", "A", "B", "1", { zip: "60611-1234" })));
    eq(r.orders.map((o) => o.zip), ["07302", "60611-1234"]);
  },
  "parseOrders: messy numbers, item count default, lower-case state": async () => {
    const r = parseOrders(csvOf(row("N-1", "A", "B", "\"$1,020.50\"", { w: "", n: "", st: "il" }), row("N-2", "A", "B", "", { w: "0.5 oz", n: "0" })));
    eq(r.orders[0].value, 1020.5); eq(r.orders[0].weightOz, null); eq(r.orders[0].itemCount, 1); eq(r.orders[0].state, "IL");
    eq(r.orders[1].value, 0); eq(r.orders[1].weightOz, 0.5); eq(r.orders[1].itemCount, 1);
  },

  // ---------- plan ----------
  "plan: value thresholds 19.99/20, 49.98/49.99, 249.99/250": async () => {
    const tag = (v, m = "Standard (7-10 days)") => planOrder(order({ value: v, shippingMethod: m })).tag;
    eq(tag(0), "envelope"); eq(tag(19.99), "envelope"); eq(tag(20), "tracking-recommended");
    eq(tag(49.98), "tracking-recommended"); eq(tag(49.99), "tracking-required");
    eq(tag(249.99), "tracking-required"); eq(tag(250), "signature"); eq(tag(1000), "signature");
    eq(tag(19.999999999), "tracking-recommended", "float error near 20");
  },
  "plan: expedited / priority / express / tracked methods under $20": async () => {
    for (const m of ["Expedited (1-5 days)", "PRIORITY", "Express Mail", "Tracked shipping"]) {
      const p = planOrder(order({ value: 3, shippingMethod: m }));
      eq(p.tag, "tracking-recommended", m); eq(p.tracked, true, m);
    }
    eq(planOrder(order({ value: 3, shippingMethod: "Standard" })).tracked, false);
    eq(planOrder(order({ value: 300, shippingMethod: "Expedited" })).tag, "signature");
  },
  "plan: labels": async () => {
    eq(planOrder(order({ value: 300 })).label, "Signature required");
    eq(planOrder(order({ value: 60 })).label, "Tracking required");
    eq(planOrder(order({ value: 25 })).label, "Tracking recommended");
    eq(planOrder(order({ value: 5 })).label, "Envelope OK");
  },
  "plan: stamp table 1 / 1.01 / 2 / 3 / 3.5 / 3.51 oz, rigid on and off": async () => {
    const table = [[1, 0.82, 1.31], [1.01, 1.11, 1.60], [2, 1.11, 1.60], [3, 1.40, 1.89], [3.5, 1.69, 2.18]];
    for (const [oz, plain, rigid] of table) {
      const off = planOrder(order({ weightOz: oz }), { ...BARE, rigid: false });
      const on = planOrder(order({ weightOz: oz }), { ...BARE, rigid: true });
      near(off.weightOz, oz, 1e-9, "weight " + oz);
      eq(off.postage, plain, oz + " oz plain"); eq(on.postage, rigid, oz + " oz rigid");
      eq(off.letterOk, true); eq(off.note, "");
      eq(off.stamps, Math.ceil(plain / 0.82 - 1e-9), oz + " oz stamps");
      eq(on.stamps, Math.ceil(rigid / 0.82 - 1e-9), oz + " oz rigid stamps");
    }
    eq(planOrder(order({ weightOz: 1 }), { ...BARE, rigid: false }).stamps, 1);
    eq(planOrder(order({ weightOz: 1 }), { ...BARE, rigid: true }).stamps, 2);
    eq(planOrder(order({ weightOz: 3.5 }), { ...BARE, rigid: false }).stamps, 3);
    eq(planOrder(order({ weightOz: 3.5 }), { ...BARE, rigid: true }).stamps, 3);
    for (const rigid of [true, false]) {
      const heavy = planOrder(order({ weightOz: 3.51 }), { ...BARE, rigid });
      eq([heavy.letterOk, heavy.postage, heavy.stamps], [false, null, null]);
      eq(heavy.note, "Too heavy for a letter: ship as a flat or package");
    }
    eq(letterPostage(0.5, false), { letterOk: true, postage: 0.82 });
  },
  "plan: estimated weight formula (weight given, weight missing, slips off, toploaders)": async () => {
    const p = planOrder(order({ weightOz: 0.12, itemCount: 2 }));
    near(p.weightOz, 0.12 + 0.2 + 0.16 + 0.3, 1e-9); eq(p.postage, 1.31); eq(p.stamps, 2);
    const q = planOrder(order({ weightOz: null, itemCount: 9 }), { slips: false });
    near(q.weightOz, 0.06 * 9 + 0.2 + 0.3 * 3, 1e-9);
    const r = planOrder(order({ weightOz: null, itemCount: 4 }), { cardsPerToploader: 4 });
    near(r.weightOz, 0.24 + 0.2 + 0.16 + 0.3, 1e-9);
    const s = planOrder(order({ weightOz: null, itemCount: 5 }));
    near(s.weightOz, 0.30 + 0.2 + 0.16 + 0.6, 1e-9);
    const t = planOrder(order({ weightOz: 0.06 }), { foreverValue: 0.5, rigid: false });
    eq(t.postage, 0.82); eq(t.stamps, 2);
  },
  "plan: defaults": async () => {
    eq(DEFAULT_PLAN_SETTINGS, { cardOz: 0.06, envelopeOz: 0.2, slipOz: 0.16, toploaderOz: 0.3, cardsPerToploader: 4, rigid: true, slips: true, foreverValue: 0.82 });
  },
  "FILTERS + filterOrders keep file order": async () => {
    eq(FILTERS.map((f) => f.id), ["all", "envelope", "tracked", "unshipped"]);
    ok(FILTERS.every((f) => f.label), "labels");
    eq(FILTERS[1].label, "Envelopes only (under $20)");
    const os = [order({ id: "1", value: 5 }), order({ id: "2", value: 30 }), order({ id: "3", value: 2, shippingMethod: "Expedited" }),
      order({ id: "4", value: 300, tracking: "9400111111111111111111" }), order({ id: "5", value: 1 }), order({ id: "6", value: 60 })];
    const ids = (f, st) => filterOrders(os, f, st).map((o) => o.id);
    eq(ids("all"), ["1", "2", "3", "4", "5", "6"]);
    eq(ids("envelope"), ["1", "5"]);
    eq(ids("tracked"), ["2", "3", "4", "6"]);
    eq(ids("unshipped", {}), ["1", "2", "3", "5", "6"]);
    eq(ids("unshipped", { 1: { shipped: true }, 2: { tracking: "9400", shipped: false }, 5: { shipped: false } }), ["3", "5", "6"]);
    ok(filterOrders(os, "all") !== os, "returns a new array");
    // order.plan is used when present
    eq(filterOrders([order({ id: "p", value: 5, plan: { tag: "signature", tracked: true } })], "tracked").length, 1);
  },
  "summarize: counts, totals, stamps": async () => {
    const os = [order({ value: 5, weightOz: 0.06 }), order({ value: 25.5, weightOz: 0.06 }), order({ value: 300, weightOz: 10 }), order({ value: 60, weightOz: 0.06 })];
    const s = summarize(os, DEFAULT_PLAN_SETTINGS);
    eq(s.count, 4);
    eq(s.byTag, { signature: 1, "tracking-required": 1, "tracking-recommended": 1, envelope: 1 });
    near(s.totalValue, 390.5, 1e-9);
    near(s.totalPostage, 1.31 * 3, 1e-9);
    eq(s.totalStamps, 6);
    eq(summarize([], undefined), { count: 0, byTag: { signature: 0, "tracking-required": 0, "tracking-recommended": 0, envelope: 0 }, totalValue: 0, totalPostage: 0, totalStamps: 0 });
  },

  // ---------- sample ----------
  "sample CSV: exact header, ~10 orders, every plan tag and edge case": async () => {
    const text = await sample();
    eq(parseCsv(text)[0].join(","), TCG_HEADER);
    const r = parseOrders(text);
    eq(r.errors, []); eq(r.skipped, []);
    ok(r.orders.length >= 8 && r.orders.length <= 12, "count " + r.orders.length);
    const plans = r.orders.map((o) => planOrder(o));
    const tags = plans.map((p) => p.tag);
    ok(tags.filter((t) => t === "envelope").length >= 3, "several envelopes");
    for (const t of ["signature", "tracking-required", "tracking-recommended"]) ok(tags.includes(t), "tag " + t);
    ok(r.orders.some((o) => o.value >= 20 && o.value < 49.99), "$20-49");
    ok(r.orders.some((o) => o.value < 20 && /expedited/i.test(o.shippingMethod)), "expedited under $20");
    ok(r.orders.some((o) => o.address2 && /apt|suite|unit/i.test(o.address2)), "apt/suite");
    ok(r.orders.some((o) => o.zip.startsWith("0")), "leading-zero ZIP");
    ok(r.orders.some((o) => o.name.includes("'")), "apostrophe");
    ok(r.orders.every((o) => /^\d{5}(-\d{4})?$/.test(o.zip)), "all ZIPs 5 digits");
  },

  // ---------- tracking ----------
  "detectCarrier": async () => {
    eq(detectCarrier("1Z999AA10123456784"), "UPS");
    eq(detectCarrier("1z 999 aa1 0123 4567 84"), "UPS");
    eq(detectCarrier("9400 1000 0000 0000 0000 00"), "USPS");
    eq(detectCarrier("94001000000000000000"), "USPS");
    eq(detectCarrier("9205590164917312751089"), "USPS");
    eq(detectCarrier("420627019400100000000000000000"), "USPS");
    eq(detectCarrier("42062701123494001000000000000000"), "USPS");
    eq(detectCarrier("EA123456789US"), "USPS");
    eq(detectCarrier("1234-5678-9012"), "FedEx");
    eq(detectCarrier("123456789012345"), "FedEx");
    eq(detectCarrier("1234567890"), "DHL");
    eq(detectCarrier("hello"), ""); eq(detectCarrier(""), ""); eq(detectCarrier("12345"), "");
  },
  "matchTracking: bare numbers go to orders in label order": async () => {
    const os = [order({ id: "A" }), order({ id: "B" }), order({ id: "C" })];
    const r = matchTracking("9400100000000000000001\n\n 1Z999AA10123456784 \n", os);
    eq(r.matches, [{ orderId: "A", tracking: "9400100000000000000001", carrier: "USPS" }, { orderId: "B", tracking: "1Z999AA10123456784", carrier: "UPS" }]);
    eq(r.unmatched, []);
    ok(r.warnings.some((w) => /got none/.test(w)), "fewer numbers warned: " + r.warnings);
  },
  "matchTracking: order# + tracking (space, tab, comma, semicolon), mixed with bare": async () => {
    const os = [order({ id: "SAMPLE-0001" }), order({ id: "SAMPLE-0002" }), order({ id: "SAMPLE-0003" }), order({ id: "SAMPLE-0004" }), order({ id: "SAMPLE-0005" })];
    const r = matchTracking([
      "SAMPLE-0003 9400100000000000000003",
      "sample-0001\t9400 1000 0000 0000 0000 01",
      "9400100000000000000099",
      "SAMPLE-0005, 9400100000000000000005",
      "SAMPLE-0004;9400100000000000000004",
    ].join("\r\n"), os);
    eq(r.matches.map((m) => [m.orderId, m.tracking]), [
      ["SAMPLE-0001", "9400100000000000000001"], ["SAMPLE-0002", "9400100000000000000099"],
      ["SAMPLE-0003", "9400100000000000000003"], ["SAMPLE-0004", "9400100000000000000004"],
      ["SAMPLE-0005", "9400100000000000000005"]]);
    eq(r.unmatched, []); eq(r.warnings, []);
  },
  "matchTracking: warns on duplicates, extra numbers and junk": async () => {
    const os = [order({ id: "A" }), order({ id: "B" })];
    const r = matchTracking("9400100000000000000001\n9400100000000000000001\nA 9400100000000000000002\nA 9400100000000000000003\n9400100000000000000004\n9400100000000000000005\nhello there\nB", os);
    eq(r.matches, [{ orderId: "A", tracking: "9400100000000000000002", carrier: "USPS" }, { orderId: "B", tracking: "9400100000000000000001", carrier: "USPS" }]);
    eq(r.unmatched, ["9400100000000000000001", "A 9400100000000000000003", "hello there", "B", "9400100000000000000004", "9400100000000000000005"]);
    ok(r.warnings.some((w) => /more than once/.test(w) && w.includes("9400100000000000000001")), "dup number");
    ok(r.warnings.some((w) => /Order A is pasted more than once/.test(w)), "dup order");
    ok(r.warnings.some((w) => /2 more tracking numbers than orders/.test(w)), "extra: " + r.warnings);
    ok(r.warnings.some((w) => /hello there/.test(w)), "junk");
    ok(r.warnings.some((w) => /Order B has no tracking/.test(w)), "order alone");
  },
  "matchTracking: TCGplayer-style ids that look like numbers alone are not tracking": async () => {
    const os = [order({ id: "36666676-C2E9D3-A8F21" })];
    const r = matchTracking("36666676-C2E9D3-A8F21", os);
    eq(r.matches, []); eq(r.unmatched.length, 1);
  },
  "importFileCsv: original columns in order, Shipped keyword, missingRequired": async () => {
    const r0 = parseOrders(csvOf(
      row("I-1", "Ash", "One", "5"), row("I-2", "Bo", "Two", "60"), row("I-3", "Cy", "Three", "70"),
      row("I-4", "Di", "Four", "8"), row("I-5", "Ed", "Five", "9", { track: "1Z999AA10123456784", car: "UPS" })));
    const os = r0.orders.concat(parseAddresses("Pat Paste\n1 Elm St\nAustin, TX 78701").orders);
    const st = {
      "I-1": { tracking: "9400 1000 0000 0000 0000 01", carrier: "USPS", shipped: true, at: "2026-10-20" },
      "I-2": { shipped: true, at: "2026-10-20" },
      "I-3": { tracking: "9400100000000000000003", shipped: true },
      "P-001": { shipped: true },
    };
    const out = importFileCsv(os, st);
    eq(out.count, 4);
    eq(out.missingRequired, ["I-2"]);
    const rows = parseCsv(out.csv);
    eq(rows[0], TCG_HEADER.split(","));
    const col = (name) => rows[0].indexOf(name);
    eq(rows.slice(1).map((r) => [r[0], r[col("Tracking #")], r[col("Carrier")]]), [
      ["I-1", "9400100000000000000001", "USPS"], ["I-2", "Shipped", "USPS"], ["I-3", "9400100000000000000003", "USPS"], ["I-5", "1Z999AA10123456784", "UPS"]]);
    eq(rows[1][col("Value Of Products")], "5");
    eq(rows[1][col("LastName")], "One");
    ok(out.csv.includes("\r\n"), "CRLF");
  },
  "importFileCsv: odd column order kept, missing Tracking #/Carrier appended, round trip": async () => {
    const text = 'City,Order #,Address1,Name,State,Zip,Notes\nSpringfield,K-1,1 Main St,Ash Example,IL,62701,"fragile, ""top"""\nAustin,K-2,2 Elm St,Bo Lee,TX,78701,\n';
    const r = parseOrders(text);
    eq(r.errors, []);
    const out = importFileCsv(r.orders, { "K-1": { tracking: "1Z999AA10123456784", carrier: "UPS", shipped: true }, "K-2": { shipped: false } });
    eq(out.count, 1);
    const rows = parseCsv(out.csv);
    eq(rows, [["City", "Order #", "Address1", "Name", "State", "Zip", "Notes", "Tracking #", "Carrier"],
      ["Springfield", "K-1", "1 Main St", "Ash Example", "IL", "62701", 'fragile, "top"', "1Z999AA10123456784", "UPS"]]);
    // A tracking number with no carrier known falls back to detection, then USPS.
    const out2 = importFileCsv(r.orders, { "K-2": { tracking: "XX12345678" } });
    eq(parseCsv(out2.csv)[1].slice(-2), ["XX12345678", "USPS"]);
    // Nothing shipped: header only.
    eq(importFileCsv(r.orders, {}).count, 0);
  },
  "importFileCsv: uses the file's own tracking column spelling": async () => {
    const r = parseOrders("Order Number,Name,Address 1,City,State,Zip,Tracking Number\nT-1,Ash Ex,1 Main,Springfield,IL,62701,\n");
    const rows = parseCsv(importFileCsv(r.orders, { "T-1": { tracking: "9400100000000000000001" } }).csv);
    eq(rows[0], ["Order Number", "Name", "Address 1", "City", "State", "Zip", "Tracking Number", "Carrier"]);
    eq(rows[1].slice(-2), ["9400100000000000000001", "USPS"]);
  },
  "pirateShipCsv: tracked orders without tracking, weight rounded up to 0.1": async () => {
    const os = [
      order({ id: "1", value: 5, weightOz: 0.06 }),
      order({ id: "2", name: "Bo Lee", value: 30, weightOz: 0.12, itemCount: 2, address2: "Apt 2", zip: "02134" }),
      order({ id: "3", value: 300, weightOz: 0.06, tracking: "9400100000000000000001" }),
      order({ id: "4", value: 60, weightOz: 0.7, itemCount: 1 }),
      order({ id: "5", value: 2, shippingMethod: "Expedited", weightOz: 0.06 }),
    ];
    const planned = Object.fromEntries(os.map((o) => [o.id, planOrder(o)]));
    const rows = parseCsv(pirateShipCsv(os, planned));
    eq(rows[0], ["Order ID", "Name", "Address", "Address Line 2", "City", "State", "Zipcode", "Country", "Ounces"]);
    eq(rows.slice(1).map((r) => r[0]), ["2", "4", "5"]);
    eq(rows[1], ["2", "Bo Lee", "1 Main St", "Apt 2", "Springfield", "IL", "02134", "US", "0.8"]);
    eq(rows[2][8], "1.4"); // 0.7 + 0.2 + 0.16 + 0.3 = 1.36 -> 1.4
    eq(rows[3][8], "0.8"); // 0.72 -> 0.8
    // array form and shippedState both accepted
    eq(parseCsv(pirateShipCsv(os, os.map((o) => planOrder(o)), { 2: { tracking: "9400" } })).slice(1).map((r) => r[0]), ["4", "5"]);
  },

  // ---------- paste ----------
  "parseAddresses: blocks separated by blank lines, noise ignored": async () => {
    const text = [
      "Ship to:", "Ash Example", "45 Example St", "Apt 2", "Los Angeles, CA 90012", "United States", "(213) 555-0147", "ash@example.com",
      "", "",
      "Shipping address", "Brenna O'Callahan", "1820 Larkspur Ln", "Portland OR 97214-1234", "USA",
      "",
      "Ship to: Dmitri Vale", "77 Harbor View Rd", "Boston, Massachusetts 2127", "Phone: +1 617 555 0100",
    ].join("\n");
    const r = parseAddresses(text);
    eq(r.problems, []);
    eq(r.orders.map((o) => o.id), ["P-001", "P-002", "P-003"]);
    const [a, b, c] = r.orders;
    eq([a.name, a.firstName, a.lastName, a.address1, a.address2, a.city, a.state, a.zip, a.country], ["Ash Example", "Ash", "Example", "45 Example St", "Apt 2", "Los Angeles", "CA", "90012", "US"]);
    eq([b.name, b.address1, b.address2, b.city, b.state, b.zip], ["Brenna O'Callahan", "1820 Larkspur Ln", "", "Portland", "OR", "97214-1234"]);
    eq([c.name, c.address1, c.city, c.state, c.zip], ["Dmitri Vale", "77 Harbor View Rd", "Boston", "MA", "02127"]);
    eq([a.value, a.itemCount, a.row, a.items, a.tracking, a.weightOz, a.line], [0, 1, {}, [], "", null, 1]);
    eq(b.line, 11);
  },
  "parseAddresses: one address per line (commas and tabs)": async () => {
    const r = parseAddresses("Ash Example, 45 Example St, Apt 2, Los Angeles, CA 90012\r\nBo Lee, 2 Elm St, Austin, TX, 78701, USA\nCy Moe, 9 Oak Ave, Newark, NJ 7102");
    eq(r.problems, []);
    eq(r.orders.map((o) => [o.id, o.name, o.address1, o.address2, o.city, o.state, o.zip]), [
      ["P-001", "Ash Example", "45 Example St", "Apt 2", "Los Angeles", "CA", "90012"],
      ["P-002", "Bo Lee", "2 Elm St", "", "Austin", "TX", "78701"],
      ["P-003", "Cy Moe", "9 Oak Ave", "", "Newark", "NJ", "07102"]]);
    const t = parseAddresses("Name\tStreet\tStreet 2\tCity\tState\tZip\nAsh Example\t45 Example St\t\tLos Angeles\tCA\t90012\nBo Lee\t2 Elm St\tSuite 5\tAustin\tTX\t78701-0001");
    eq(t.problems, []);
    eq(t.orders.map((o) => [o.name, o.address2, o.city, o.state, o.zip, o.line]), [["Ash Example", "", "Los Angeles", "CA", "90012", 2], ["Bo Lee", "Suite 5", "Austin", "TX", "78701-0001", 3]]);
  },
  "parseAddresses: problems reported, good ones still parsed": async () => {
    const r = parseAddresses("Ash Example\n45 Example St\nLos Angeles, CA 90012\n\nJust a name\nsomewhere\n\nBo Lee\nAustin, TX 78701\n\n555-123-4567\nfoo@bar.com");
    eq(r.orders.map((o) => o.name), ["Ash Example"]);
    eq(r.problems.length, 2);
    ok(r.problems[0].text.includes("Just a name") && /city, state and ZIP/.test(r.problems[0].reason), JSON.stringify(r.problems[0]));
    ok(r.problems[1].text.includes("Bo Lee") && /street/i.test(r.problems[1].reason), JSON.stringify(r.problems[1]));
    eq(parseAddresses(""), { orders: [], problems: [] });
  },
  "Pirate Ship: the Shipments export (.xlsx) reads like a real one": async () => {
    const rows = await readXlsx(await (await fetch("../samples/pirateship-shipments-sample.xlsx")).arrayBuffer());
    eq(rows[0].slice(0, 6), ["Created Date", "Recipient", "Email", "Tracking Number", "Cost", "Status"]);
    eq(rows[1][2], "", "an empty cell left out of the file still keeps the columns in place");
    eq(rows[1][3], "9300110000000000000005");
    eq(rows[1][4], "4.97", "number cells too");
    const r = readShipments(rows);
    eq(r.voided, 1, "the refunded label is left out");
    eq(r.shipments.length, 5);
    eq(r.shipments[0], { name: "Marcus Delgado", tracking: "9300110000000000000005", carrier: "USPS", created: "2026-10-18",
      status: "Purchased", orderId: "", zip: "" });
    eq(r.shipments[2].name, "rafael ito brandt", "trailing comma trimmed");
    let bad = null;
    try { await readXlsx(new TextEncoder().encode("not a zip").buffer); } catch (e) { bad = e; }
    ok(bad, "a file that isn't an .xlsx is refused");
  },
  "Pirate Ship: a .csv export and the helpers": async () => {
    const r = shipmentsFromCsv("Created Date,Recipient,Tracking Number,Status,Order ID,Zipcode\n2026-10-18,Ash Example,9400 1000 0000 0000 0000 01,Purchased,SAMPLE-0001,90012\n");
    eq(r.shipments[0].tracking, "9400100000000000000001");
    eq(r.shipments[0].orderId, "SAMPLE-0001");
    eq(r.shipments[0].zip, "90012");
    eq(shipmentsFromCsv("Order #,FirstName\n1,A\n"), null, "a TCGplayer file isn't a Shipments export");
    eq(nameKey("  Zo\u00eb  O'Neil-Smith "), "zoe o neil smith");
    eq(isoDate("9/4/26 3:04 PM EDT"), "2026-09-04");
    eq(isoDate("2026-10-19"), "2026-10-19");
    eq(isoDate("soon"), "");
  },
  "Pirate Ship: labels go to the one open order of that buyer, never guessed": async () => {
    const S = (name, tracking, created, extra = {}) => ({ name, tracking, carrier: "USPS", created, status: "Purchased", orderId: "", zip: "", ...extra });
    const C = (id, name, date, extra = {}) => ({ id, name, zip: "", date, tracking: "", shipped: false, ...extra });
    const m = matchShipments([
      S("Ash Example", "T1", "2026-10-18"),                    // one open order
      S("ASH  EXAMPLE", "T2", "2026-10-19"),                   // same buyer again: the first label took the order -> conflict
      S("Bo Lee", "T3", "2026-10-18"),                         // two open orders -> not guessed
      S("Cy Moe", "T4", "2026-10-18"),                         // already has this tracking
      S("Di Ray", "T5", "2026-10-18"),                         // her only order is from long ago
      S("Ed Fox", "T6", "2026-10-18", { orderId: "E-2" }),     // the Order ID column decides
      S("Fay Kim", "T7", "2026-10-18"),                        // one ticked Shipped (envelope), one open: the open one
      S("Gus Tan Moreno", "T8", "2026-10-18"),                 // first + last name when the middle name differs
      S("Hal Ng", "T9", "2026-10-18", { zip: "10001" }),       // ZIP picks between two buyers of the same name
      S("Old Timer", "T0", "2026-07-01"),                      // before every known order: summed up, not listed
    ], [
      C("A-1", "Ash Example", "2026-10-15"),
      C("B-1", "Bo Lee", "2026-10-14"), C("B-2", "Bo Lee", "2026-10-15"),
      C("C-1", "Cy Moe", "2026-10-15", { tracking: "T4" }),
      C("D-1", "Di Ray", "2026-08-01"),
      C("E-1", "Ed Fox", "2026-10-15"), C("E-2", "Ed Fox", "2026-10-16"),
      C("F-1", "Fay Kim", "2026-10-15", { shipped: true }), C("F-2", "Fay Kim", "2026-10-16"),
      C("G-1", "Gus Moreno", "2026-10-16"),
      C("H-1", "Hal Ng", "2026-10-16", { zip: "94110" }), C("H-2", "Hal Ng", "2026-10-16", { zip: "10001-2345" }),
    ]);
    eq(m.matches.map((x) => `${x.orderId} ${x.tracking}`).sort(), ["A-1 T1", "E-2 T6", "F-2 T7", "G-1 T8", "H-2 T9"]);
    eq(m.already, [{ orderId: "C-1", tracking: "T4" }]);
    eq(m.conflicts.map((x) => `${x.orderId} ${x.tracking}`), ["A-1 T2"]);
    eq(m.unmatched.map((x) => x.tracking).sort(), ["T3", "T5"]);
    ok(/2 orders/.test(m.unmatched.find((x) => x.tracking === "T3").why), "says why");
    eq(m.older, [{ name: "Old Timer", tracking: "T0" }]);
    // A label bought before the order isn't for it.
    eq(matchShipments([S("Ash Example", "T1", "2026-10-14")], [C("A-1", "Ash Example", "2026-10-15")]).matches, []);
  },
  "parseAddresses: single address with no blank lines is one block": async () => {
    const r = parseAddresses("Ash Example\n45 Example St\nLos Angeles, CA 90012");
    eq(r.orders.length, 1); eq(r.orders[0].city, "Los Angeles");
    const one = parseAddresses("Ash Example, 45 Example St, Los Angeles, CA 90012");
    eq(one.orders.length, 1); eq(one.orders[0].address1, "45 Example St");
  },
};
