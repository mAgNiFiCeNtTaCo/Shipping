# Station brief: UI

You are the **UI** station of a 4-station nodeterm build of **Ship Desk** in `D:\ClaudeProjects\Shipping`
(shared working tree, no git, no worktrees). Two other builders (Data, PDF) write the modules you call, at
the same time; a QA station starts after all three report success.

1. Read `D:\ClaudeProjects\Shipping\CONTRACT.md` in full. It is the spec. Call the Data modules
   (`app/js/csv.js`, `plan.js`, `tracking.js`, `paste.js`) and PDF modules (`app/js/render.js`,
   `slips.js`) exactly as the contract names them. They may not exist yet when you start: build against
   the contract, and check back on them (read the files) once they appear, before you finish.
2. Build:
   - `app/index.html`, `app/css/app.css`, `app/js/app.js`, `app/js/store.js`: the whole one-page app as
     described in the contract's "app.js / store.js / UI" section (drop zone with drag & drop anywhere +
     tap to browse + "Try the sample", return-address profiles, orders + shipping plan table with filters,
     selection checkboxes and totals, output options + Download PDF, packing-slip PDF upload + "Slips in
     label order", paste addresses, design panel, tracking match + mark shipped + TCGplayer import file +
     Pirate Ship CSV, clear shipped history). Load the vendor scripts with classic `<script>` tags
     (`vendor/jspdf.umd.min.js`, `vendor/pdf.min.js`, `vendor/qrcode.js`) before the module.
   - `app/sw.js` (cache-first offline for the app shell, `js/`, `css/`, `vendor/`, `samples/`; bump a
     version constant to update) + `app/manifest.webmanifest` + `app/icon.svg` (an original simple icon:
     a parcel/label mark, not anyone's logo). Register the service worker only on http(s).
   - `Start Ship Desk.bat` in the project root: runs `python serve.py` (port 5091, opens the browser),
     working directory = the bat's folder, readable message if Python is missing.
   - `app/tests/ui.test.js`: test `store.js` (works when localStorage throws), and the app wiring in an
     iframe or by importing app.js functions you export for testing: loading the sample CSV fills the table
     with the right row count, a filter changes the visible rows, a bad CSV shows the found headers, the
     return address survives a reload of the store.
3. Design: original, clean, friendly, fast to use for a card seller shipping 5-50 orders at a time. Big
   obvious drop zone, clear step order (1 Drop file, 2 Check plan, 3 Print, 4 Mark shipped), works at phone
   width (16px gutters, no sideways scroll), light + dark (prefers-color-scheme), keyboard accessible,
   plain-English messages. Show the plan tags as coloured chips. Never use tcgspeedshipper.com's name,
   text, colours or layout: do not fetch or copy anything from that site.
4. The user isn't a programmer: every message the app shows must be plain English.
5. Run `python tools/test.py ui` (from `D:\ClaudeProjects\Shipping`) until it passes. Check the page
   looks right with headless Edge screenshots (`msedge --headless=new --screenshot=<png> --window-size=1280,1600 <url>`
   while `python serve.py --no-browser --port 5099` runs in the background; also 500 px wide) and fix what
   looks off. Stop that server when you're done.
6. Touch only the files you own (CONTRACT.md "File ownership"). If you need something from another station,
   add it under "## Requests" at the bottom of this file and code against the contract.
7. At the end, add a short "## Done" section at the bottom of this file: what you built, test count,
   screenshots taken, anything still waiting on Data/PDF.

When you are done, run exactly one of:

    sh "C:\Users\RubenNoodle\AppData\Roaming\node-terminal\canvas-control\nodeterm.sh" report-outcome --outcome succeeded --note "ui: N tests pass"
    sh "C:\Users\RubenNoodle\AppData\Roaming\node-terminal\canvas-control\nodeterm.sh" report-outcome --outcome failed --note "<why>"

`succeeded` only if `python tools/test.py ui` passes.

## Done

2026-10-20, UI station.

- **Built:** `app/index.html`, `app/css/app.css`, `app/js/app.js`, `app/js/store.js`, `app/sw.js`,
  `app/manifest.webmanifest`, `app/icon.svg` (original parcel + label mark), `Start Ship Desk.bat` (CRLF; tries
  `python` then `py -3`, plain message if Python is missing or the port is busy), `app/tests/ui.test.js`.
- **Page:** sticky step bar (1 Drop file, 2 Check plan, 3 Print, 4 Mark shipped; steps tick off as done);
  step 1 has tabs "TCGplayer file" (big drop zone, drop anywhere on the page, tap to browse, Try the sample,
  "How do I get the file?") and "Paste addresses"; return-address card with saved profiles (+ New, Delete,
  pick, nickname field = rename); plan table with coloured chips, filter buttons with counts, tick boxes,
  tick-all, totals from `summarize`; it turns into cards at phone width; Print step with every FORMAT, slips /
  bold / no-divider, packing-slip PDF upload + "Slips in label order" + "Only my slips, in label order",
  collapsible Label design, Download PDF (`labels-YYYY-MM-DD.pdf`), and the 100% scale reminder; Mark shipped
  with tracking paste -> Match, a tracking box + Shipped tick per order, the $49.99+ warning, TCGplayer import
  file (`tcgplayer-import-YYYY-MM-DD.csv`), Pirate Ship CSV (`pirate-ship-YYYY-MM-DD.csv`), Clear shipped history.
  A dropped PDF goes to the packing slips.
- **For QA:** the app sets `window.shipdesk` (also the exports of `app.js`): `loadCsvText(text, name)`,
  `loadPastedText`, `setFilter`, `visibleOrders`, `printOrders`, `pdfOptions`, `buildPdf()` (what Download PDF
  saves, returns the jsPDF doc), `downloadPdf`, `matchPasted`, `importFile()`, `pirateFile()`, `clearShipped`,
  `state`. `index.html?sample` opens with the sample loaded (for screenshots). The service worker is not
  registered inside an iframe or on file://.
- **Deviation:** the plan settings (weights, rigid, forever stamp value) sit under step 2 ("Weights and postage
  settings") instead of the Design panel, next to the numbers they change.
- **Tests:** `python tools/test.py ui` = 13 passed. Full run `python tools/test.py` = 104 passed, 0 failed
  (e2e not written yet).
- **Screenshots** (headless Edge, light + dark, 1280 and 500 px, before and after the sample) checked by eye;
  fixed a class clash that put circles in the Items/Value cells, the first card hiding under the step bar, an
  empty toast showing, and "optional" wrapping. Kept in the session scratchpad only (QA makes the ones for docs/).
- **Waiting on Data/PDF:** nothing. Both stations' modules were checked against the calls the UI makes.
