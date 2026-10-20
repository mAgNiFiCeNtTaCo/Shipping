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
- `app/sw.js` offline cache (bump `VERSION` whenever app files change), `app/manifest.webmanifest`, `app/icon.svg`.
- `app/vendor/` jsPDF 2.5.2, pdf.js 3.11.174, qrcode-generator 1.4.4 (no CDN: the app works offline).
- `app/samples/tcgplayer-sample.csv` invented sample orders. `app/tests/` browser test suites.
- `Saved/` (gitignored, real buyer addresses): files the app makes, written by `serve.py` (`POST /api/save`,
  `/api/open-folder`; only Ship Desk's own page may call them: Host + Origin + `X-Ship-Desk` header). Tests write to a temp folder.
- `serve.py` local server, `tools/test.py` test runner, `docs/make_screens.py` + `docs/screens/` screenshots.
- `specs/` the build briefs of 2026-10-20.

## Commands
- Run: `Start Ship Desk.bat` or `python serve.py` -> http://127.0.0.1:5091/ (`--port`, `--no-browser`).
- Tests: `python tools/test.py` (all) or `python tools/test.py data render ui e2e`; runs in headless Edge.
- Screenshots: `python serve.py --no-browser --port 5098` in the background, then `python docs/make_screens.py`.

## Rules
- Order files contain buyers' names and addresses: never save them into the project or commit them; the app keeps everything in the browser.
- Don't copy tcgspeedshipper.com's code, text, images or name; it is the feature reference only.
- Adding a print format: add it to `FORMATS` in render.js, update the format list in `app/tests/render.test.js`, bump `VERSION` in `sw.js`, add a README row.

## Gotchas
- No Node on this PC: JS tests only run through `tools/test.py` (headless Edge).
- TCGplayer's help pages are behind a Cloudflare check; the `Shipped` keyword in the import file and the slip item reader are unconfirmed until a real batch.
- Browsers keep the old app until the service worker's `VERSION` changes: reload once or twice after an update.
