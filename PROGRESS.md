# Shipping: progress log

Ship Desk: a local browser app that does what tcgspeedshipper.com does (our own code and design). Drop TCGplayer's
"Export Shipping" CSV and get address labels, packing slips and envelopes as one PDF, a shipping plan with
stamps, and the TCGplayer import file that marks the batch shipped.

## Where it stands (2026-10-20)
- Working. First real labels printed on 2026-10-20 (thermal); not yet tried on a real TCGplayer import.
- Start: double-click `Start Ship Desk.bat` (runs `python serve.py`) -> http://127.0.0.1:5091/ . Works offline.
- Tests: `python tools/test.py` = **144 passed, 0 failed** (harness 2, data 39, render 55, ui 13, history 13, e2e 9, phone 13).
- 9 print formats: thermal 4x6, thermal 6x4 sideways (upright page, turned layout), letter 1/2/3/4 per page,
  label + slip, Avery 5160, #10 envelope. Labels, envelopes and slips carry an order QR code (switchable).
- History page (header switch) of every order labelled or shipped; generated files save into `Saved\` (gitignored).
- Phone page (`/phone.html`, iPhone through Tailscale serve, pairing code): photos per order (contents / packed /
  post office) into `Saved\Photos`, offline queue; **Scan labels** reads the order QR codes and mailer tracking
  barcodes. Phone access is switched on from the PC's "Phone photos" window (not yet switched on for real).

## Log
### 2026-10-20: phone photos, label scanning, sideways label fix
- **Phone photos** (user: pick the order, attach contents / packed / post office photos from the phone, save them
  here, queue them when the server is down): new `app/phone.html` + `js/phone.js` + `css/phone.css` + `phone-sw.js`.
  Pick a photo kind, tick one or more orders, Take photo / Choose photos. Every photo goes into the phone's
  IndexedDB first (bytes as ArrayBuffer) and is deleted only after `POST /api/phone/photo` says saved; retries on
  load, online, visible, every 15 s. Photos re-encoded to JPEG, max 2560 px (strips location). Saved to
  `Saved\Photos\<order # buyer>\<Kind> <date time> <id>.jpg`, indexed in `photos.json`, same id saved once.
  History got a Photos column + photos window; the PC sends the phone its order list (name/city/ZIP, no street).
- **How the phone reaches the PC**: double NAT at home, so `tailscale serve --https=5091` (tailnet only, never
  Funnel), switched on/off from the PC's new "Phone photos" window (QR link + 12-character pairing code in
  `Saved\Phone\pairing-code.txt`, a secret). serve.py still listens on 127.0.0.1 only; anything through the proxy
  (X-Forwarded-For / Tailscale-User-* headers / non-local Host) gets only the phone files and `/api/phone/*` with the
  code. Checked once against the real Tailscale on a spare port, then switched off; port 5091 is not switched on yet.
- **Sideways label printed cut off** (user's photo: name, return address and order # missing on the left): the
  6x4 PDF page was 6 in wide and the 4 in thermal roll cut it. Now `thermal6x4` is an upright 4x6 page with the
  layout turned a quarter turn (render.js `sideways`, a PDF `cm` transform); new test checks page size, text
  direction and that nothing runs off.
- **Scanning** (user: QR codes on envelopes to scan with the phone, and scan bubble mailer labels into History
  with photos): render.js prints `SHIPDESK:<history key>` as a QR code on labels, envelopes and packing slips
  (design option "Order QR code", default on, not on Avery). The phone's **Scan labels** uses vendored
  `@zxing/library` 0.21.3 (MIT, QR + Code 128, loaded only when scanning): picks orders from Ship Desk's QR codes
  or a known tracking number; an unknown mailer tracking number (USPS `420`+ZIP prefix handled, UPS) asks which
  order, then is queued like a photo and sent to `POST /api/phone/link` (`Saved\Phone\links.json`). The PC page
  takes them (`GET /api/links`, `/api/links-done`) into History (shipped + tracking) and step 4's shipped list,
  so they go in the TCGplayer import file. zxing reads one code per look and doesn't turn 1D codes: phone.js
  covers a useless code (e.g. the shop-link QR) and looks again, and turns every other camera frame.
- Tests 130 -> 144 (new `phone` suite: Tailscale split, pairing window, photo upload, offline queue, wrong code,
  duplicates, History photos, QR read back from every rendered format incl. sideways, a drawn USPS barcode
  upright + sideways, the live scanner on a canvas `captureStream()` camera, an offline mailer link landing in
  History + the import file). Phone screenshots use real-time DevTools capture (virtual time ignores IndexedDB).
- Open: the user must restart Ship Desk, switch on phone access and add the page to the iPhone home screen;
  scanning not yet tried with the real iPhone camera or a real mailer label; iOS only uploads while the page is open.

### 2026-10-20: History tab + files saved into the Saved folder
- **History page** (user asked for a tab of every order labelled and shipped): "Ship orders / History" switch in the
  header (`#history` opens it). New `app/js/history.js`: a record per order when Download PDF runs (date, label
  format, times printed) and when it's marked shipped (date, tracking, carrier; orders shipped without printing
  here too). Filters (All / Labels made, not shipped / Shipped), search, Track on USPS/UPS/FedEx/DHL links,
  Shipped tick + tracking box per row (also updates step 4's shipped list for TCGplayer orders), Remove, Clear,
  Download history (CSV). Stored in localStorage `shipdesk.history`: name, city, state, ZIP only (no street);
  pasted orders keyed by name + ZIP (P-001 repeats); max 5,000 records.
- **Saved folder** (user asked to stop filling Downloads, other downloads unchanged): `serve.py` now saves the
  files the app makes into `Saved\Labels`, `Packing slips`, `TCGplayer import files`, `Pirate Ship`, `History`
  (`POST /api/save`, numbered copies, never overwrites) and opens them in Explorer (`/api/open-folder`). Only
  Ship Desk's own page may call them (Host + Origin + `X-Ship-Desk` header), names whitelisted to .pdf/.csv,
  size checked. "Where files go" choice under Download PDF (Saved folder default / My Downloads, remembered);
  falls back to a normal download when the server isn't running. Decided against changing the browser's
  download folder: it would move every other download too.
- `Saved/` added to `.gitignore` before anything was saved (the repo is public and those files hold buyer
  addresses); checked with `git check-ignore`. Tests save into a temp folder (`tools/test.py`), never `Saved/`.
- Tests 117 -> 130 (new `history` suite: records, filters, CSV, the History page, the Saved folder, the server
  refusing other origins / bad names). Live check: a file posted to the real server landed in
  `Saved\Labels` (then deleted); a cross-site request got 403. Screenshots `docs/screens/app-*-history*.png`.
  Service-worker cache now `shipdesk-v5`.
- User: restart Ship Desk (close the black window, run `Start Ship Desk.bat`) and reload the page to get these.

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
