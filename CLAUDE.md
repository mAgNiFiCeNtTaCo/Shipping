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
- `app/js/pirate.js`: Pirate Ship's Shipments export (Reports -> View All Shipments -> Export, an .xlsx; .csv works too)
  -> tracking numbers. `readXlsx` unzips with the browser's DecompressionStream (no library), `readShipments`,
  `matchShipments` (by buyer name: the one open order from `MATCH_DAYS` = 21 before the label; never guesses between
  several). app.js `applyShipments` / `shipmentCandidates` (batch orders + History). The real export has no order #
  or ZIP (checked 2026-10-25); Order ID / ZIP columns are used if present. The Transactions export has no tracking.
- `app/js/orderlist.js` (2026-10-26): TCGplayer's Order List export (`TCGplayer_OrderList_<yyyymmdd>_<hhmmss>.csv`: Order #,
  Buyer Name, Order Date, Status, ...; no addresses) dropped on the page -> app.js `applyOrderList`: `compareOrderList` lists
  forgotten (shipped here, still "Ready to Ship" there), missed, canceled, already shipped there; each History record gets
  `tcg: { status: open|shipped|canceled, text, at }` (`at` = time in the file name). history.js `tcgSays(r)` (an "open"
  older than or same minute as `sentAt` no longer counts), `notSentYet` = History filter `notsent`. importCandidates: "open"
  drops `sent` (goes in again, past the 14-day / firstSent cutoffs), "shipped" = `sent: { tcg: true }` (left out;
  tracking.js skips `sent.tcg`). Chips `.tcg-open` / "Shipped on TCGplayer" in step 4 and History.
- TCGplayer tracked envelopes (announced 2026-10-27, sellers get it 2026-11-02..06: free USPS IMb on the packing slip for
  orders <= $49.99, window envelope, own stamps). Plan setting `trackedEnvelopes` (plan.js, off by default; checkbox in
  "Weights and postage settings"): letter-size `envelope` / non-expedited `tracking-recommended` orders -> tag
  `tracked-envelope` (`isEnvelopeTag`, tracked false = not in the Pirate Ship file). `app/js/imb.js` (2026-10-29): USPS-B-3200
  encoder/decoder (`encodeImb`, `decodeImb`; checked against USPS's Figure 5), `drawImb` (jsPDF, 22 bars/in), `findImb`
  (bars in an ImageData, any quarter turn). slips.js `readSlipPdf(buf, ids, { imb: true })` (when the setting is on)
  renders each slip page at 300 dpi -> `entry.imb` -> `attachSlips` sets `order.imb`; render.js `imbFor` prints it under
  the ship-to block (labels, labelSlip, envelope10; not Avery). Not yet seen: a real tracked slip (layout, whether its
  barcode is vector/font/image, whether TCGplayer's protection counts with the barcode on our label).
- `app/js/render.js` (all PDF formats, `FORMATS`), `app/js/slips.js` (reads TCGplayer's packing-slip PDF).
- Loaded batch kept across reloads: `KEYS.batch` holds the CSV/pasted text + ticks (app.js `keepBatch` / `restoreBatch` /
  `clearBatch`, "Clear these orders" in step 1, 14 days at most; full addresses, this browser only; slips not kept).
- `app/js/history.js`: the History page's records (`shipdesk.history` in localStorage: name/city/ZIP only, no street).
- `app/phone.html` + `js/phone.js` + `css/phone.css` + `phone-sw.js` (scope `./phone`, network-first): the iPhone page for
  order photos (contents / packed / post office). Photos wait in the phone's IndexedDB (`shipdesk-phone`) until
  `POST /api/phone/photo` succeeds; saved to `Saved/Photos/<order # buyer>/`, listed in `Saved/Photos/photos.json`.
- Scanning (phone.js `decodeFrame`): main reader `vendor/zxing-wasm-3.1.6/` (zxing-cpp as WebAssembly, `readBarcodes`, all codes
  in the picture at once, turns sideways ones; served as application/wasm, `locateFile` points at the local .wasm). Fallback
  `vendor/zxing-library-0.21.3.min.js` (JS): Code 128 from two squashed strips with patch-by-patch thresholds, QR from the
  whole picture. Both loaded only when the scanner opens.
  Order QR = `SHIPDESK:<history key>` (render.js `orderQrText`, design option `orderQr`, not on Avery). A mailer's
  unknown tracking number is linked to an order on the phone, queued like a photo (`link: true`), sent to
  `POST /api/phone/link` -> `Saved/Phone/links.json`; the PC page takes them (`takePhoneLinks`, `GET /api/links`,
  `POST /api/links-done`) into History + `state.shipped`. A mailer with no order in the list becomes a new entry
  keyed `mailer:<tracking>` (history source "mailer"); typing its order # in History (`setOrderNumber`) re-keys it and
  `POST /api/photos-rekey` moves its photos (`Saved/Phone/rekeys.json` sends late uploads to the order).
- Phone "To do" view (default filter `todo`, phone.js `nextPhoto` / `todoGroups` / `todoRows`): not-shipped orders that are
  in the PC batch, labelled in the last `TODO_DAYS` = 14, or have photos waiting; grouped by the next photo (packed
  skips contents; a post office photo ends it), counting saved + waiting photos. Row camera button (`data-shoot`) picks,
  sets the kind and clicks `#btn-cam`; "Step through all" (`data-shoot-all`) = `openScanner(keys, { steps: true })`:
  `scan.steps`, `nextStep()` makes one order current (`scan.fresh`), each post office photo moves on; × skips. Picked orders off the list show under
  "Picked".
- Post office photos on the camera screen go only to `scan.fresh` (scanned since the last post office photo), else
  `scan.lastPost` (retake); `scan.posted` get a tick chip. Contents/packed photos go to all of `scan.found` (user's
  wish 2026-10-26).
- Camera screen = the scanner (`#scanner`): shutter (`shoot`) takes any number of photos for `scan.found` without
  leaving; turn from `devicemotion` gravity (`onMotion`, iOS sign differs from Android; flat keeps the last turn;
  no turn when the page itself is landscape); `#cam-turn` overrides. A post office photo leaves a "shipped" note
  (`links.json`, empty tracking) that `takePhoneLinks` applies only to orders not shipped yet. PC turn buttons:
  canvas rotate + `POST /api/photo-rotate`. The camera stream is reused and kept 5 min after Done (`KEEP_CAMERA_MS`):
  iPhone home-screen apps re-ask on every `getUserMedia`.
- On/off switch in the PC header (app.js `checkPower` / `turnOff`, `#power`): `GET /api/ping`, `POST /api/shutdown`
  (PC page only; `stop_server` -> the .bat ends, window closes). Turn on = link `shipdesk://start`, registered by
  serve.py `register_launcher()` in HKCU\Software\Classes\shipdesk on each start (port 5091 only); it runs
  `pythonw serve.py --no-browser` (no window; the .bat only without pythonw) and never passes the link's text on.
- Background: `Start Ship Desk.bat` starts `pythonw serve.py` and closes (falls back to a visible window without
  pythonw); with no console serve.py logs to `Saved/ship-desk.log` and shows start problems in a message box.
  Port claimed exclusively (`Server.server_bind`, SO_EXCLUSIVEADDRUSE): a second start sees `already_running()`
  and only opens the page. `Stop Ship Desk.bat` posts `/api/shutdown` with curl.
- Start with Windows: HKCU\...\CurrentVersion\Run value "Ship Desk" = `launcher_command()` (serve.py
  `set_autostart` / `autostart_enabled`, `POST /api/autostart?on=1|0`, `#power-auto` in the header; refreshed on each
  start). Switched on for the user on 2026-10-21. tools/test.py stands in for it (never touches the registry).
  tools/test.py fakes `stop_server` (records "STOP" in `/__opened`).
- Backup (user chose Dropbox 2026-10-25, OneDrive before): serve.py copies new/changed files in `Saved\` to
  `<Dropbox or OneDrive>\Ship Desk backup` (`backup_folder(place)`: Dropbox's path from `%LOCALAPPDATA%\Dropbox\info.json`,
  OneDrive from `%OneDrive%`; `run_backup` / `set_backup` / `backup_into`; `backup_loop` thread: 60 s after start, then
  hourly, port 5091 only) while `Saved/backup.json` (`on`, `to`) says on; no `to` = onedrive. Never deletes in the backup;
  skips `Phone/pairing-code.txt`, `ship-desk.log*`, `*.tmp`. `GET /api/backup`, `POST /api/backup?on=1|0&to=dropbox|onedrive
  |now=1|open=1`; History page `#backup-row` + `#backup-to` (app.js `loadBackup` / `setBackup` / `setBackupPlace` /
  `backupNow`). tools/test.py points `backup_folder_for()` at a temp folder (`GET /__backup` lists it).
- History copy: `GET/POST /api/history-copy` -> `Saved/History/ship-desk-history.json` (+ `Backups/history-<date>.json`,
  30 days). A browser writes it only once linked (`KEYS.historyCopy` = "on"); unlinked + different -> `#history-copy`
  offer (`restoreHistoryCopy` merges, rebuilds `state.shipped`; `keepThisHistory`). `copyHistory` runs 0.8 s after
  every `saveHistory`.
- Import file = loaded orders + History's shipped, not-sent TCGplayer orders (app.js `importCandidates` /
  `historyOnlyOrders`, 2026-10-26: it used to take only the loaded file, so post office scans of earlier files were
  left out). Their rows: `KEYS.rows` (every loaded file's rows by order #, `keepRows`, `ROW_DAYS` = 14) else
  `rowFromHistory` (no street). Left out: shipped more than 14 days ago, or before History's earliest `sentAt` (handled
  before the import file kept track). `#ship-extra` lists them; step 4 shows even with no file loaded.
- Sent to TCGplayer: making the import file sets `state.shipped[id].sent = { at, what }` (what = tracking or
  "Shipped") and history `sentAt`; `importFileCsv(..., { skipSent })` leaves out same-`what` orders unless
  `state.importAgain` ("Put them in again"). Code that rewrites a shipped entry keeps `sent` (`withSent`).
- Proof pack (app.js `proofPack`, photos window button): jsPDF letter PDF, page 1 facts + thumbnails, then one photo
  per page (photos redrawn as JPEG via createImageBitmap); kind "proof" -> `Saved/Proof packs`.
- Saved file names come from app.js `fileName()` ("Labels <date> <HH-MM> - N orders - buyer, buyer ...pdf"); serve.py
  `NAME_OK` must keep allowing what it produces (any-language letters, `,'&+()`).
- `app/sw.js` offline cache (bump `VERSION` whenever app files change), `app/manifest.webmanifest`, `app/icon.svg`.
- `app/vendor/` jsPDF 2.5.2, pdf.js 3.11.174, qrcode-generator 1.4.4, @zxing/library 0.21.3, zxing-wasm 3.1.6 reader (MIT) (no CDN: the app works offline).
- `app/samples/tcgplayer-sample.csv` invented sample orders; `pirateship-shipments-sample.xlsx` invented Pirate Ship
  labels for those buyers (made by `tools/make_pirate_sample.py`, same columns as the real export). `app/tests/` browser test suites.
- `Saved/` (gitignored, real buyer addresses): files the app makes, written by `serve.py` (`POST /api/save`,
  `/api/open-folder`; only Ship Desk's own page may call them: Host + Origin + `X-Ship-Desk` header). Tests write to a temp folder.
  `Saved/Phone/pairing-code.txt` is a secret (the phone's key): never print or commit it.
- Phone access: `serve.py` stays on 127.0.0.1; the phone comes in through `tailscale serve --https=5091` (switched on/off
  by the Phone photos window, tailnet only, never Funnel). Anything with X-Forwarded-For / Tailscale-User-* headers or a
  non-local Host gets only `PHONE_FILES` + `/api/phone/*` (with the `X-Ship-Desk-Key` pairing code).
- `serve.py` local server, `tools/test.py` test runner, `docs/make_screens.py` + `docs/screens/` screenshots.
- Windows installer (2026-10-26): `tools/build_installer.py` -> `dist/ShipDesk-Setup-<APP_VERSION>.exe` (build/ and dist/
  gitignored). It stages serve.py + app/ (no tests) + Python's embeddable zip (`PY_VERSION`, checked against
  `PY_SHA256` from python.org's API) + `shipdesk.ico` (icon.svg drawn by Edge, Pillow) + "Ship Desk guide.html" (README
  without "For developers", own small converter) + `installer/THIRD-PARTY-NOTICES.txt`, then compiles
  `installer/ShipDesk.iss` (Inno Setup 6, per-user, no admin, AppId DCB21337-...). Setup asks the files folder (default
  Documents\Ship Desk, `/DATADIR=` on the command line) and writes `{app}\install.json` {"dataDir"}; serve.py
  `data_root()` reads it (no install.json = Saved next to serve.py, as in this folder). Tasks: desktop icon, start
  with Windows (same Run value as `launcher_command()`). Uninstall removes the Run value / shipdesk:// key only when
  they point into {app}, and asks before deleting only Ship Desk's own subfolders in the files folder.
  Since 1.1.2 (audit 2026-10-26): a chosen folder that isn't empty (and isn't the previous one / marked) gets `\Ship Desk`
  appended (`UsableDataDir`, also at ssInstall for silent installs); setup writes the marker `Ship Desk files.txt` into a
  new/empty folder (or one named Ship Desk) and uninstall deletes only where the marker is (`/DELETEFILES=1` = silent
  delete, used by test_installer.py); default folder `{localappdata}\Ship Desk` when Documents is inside OneDrive, and a
  warning for OneDrive/Dropbox folders. serve.py `signed_by` compares the signer's subject fields exactly
  (`TAILSCALE_SIGNER` O/C/SERIALNUMBER, `subject_fields`, `signer_matches`; PowerShell by full path); `tools/test.py`
  runs these as the "server" checks (`python tools/test.py server`).
  `serve.py --stop` turns off only the copy whose `/api/ping` "home" is this folder (`--stop-any` for any).
- 1.1.0 (2026-10-26): first-run checklist (`#welcome`, app.js `welcomeItems` / `renderWelcome` / `setWelcome`,
  `KEYS.welcome` {hidden, format, sample, phone}; ticks come from real settings; "Setup checklist" `#btn-setup` brings
  it back). Update notice: serve.py `/api/update` (GET status; POST `now=1` asks GitHub `releases/latest` of
  `UPDATE_REPO`, `on=1|0`; `Saved/update.json`, daily from the page via `checkUpdates`), `#update-note` banner,
  `#update-row` switch on the History page, "Not now" = `KEYS.updateSkip`. Phone setup from scratch (`renderPhone`
  steps 1-4): `POST /api/tailscale-install` (downloads `TAILSCALE_SETUP_URL`, `signed_by()` checks the Windows signature
  is "O=Tailscale Inc." via PowerShell, then starts it; `ts_setup` state), `POST /api/tailscale-login` (`tailscale up`
  when Stopped, else `tailscale login` -> `loginLink`), `/api/phone-access` returns Tailscale's Serve/HTTPS
  `enableLink` (`tailscale_with_link` reads the login.tailscale.com link and stops the waiting command). The window
  polls every 3 s while installing / signing in. `serve.py --open phone` opens the page at `#phone` (installer task
  "phonesetup"). tools/test.py fakes all of it: `tailnet` dict, `POST /__tailnet {...}` (reset, installed, running,
  needsLogin, stopped, needEnable, latest, offline); tests never reach GitHub or Tailscale.
- `shipdesk.ico` (project root): the Ship Desk icon for the user's desktop shortcut "Ship Desk.lnk" (pythonw.exe
  serve.py here, made 2026-10-26); the installer makes its own copy in build/stage.
- `specs/` the build briefs of 2026-10-20.

## On /save-progress (the user's standing wish, 2026-10-26)
Every save: `python tools/build_installer.py --if-changed --test` before the git snapshot. It builds a new installer
only when something that goes into it changed since the last build (fingerprint in `dist/builds.json`), bumps the
patch version in serve.py when needed (1.1.0 -> 1.1.1; commit that), runs the browser tests first and
`tools/test_installer.py` on the result (silent install over the previous build, run on port 5099, stop, uninstall,
the user's own copy and Windows entries untouched). Keep every build at least a month: they stay in `dist/` (older
same-version files in `dist/old/`); the script removes only builds older than 31 days, never the newest 3. It writes
`dist/release-notes-<version>.md` (its "What's new" comes from commit subjects, so rewrite it in plain words from the
save's log entry: this save's own work isn't committed yet); publishing stays the user's (auto mode blocks `gh release create`): give them the
printed `gh release create ...` line. Log the new version in PROGRESS.md and on the card.

## Commands
- Run: `Start Ship Desk.bat` (background) / `Stop Ship Desk.bat`, or `python serve.py` (in a window) ->
  http://127.0.0.1:5091/ (`--port`, `--no-browser`, `--stop`).
- Installer: `python tools/build_installer.py` (Inno Setup 6 in %LOCALAPPDATA%\Programs, installed 2026-10-26 with winget);
  `--if-changed --test` = the save-progress build (see above). `python tools/test_installer.py <exe> [--upgrade-from <older exe>]`
  checks one by itself.
- Tests: `python tools/test.py` (all) or `python tools/test.py data render ui e2e`; runs in headless Edge.
- Screenshots: `python serve.py --no-browser --port 5098` in the background, then `python docs/make_screens.py`
  (`python docs/make_screens.py phone` = only the phone shots, on a private server with fake Tailscale).

## Rules
- Order files contain buyers' names and addresses: never save them into the project or commit them; the app keeps everything in the browser.
- Don't copy tcgspeedshipper.com's code, text, images or name; it is the feature reference only.
- Adding a print format: add it to `FORMATS` in render.js, update the format list in `app/tests/render.test.js`, bump `VERSION` in `sw.js`, add a README row.
- Security (audit 2026-10-25, report in `D:\ClaudeProjects\Security_Agent_Audit\reports\2026-10-25-Shipping.md`):
  order keys from the phone go through serve.py `valid_order_key()`; app.js looks keyed lists up with `own()` (never
  `state.history[key]` for a key from outside); CSVs meant for Excel use `toCsv(..., { spreadsheetSafe: true })`;
  pages are served with a Content-Security-Policy (`CSP` in serve.py): no inline scripts, new script/wasm/worker
  sources must be allowed there. No innerHTML anywhere: keep building DOM with `el()` / textContent.

## Gotchas
- No Node on this PC: JS tests only run through `tools/test.py` (headless Edge).
- Testing the installer on this PC: install silently to a temp folder with `/MERGETASKS="!desktopicon,!autostart"
  /NOICONS /DATADIR=...` (both tasks are ticked by default: a plain silent install would point the user's "Start with
  Windows" at the test copy), run it on another port, never on 5091. On 2026-10-26 a test `--stop` turned off the
  user's running copy because that older process didn't report "home"; now a copy that doesn't say where it runs
  from is left on. PowerShell scripts can't be run with `powershell -Command & x.ps1` here (execution policy): use
  the PowerShell tool.
- TCGplayer's help pages are behind a Cloudflare check (403 to fetchers). Confirmed on a real upload 2026-10-25: an
  untracked row = Tracking `Shipped` + Carrier `USPS` (an empty carrier is refused: "Carrier is unrecognized").
  TCGplayer's help ("Importing Shipping Info for Customer Orders", found via search 2026-10-26) says rows are matched by
  Order Number and only Order Number + Tracking Number are required. Confirmed on a real upload 2026-10-26: 9 rows built
  from History (no street; 7 `Shipped` + 2 tracked) all imported.
  Slip reader checked on a real slip 2026-10-26: items read "Game - Set - Name - #Number - Rarity - Condition" and wrap
  onto a second line (slips.js `describeItem`, `itemsFromRows` joins indented rows without a price).
- Windows reads a running .bat from disk line by line: editing `Start Ship Desk.bat` while an old window still runs
  it made that window start a second copy when Ship Desk stopped (2026-10-21). Close old windows first.
- Browsers keep the old app until the service worker's `VERSION` changes: reload once or twice after an update.
- Home network is double NAT: the phone can't reach 192.168.1.x, so phone access is Tailscale only (iPhone "iphone182").
- `--virtual-time-budget` screenshots don't wait for IndexedDB: the phone shots use real-time DevTools capture (`live_shot`).
- Tests never touch real Tailscale (`tools/test.py` fakes `tailscale_status` / `tailscale_switch`).
- The `thermal6x4` label is an upright 4x6 page with the layout turned (render.js `sideways`): thermal printers cut a wide page off.
- Patch scripts: encode before opening for "wb" (a failed write must not empty the file), keep each file's
  line endings (CRLF files exist), and never re-run a script whose `new` text contains its `old` text.
- zxing-js (the fallback) finds one code per look, doesn't turn 1D barcodes, and its row reader fails when a darker
  mailer is beside the label (whole-row threshold): hence strips + HybridBinarizer rows. On 96 phone-like test pictures
  the old look read 15, JS strips 24, zxing-wasm 50 (the misses are very soft small barcodes). `cameraPicture()` in
  phone.test.js makes such pictures. Scanner tests use a canvas `captureStream()` as the camera.
