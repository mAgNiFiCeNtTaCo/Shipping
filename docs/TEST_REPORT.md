# Ship Desk: test report

QA station, 2026-10-20.

## Result

`python tools/test.py` (all suites, headless Edge): **113 passed, 0 failed** (run twice after the last fix, same result both times).

| Suite | Owner | Tests | Result |
|---|---|---|---|
| harness | orchestrator | 2 | pass |
| data | Data station (CSV, plan, tracking, paste) | 39 | pass |
| render | PDF station (labels, slips, slip-PDF reader) | 50 | pass |
| ui | UI station (store, page) | 13 | pass |
| e2e | QA station (whole app) | 9 | pass |

## What the e2e suite checks (`app/tests/e2e.test.js`)

The real page (`index.html`) runs in an iframe. Files go in with a real drag-and-drop event (a `File` in a
`DataTransfer`), buttons are clicked, and the files the app saves are caught (jsPDF `save` and download links)
and read back: PDFs with pdf.js, CSVs with `parseCsv`.

1. **Drop the sample CSV**: 10 orders, 10 table rows, the 4-digit ZIP `8540` becomes `08540`, the quoted comma
   address survives, every order gets the right plan tag, and stamp maths matches USPS by hand (SAMPLE-0001
   0.78 oz -> $1.31 -> 2 stamps; SAMPLE-0007 1.44 oz -> $1.60 -> 2 stamps; slips off takes 0.16 oz off).
2. **Every format x slips on/off (16 PDFs)** through the Download PDF button: file name `labels-YYYY-MM-DD.pdf`,
   page count (labels per page, + 1 slip per order; label+slip = 1 page per order), page sizes, each buyer's name
   and ZIP on the label pages, return address (not on Avery, by design), order numbers on the slips.
3. **Selection and filters**: the Tracked filter prints only the 5 tracked orders; an unticked order is left out.
4. **Messy real-shaped export**: BOM, CRLF, quoted address with a comma, 4-digit ZIP, an empty line, a row of
   empty cells, two unknown extra columns, `"$1,234.50"`, ZIP+4, accents, a `""` escape. 3 orders, no warning,
   values right, names/ZIPs on the PDF; the import file keeps all 19 columns in the original order, extra
   columns untouched.
5. **Paste addresses** (with a "Ship to:" header, phone, email, "United States", a full state name, ZIP+4):
   3 orders `P-001..003`, every format's PDF has each name and ZIP, import button disabled.
6. **Tracking paste -> import file -> parseCsv round trip**: after printing the tracked orders, bare numbers
   follow label order (spaces removed), `order# <tab> number` works, UPS detected; the saved
   `tcgplayer-import-YYYY-MM-DD.csv` has CRLF, the exact export header, 3 rows, reads back through
   `parseOrders` with the right tracking/carrier, and every other cell equals the original row.
7. **Shipped keyword**: ticking Shipped on 3 untracked orders writes `Shipped` + empty carrier; the $49.99+ one
   is flagged before and after saving; typing a tracking number replaces the keyword and clears the warning;
   dropping the same file again leaves the 3 shipped orders unticked.
8. **Pirate Ship CSV**: exact header, only tracked orders without tracking (SAMPLE-0005/6/8/9), ounces rounded
   up (0.84 -> 0.9).
9. **Offline**: collects every file the app loads (page `src`/`href`, every module import followed through all
   modules, the pdf.js worker, manifest icons, the sample), checks `sw.js` lists each one, then registers the
   real service worker and confirms each file is actually in its cache.

## Visual check (`docs/screens/`)

Made with `python docs/make_screens.py` against `python serve.py --no-browser --port 5098` (headless Edge):
the app at 1280 and 500 px, empty and with the sample, light and dark; page 1 of all 8 PDF formats plus a thermal
and a letter packing slip (rendered with pdf.js by `app/tests/pdf-preview.html`). All looked at by eye: no
overflowing or cut-off text, chips readable in both themes, Avery text sits in the 5160 grid (0.5" top,
0.1875" left, 2.75" column pitch, 1" rows), envelope stamp corner empty, cut lines where they belong.

## What QA fixed

- `app/js/app.js`: weights showed as "0.9 oz" next to "0.78 oz"; now always two decimals ("0.90 oz").
- `app/js/app.js`: totals line said "5 envelope"; now "5 envelope OK", matching the chip.
- `app/css/app.css`: at phone width the Mark-shipped order list was a scroll box whose edge fell exactly between
  rows, so it looked like only 5 orders existed. On phones it now grows with the page (desktop keeps the box).
- `app/sw.js`: cache `VERSION` bumped to `shipdesk-v2` so browsers pick up the fixed files.
- No mismatches between stations were found: no open Requests in any brief, and every call the UI makes matched
  the Data and PDF modules.

New QA files: `app/tests/e2e.test.js`, `app/tests/pdf-preview.html` (screenshot helper; the pdf.js worker is
loaded on the page because a separate worker stalls under headless Edge's virtual time; the app itself is not
affected), `docs/make_screens.py`, `README.md`, this report.

## What is left

- **Check on the first real batch** (built from public descriptions, TCGplayer's help pages are behind a
  Cloudflare check): that TCGplayer's Import Shipping Info accepts `Shipped` in the tracking column for untracked
  orders, and that the packing-slip PDF reader finds the cards on a real TCGplayer slip (it was tested on
  slips made to match the brief's example lines).
- Not tested here: printing on real printers (thermal margins, Avery alignment on paper), the "Start Ship
  Desk.bat" double-click itself, and installing the app from the browser (manifest).
- Small cosmetic idea, not a bug: on the full-sheet (letter 1-up) label the address is the same size as on the
  half sheet, so it looks small on the page.
