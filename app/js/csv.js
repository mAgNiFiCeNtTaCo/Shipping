// CSV reading and writing, and turning a TCGplayer "Export Shipping" file into Order objects.
// Plain ES module, no dependencies. See CONTRACT.md "csv.js" and "The Order object".

// Parse CSV text into records, keeping the 1-based line each record starts on.
// RFC 4180: quoted fields, "" escapes, commas/newlines inside quotes, CRLF/LF/CR line ends.
function parseRecords(text) {
  text = String(text ?? "");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const records = [];
  let cells = [], cell = "", quoted = false, line = 1, start = 1, i = 0;
  const endCell = () => { cells.push(cell); cell = ""; };
  const endRecord = () => { endCell(); records.push({ cells, line: start }); cells = []; };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      if (c === "\r" || c === "\n") {
        line++;
        if (c === "\r" && text[i + 1] === "\n") { cell += "\r\n"; i += 2; continue; }
      }
      cell += c; i++; continue;
    }
    if (c === '"' && cell === "") { quoted = true; i++; continue; }
    if (c === ",") { endCell(); i++; continue; }
    if (c === "\r" || c === "\n") {
      endRecord();
      i += c === "\r" && text[i + 1] === "\n" ? 2 : 1;
      line++; start = line;
      continue;
    }
    cell += c; i++;
  }
  if (cell !== "" || cells.length || quoted) endRecord();
  return records.filter((r) => r.cells.some((v) => v.trim() !== ""));
}

/** parseCsv(text) -> string[][]: rows of cells, BOM stripped, fully blank rows dropped. */
export function parseCsv(text) {
  return parseRecords(text).map((r) => r.cells);
}

/** toCsv(rows) -> CSV text with CRLF line ends; cells quoted only when needed. */
export function toCsv(rows) {
  const cell = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

// Canonical Order field -> accepted header spellings (first is TCGplayer's own).
export const HEADER_ALIASES = {
  id: ["Order #", "Order Number", "Order No", "Order ID", "Order", "Order Num", "Sales Record Number"],
  firstName: ["FirstName", "First Name", "Buyer First Name", "Ship To First Name", "Recipient First Name",
    "Shipping First Name", "Given Name"],
  lastName: ["LastName", "Last Name", "Buyer Last Name", "Ship To Last Name", "Recipient Last Name",
    "Shipping Last Name", "Surname", "Family Name"],
  name: ["Buyer Name", "Full Name", "Name", "Ship To Name", "Recipient", "Recipient Name", "Customer Name",
    "Shipping Name", "Buyer"],
  address1: ["Address1", "Address 1", "Ship To Address 1", "Ship To Address1", "Address Line 1",
    "Shipping Address 1", "Shipping Address Line 1", "Street Address", "Street", "Address"],
  address2: ["Address2", "Address 2", "Ship To Address 2", "Ship To Address2", "Address Line 2",
    "Shipping Address 2", "Shipping Address Line 2", "Apt", "Suite", "Apt/Suite"],
  city: ["City", "Ship To City", "Shipping City", "Town", "City/Town"],
  state: ["State", "Ship To State", "Shipping State", "Province", "State/Province", "Region", "State Code"],
  zip: ["PostalCode", "Postal Code", "Zip", "Zip Code", "Zipcode", "Ship To Zip", "Ship To Zip Code",
    "Ship To Postal Code", "Shipping Zip", "Shipping Postal Code", "Postcode", "Post Code", "ZIP+4"],
  country: ["Country", "Ship To Country", "Shipping Country", "Country Code"],
  orderDate: ["Order Date", "Date", "Sale Date", "Order Created", "Created", "Purchase Date"],
  weightOz: ["Product Weight", "Weight", "Weight (oz)", "Weight Oz", "Ounces", "Total Weight"],
  shippingMethod: ["Shipping Method", "Shipping Service", "Ship Method", "Shipping Type", "Service",
    "Shipping Option"],
  itemCount: ["Item Count", "Items", "Quantity", "Qty", "Number Of Items", "Card Count"],
  value: ["Value Of Products", "Product Value", "Order Value", "Products Value", "Subtotal", "Item Total",
    "Items Total", "Order Total", "Value", "Total"],
  shippingPaid: ["Shipping Fee Paid", "Shipping Paid", "Shipping Fee", "Shipping Cost", "Shipping Charged",
    "Postage Paid", "Shipping"],
  tracking: ["Tracking #", "Tracking Number", "Tracking", "Tracking No", "Tracking ID", "Tracking Code"],
  carrier: ["Carrier", "Shipping Carrier", "Shipping Company"],
};

// Readable names for required fields, used in `missing` and error messages.
const FIELD_LABELS = {
  id: "Order #", firstName: "First Name", lastName: "Last Name", name: "Name", address1: "Address 1",
  city: "City", state: "State", zip: "Postal Code",
};

/** Header matching key: case, spaces, _ - . and other punctuation ignored; "#", "number", "no" equal. */
export function normalizeHeader(h) {
  return String(h ?? "").toLowerCase().replace(/#/g, "number").replace(/[^a-z0-9]/g, "").replace(/number/g, "no");
}

/** Map each canonical key to a column index (or -1). Earlier aliases win; a column is used once. */
export function matchHeaders(headers) {
  const norm = headers.map(normalizeHeader);
  const used = new Set();
  const cols = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    cols[key] = -1;
    for (const alias of aliases) {
      const a = normalizeHeader(alias);
      const idx = norm.findIndex((n, i) => n === a && !used.has(i));
      if (idx >= 0) { cols[key] = idx; used.add(idx); break; }
    }
  }
  return cols;
}

const US = /^(|us|usa|u\.s\.a?\.?|united states( of america)?)$/i;

/** ZIP as text: a US ZIP that lost its leading zero(s) gets them back; 9 digits become ZIP+4. */
export function normalizeZip(zip, country = "") {
  let z = String(zip ?? "").trim();
  if (!US.test(String(country ?? "").trim())) return z;
  const plus4 = z.match(/^(\d{3,5})\s*-\s*(\d{4})$/);
  if (plus4) return plus4[1].padStart(5, "0") + "-" + plus4[2];
  if (/^\d{3,4}$/.test(z)) return z.padStart(5, "0");
  if (/^\d{8,9}$/.test(z)) { z = z.padStart(9, "0"); return z.slice(0, 5) + "-" + z.slice(5); }
  return z;
}

/** Number from a cell like "$1,234.50" or "0.12 oz"; null when there is no number. */
export function parseNumber(s) {
  const m = String(s ?? "").replace(/[$,\s]/g, "").match(/-?\d*\.?\d+/);
  return m ? parseFloat(m[0]) : null;
}

/** Split "Ash B. Example" into first ("Ash B.") and last ("Example"). */
export function splitName(full) {
  const parts = String(full ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { firstName: parts[0] || "", lastName: "" };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * parseOrders(text) -> { orders, skipped: [{line, reason}], headers, missing, errors }
 * Reads a TCGplayer shipping export (or a similar CSV) into Order objects.
 */
export function parseOrders(text) {
  const records = parseRecords(text);
  const result = { orders: [], skipped: [], headers: [], missing: [], errors: [] };
  if (!records.length) {
    result.missing = ["id", "firstName", "lastName", "address1", "city", "state", "zip"].map((k) => FIELD_LABELS[k]);
    result.errors.push("The file is empty: there is no header row and no orders.");
    return result;
  }
  const headers = records[0].cells.map((h) => h.trim());
  result.headers = headers;
  const cols = matchHeaders(headers);

  const missing = [];
  if (cols.id < 0) missing.push("id");
  if (cols.name < 0 && cols.firstName < 0 && cols.lastName < 0) missing.push("firstName", "lastName");
  for (const k of ["address1", "city", "state", "zip"]) if (cols[k] < 0) missing.push(k);
  result.missing = missing.map((k) => FIELD_LABELS[k]);
  if (missing.length) {
    const found = headers.filter(Boolean);
    result.errors.push(
      `This file is missing ${missing.length === 1 ? "a column" : "columns"} it needs: ${result.missing.join(", ")}. ` +
      `Columns found in the file: ${found.length ? found.join(", ") : "(none)"}.`,
    );
    return result;
  }

  const seen = new Map();
  for (const rec of records.slice(1)) {
    const get = (k) => (cols[k] >= 0 ? clean(rec.cells[cols[k]]) : "");
    const row = {};
    headers.forEach((h, i) => { if (!(h in row)) row[h] = rec.cells[i] ?? ""; });

    let firstName = get("firstName"), lastName = get("lastName");
    if (!firstName && !lastName) ({ firstName, lastName } = splitName(get("name")));
    const name = clean(`${firstName} ${lastName}`);
    const country = get("country") || "US";
    const weight = parseNumber(get("weightOz"));
    const count = parseInt(String(get("itemCount")).replace(/[^\d]/g, ""), 10);
    const order = {
      id: get("id"), firstName, lastName, name,
      address1: get("address1"), address2: get("address2"),
      city: get("city"), state: get("state"), zip: normalizeZip(get("zip"), country), country,
      orderDate: get("orderDate"),
      weightOz: weight,
      shippingMethod: get("shippingMethod"),
      itemCount: count > 0 ? count : 1,
      value: parseNumber(get("value")) ?? 0,
      shippingPaid: parseNumber(get("shippingPaid")) ?? 0,
      tracking: get("tracking"), carrier: get("carrier"),
      items: [], row, line: rec.line,
    };
    if (/^[a-z]{2}$/i.test(order.state)) order.state = order.state.toUpperCase();

    const lacking = [["id", order.id], ["name", order.name], ["address1", order.address1], ["city", order.city],
      ["state", order.state], ["zip", order.zip]].filter(([, v]) => !v).map(([k]) => FIELD_LABELS[k]);
    if (lacking.length) {
      result.skipped.push({ line: rec.line, reason: `Missing ${lacking.join(", ")}${order.id ? ` (order ${order.id})` : ""}` });
      continue;
    }
    if (seen.has(order.id)) {
      result.skipped.push({ line: rec.line, reason: `Duplicate order # ${order.id} (already on line ${seen.get(order.id)})` });
      continue;
    }
    seen.set(order.id, rec.line);
    result.orders.push(order);
  }
  return result;
}
