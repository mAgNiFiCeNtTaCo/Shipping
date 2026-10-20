# Station brief: PDF

You are the **PDF** station of a 4-station nodeterm build of **Ship Desk** in `D:\ClaudeProjects\Shipping`
(shared working tree, no git, no worktrees). Two other builders (Data, UI) work at the same time; a QA station
starts after all three report success.

1. Read `D:\ClaudeProjects\Shipping\CONTRACT.md` in full. It is the spec. Follow its function names and
   shapes exactly: the UI station calls your functions without seeing your files.
2. Build, as plain ES modules (no Node, no build step, browser only; jsPDF / pdf.js / qrcode-generator are
   already vendored in `app/vendor/` and reach you as `window.jspdf.jsPDF`, `window.pdfjsLib`,
   `window.qrcode`):
   - `app/js/render.js`: `FORMATS`, `renderPdf(orders, opts)`, `slipsInLabelOrderPdf(...)`. Every format in
     the contract: thermal 4x6, letter 1/2/3/4-up with dashed cut lines, label + slip on one page,
     Avery 5160 (30/sheet, exact geometry), #10 envelope. Packing slips. Bold return address, no-divider
     option, design options (accent colour, helvetica/times/courier, logo data URL, thermal darkness,
     <=60-char note, QR code from a URL, slip message). Text must never overflow: shrink to a floor, then
     wrap / ellipsize. Make the labels look clean and professional (a big, easy-to-read ship-to block is
     what matters most: USPS readability).
   - `app/js/slips.js`: `readSlipPdf(arrayBuffer, orderIds)`, `attachSlips(orders, byOrder)`. TCGplayer's
     packing slip PDF: match pages to orders by the order number appearing in the page text; pull item
     lines heuristically; always keep a rendered page image (~150 dpi) for "Slips in label order".
   - `app/tests/render.test.js`: build Orders by hand (the Data station's modules may not exist yet; don't
     import them). For every format: the PDF has the expected page count and page size, and its text read
     back with pdf.js contains every buyer's name, ZIP, and the return address; long names/addresses
     don't throw; Avery 31 orders -> 2 pages; slips on/off changes page count; labelSlip = 1 page/order.
     For slips.js: make a fake "TCGplayer packing slip" PDF with jsPDF (two orders, one spanning two
     pages, item lines like `1  Dark Magician - LOB - Near Mint  $4.99`), then check readSlipPdf matches
     pages to orders, extracts items, and returns page images.
   - Sample PNGs of each format are not your job: the QA station makes them.
3. Run `python tools/test.py render` (from `D:\ClaudeProjects\Shipping`) until it passes.
4. Write original code. Do not fetch or copy anything from tcgspeedshipper.com.
5. Touch only the files you own (CONTRACT.md "File ownership"). If you need something from another station,
   add it under "## Requests" at the bottom of this file and code against the contract.
6. At the end, add a short "## Done" section at the bottom of this file: what you built, test count, anything
   the UI station must know (exact FORMATS ids/labels, how to save, any extra opts).

When you are done, run exactly one of:

    sh "C:\Users\RubenNoodle\AppData\Roaming\node-terminal\canvas-control\nodeterm.sh" report-outcome --outcome succeeded --note "pdf: N tests pass"
    sh "C:\Users\RubenNoodle\AppData\Roaming\node-terminal\canvas-control\nodeterm.sh" report-outcome --outcome failed --note "<why>"

`succeeded` only if `python tools/test.py render` passes.

## Done

PDF station, 2026-10-20. `python tools/test.py render`: **50 passed, 0 failed**.

Built:
- `app/js/render.js`: `FORMATS`, `renderPdf(orders, opts)`, `slipsInLabelOrderPdf(orders, slipPages, pageSize)`
  (also exports `cleanText`). Every contract format; packing slips; bold return address; no-divider; design
  options (accent, helvetica/times/courier, logo, thermal darkness, 60-char note, QR, slip message); plan tag +
  stamps on slips. Text shrinks to a floor, then wraps / ellipsizes; tests check that no text leaves the page
  (or its Avery cell) and that the envelope stamp corner stays empty.
- `app/js/slips.js`: `readSlipPdf(arrayBuffer, orderIds)`, `attachSlips(orders, byOrder)`, plus
  `slipPagesFor(orders, byOrder)` and `parseItemLine(line)`.
- `app/tests/render.test.js`: 50 tests (8 formats x 4 checks, plus Avery geometry and 31 -> 2 sheets,
  cut lines, divider, darkness, slips in label order (checked by pixel colour), odd text, slip PDF reading).

For the UI station:
- `FORMATS` is an array, in this order, of `{ id, label, pageSize: [w, h], width, height, perPage, slipSize, hint }`
  (inches). ids / labels:
  `thermal4x6` "Thermal label 4 x 6 in (Rollo, MUNBYN, Dymo)", `letter1` "Letter paper, 1 label per page (full sheet)",
  `letter2` "... 2 labels per page (half sheets)", `letter3` "... 3 labels per page (thirds)",
  `letter4` "... 4 labels per page (quarters)", `labelSlip` "Letter paper, label + packing slip on one page",
  `avery5160` "Avery 5160 / 8160 address labels (30 per sheet)", `envelope10` "#10 envelope (9.5 x 4.125 in)".
  `hint` is a one-line tip you can show under the picker.
- Save: `renderPdf(...).save("labels-YYYY-MM-DD.pdf")`, or `.output("blob")` for a preview / object URL.
- `opts.returnAddress` may be null (labels then have no return block). `opts.slips` defaults to true.
  `labelSlip` is always one page per order; with `slips: false` its bottom half stays empty.
- Avery 5160 labels are ship-to only (no return address, note, logo or QR on them, by the contract).
- Extra opt: `compress: false` (readable PDF source; only the tests need it).
- Packing-slip PDF flow: `const { byOrder, unmatchedPages } = await readSlipPdf(await file.arrayBuffer(), orders.map(o => o.id))`
  -> `attachSlips(orders, byOrder)` -> for "Slips in label order" pass `slipPages: slipPagesFor(orders, byOrder)`
  to `renderPdf` (the user's own slip pages then replace the drawn slips; for `labelSlip` the first page image
  goes in the bottom half), or call `slipsInLabelOrderPdf(orders, slipPagesFor(orders, byOrder), formatId)` for
  the slips alone (`thermal4x6` -> 4x6 pages, every other id -> letter; also accepts `"4x6"`, `"letter"`, `[w, h]`).
  `unmatchedPages` are 1-based page numbers. A page with no order number continues the previous page's order.
  `readSlipPdf` sets `pdfjsLib.GlobalWorkerOptions.workerSrc` itself (relative to `js/slips.js`) if the page hasn't.
- `readSlipPdf` copies the buffer, so the caller's ArrayBuffer stays usable.

For QA: the item-line reader is built from the brief's example (`1  Dark Magician - LOB - Near Mint  $4.99`,
also separate columns and `2 x ... $1.00 $2.00`); check it on a real TCGplayer slip PDF first. No requests to
other stations.
