# Shipping: progress log

Ship Desk: a local browser app that does what tcgspeedshipper.com does (our own code and design). Drop TCGplayer's
"Export Shipping" CSV and get address labels, packing slips and envelopes as one PDF, a shipping plan with
stamps, and the TCGplayer import file that marks the batch shipped.

## Where it stands (2026-10-20)
- Working, not yet tried on a real TCGplayer batch or a real printer.
- Start: double-click `Start Ship Desk.bat` (runs `python serve.py`) -> http://127.0.0.1:5091/ . Works offline.
- Tests: `python tools/test.py` = **117 passed, 0 failed** (harness 2, data 39, render 54, ui 13, e2e 9).
- 9 print formats: thermal 4x6, thermal 6x4 landscape, letter 1/2/3/4 per page, label + slip, Avery 5160, #10 envelope.

## Log
### 2026-10-20: first build (nodeterm team) + landscape thermal label
- Researched tcgspeedshipper.com: TCGplayer "Export Shipping" CSV columns (from its sample file), TCGplayer
  plan thresholds ($20 / $49.99 / $250), USPS stamped-letter prices from 2026-10-04 (0.82 + 0.29/oz, max 3.5 oz,
  +0.49 nonmachinable), import file = original export columns with `Tracking #` / `Carrier` filled, the word
  `Shipped` for orders sent without tracking. TCGplayer's own help pages are behind a Cloudflare check, so that
  keyword is from second-hand descriptions.
- Decided: our own name (Ship Desk), code, design and wording; nothing copied from the site. Left out accounts,
  plans/limits, billing, referrals, buying postage (only "coming soon" on the site) and Enterprise integrations;
  every paid feature is just on.
- Stack: static ES-module app in `app/`, vendored jsPDF 2.5.2, pdf.js 3.11.174, qrcode-generator 1.4.4 (offline,
  no CDN), Python stdlib `serve.py` on 127.0.0.1:5091. No Node on this PC, so tests run in headless Edge
  (`tools/test.py` serves the app, opens `app/tests/run.html`, the page POSTs results back).
- Built by 4 stations on the shared working tree (no worktrees, as asked), from `CONTRACT.md` + `specs/*.md`:
  Data (CSV/plan/tracking/paste, 39 tests), PDF (labels/slips/slip-PDF reader, 50), UI (page, profiles, offline
  service worker, `Start Ship Desk.bat`, 13), then QA (9 end-to-end tests, 16 screenshots in `docs/screens/`,
  `README.md`, `docs/TEST_REPORT.md`, small fixes: phone scroll box, 2-decimal weights, "envelope OK" wording).
  Details in `WORKFLOW.md`.
- User asked for a landscape label: added format `thermal6x4` ("Thermal label 6 x 4 in, landscape") in
  `app/js/render.js` (same layout code, wide box; slips stay upright 4x6), tests updated, service-worker cache
  bumped to `shipdesk-v3`, README row, screenshot `docs/screens/pdf-thermal6x4.png`.
- Open: check on the first real batch that TCGplayer's Import Shipping Info accepts `Shipped`, that the
  packing-slip reader finds the cards on a real TCGplayer slip PDF, and real-printer alignment (thermal margins,
  Avery). Ideas: sideways letter-paper labels; bigger address on the full-sheet label.
