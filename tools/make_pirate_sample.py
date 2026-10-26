"""Make app/samples/pirateship-shipments-sample.xlsx: a made-up Pirate Ship Shipments export for the tests.

Same columns and cell types as a real export (2026-10-25): text cells in sharedStrings, Cost as a number,
empty Email / Source cells left out of the sheet. Buyers are the invented ones in tcgplayer-sample.csv.
Run: python tools/make_pirate_sample.py
"""
import os
import zipfile
from xml.sax.saxutils import escape

OUT = os.path.join(os.path.dirname(__file__), "..", "app", "samples", "pirateship-shipments-sample.xlsx")

HEADERS = ["Created Date", "Recipient", "Email", "Tracking Number", "Cost", "Status", "Batch", "Label Size",
           "Saved Package", "Ship From", "Tracking Status", "Source"]
ROWS = [
    # SAMPLE-0005 (ordered 10/15/2026)
    ["10/18/26 9:12 AM EDT", "Marcus Delgado", "", "9300110000000000000005", 4.97, "Purchased", "Marcus Delgado: 1 Label Batch",
     "4x6", "Small Bubble Mailer", "Card Shop", "In Transit", ""],
    # SAMPLE-0008
    ["10/18/26 9:13 AM EDT", "Lena Fairweather", "", "9300110000000000000008", 4.97, "Purchased", "Lena Fairweather: 1 Label Batch",
     "4x6", "Small Bubble Mailer", "Card Shop", "Delivered", ""],
    # SAMPLE-0009, written differently (case, no hyphen, trailing comma like a real export had)
    ["10/19/26 1:40 PM EDT", "rafael ito brandt ,", "", "9300110000000000000009", 5.42, "Purchased", "rafael ito brandt: 1 Label Batch",
     "4x6", "Small Bubble Mailer (Modified)", "Card Shop", "New label, not scanned yet", ""],
    # A refunded label: left out
    ["10/18/26 9:14 AM EDT", "Gideon Marsh", "", "9300110000000000000007", 4.97, "Refunded", "Gideon Marsh: 1 Label Batch",
     "4x6", "Small Bubble Mailer", "Card Shop", "Other", ""],
    # Label made before Tess Okafor's order (10/16/2026): not hers
    ["10/15/26 8:00 AM EDT", "Tess Okafor", "", "9300110000000000000006", 4.97, "Purchased", "Tess Okafor: 1 Label Batch",
     "4x6", "Unsaved Package", "Card Shop", "Delivered", ""],
    # Nobody in the orders
    ["10/18/26 9:15 AM EDT", "Pat Nobody", "", "9300110000000000000099", 4.97, "Purchased", "Pat Nobody: 1 Label Batch",
     "4x6", "Small Bubble Mailer", "Card Shop", "In Transit", ""],
]


def col(i):
    s = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def main():
    strings, index = [], {}

    def sid(text):
        if text not in index:
            index[text] = len(strings)
            strings.append(text)
        return index[text]

    rows_xml = []
    for r, row in enumerate([HEADERS] + ROWS, start=1):
        cells = []
        for c, v in enumerate(row):
            ref = f"{col(c)}{r}"
            if v == "":
                continue
            if isinstance(v, (int, float)):
                cells.append(f'<c r="{ref}"><v>{v}</v></c>')
            else:
                cells.append(f'<c r="{ref}" t="s"><v>{sid(v)}</v></c>')
        rows_xml.append(f'<row r="{r}">{"".join(cells)}</row>')

    main_ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    rel_ns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    files = {
        "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>',
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        "xl/_rels/workbook.xml.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
        "xl/workbook.xml": f'<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="{main_ns}" xmlns:r="{rel_ns}">'
        '<sheets><sheet name="Worksheet" sheetId="1" r:id="rId1"/></sheets></workbook>',
        "xl/sharedStrings.xml": f'<?xml version="1.0" encoding="UTF-8"?><sst xmlns="{main_ns}" count="{len(strings)}" uniqueCount="{len(strings)}">'
        + "".join(f"<si><t>{escape(s)}</t></si>" for s in strings) + "</sst>",
        "xl/worksheets/sheet1.xml": f'<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="{main_ns}"><sheetData>{"".join(rows_xml)}</sheetData></worksheet>',
    }
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        for name, text in files.items():
            z.writestr(name, text)
    print("wrote", os.path.normpath(OUT))


if __name__ == "__main__":
    main()
