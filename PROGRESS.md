# Shipping: progress log

Ship Desk: a local browser app that does what tcgspeedshipper.com does (our own code and design). Drop TCGplayer's
"Export Shipping" CSV and get address labels, packing slips and envelopes as one PDF, a shipping plan with
stamps, and the TCGplayer import file that marks the batch shipped.

## Where it stands (2026-10-26)
- Working and in daily use: real thermal labels printed and real phone photos/scans sent 2026-10-20; TCGplayer
  import confirmed 2026-10-25; real packing slip read correctly 2026-10-26. Every part has now met real data.
- **Version 1.1.1** (built and published 2026-10-26), Windows installer for other people:
  `dist\ShipDesk-Setup-<version>.exe` (13 MB, own Python, per-user, no admin), every build kept in `dist\` (log
  `dist\builds.json`). Every /save-progress builds a new one when something changed (`tools/build_installer.py
  --if-changed --test`). MIT licence. Published: https://github.com/mAgNiFiCeNtTaCo/Shipping/releases (v1.0.0, v1.1.0, v1.1.1 = latest). A fresh install sets itself up
  completely: first-run checklist, guided Tailscale phone setup, update notice.
- Runs in the background (no window) and starts with Windows; on/off switch + "Start with Windows" box at the top of
  the page, or `Start Ship Desk.bat` / `Stop Ship Desk.bat` -> http://127.0.0.1:5091/ . Works offline.
- Tests: `python tools/test.py` = **173 passed, 0 failed** (2026-10-26); `tools/test_installer.py` 14 checks.
- 9 print formats: thermal 4x6, thermal 6x4 sideways (upright page, turned layout), letter 1/2/3/4 per page,
  label + slip, Avery 5160, #10 envelope. Labels, envelopes and slips carry an order QR code (switchable).
- History page (header switch) of every order labelled or shipped; generated files save into `Saved\` (gitignored),
  named by time and buyers (`Labels 2026-10-21 14-05 - 3 orders - A, B, C.pdf`). The loaded orders stay through
  reloads and restarts (until cleared, a new file, or 14 days). Pirate Ship's Shipments export (.xlsx) dropped on
  the page puts the tracking numbers on their orders. `Saved\` is backed up to Dropbox every hour
  (`Dropbox\Ship Desk backup`; switch + Dropbox/OneDrive menu on the History page; on since 2026-10-25). History has a copy in
  `Saved\History` (+ daily backups); import files only carry what's new ("Sent to TCGplayer"); proof pack PDF per order.
- Phone page (`/phone.html`, iPhone through Tailscale serve, pairing code): photos per order (contents / packed /
  post office) into `Saved\Photos`, offline queue. Its camera screen scans order QR codes and mailer tracking
  barcodes and takes any number of photos in a row, turned upright by the tilt sensor. Post office photos mark
  orders shipped; unknown mailers become History entries (name + tracking, order # added later). Phone access is
  on (tailnet only, https://taco.tail060b61.ts.net:5091/phone.html).

## Log
### 2026-10-26: import file takes every shipped order; automatic builds on save; 1.1.1
- **Bug (user report):** after scanning all packages at the post office, the TCGplayer import file had 1 order. Cause:
  the import file only took the *loaded* file's orders, and the kept batch was the 1-order packing-slip test file;
  the phone had marked 19 orders shipped in History (all notes applied), 17 never sent. TCGplayer's own Order List
  (D:\Downloads, 00:08) showed which still needed it: 7 envelopes "Ready to Ship" (all post office scans of
  2026-10-26); the older ones were already shipped there (Pirate Ship / earlier uploads).
- **Fix:** import file = loaded orders + History's shipped, not-sent TCGplayer orders (`importCandidates`,
  `historyOnlyOrders`): rows from `KEYS.rows` (every loaded file's rows kept 14 days, `keepRows`) or `rowFromHistory`
  (order #, buyer, city/state/ZIP, tracking; no street, not yet confirmed by a TCGplayer upload). Orders shipped more
  than 14 days ago or before History's earliest `sentAt` (2026-10-25 20:08 here) stay out. Step 4 lists them
  (`#ship-extra`) and shows even with no file loaded. On the real History copy: exactly 9 (7 envelopes + 2 mailers).
- **Phone fix:** a photo added while another was sending waited for the next 15 s timer (`pump` snapshot); now a
  second round runs straight after (`state.pumpAgain`). Found through a flaky test.
- **Standing wish:** every /save-progress builds a new installer when something changed and keeps builds at least a
  month. `tools/build_installer.py --if-changed --test`: fingerprint of everything in the installer (serve.py's
  version line left out) vs `dist/builds.json`, bumps the patch version, runs the browser tests and
  `tools/test_installer.py` (new: silent install over the previous build, run on 5099, save, --stop, uninstall, the
  user's copy and Windows entries untouched; 14 checks), keeps every build (`dist/old/` for rebuilt versions), prunes
  only builds older than 31 days and never the newest 3, writes `dist/release-notes-<v>.md`. Recorded in CLAUDE.md
  ("On /save-progress"), the save-progress skill (step 3b), the shared CLAUDE.md and memory.
- First automatic build: **1.1.1** (`caf281a5...`). The first try stopped on a test that timed out opening the page
  (8 s) during the long full run; it passed 3/3 alone, so the page-start waits are now 20 s; the second try: 173 tests,
  install test 14/14 (over 1.1.0). Release notes rewritten in plain words (the generated list only sees commits).
- Later the same day: 1.1.1 published by the user; the user's copy restarted on 1.1.1 (no banner; backup, phone,
  autostart kept). TCGplayer's help says only Order Number + Tracking Number are required (rows matched by order
  number). Dry run on a private server from the real History copy: the import file has the expected 9 rows, each
  with order #, `Shipped` or tracking, carrier USPS. Waiting for the user's real upload result.

### 2026-10-26: the user's own copy on 1.1.0; desktop shortcut
- Restarted the user's running Ship Desk at their request (`serve.py --stop`, then `launcher_command()`): 1.0.0 ->
  1.1.0; start with Windows, Dropbox backup and phone access (ready, same pairing) carried over; the update check
  sees 1.1.0 as the newest.
- Desktop shortcut "Ship Desk" (`C:\Users\RubenNoodle\Desktop\Ship Desk.lnk`): pythonw.exe
  `D:\ClaudeProjects\Shipping\serve.py` in that folder, icon `shipdesk.ico` (now kept in the project root, a copy of
  the installer's icon, so a rebuild can't break it). Opens the page; starts Ship Desk first when it's off.

### 2026-10-26: Ship Desk 1.1.0: everything a new PC needs (Tailscale setup, welcome checklist, update notice)
- User asked for the update notice and the first-run welcome, and for the package to work exactly like their own
  copy with nothing missing, Tailscale setup included. The gap was Tailscale: a new PC must install it, sign in, and
  switch on Serve/HTTPS for its tailnet once (this PC had all of that already).
- **Phone setup from scratch** (Phone photos window, steps 1-4, polling every 3 s while installing / signing in):
  `POST /api/tailscale-install` downloads `https://pkgs.tailscale.com/stable/tailscale-setup-latest.exe`, checks its
  Windows signature is valid and "O=Tailscale Inc." (PowerShell Get-AuthenticodeSignature, checked on the real file),
  then starts it; `POST /api/tailscale-login` runs `tailscale up` (Stopped) or `tailscale login` and hands back the
  sign-in link; switching on phone access returns Tailscale's Serve/HTTPS enable link (`tailscale_with_link` reads
  the login.tailscale.com link and stops the waiting command); step 4 links the Tailscale app for iPhone and Android.
- **Welcome checklist** (`#welcome`): return address, print format, sample, then optional phone / backup / start with
  Windows / update notice; ticks from the real settings; hide + "Setup checklist" to bring it back. Found by its test:
  typing the return address didn't redraw it (now `renderWelcome` on input).
- **Update notice**: `/api/update` asks GitHub `releases/latest` (once a day, from the page), `Saved/update.json`,
  banner with Download / Not now, switch on the History page; on by default; README says what goes out.
- Installer: optional task "Help me set up phone photos" -> `serve.py --open phone` opens the page at #phone;
  uninstall also removes update.json. Generic texts instead of "Start Ship Desk.bat".
- Tests 169 -> 172 (setup checklist, update notice incl. offline, phone setup from not-installed to QR code);
  tools/test.py stands in for Tailscale and GitHub (`POST /__tailnet`). Install test: 1.0.0 then 1.1.0 over it
  keeps the files folder and its files; the user's copy and Windows entries untouched.
- Released v1.1.0 (the user ran `gh release create`; asset checksum matches the tested file; GitHub's latest = 1.1.0).
- Not yet confirmed: the first-time Tailscale steps on a PC that never had Tailscale (only stand-ins + the real
  pieces were tested here). The user's running Ship Desk still runs the older server code until Turn off / Turn on.

### 2026-10-26: Windows installer (Ship Desk 1.0.0), MIT licence
- User asked to package Ship Desk as a Windows installer others can set up their own way. Inno Setup 6.7.3 installed
  with winget at the user's OK (build tool only).
- `tools/build_installer.py`: stages serve.py + app/ (no tests) + Python 3.14.7 embeddable (sha256 checked against
  python.org's release-file API) + `shipdesk.ico` (icon.svg drawn by headless Edge, Pillow, 9 sizes) + "Ship Desk
  guide.html" (README without the developer notes, through a small Markdown converter: wrapped lines joined first
  so bold across a wrap works; list paragraphs by indent) + LICENSE + `installer/THIRD-PARTY-NOTICES.txt` (jsPDF MIT,
  pdf.js Apache-2.0, qrcode-generator MIT, @zxing/library Apache-2.0, zxing-wasm MIT + zxing-cpp Apache-2.0,
  Python PSF), then ISCC -> `dist\ShipDesk-Setup-1.0.0.exe` (13.0 MB).
- `installer/ShipDesk.iss`: per-user (no admin, %LOCALAPPDATA%\Programs\Ship Desk), files folder page (default
  Documents\Ship Desk, user's choice; `/DATADIR=`), tasks desktop icon + start with Windows; Start menu: Ship Desk,
  Turn off Ship Desk, Ship Desk files, guide. Writes `install.json`. Updates stop the running copy first. Uninstall
  removes the Run value / shipdesk:// key only if they start this copy, and asks before deleting only Ship Desk's own
  subfolders (a broad folder like Documents is never wiped).
- serve.py: `APP_VERSION` 1.0.0, `data_root()` (install.json "dataDir", else Saved next to it: this folder unchanged),
  `--stop` / `--stop-any`, `/api/ping` reports version + home.
- Problem on the way: the first install test's `--stop` turned off the user's running copy (its older process didn't
  report "home", and the check let "unknown" through). Turned it straight back on (about a minute off; backup still on,
  Dropbox) and fixed: only a copy that says it is this folder is stopped. Also: a plain silent install would have
  ticked "start with Windows" (both tasks default on); tests use `/MERGETASKS="!desktopicon,!autostart"`.
- Tested: silent install to a temp folder, ran it on port 5099, page served, a saved label landed in the chosen
  files folder, its `--stop` left the user's copy on, uninstall cleaned up, the user's Run value and shipdesk:// key
  identical before/after (twice, the second time on the final file). 169 tests pass.
- Recommended to the user and agreed: MIT licence (LICENSE, copyright mAgNiFiCeNtTaCo), a GitHub release, no code
  signing for now (the SmartScreen "More info -> Run anyway" step is in the guide and notes), try the wizard on another
  Windows account. Code pushed (271e59f). Creating the release was blocked by Claude Code's auto-mode check
  (public surface): the user runs `gh release create v1.0.0 "dist/ShipDesk-Setup-1.0.0.exe" --title "Ship Desk 1.0.0"
  --notes-file "dist/release-notes-1.0.0.md" --target main` (notes kept in dist\, gitignored).

### 2026-10-26: first real TCGplayer packing slip; item reader fixed
- The user ran a real slip PDF (1 order, `TCGplayer_PackingSlips_...pdf` in D:\Downloads): the page matched its order
  and the printed label + slip used TCGplayer's own page, so the printout was right.
- But the item reader was wrong for the real layout: items read "YuGiOh - Beyond the Brave - Elemental Saga Doriado -
  #BETB-EN028 - Secret Rare - Near Mint 1st Edition", wrapped onto a second line, with Price and Total Price columns.
  Ship Desk took "YuGiOh" as the card name and dropped the wrapped part (only Ship Desk's own slip layout shows it).
- slips.js: `describeItem` (name = the part before "#Number"; without a number the third part when the first is a
  game; the game name is left out of the detail; plain "Name - detail" lines as before), `pageRows` (lines with their
  x), `itemsFromRows` (joins the indented rows under an item that have no price and aren't totals). `parseItemLine`
  keeps its old shape.
- Checked on the real slip in a throwaway browser (copy deleted after): 3 x "Elemental Saga Doriado", "Beyond the
  Brave - #BETB-EN028 - Secret Rare - Near Mint 1st Edition", $3.00. Tests 167 -> 169 (describeItem cases; a
  made-up slip laid out like the real one, two items, both wrapped). Cache `shipdesk-v22`.

### 2026-10-26: one post office photo per order; step through the pile
- User asked whether a post office photo went to every scanned order: it did (every shutter press went to all orders
  on the camera screen). Their wish: one post office photo for each scanned order. Now, with Post office selected,
  a photo goes only to the order(s) scanned since the previous post office photo (`scan.fresh`), ticked ✓ on screen;
  another photo without a new scan is a retake for the same order (`scan.lastPost`). Contents and packed photos
  still go to every order on screen (not asked to change).
- The To do list's "One photo for all N" became **Step through all N** (user's choice over removing it):
  `openScanner(keys, { steps: true })` makes one order current (▶ chip, "Post office photo for ... (1 of 4)"), each
  photo moves on to the next (`nextStep`), "All N done" at the end; × skips an order, scanning a label makes it
  the current one.
- Explained to the user: scanning picks the order by itself (Ship Desk's QR code always; a bought label's tracking
  barcode once Ship Desk knows the number, e.g. after dropping Pirate Ship's Shipments export; otherwise it asks
  once and remembers).
- Tests 166 -> 167 (scan A / photo / scan B / photo / retake counts per order; stepping: one photo each, skip,
  scan to jump). Found on the way: awaiting `openScanner` hangs in headless Edge (camera start never settles) and a
  static canvas `captureStream` sends no frames: tests start it like a tap and keep repainting. Phone cache
  `shipdesk-phone-v11`; no PC restart.

### 2026-10-26: phone "To do" list
- The phone page opens on a new **To do** view (filter `todo`, the old "Not shipped" and "All" stay): orders not
  shipped that are loaded on the PC, labelled in the last 14 days (`TODO_DAYS`) or have photos waiting on the phone,
  grouped by the photo they need next: Contents photo next / Packed photo next / To the post office. Counts saved +
  waiting photos; a packed photo skips the contents step; a post office photo takes the order off (the PC marks it
  shipped as before). Old labels never marked shipped are not listed.
- Each order has a camera button (picks it, sets the kind, opens the camera); "To the post office" has "One photo for
  all N" for the pile. Picked orders that aren't on the list show under "Picked" at the top (two scan tests needed
  that: a mailer just scanned is shipped, but must stay in sight). phone.js `nextPhoto` / `todoGroups` / `todoRows`.
- Camera buttons narrowed (icon above the word) after checking phone screenshots (light + dark); `docs/screens`
  phone shots retaken. Phone cache `shipdesk-phone-v9`; no restart needed (serve.py unchanged).
- Test 165 -> 166: contents -> packed -> post office on pasted orders of its own (the sample orders already have
  photos from earlier tests), one-tap camera, one photo for all, old labels left out, search, other views.
- Next: real-iPhone checks of the To do list and camera; a real packing-slip PDF (user); photo storage.

### 2026-10-26: backup moved from OneDrive to Dropbox
- Right after the OneDrive backup (late 2026-10-25) the user asked to move it to Dropbox. Dropbox runs on this PC
  (`C:\Users\RubenNoodle\Dropbox`, path read from `%LOCALAPPDATA%\Dropbox\info.json`).
- serve.py: the place is a setting (`backup.json` `to`: dropbox | onedrive; none = onedrive, for backups made before):
  `dropbox_base()` / `onedrive_base()` / `backup_folder(place)`; `POST /api/backup?to=...` (backs up right away when
  on). `set_backup` switches and backs up in one locked step (`backup_into`): the test saw the new place with no
  backup yet in between. History page: a Dropbox / OneDrive menu next to the switch (`#backup-to`,
  `setBackupPlace`); messages name the place. Cache `shipdesk-v21`.
- Test: the backup test now picks Dropbox from the menu; its async waits use `waitForServer` (the suite's `waitFor`
  treats a promise as done at once). 165 pass.
- Restarted at the user's OK; first Dropbox backup 2026-10-25 23:39: 218 files / 171 MB, compared file by file with
  the OneDrive copy (identical), then the OneDrive copy was deleted at the user's request (OneDrive's online recycle
  bin keeps it ~30 days).

### 2026-10-25: hourly backup of the Saved folder to OneDrive
- User asked "what's next"; suggested a backup of `Saved\` first (photos lived on D: only). Offered E:/G: (other
  drives) or OneDrive; **the user chose OneDrive** (told: buyers' names, addresses and photos go to their Microsoft
  account).
- serve.py: `onedrive_folder()` (`%OneDrive%\Ship Desk backup`), `copy_new_files` / `run_backup` (new or changed
  files only, by size + time; `.part` then rename), `backup_loop` thread (60 s after start, then hourly, port 5091
  only) while `Saved/backup.json` says on. Never deletes in the backup. Not copied: `Phone/pairing-code.txt` (the
  phone's key stays on the PC), `ship-desk.log*`, `*.tmp`/`*.part`. Refuses a backup folder inside `Saved` (or the
  reverse). `GET /api/backup`, `POST /api/backup?on=1|0|now=1|open=1` (PC page only).
- History page: "Back up the Saved folder to OneDrive every hour" box, last backup line, Back up now, Open the backup
  folder (app.js `loadBackup` / `setBackup` / `backupNow`). Cache `shipdesk-v20`.
- Tests 164 -> 165 (tools/test.py sends the backup to a temp folder, `GET /__backup` lists it); direct checks of the
  skip list, changed files, deleted files kept, the inside-Saved refusal. README "Backup to OneDrive", CLAUDE.md.
- Restarted Ship Desk at the user's OK (shutdown API + `launcher_command()`), switched the backup on: first run
  copied 218 files / 171 MB, pairing code not among them. Note: `tailscaled` also listens on port 5091 (tailnet
  addresses), so "is the port free" checks must look at 127.0.0.1 only.
- Next: real-iPhone checks and a real packing-slip PDF (user); phone "to do" list; photo storage (OneDrive is on
  C:, 43 GB free; ~5 MB/order).

### 2026-10-25: loaded orders survive a reload; tracking numbers from Pirate Ship's export
- **Batch kept across reloads** (the agreed next step): the loaded CSV / pasted text, ticks, filter and label order
  are kept in the browser (`shipdesk.batch`, app.js `keepBatch` / `restoreBatch` / `clearBatch`) and come back on
  start with a "Your orders are still here" note. Step 1 shows "N orders from <file>, loaded <time>" and a **Clear
  these orders** button (History and shipped marks stay). Forgotten after 14 days (`BATCH_DAYS`) or when a new file
  replaces them. Packing-slip pages are not kept (too big). So the import file can be made later without dropping
  the CSV again.
- **Pirate Ship tracking import**: new `app/js/pirate.js`. The user's first file was the Transactions export
  (payments only, no tracking); the Shipments export (Reports -> View All Shipments -> Export) is an .xlsx with
  Created Date, Recipient, Tracking Number, Status, ... and **no order # or ZIP**. So:
  - `readXlsx` reads .xlsx with the browser's own `DecompressionStream` (no library); a .csv export works too.
  - `matchShipments` matches by buyer name (accents/case/punctuation ignored, first+last fallback): the buyer's one
    order without tracking from the 21 days before the label (`MATCH_DAYS`); several -> listed, never guessed;
    labels already on an order, voided labels and labels older than every known order are summed up.
  - app.js `applyShipments`: works on the loaded orders (step 4 message) and on History alone (step 1 message:
    drop that day's CSV for the import file). Transactions or other spreadsheets get an explanation.
  - Dry run on the user's real export vs the History copy (throwaway browser, counts only): 22 labels -> 15
    already there (phone scans), 6 older than Ship Desk, 1 non-TCGplayer buyer, 0 wrong matches.
- Tests 158 -> 164: batch reload/clear/14 days (ui), .xlsx reading + matching rules (data), dropping the export
  with and without orders loaded (e2e); invented `app/samples/pirateship-shipments-sample.xlsx` made by
  `tools/make_pirate_sample.py`. One phone test assumed a reload empties the page (fixed). Passed twice. Cache
  `shipdesk-v19`; no restart needed (serve.py unchanged).
- Next: the user's real-iPhone checks and a real packing-slip PDF; backup of `Saved\` (needs a place chosen);
  photo storage; phone "to do" list.

### 2026-10-25: security audit and its fixes
- A full /security-audit (security-auditor subagent, report-only, nothing changed during it) of the week's new parts:
  report `D:\ClaudeProjects\Security_Agent_Audit\reports\2026-10-25-Shipping.md` (proofs in `reports\proofs\`).
  0 critical / high / medium, 3 low, 4 info. Checked and fine: other websites can't reach PC-only routes (62 raw
  attempts refused, DNS rebinding included), the phone side only gets its files + `/api/phone/*` (path tricks 404,
  `Saved/` never served), pairing code ~2^60 with `hmac.compare_digest`, fixed shutdown/autostart/shipdesk://
  commands, no innerHTML/eval anywhere, the public repo's history has no secrets or buyer data.
- Fixed at the user's request (same day):
  - **01 `__proto__` order key** (a forged link/post office note for it marked every order shipped): serve.py
    `valid_order_key()` on photo/link/rekey/order list; app.js `own()`/`safeKey()` in `takePhoneLinks`; phone.js
    `parseScan` refuses such keys.
  - **02 CSV formulas**: `toCsv(rows, { spreadsheetSafe })` puts `'` before `= + - @` cells; History CSV only
    (TCGplayer / Pirate Ship files stay exact).
  - **03 headers**: nosniff, no-referrer, X-Frame-Options SAMEORIGIN and a Content-Security-Policy (self only,
    'wasm-unsafe-eval' for the barcode reader, data:/blob: images; not on /tests/).
  - Info 07: README's opening now says what the phone receives.
  - Not changed (info): jsPDF 2.5.2 / pdf.js 3.11.174 advisories not reachable (pdf.js runs with isEvalSupported
    false); the Tailscale address in this log grants nothing; any local program can use the PC routes (as designed,
    one-account PC).
- Tests 155 -> 158 (headers + labels and a slip PDF read inside the page with no policy violations; `__proto__`
  refused and harmless; formula-safe History CSV); the live camera test now checks the WebAssembly reader really ran
  (`readers.used`). Passed twice. Caches `shipdesk-v17` / `shipdesk-phone-v8`. Ship Desk restarted at the user's OK;
  page and phone address serve the new headers. Fixes noted at the end of the audit report.
- Open questions from the audit for the user: who else is on the tailnet (a Tailscale rule could limit port 5091 to
  the iPhone); if the phone is lost, remove it from Tailscale and press New pairing code.

### 2026-10-25: first real TCGplayer upload; untracked rows need carrier USPS
- The user's first real import file (1 envelope order, Tracking `Shipped`, Carrier empty) came back from TCGplayer's
  Import Tracking page as "0 rows imported ... Carrier is unrecognized". TCGplayer's help article is 403 to fetchers,
  so the fix followed the error: untracked rows now get Carrier `USPS` (tracking.js `importFileCsv`). Re-uploaded
  with "Put them in again": "1 row successfully imported, 0 errors". So the import file is confirmed for tracked
  and untracked orders; only the slip item reader is still unchecked on real data.
- Explained the routine to the user: phone post office photo / mailer scan marks orders shipped on the PC; with the
  day's TCGplayer export loaded, one click makes one CSV with everything new; upload stays manual (user's choice).
- The History copy (`Saved\History\ship-desk-history.json` + Backups) appeared after the user's page load: working.
- Tests updated for the carrier (still 155, all pass). README, CLAUDE.md, CONTRACT.md updated. Cache `shipdesk-v16`.
- Next (suggested): /security-audit of the week's new endpoints; keep the loaded batch across page reloads (so
  the import file never needs the CSV dropped again); Pirate Ship export import; backups; photo storage.

### 2026-10-25: History copy on the PC, "sent to TCGplayer", proof packs
- User asked for improvement ideas, then "start wherever you think is best". Suggested (in order): History copy,
  remember what went to TCGplayer, proof pack, Pirate Ship export import, phone "to do" view, photo storage growth
  (~5 MB/order), backups of `Saved\`, first real TCGplayer upload check, real-iPhone checks, a security review. Did the
  first three; the rest stay open.
- **History copy:** `GET/POST /api/history-copy` -> `Saved/History/ship-desk-history.json` + `Backups/history-<date>.json`
  (30 days). The browser writes it 0.8 s after each change, but only once "linked" (`shipdesk.historyCopy`): a cleared
  browser (or another one) gets an offer in History (Restore = merge + rebuild step 4's shipped list; Keep = this
  browser's becomes the copy) and never overwrites the copy first. Clear history is followed by the copy (dated
  backups stay). The live copy is written when the user next loads the page (not there yet at the save).
- **Sent to TCGplayer:** making the import file marks each order `state.shipped[id].sent = { at, what }` and History
  `sentAt`; the next file leaves out orders sent with the same tracking / "Shipped" (an order that got tracking since
  goes in again); step 4 shows how many and a "Put them in again" box; "Sent to TCGplayer <date>" in step 4 and History.
  `withSent` keeps the note when other code rewrites a shipped entry. Import files made before 2026-10-25 weren't
  recorded, so their orders can appear once more.
- **Proof pack:** "Make proof pack (PDF)" in an order's photos window: letter PDF, page 1 = order, buyer, city/ZIP,
  value, label made, shipped, tracking + clickable tracking page, sent to TCGplayer, every photo small with its
  time; then one photo per page. `Saved\Proof packs`, `Proof pack <date time> - <buyer> - <order #>.pdf`, no street.
  Screenshot `docs/screens/proof-pack.png` (new phone-preview mode "proof").
- Phone status no longer says "Sending..." for a moment when nothing is waiting (it made a phone test flaky in a
  full run once).
- Tests 152 -> 155 (History copy offer/restore/keep/clear and refusals; import only what's new / changed / again;
  proof pack pages, text, link, images, file name), passed twice. Caches `shipdesk-v15` / `shipdesk-phone-v7`.
  Ship Desk restarted at the user's OK (off via the page's request, on via shipdesk://start).

### 2026-10-21: on/off switch, runs in the background, starts with Windows
- **On/off switch** (user: a button on the web app to turn Ship Desk on and off; asked which "this" meant, user chose
  Ship Desk itself): header `#power` shows on / off / turning off / starting, checks `GET /api/ping` every 10 s.
  Turn off asks first, then `POST /api/shutdown` (Ship Desk's own page only) stops the server. Turn on is the link
  `shipdesk://start`: serve.py registers it for this Windows user (HKCU\Software\Classes\shipdesk) on each start;
  the command is fixed (never takes the link's text) and starts Ship Desk with `--no-browser`. The page itself opens
  from sw.js's offline copy while Ship Desk is off.
- **In the background** (user): `Start Ship Desk.bat` starts `pythonw serve.py` and closes; with no console serve.py
  logs to `Saved/ship-desk.log` and shows start problems in a message box. New `Stop Ship Desk.bat` (curl to
  `/api/shutdown`). A second start sees Ship Desk already running and only opens the page.
- **Bug found in the live test, fixed:** two Ship Desks could listen on 5091 at once. Python's server asks for
  SO_REUSEADDR, which on Windows lets a second process bind the same port, so "already running" was never noticed
  and Turn off stopped only one. Now `Server.server_bind` uses SO_EXCLUSIVEADDRUSE (a second bind fails with 10048).
  The second copy came from an old visible window: cmd reads a running .bat from disk line by line, so after Ship
  Desk stopped it went on into the newly edited .bat and started a background copy.
- **Start with Windows** (user): HKCU Run value "Ship Desk" = the windowless command (`set_autostart`), shown in
  Task Manager > Startup apps; "Start with Windows" box in the header (`POST /api/autostart`). Switched on for the
  user; the exact command was run while Ship Desk was up and correctly said "already running".
- Live checks on the user's PC: start (window closes), second start, Stop Ship Desk, Turn on via shipdesk://start,
  Turn off the page's way, on again; phone address still answers. Restarts were done at the user's OK.
- Tests 150 -> 152 (switch: refused for other sites and the phone, asks first, off, Turn on link, back on; Start with
  Windows on/off survives a reload). tools/test.py stands in for stopping and the startup list. The e2e offline test
  now skips `scheme:` links. Caches `shipdesk-v14`.

### 2026-10-21: tracking barcodes read much better (zxing-wasm)
- User: QR codes scan great, but a mailer's tracking barcode took forever and needed the camera moved around.
- Cause found with a 96-picture benchmark (1440x1920 phone-like pictures of a USPS label: bar width 1.4-3 px,
  blur 0.6/1.2 px, 0/4 degree tilt, upright/sideways, on white / grey / kraft mailers, grain, uneven light):
  zxing-js decides black/white over a whole row, so a darker mailer beside the white label made it fail outright
  (it only read once the label filled the picture); it also looked at a picture shrunk to 1280 px and spent every
  other look on the sideways copy. Old look: 15/96, 51 ms.
- Tried: zxing-js on two full-sharpness strips squashed across the bars + patch-by-patch thresholds (HybridBinarizer
  rows): 24/96. zxing-wasm 3.1.6 (zxing-cpp as WebAssembly, MIT) on the whole picture: **50/96, 45 ms**, every code
  at once, turns sideways barcodes itself; on strips it did worse (25), and its options (no downscale, denoise,
  global binarizer) changed nothing. The misses are very soft, small barcodes.
- Now: phone.js `decodeFrame` uses zxing-wasm (`vendor/zxing-wasm-3.1.6/`, local .wasm via `locateFile`, picture up
  to 1920 px, QR + Code 128, up to 4 codes, the useful one wins); the JS strips + QR look is the fallback when
  WebAssembly can't start. serve.py serves `.wasm` as application/wasm and lets the phone load both files;
  phone-sw caches them (`shipdesk-phone-v6`).
- Tests 148 -> 150: `cameraPicture()` makes those mailer pictures; kraft/grey/white, tilted and sideways cases must
  read in one look, and the JS fallback must read too; through Tailscale the reader files load. Passed twice.
  Ship Desk restarted at the user's OK; checked the phone's address serves the reader files.
- Open: confirm on the real iPhone with real mailers.

### 2026-10-21: file names that say what's inside, camera asked for once
- **File names** (user: label names too generic, e.g. `labels-2026-10-20 (2).pdf` ... `(5)`): app.js `fileName()`
  names every saved file by date, time and buyers: `Labels 2026-10-21 14-05 - 3 orders - Zackery Twork, Ash Example,
  Pat Doe.pdf` ("... and N more" past 3; one order: `Label <date time> - <buyer> - <order #>.pdf`), `Packing slips ...`,
  `TCGplayer import <date time> - 5 orders.csv`, `Pirate Ship ...`, `Ship Desk history ...`. serve.py `NAME_OK`
  now allows letters of any language, commas, apostrophes, `&`, `+` (max 150). The 5 old `labels-2026-10-20*.pdf`
  files keep their names (renaming them would mean reading each PDF; offered, not done).
- **Camera permission asked every time** (user): each opening of the camera screen called `getUserMedia`, which an
  iPhone home-screen app re-asks. phone.js now keeps the stream for 5 minutes after Done (`KEEP_CAMERA_MS`) and
  reuses it; it stops at once when the app goes to the background. The motion prompt was already once per launch.
  iOS may still ask once per app start (not in the page's control); Safari's Settings for Websites → Camera →
  Allow suggested to the user, not confirmed for home-screen apps.
- Tests stay 148 (file-name patterns updated; the live-camera test now checks a second open doesn't ask again),
  passed twice. Caches `shipdesk-v11` / `shipdesk-phone-v5`. Ship Desk restarted at the user's OK; the live server
  accepts a name like "José O'Hara".

### 2026-10-21: mailer entries, camera screen, post office = shipped, photo turning
- **Mailer not in the list** (user: a scanned USPS label wanted an existing entry; make the entry from name +
  tracking, order # later): the phone's question screen now starts with **Make a new entry** (buyer's name, typed
  or read with the iPhone keyboard's Scan Text; optional TCGplayer order #). Without an order # it is keyed
  `mailer:<tracking>` (history source "mailer"), listed in History as "Mailer scanned on the phone" with an
  **Add order #** box; typing it (`setOrderNumber`) re-keys the record to the order, puts it in step 4's shipped
  list and moves its photos (`POST /api/photos-rekey`; `Saved/Phone/rekeys.json` sends later uploads to the order).
  The server lists phone-made entries in the order list until the PC takes them, so the phone keeps them.
- **Several photos in a row** (user): the scanner became the camera screen: Contents / Packed / Post office switch
  on the picture, round shutter (`shoot`) for any number of photos for all orders on screen, thumbnails strip,
  Done. "Take photo" opens it with the ticked orders; "iPhone camera" still takes one native photo.
- **Sideways photos** (user: rotate photos taken landscape): all 20 photos the user sent were saved tall, i.e. the
  phone held sideways over the desk wasn't noticed. The camera screen reads `devicemotion` gravity (iPhone sign is
  the opposite of Android's), keeps the last turn while the phone lies flat, skips turning when the page itself
  is landscape, and has a tap-to-turn override. The PC photos window got turn left/right buttons that rewrite the
  saved JPEG (`POST /api/photo-rotate`), for photos already saved.
- **Post office photo = shipped** (user): each new post office photo leaves a "shipped" note in `links.json`
  (empty tracking); `takePhoneLinks` marks the order shipped only if it isn't already (tracking and date kept).
- Bug found by the tests: on Windows `os.replace` of photos.json failed while another request was reading it,
  so a photo move could look lost. `read_json` / `write_json` now retry for up to a second.
- Own mistake, recovered: a patch script opened `app/js/phone.js` for writing and then failed on an emoji escape,
  leaving the file empty. Rebuilt from the last commit and re-applied the session's changes in order; the full
  suite proved nothing was lost. Patch scripts now encode before opening the file and keep each file's CRLF/LF.
- Tests 144 -> 148 (mailer entry + order # later, camera shots with turn direction checked by a red corner mark,
  post office shipped vs already shipped, PC turn buttons), stable over 3 runs. Ship Desk restarted twice at the
  user's OK; caches `shipdesk-v10` / `shipdesk-phone-v4`.
- Open: tilt-sensor direction not yet confirmed on the real iPhone (flip `onMotion` if photos turn the wrong way).

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
