# Station brief: Data

You are the **Data** station of a 4-station nodeterm build of **Ship Desk** in `D:\ClaudeProjects\Shipping`
(shared working tree, no git, no worktrees). Two other builders (PDF, UI) work at the same time; a QA station
starts after all three report success.

1. Read `D:\ClaudeProjects\Shipping\CONTRACT.md` in full. It is the spec. Follow its function names and
   shapes exactly: the PDF and UI stations code against them without seeing your files.
2. Build, as plain ES modules (no Node, no build step, browser only):
   - `app/js/csv.js`: `parseCsv`, `HEADER_ALIASES`, `parseOrders`, `toCsv`.
   - `app/js/plan.js`: `planOrder`, `DEFAULT_PLAN_SETTINGS`, `FILTERS`, `filterOrders`, `summarize`.
   - `app/js/tracking.js`: `detectCarrier`, `matchTracking`, `importFileCsv`, `pirateShipCsv`.
   - `app/js/paste.js`: `parseAddresses`.
   - `app/samples/tcgplayer-sample.csv`: an **invented** sample in TCGplayer's export format (header row
     exactly: `Order #,FirstName,LastName,Address1,Address2,City,State,PostalCode,Country,Order Date,Product Weight,Shipping Method,Item Count,Value Of Products,Shipping Fee Paid,Tracking #,Carrier`),
     about 10 orders with made-up names and real-looking US addresses, covering every plan tag: several
     under $20, a $20-49 one, an expedited one under $20, a $49.99+ one, a $250+ one, an Apt/Suite line,
     a ZIP with a leading zero, a name with an apostrophe.
   - `app/tests/data.test.js`: thorough tests: quoted commas/newlines/`""`, BOM, CRLF, blank rows, header
     variants (at least 4 different header spellings), missing-column error that lists the found headers,
     4-digit ZIP fix, ZIP+4, duplicate order #, every plan threshold edge (19.99/20, 49.98/49.99,
     249.99/250, expedited), the stamp table (1 / 1.01 / 2 / 3 / 3.5 / 3.51 oz, rigid on/off), filters,
     carrier detection, both tracking paste forms + warnings, import file (original column order kept,
     `Shipped` keyword, missing columns appended, missingRequired, round-trips through parseCsv), Pirate
     Ship CSV, paste parser (blocks, one-per-line, phone/email/"Ship to" ignored).
3. Run `python tools/test.py data` (from `D:\ClaudeProjects\Shipping`) until it passes. Nothing else of the
   app exists yet, so test your modules directly.
4. Write original code. Do not fetch or copy anything from tcgspeedshipper.com.
5. Touch only the files you own (CONTRACT.md "File ownership"). If you need something from another station,
   add it under "## Requests" at the bottom of this file and code against the contract.
6. At the end, add a short "## Done" section at the bottom of this file: what you built, test count, anything
   the UI/PDF stations must know (e.g. extra exports you added).

When you are done, run exactly one of:

    sh "C:\Users\RubenNoodle\AppData\Roaming\node-terminal\canvas-control\nodeterm.sh" report-outcome --outcome succeeded --note "data: N tests pass"
    sh "C:\Users\RubenNoodle\AppData\Roaming\node-terminal\canvas-control\nodeterm.sh" report-outcome --outcome failed --note "<why>"

`succeeded` only if `python tools/test.py data` passes.

## Done

Built (2026-10-20): `app/js/csv.js`, `app/js/plan.js`, `app/js/tracking.js`, `app/js/paste.js`,
`app/samples/tcgplayer-sample.csv` (10 invented orders: 5 envelope incl. 19.99 edge, $34.75, expedited $6.50,
$49.99, $88.20, $312, Apt/Suite/Unit lines, ZIPs 02127 / 05401 and a 4-digit `8540` that becomes 08540,
O'Callahan, a quoted address with a comma), `app/tests/data.test.js`.
`python tools/test.py data`: **39 passed, 0 failed.**

Notes for UI / PDF / QA:
- `FILTERS` is an array: `[{ id, label }]` (ids `all`, `envelope`, `tracked`, `unshipped`).
- `filterOrders` uses `order.plan` when set, else `planOrder(order)` with default settings: set
  `order.plan = planOrder(order, settings)` so filters follow the user's plan settings.
- `planOrder(order, settings)`: `settings` may be partial or missing; it is merged over `DEFAULT_PLAN_SETTINGS`.
  `weightOz` is the estimated packed weight; `postage`/`stamps` are `null` when `letterOk` is false.
- `summarize().byTag` always has all four tags (0 when none).
- `matchTracking` matches have `carrier: ""` when the number's carrier isn't recognised; `importFileCsv` then
  uses `shippedState.carrier`, the file's carrier, detection, else "USPS". Tracking numbers come back without
  spaces/dashes. Bare numbers go to the orders (in the order passed) that didn't get one by order #.
- `importFileCsv` skips pasted orders (`row` {}); orders in `missingRequired` are still written (as `Shipped`)
  and counted, so show the warning before the user uploads.
- `pirateShipCsv(orders, planned, shippedState?)`: `planned` may be `{ [orderId]: plan }` or an array parallel
  to `orders`; missing entries fall back to `order.plan` / `planOrder`. Optional 3rd arg skips orders that got
  tracking in `shippedState`.
- Extra exports: csv.js `normalizeHeader`, `matchHeaders`, `normalizeZip`, `parseNumber`, `splitName`;
  plan.js `TAG_LABELS`, `LETTER_RATES`, `TOO_HEAVY_NOTE`, `planTag`, `letterPostage`, `stampsFor`, `isShipped`.
- `parseAddresses` also accepts full state names ("Massachusetts" -> MA), ZIP+4, Canadian postal codes
  (country "CA"), "Name:"-style labels, and skips a spreadsheet header row.
