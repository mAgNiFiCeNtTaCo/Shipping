# Station brief: QA + integration

You are the **QA** station of a 4-station nodeterm build of **Ship Desk** in `D:\ClaudeProjects\Shipping`
(shared working tree, no git). The Data, PDF and UI stations have finished and reported success. Read their
briefs' "## Done" and "## Requests" sections in `specs/data.md`, `specs/pdf.md`, `specs/ui.md` first, then
`CONTRACT.md`.

Goal: make the whole app work end to end, prove it, and document it for a non-programmer.

1. Run `python tools/test.py` (all suites). Fix anything that fails or any mismatch between stations
   (function names, shapes, Requests nobody answered). You may now edit any app file, but keep fixes small
   and note each one.
2. Write `app/tests/e2e.test.js`: load the real app (`../index.html`) in an iframe, feed it the sample CSV
   the way a drop does, and for **every** output format download path (call the same function the Download
   button calls) read the PDF back with pdf.js: each buyer's name and ZIP is on it, page counts are right.
   Also: a messy real-shaped export (BOM, CRLF, quoted address with a comma, 4-digit ZIP, a blank row, extra
   unknown columns), paste addresses, tracking paste -> import file -> parseCsv round trip with the original
   columns, "Shipped" keyword for untracked shipped orders, Pirate Ship CSV, offline: the service worker
   caches the app files (check `sw.js` lists every file the app loads).
3. Visual check: start `python serve.py --no-browser --port 5098` in the background, screenshot the app
   with headless Edge at 1280 and 500 px wide before and after loading the sample, and render page 1 of each
   PDF format to a PNG (pdf.js in a small page, or headless Edge on the PDF). Save them to
   `D:\ClaudeProjects\Shipping\docs\screens\`. Look at every image yourself and fix what looks wrong
   (overflowing text, cut-off labels, misaligned Avery grid, unreadable chips). Stop the server after.
4. Write `README.md` for the user (plain English, short): what Ship Desk does, how to start it
   (double-click `Start Ship Desk.bat`), the 4 steps (export from TCGplayer: Orders -> tick orders ->
   Export Shipping; drop the CSV; print at 100% scale, zero margins on thermal printers; mark shipped:
   upload the import file under Orders -> Import Shipping Info), every format, paste addresses, design
   options, tracking/Pirate Ship, where data is kept (browser storage on this PC only), and the honest
   limits: labels are address labels, not postage; the `Shipped` keyword in the import file and the
   packing-slip item reading are built from public descriptions and should be checked on the first real
   batch.
5. Write `docs/TEST_REPORT.md`: what you tested, results (test counts per suite), what you fixed, what is
   left.

When you are done, run exactly one of:

    sh "C:\Users\RubenNoodle\AppData\Roaming\node-terminal\canvas-control\nodeterm.sh" report-outcome --outcome succeeded --note "qa: all N tests pass, screens in docs/screens"
    sh "C:\Users\RubenNoodle\AppData\Roaming\node-terminal\canvas-control\nodeterm.sh" report-outcome --outcome failed --note "<why>"

`succeeded` only if `python tools/test.py` passes every suite and you looked at the screenshots.

## Done

QA station, 2026-10-20. `python tools/test.py`: **113 passed, 0 failed** (harness 2, data 39, render 50, ui 13,
e2e 9). Wrote `app/tests/e2e.test.js`, `app/tests/pdf-preview.html`, `docs/make_screens.py`, `docs/screens/`
(16 PNGs, all looked at), `README.md`, `docs/TEST_REPORT.md`. Small fixes: weights shown with 2 decimals and
"envelope OK" in the totals (app.js), Mark-shipped list no longer a scroll box on phones (app.css), sw.js
VERSION -> shipdesk-v2. Details in `docs/TEST_REPORT.md`.
