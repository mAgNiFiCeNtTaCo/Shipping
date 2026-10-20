# Ship Desk

Ship Desk turns your TCGplayer orders into print-ready **address labels, packing slips and envelopes**, tells you
**how to ship each order** (stamped envelope, tracking, or signature), estimates the **weight and stamps**, and makes
the **file that marks the orders shipped** on TCGplayer.

It runs on this PC in your web browser. Your buyers' names and addresses never leave the computer.

## Start it

Double-click **`Start Ship Desk.bat`**. A black window opens and your browser opens Ship Desk
(http://127.0.0.1:5091/). Keep the black window open while you work; close it when you're done.

No internet needed. (It needs Python; if it's missing, the window tells you how to install it.)

## The 4 steps

1. **Get your orders file from TCGplayer.** In the Seller Portal go to **Orders**, tick the orders you want to ship,
   and click **Export Shipping**. That saves a `.csv` file. (The **Packing Slip** button makes a PDF, which is a
   different thing, see "Your own packing slips" below.)
2. **Drop the CSV onto Ship Desk** (anywhere on the page), or click the drop box to pick it. Your orders appear in a
   table with a coloured tag for each one:
   - **Envelope OK**: under $20, a stamped envelope is fine.
   - **Tracking recommended**: $20 or more, or the buyer paid for faster shipping.
   - **Tracking required**: $49.99 or more (TCGplayer's rule).
   - **Signature required**: $250 or more.

   Each order also shows its estimated packed weight and, for envelopes, how many Forever stamps it needs.
   Untick any order you don't want to print. The filter buttons show just envelopes, just tracked orders, or
   orders not yet marked shipped.
3. **Print.** Fill in your return address once (it is remembered), pick what you print on, click
   **Download PDF**, open it and print at **100% scale** ("Actual size", not "Fit to page"). On a thermal label
   printer, set the margins to **zero**.
4. **Mark them shipped on TCGplayer.** In "Mark shipped", paste your tracking numbers or tick **Shipped** for
   envelopes without tracking, then click **Download TCGplayer import file**. Upload that file in the Seller
   Portal under **Orders -> Import Shipping Info**.

## What you can print on

| Choice | What you get |
|---|---|
| Thermal label 4 x 6 in | One label per 4x6 label (Rollo, MUNBYN, Dymo and similar). Packing slips come after, also 4x6. |
| Thermal label 6 x 4 in, landscape | The same 4x6 label turned sideways (wide). Packing slips come after, upright 4x6. If the printer cuts it off, pick 4 x 6 paper with auto-rotate on in the print box. |
| Letter paper, 1 / 2 / 3 / 4 labels per page | Full sheet, halves, thirds or quarters, with dashed cut lines. |
| Letter paper, label + packing slip | Label on the top half, packing slip on the bottom half of each page. |
| Avery 5160 / 8160 | 30 address labels per sheet (just the buyer's address). |
| #10 envelope | Prints straight onto a 9.5 x 4.125 in envelope; the stamp corner is left empty. |

Tick boxes under the picker: **Packing slips too**, **Bold return address** (darker on thermal printers) and
**No divider line** (leaves room for stamps or a postage meter).

## Your own packing slips

Click **+ Add TCGplayer packing slips (PDF)** and pick the PDF from TCGplayer's Packing Slip button. Ship Desk
reads which cards are in each order and lists them on its own slips. Tick **Slips in label order** to print
TCGplayer's own slip pages sorted to match your labels instead.

## Paste addresses (eBay, Whatnot, PayPal, email)

Not a TCGplayer order? Open the **Paste addresses** tab in step 1 and paste the addresses, each one on its own
lines (name, street, city ST ZIP) with a blank line between them. You get the same labels and slips. (These
can't go in the TCGplayer import file, because they aren't TCGplayer orders.)

## Make the labels yours

Open **Label design** in step 3: accent colour, font (Sans, Serif or Mono), your logo, thermal darkness, a short
note on each label (up to 60 characters), a QR code to your store, and a message on the packing slips.

**Weights and postage settings** (under the table in step 2) set the weight of a card, envelope, slip and
toploader, how many cards go in one toploader, whether your envelopes are rigid (adds USPS's non-machinable charge) and the Forever stamp price.

## Tracking and Pirate Ship

- In **Mark shipped**, paste one tracking number per line. Either just the numbers, in the same order as your
  labels, or the order number then the tracking number (`SAMPLE-0005 9400 1000 ...`). Or type a number into an
  order's box.
- Orders of **$49.99 or more** must have tracking: Ship Desk warns you if one is ticked Shipped without it.
- **Download Pirate Ship CSV** lists the orders that should get a tracked label and don't have one yet, with their
  estimated weight. In Pirate Ship choose Import -> Spreadsheet.
- Ship Desk remembers what you marked shipped, so if you drop the same file again those orders aren't ticked
  for printing. **Clear shipped history** forgets it.

## Where your files go (the Saved folder)

Everything Ship Desk makes is saved straight into the **`Saved`** folder inside the Ship Desk folder
(`D:\ClaudeProjects\Shipping\Saved`), not into your Downloads. Your browser's other downloads still go to Downloads as before.

| Folder | What's in it |
|---|---|
| `Saved\Labels` | the label PDFs (`labels-2026-10-20.pdf`) |
| `Saved\Packing slips` | "Only my slips, in label order" PDFs |
| `Saved\TCGplayer import files` | the files you upload under Orders -> Import Shipping Info |
| `Saved\Pirate Ship` | Pirate Ship CSVs |
| `Saved\History` | History downloads |

- A second file with the same name on the same day is kept as `labels-2026-10-20 (2).pdf`; nothing is overwritten.
- After each save the message shows where the file is, with an **Open the folder** button. Under the Download PDF
  button there is also **Open the Saved folder**.
- Prefer your Downloads folder? Under the Download PDF button, **Where files go** -> **My Downloads folder**. Ship
  Desk remembers the choice.
- The black Ship Desk window does the saving. If it was closed, files fall back to your Downloads folder and the
  message says so.
- These files contain your buyers' names and addresses: they stay on this PC (the folder is never put in git or on GitHub).

## History

Click **History** at the top to see every order you made labels for or marked shipped, newest first.

- An order is added when you click **Download PDF**, and updated when you mark it shipped (tracking number
  or the Shipped tick). Orders you mark shipped without printing here are added too.
- Each row shows when its labels were made and on what (4x6, Avery, ...; "2 times" if you reprinted), the order,
  buyer, city, value, plan, and whether it shipped (date, tracking number, a "Track on USPS/UPS" link).
- You can tick **Shipped** or type a tracking number right there, even days later without the file: a TCGplayer
  order then also counts as shipped in step 4, so it goes in the import file next time you load its CSV.
- Buttons: **All / Labels made, not shipped / Shipped**, a search box (order #, buyer, city or tracking),
  **Download history (CSV)** for Excel or Google Sheets, **Remove** on a row, and **Clear history**.
- Only the buyer's name, city, state and ZIP are kept, never the street address. Up to 5,000 orders; the oldest
  drop off after that.

## Where your data is kept

Only in this browser on this PC: your return addresses, design and settings, which orders you marked shipped,
and the History list.
Order files are read in the browser and never uploaded or saved in the Ship Desk folder. A different browser
(or another PC) starts empty.

## Honest limits

- These are **address labels, not postage.** Add stamps, or buy a tracked label (Pirate Ship, USPS, ...) for
  orders that need tracking.
- Stamp counts are estimates from USPS's letter prices (from 2026-10-04) and the weights in your settings.
  Weigh a heavy order to be sure.
- Two things were built from public descriptions because TCGplayer's help pages couldn't be read directly.
  **Check them on your first real batch:**
  - the word **`Shipped`** that the import file puts in the tracking column for orders shipped without tracking
    (if TCGplayer refuses it, tell Claude what the error says);
  - reading the **card list from TCGplayer's packing-slip PDF**. If a slip shows "Card details are on your
    TCGplayer packing slip" instead of the cards, the reader didn't recognise the layout: use
    **Slips in label order** to print TCGplayer's own slips.

## For developers

Static browser app in `app/` (no build step), served by `serve.py`. Tests: `python tools/test.py` (runs every
suite in headless Edge). Screenshots: start `python serve.py --no-browser --port 5098`, then
`python docs/make_screens.py`. Build spec: `CONTRACT.md`; test results: `docs/TEST_REPORT.md`.
