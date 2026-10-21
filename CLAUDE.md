# Shipping (Ship Desk)

Local browser app for the user's TCGplayer shipping: drop TCGplayer's "Export Shipping" CSV, get address labels,
packing slips and envelopes as one PDF, a shipping plan with stamps, and the TCGplayer import file that marks the
batch shipped. Does what tcgspeedshipper.com does, with our own code and design. The user isn't a programmer:
explain in plain words and finish jobs end to end.

## Read first
- `PROGRESS.md` (log + where it stands), `WORKFLOW.md` (who built what), `CONTRACT.md` (the spec: Order object,
  module APIs, formats, file ownership), `README.md` (user guide), `docs/TEST_REPORT.md`.
- `WORKFLOW.html` is the picture of how the project was built, drawn from `workflow.json` by
  `_brain/workflow.py` on each /save-progress: edit the JSON (or let /save-progress do it), never the HTML.

## Layout
- `app/index.html`, `app/css/app.css`, `app/js/app.js` + `store.js`: the page and its saved settings (localStorage).
- `app/js/csv.js`, `plan.js`, `tracking.js`, `paste.js`: reading files, shipping plan + stamps, tracking/import files, pasted addresses.
- `app/js/render.js` (all PDF formats, `FORMATS`), `app/js/slips.js` (reads TCGplayer's packing-slip PDF).
- `app/js/history.js`: the History page's records (`shipdesk.history` in localStorage: name/city/ZIP only, no street).
- `app/phone.html` + `js/phone.js` + `css/phone.css` + `phone-sw.js` (scope `./phone`, network-first): the iPhone page for
  order photos (contents / packed / post office). Photos wait in the phone's IndexedDB (`shipdesk-phone`) until
  `POST /api/phone/photo` succeeds; saved to `Saved/Photos/<order # buyer>/`, listed in `Saved/Photos/photos.json`.
- Scanning (phone.js): `vendor/zxing-library-0.21.3.min.js` (loaded only when the scanner opens) reads QR + Code 128.
  Order QR = `SHIPDESK:<history key>` (render.js `orderQrText`, design option `orderQr`, not on Avery). A mailer's
  unknown tracking number is linked to an order on the phone, queued like a photo (`link: true`), sent to
  `POST /api/phone/link` -> `Saved/Phone/links.json`; the PC page takes them (`takePhoneLinks`, `GET /api/links`,
  `POST /api/links-done`) into History + `state.shipped`. A mailer with no order in the list becomes a new entry
  keyed `mailer:<tracking>` (history source "mailer"); typing its order # in History (`setOrderNumber`) re-keys it and
  `POST /api/photos-rekey` moves its photos (`Saved/Phone/rekeys.json` sends late uploads to the order).
- Camera screen = the scanner (`#scanner`): shutter (`shoot`) takes any number of photos for `scan.found` without
  leaving; turn from `devicemotion` gravity (`onMotion`, iOS sign differs from Android; flat keeps the last turn;
  no turn when the page itself is landscape); `#cam-turn` overrides. A post office photo leaves a "shipped" note
  (`links.json`, empty tracking) that `takePhoneLinks` applies only to orders not shipped yet. PC turn buttons:
  canvas rotate + `POST /api/photo-rotate`. The camera stream is reused and kept 5 min after Done (`KEEP_CAMERA_MS`):
  iPhone home-screen apps re-ask on every `getUserMedia`.
- Saved file names come from app.js `fileName()` ("Labels <date> <HH-MM> - N orders - buyer, buyer ...pdf"); serve.py
  `NAME_OK` must keep allowing what it produces (any-language letters, `,'&+()`).
- `app/sw.js` offline cache (bump `VERSION` whenever app files change), `app/manifest.webmanifest`, `app/icon.svg`.
- `app/vendor/` jsPDF 2.5.2, pdf.js 3.11.174, qrcode-generator 1.4.4, @zxing/library 0.21.3 (no CDN: the app works offline).
- `app/samples/tcgplayer-sample.csv` invented sample orders. `app/tests/` browser test suites.
- `Saved/` (gitignored, real buyer addresses): files the app makes, written by `serve.py` (`POST /api/save`,
  `/api/open-folder`; only Ship Desk's own page may call them: Host + Origin + `X-Ship-Desk` header). Tests write to a temp folder.
  `Saved/Phone/pairing-code.txt` is a secret (the phone's key): never print or commit it.
- Phone access: `serve.py` stays on 127.0.0.1; the phone comes in through `tailscale serve --https=5091` (switched on/off
  by the Phone photos window, tailnet only, never Funnel). Anything with X-Forwarded-For / Tailscale-User-* headers or a
  non-local Host gets only `PHONE_FILES` + `/api/phone/*` (with the `X-Ship-Desk-Key` pairing code).
- `serve.py` local server, `tools/test.py` test runner, `docs/make_screens.py` + `docs/screens/` screenshots.
- `specs/` the build briefs of 2026-10-20.

## Commands
- Run: `Start Ship Desk.bat` or `python serve.py` -> http://127.0.0.1:5091/ (`--port`, `--no-browser`).
- Tests: `python tools/test.py` (all) or `python tools/test.py data render ui e2e`; runs in headless Edge.
- Screenshots: `python serve.py --no-browser --port 5098` in the background, then `python docs/make_screens.py`
  (`python docs/make_screens.py phone` = only the phone shots, on a private server with fake Tailscale).

## Rules
- Order files contain buyers' names and addresses: never save them into the project or commit them; the app keeps everything in the browser.
- Don't copy tcgspeedshipper.com's code, text, images or name; it is the feature reference only.
- Adding a print format: add it to `FORMATS` in render.js, update the format list in `app/tests/render.test.js`, bump `VERSION` in `sw.js`, add a README row.

## Gotchas
- No Node on this PC: JS tests only run through `tools/test.py` (headless Edge).
- TCGplayer's help pages are behind a Cloudflare check; the `Shipped` keyword in the import file and the slip item reader are unconfirmed until a real batch.
- Browsers keep the old app until the service worker's `VERSION` changes: reload once or twice after an update.
- Home network is double NAT: the phone can't reach 192.168.1.x, so phone access is Tailscale only (iPhone "iphone182").
- `--virtual-time-budget` screenshots don't wait for IndexedDB: the phone shots use real-time DevTools capture (`live_shot`).
- Tests never touch real Tailscale (`tools/test.py` fakes `tailscale_status` / `tailscale_switch`).
- The `thermal6x4` label is an upright 4x6 page with the layout turned (render.js `sideways`): thermal printers cut a wide page off.
- Patch scripts: encode before opening for "wb" (a failed write must not empty the file), keep each file's
  line endings (CRLF files exist), and never re-run a script whose `new` text contains its `old` text.
- zxing finds one code per look and doesn't turn 1D barcodes by itself: phone.js covers a useless code and looks
  again (`decodeUseful`), and turns the picture every other frame. Scanner tests use a canvas `captureStream()` as the camera.
