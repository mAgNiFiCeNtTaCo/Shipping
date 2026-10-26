# Ship Desk: build contract

**Ship Desk** is a local app that does what tcgspeedshipper.com does, for the user's own TCGplayer shipping:
drop TCGplayer's "Export Shipping" CSV, get print-ready **address labels, packing slips and envelopes** as one
PDF, a **shipping plan** per order (envelope / tracking / signature), estimated **weight + stamps**, and a
**TCGplayer import file** that marks the batch shipped. Everything runs in the browser; order data never
leaves the PC.

It is our own app: **write original code, design and wording.** Do not fetch, copy or paraphrase
tcgspeedshipper.com's JavaScript, CSS, images or page text, and never use its name or branding in the app.
The facts below (file formats, USPS prices, TCGplayer thresholds) are the shared spec.

Not built (on purpose): accounts, plans/billing/limits, referral/promo codes, buying postage
(the site only has it as "coming soon"), Enterprise integrations. Every feature, including the site's paid
"Premium" ones, is simply on.

## Stack and layout (no build step, no Node on this PC)

- Static browser app in `app/`: `index.html` + ES modules in `app/js/` + `app/css/app.css`.
- Vendored libraries (already downloaded, loaded with classic `<script>` tags, used through `window.*`):
  `app/vendor/jspdf.umd.min.js` (jsPDF 2.5.2, `window.jspdf.jsPDF`), `app/vendor/pdf.min.js` +
  `pdf.worker.min.js` (pdf.js 3.11.174, `window.pdfjsLib`; set `GlobalWorkerOptions.workerSrc` to the worker
  path relative to the page), `app/vendor/qrcode.js` (qrcode-generator 1.4.4, `window.qrcode(typeNumber, 'M')`).
  No CDN, no other libraries: the app must work offline.
- `serve.py` serves `app/` at http://127.0.0.1:5091/ (`--port`, `--no-browser`). `Start Ship Desk.bat` (UI
  station) runs it.
- Tests: `python tools/test.py [suite ...]` runs `app/tests/<suite>.test.js` in headless Edge (see
  `app/tests/runner.js`: export `tests = { "name": async () => {...} }`, helpers `ok eq near throws`).
  Suites: `data` (Data station), `render` (PDF station), `ui` (UI station), `e2e` (QA station).

## File ownership (shared working tree: touch only your own files)

| Station | Owns |
|---|---|
| Data | `app/js/csv.js`, `app/js/plan.js`, `app/js/tracking.js`, `app/js/paste.js`, `app/samples/tcgplayer-sample.csv`, `app/tests/data.test.js` |
| PDF | `app/js/render.js`, `app/js/slips.js`, `app/tests/render.test.js` |
| UI | `app/index.html`, `app/css/app.css`, `app/js/app.js`, `app/js/store.js`, `app/sw.js`, `app/manifest.webmanifest`, `app/icon.svg`, `Start Ship Desk.bat`, `app/tests/ui.test.js` |
| QA | `app/tests/e2e.test.js`, `README.md`, `docs/`, small fixes anywhere **after** the three builders are done |

`serve.py`, `tools/test.py`, `app/tests/runner.js`, `app/tests/run.html`, `app/vendor/` belong to the
orchestrator: ask before changing them (adding a suite name to `SUITES` in runner.js is fine).
Need a change in another station's file? Don't edit it: write what you need under "Requests" at the
bottom of your `specs/<station>.md` and code against this contract.

## The Order object (every module speaks this)

```js
{
  id: "SAMPLE-0001",          // "Order #", trimmed; required
  firstName: "Ash", lastName: "Example",
  name: "Ash Example",        // first + last, collapsed spaces; required (non-empty)
  address1: "45 Example St", address2: "Apt 2",   // address1 required
  city: "Los Angeles", state: "CA", zip: "90012", country: "US",  // city/state/zip required
  orderDate: "10/1/2026",     // as in the file
  weightOz: 0.12,             // "Product Weight", ounces (TCGplayer); null if missing/blank
  shippingMethod: "Standard (7-10 days)",
  itemCount: 2,               // integer, default 1
  value: 9.99,                // "Value Of Products", dollars (strip $ and commas); 0 if missing
  shippingPaid: 0.99,
  tracking: "",               // "Tracking #" from the file ("" if blank)
  carrier: "",
  items: [],                  // filled from the packing-slip PDF: [{ qty: 1, name: "Card name", detail: "Set - Condition", price: 4.99 }]
  row: { "Order #": "SAMPLE-0001", ... },  // the original row, header -> cell, for the import file
  line: 2,                    // 1-based line in the file (header = 1)
}
```

ZIP: keep as text; a 4-digit US ZIP (Excel ate the leading zero) becomes 5 digits with a leading 0;
ZIP+4 kept as `12345-6789`.

## csv.js (Data)

- `parseCsv(text) -> string[][]`: RFC 4180 (quoted fields, `""` escapes, commas/newlines inside quotes,
  CRLF/LF/CR), strips a UTF-8 BOM, drops fully blank rows.
- `HEADER_ALIASES`: canonical key -> list of accepted headers. Matching ignores case, spaces, `_`, `-`, `.`,
  `#` vs "number"/"no". Must accept at least: TCGplayer's own export headers
  (`Order #, FirstName, LastName, Address1, Address2, City, State, PostalCode, Country, Order Date,
  Product Weight, Shipping Method, Item Count, Value Of Products, Shipping Fee Paid, Tracking #, Carrier`)
  and common variants ("First Name", "Buyer First Name", "Ship To Address 1", "Address 1", "Zip", "Zip Code",
  "Postal Code", "Order Number", "Buyer Name"/"Full Name"/"Name" (split into first/last), "Province").
- `parseOrders(text) -> { orders: Order[], skipped: [{line, reason}], headers: string[], missing: string[], errors: string[] }`.
  `missing` lists required fields with no matching column (canonical names, readable: "Order #", "First Name",
  "Address 1", ...); when anything required is missing, `orders` is `[]` and `errors[0]` says which
  columns are missing **and lists the headers that were found**. Rows missing a required value are
  skipped with a reason. Duplicate Order # rows: keep the first, skip the rest with a reason.
- `toCsv(rows: string[][]) -> string`: quotes when needed, CRLF line ends.

## plan.js (Data)

TCGplayer thresholds (order value = "Value Of Products"):

| Tag (`order.plan.tag`) | Label | Rule |
|---|---|---|
| `signature` | Signature required | value >= 250 |
| `tracking-required` | Tracking required | value >= 49.99 |
| `tracking-recommended` | Tracking recommended | value >= 20, or shipping method contains "expedited"/"priority"/"express"/"tracked" (case-insensitive) |
| `envelope` | Envelope OK | otherwise |

- `planOrder(order, settings) -> { tag, label, tracked: bool, weightOz, postage, stamps, letterOk, note }`
  - `tracked` = tag is not `envelope`.
  - Estimated packed weight (oz) = `order.weightOz` (if null: `settings.cardOz * itemCount`) +
    `settings.envelopeOz` + `settings.slipOz` (if slips are on) + `settings.toploaderOz * ceil(itemCount / settings.cardsPerToploader)`.
  - USPS stamped letter (Notice 123, effective 2026-10-04): up to 1 oz $0.82, each additional ounce or part
    +$0.29, max 3.5 oz (so 1/2/3/3.5 oz = 0.82/1.11/1.40/1.69). Nonmachinable (rigid / toploader) surcharge
    +$0.49 when `settings.rigid`. Over 3.5 oz: `letterOk=false`, postage null, note "Too heavy for a letter:
    ship as a flat or package".
  - `stamps` = forever stamps to cover it: `ceil(postage / settings.foreverValue)` (foreverValue 0.82).
- `DEFAULT_PLAN_SETTINGS = { cardOz: 0.06, envelopeOz: 0.2, slipOz: 0.16, toploaderOz: 0.3, cardsPerToploader: 4, rigid: true, slips: true, foreverValue: 0.82 }`
- `FILTERS`: `all` "All orders", `envelope` "Envelopes only (under $20)" (tag envelope), `tracked`
  "Tracked only ($20+ / expedited)" (tracked true), `unshipped` "Not yet marked shipped" (no tracking and
  not marked shipped). `filterOrders(orders, filterId, shippedState) -> Order[]` keeps file order.
- `summarize(orders, settings) -> { count, byTag: {tag: n}, totalValue, totalPostage, totalStamps }`.

## tracking.js (Data)

`shippedState` = `{ [orderId]: { tracking: "9400...", carrier: "USPS", shipped: true, at: "2026-10-20" } }`
(the UI keeps it in localStorage so a re-uploaded file remembers what already shipped).

- `detectCarrier(trackingNo) -> "USPS" | "UPS" | "FedEx" | "DHL" | ""`: UPS `1Z` + 16; USPS 20-22 digits
  starting 9 / 420+ZIP prefix / 2 letters + 9 digits + "US"; FedEx 12 or 15 digits; DHL 10 digits.
  Spaces/dashes ignored.
- `matchTracking(pasted, orders) -> { matches: [{orderId, tracking, carrier}], unmatched: [lines], warnings: [] }`:
  each non-blank line is either `<tracking>` alone (assigned in the given label order, one per order) or
  `<order#> <tracking>` (separated by spaces, tab, comma or semicolon). A line whose first token is a known
  order # is the second form. Mixing is fine. Warn on duplicates and on more numbers than orders.
- `importFileCsv(orders, shippedState) -> { csv, count, missingRequired: [orderId] }`: TCGplayer's
  **Orders -> Import Shipping Info** file: the original export columns, in the original header order
  (`order.row`), one row per order that has tracking or is marked shipped. `Tracking #` = the tracking number;
  for an order marked shipped without tracking, `Tracking #` = `Shipped`. `Carrier` = the carrier ("USPS"
  by default; also "USPS" for `Shipped` rows, since TCGplayer refuses an empty carrier: "Carrier is unrecognized",
  real upload 2026-10-25). If the source file had no `Tracking #`/`Carrier` column,
  append them. `missingRequired` = orders with value >= 49.99 marked shipped without tracking (TCGplayer
  rejects those).
- `pirateShipCsv(orders, planned) -> csv`: tracked orders without tracking yet, headers
  `Order ID,Name,Address,Address Line 2,City,State,Zipcode,Country,Ounces` (Ounces = estimated packed weight,
  rounded up to 0.1).

## paste.js (Data)

- `parseAddresses(text) -> { orders: Order[], problems: [{text, reason}] }`: addresses pasted from eBay,
  Whatnot, PayPal, email or a spreadsheet. Blocks separated by blank lines are one address each
  (name / street / [street 2] / city, ST zip [/ country]); if there are no blank lines and lines contain
  commas or tabs, each line is one address (`Name, Street, [Street 2], City, ST ZIP`). Ignore lines that are
  phone numbers, emails, `Ship to:`/`Shipping address` headers, and "United States"/"USA". Each becomes an
  Order with `id` `P-001`, `P-002`, ..., value 0, itemCount 1, `row` {} (pasted orders never go into the
  TCGplayer import file).

## render.js (PDF)

`renderPdf(orders, opts) -> jsPDF doc` (caller saves with `doc.save(name)` / `doc.output('blob')`), and
`FORMATS` (id, label, page size, labels per page) for the UI's picker. All layout in inches.

`opts`:
```js
{
  format: "thermal4x6" | "letter1" | "letter2" | "letter3" | "letter4" | "labelSlip" | "avery5160" | "envelope10",
  slips: true,              // also print packing slips (separate pages; for labelSlip they share the page)
  returnAddress: { name, phone, street, street2, city, state, zip },  // phone optional
  boldReturn: false,        // bold return address (darker on thermal)
  noDivider: false,         // omit the divider line (leaves room for a postage meter / stamps)
  design: { accent: "#1f6feb", font: "helvetica" | "times" | "courier", logo: dataUrl|null,
            darkness: 0..3 (thermal: extra stroke on text), note: "<=60 chars", qrUrl: "", slipMessage: "" },
  slipPages: null | [{ orderId, pageImage: dataUrl }],  // "Slips in label order": the user's own TCGplayer slips
  plan: { [orderId]: planOrder result },                 // shows tag + stamps on slips
}
```
Formats:
- `thermal4x6`: 4x6 portrait page per label (Rollo/MUNBYN/Dymo). Return address top-left, divider,
  big ship-to block centred, order # small at the bottom, optional logo/QR/note. Slips (if on) are 4x6 pages
  after all labels.
- `letter1..4`: 8.5x11 with 1, 2, 3 or 4 labels per page (1 = full sheet, 2 = halves, 3 = thirds, 4 =
  quarters), dashed cut lines between labels. Slips on their own letter pages after the labels.
- `labelSlip`: one 8.5x11 page per order, label on the top half, packing slip on the bottom half,
  dashed fold/cut line.
- `avery5160`: 30 per sheet (3 x 10), label 2.625" x 1", top margin 0.5", left 0.1875", column pitch 2.75",
  row pitch 1"; ship-to only, text shrinks to fit. Slips on letter pages after.
- `envelope10`: #10 envelope page (9.5" x 4.125", landscape): return address top-left, ship-to centred
  right of middle; the top-right stamp corner (about 1.75" x 1") is always left empty.
- Packing slip content: ship-to, return address, order #, order date, shipping method, item list
  (`order.items` if any, else "N item(s), $value"), total value, optional slip message + QR, plan tag.
- Text must never overflow its box: shrink the font down to a floor, then wrap/ellipsize.
- Every page: print at 100% scale (no scaling assumptions beyond the page size).
- `slipsInLabelOrderPdf(orders, slipPages, pageSize) -> jsPDF`: the user's own slip pages (images) in label
  order, one per page, for the chosen output size.

## slips.js (PDF)

- `readSlipPdf(arrayBuffer, orderIds) -> { byOrder: { [orderId]: { items: [...], pageImages: [dataUrl] } }, unmatchedPages: [n] }`
  uses pdf.js: a page belongs to the order whose `Order #` appears in the page text (an order may span
  pages). Items are pulled from the page text heuristically (qty + name + set/condition + price lines);
  if none are recognised, `items` is `[]` but the page image is still kept (rendered at ~150 dpi, PNG/JPEG
  data URL) for "Slips in label order".
- `attachSlips(orders, byOrder) -> orders` (sets `order.items`).

## app.js / store.js / UI (UI)

One page, mobile-friendly, works offline (service worker caches the app + vendor files), installable
(manifest + icon). Light and dark theme. Sections, top to bottom:
1. **Drop zone**: "Drop your TCGplayer shipping CSV" (drag & drop anywhere on the page or tap to browse),
   "Try the sample" button (loads `samples/tcgplayer-sample.csv`), a short "How to get the file" hint
   (Seller Portal -> Orders -> tick orders -> **Export Shipping**; the Packing Slip button makes a PDF, not
   the CSV). Errors from `parseOrders` shown plainly, including the found headers. Also accepts dropping the
   packing-slip PDF (routed to slips).
2. **Return address** form (name/store, phone optional, street, apt/suite optional, city, state, ZIP),
   saved in localStorage; multiple saved profiles (add / rename / delete / pick).
3. **Orders + shipping plan** table: order #, buyer, city/state, items, value, plan tag (coloured chip),
   est. weight + stamps, tracking/shipped status, a checkbox per row (print selection). Filter buttons
   (FILTERS). Totals line from `summarize`.
4. **Output**: format picker (FORMATS), packing slips on/off, bold return address, no divider, "+ Add
   TCGplayer packing slips (PDF)" + "Slips in label order" option, **Download PDF** (file name
   `labels-YYYY-MM-DD.pdf`). Reminder: print at 100% scale, thermal printers with zero margins; these
   are address labels, not postage.
5. **Paste addresses** (tab or panel): textarea -> `parseAddresses` -> same output options.
6. **Design** (collapsible): accent colour, font (Sans/Serif/Mono), logo upload (kept on device as a data
   URL), thermal darkness, label note (60 chars, counter), store QR URL, packing-slip message, plan
   settings (weights, rigid, forever value).
7. **Tracking + mark shipped**: paste box -> "Match to orders" (`matchTracking`), per-order "Shipped"
   toggle for untracked orders, warnings (`missingRequired`), **Download TCGplayer import file**
   (`tcgplayer-import-YYYY-MM-DD.csv`; hint: Orders -> Import Shipping Info), **Download Pirate Ship CSV**.
   Shipped state persists in localStorage (`store.js`), with a "Clear shipped history" button.

`store.js` wraps localStorage (try/catch everywhere; the app must work if storage is blocked):
`load(key, fallback)`, `save(key, value)`; keys `shipdesk.profiles`, `shipdesk.activeProfile`,
`shipdesk.design`, `shipdesk.output`, `shipdesk.plan`, `shipdesk.shipped`.

## Done means

- `python tools/test.py` passes every suite.
- Dropping the sample CSV (and a real-shaped export with quoted commas, BOM, CRLF, 4-digit ZIPs) gives
  correct orders, plan tags and stamp counts; every format downloads a PDF whose text (read back with
  pdf.js) contains each buyer's name and ZIP; the import file round-trips through `parseCsv` with the
  original columns.
- Works from `Start Ship Desk.bat` with no internet.
