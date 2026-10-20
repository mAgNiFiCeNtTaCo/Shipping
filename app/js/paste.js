// Addresses pasted from eBay, Whatnot, PayPal, an email or a spreadsheet -> Order objects.
// See CONTRACT.md "paste.js".
import { normalizeZip, splitName } from "./csv.js";

const STATES = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI",
  idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA",
  washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "puerto rico": "PR",
};
const STATE_NAMES = Object.keys(STATES).sort((a, b) => b.length - a.length).join("|");
const ZIP = String.raw`(\d{5}(?:\s*-\s*\d{4})?|\d{9}|\d{4}|[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d)`;
const STATE = String.raw`([A-Za-z]{2}|${STATE_NAMES})`;
// "City, ST 12345" / "City ST 12345-6789" / "City, Illinois 62701"
const CITY_LINE = new RegExp(String.raw`^(.+?)[,\s]+${STATE}\.?[,\s]+${ZIP}$`, "i");
const STATE_ZIP = new RegExp(String.raw`^${STATE}\.?[,\s]+${ZIP}$`, "i");
const ZIP_ONLY = new RegExp(String.raw`^${ZIP}$`);
const STATE_ONLY = new RegExp(String.raw`^${STATE}$`, "i");

const COUNTRY_US = /^(us|usa|u\.s\.a?\.?|united states( of america)?)$/i;
const HEADER = /^(ship(ping)?\s+(to|address)|deliver(y)?\s+(to|address)|recipient|mail\s+to|sold\s+to|buyer)\b\s*:?\s*/i;
const LABEL = /^(name|full name|address( line)?\s*\d?|street|city|recipient)\s*:\s*/i;
const EMAIL = /^(e-?mail\s*:?\s*)?\S+@\S+\.\S+$/i;

function isPhone(line) {
  const s = line.replace(/^(phone|tel|telephone|ph|mobile|cell)\.?\s*(number|no\.?|#)?\s*:?\s*/i, "");
  if (!/^[+()\d\s.\-]+$/.test(s)) return false;
  const digits = s.replace(/\D/g, "").length;
  return digits >= 10 && digits <= 15;
}

// Strip noise: phone, email, "Ship to:" headers (keeping any name after them), labels, US country lines.
function cleanLines(lines) {
  const out = [];
  for (let line of lines) {
    line = line.replace(/[  ]+/g, " ").trim();
    if (!line || isPhone(line) || EMAIL.test(line) || COUNTRY_US.test(line)) continue;
    line = line.replace(HEADER, "").replace(LABEL, "").trim();
    if (!line || COUNTRY_US.test(line)) continue;
    out.push(line);
  }
  return out;
}

const stateCode = (s) => {
  const t = s.replace(/\.$/, "").trim();
  return STATES[t.toLowerCase()] || t.toUpperCase();
};

function makeOrder(n, name, streets, city, state, zip, country, line) {
  const { firstName, lastName } = splitName(name);
  const st = stateCode(state);
  const ctry = country || (/^[A-Za-z]\d[A-Za-z]/.test(zip) ? "CA" : "US");
  return {
    id: "P-" + String(n).padStart(3, "0"),
    firstName, lastName, name: [firstName, lastName].filter(Boolean).join(" "),
    address1: streets[0] || "", address2: streets.slice(1).join(", "),
    city: city.replace(/,$/, "").trim(), state: st,
    zip: normalizeZip(zip.toUpperCase().replace(/\s*-\s*/, "-"), ctry === "CA" ? "CA" : ""), country: ctry,
    orderDate: "", weightOz: null, shippingMethod: "", itemCount: 1, value: 0, shippingPaid: 0,
    tracking: "", carrier: "", items: [], row: {}, line,
  };
}

// One address as lines: name / street / [street 2] / city, ST zip [/ country].
function parseBlock(lines) {
  let i = lines.length - 1, cityIdx = -1, m = null;
  for (; i >= 0; i--) { m = lines[i].match(CITY_LINE); if (m) { cityIdx = i; break; } }
  if (cityIdx < 0) return { reason: "Couldn't find a city, state and ZIP line" };
  const tail = lines.slice(cityIdx + 1);
  const head = lines.slice(0, cityIdx);
  if (head.length < 2) return { reason: head.length ? "Missing the street address" : "Missing the name and street address" };
  return { name: head[0], streets: head.slice(1), city: m[1], state: m[2], zip: m[3], country: tail[0] || "" };
}

// One address on one line: "Name, Street, [Street 2], City, ST ZIP" (or tab-separated cells).
function parseLine(line) {
  const parts = line.split(line.includes("\t") ? "\t" : ",").map((p) => p.trim()).filter(Boolean)
    .filter((p) => !COUNTRY_US.test(p) && !isPhone(p) && !EMAIL.test(p));
  let city, state, zip, rest, m;
  const last = parts[parts.length - 1] || "";
  if ((m = last.match(STATE_ZIP)) && parts.length >= 4) {
    [, state, zip] = m; city = parts[parts.length - 2]; rest = parts.slice(0, -2);
  } else if (ZIP_ONLY.test(last) && parts.length >= 5 && STATE_ONLY.test(parts[parts.length - 2])) {
    zip = last; state = parts[parts.length - 2]; city = parts[parts.length - 3]; rest = parts.slice(0, -3);
  } else if ((m = last.match(CITY_LINE)) && parts.length >= 3) {
    [, city, state, zip] = m; rest = parts.slice(0, -1);
  } else {
    return { reason: "Couldn't find the state and ZIP at the end of the line" };
  }
  if (rest.length < 2) return { reason: "Missing the name or street address" };
  return { name: rest[0], streets: rest.slice(1), city, state, zip, country: "" };
}

const looksLikeHeaderRow = (line) => /name/i.test(line) && /(zip|postal)/i.test(line) && !/\d{3}/.test(line);

/** parseAddresses(text) -> { orders: Order[], problems: [{text, reason}] } */
export function parseAddresses(text) {
  const raw = String(text ?? "").replace(/^﻿/, "").split(/\r\n|\r|\n/);
  // Group lines into blocks separated by blank lines, remembering each block's first line number.
  const groups = [];
  let cur = null;
  raw.forEach((l, i) => {
    if (l.trim() === "") { cur = null; return; }
    if (!cur) { cur = { start: i + 1, lines: [] }; groups.push(cur); }
    cur.lines.push(l);
  });

  const orders = [], problems = [];
  const add = (parsed, src, line) => {
    if (parsed.reason) problems.push({ text: src, reason: parsed.reason });
    else orders.push(makeOrder(orders.length + 1, parsed.name, parsed.streets, parsed.city, parsed.state, parsed.zip, parsed.country, line));
  };

  // No blank lines and every line holds 3+ comma/tab separated parts: one address per line.
  const isRow = (l) => l.split(/\t|,/).filter((p) => p.trim()).length >= 3;
  const content = groups.length === 1 ? cleanLines(groups[0].lines).filter((l) => !looksLikeHeaderRow(l)) : [];
  const onePerLine = content.length > 0 && content.every(isRow);

  if (onePerLine) {
    groups[0].lines.forEach((l, i) => {
      const [line] = cleanLines([l]);
      if (!line || looksLikeHeaderRow(line)) return;
      add(parseLine(line), line, groups[0].start + i);
    });
  } else {
    for (const g of groups) {
      const lines = cleanLines(g.lines);
      if (!lines.length || (lines.length === 1 && looksLikeHeaderRow(lines[0]))) continue;
      const src = g.lines.map((l) => l.trim()).join("\n");
      add(lines.length === 1 && isRow(lines[0]) ? parseLine(lines[0]) : parseBlock(lines), src, g.start);
    }
  }
  return { orders, problems };
}
