import { ok, eq } from "./runner.js";

export const tests = {
  "vendored libraries load": async () => {
    ok(window.jspdf && window.jspdf.jsPDF, "jsPDF");
    ok(window.pdfjsLib, "pdf.js");
    ok(typeof window.qrcode === "function", "qrcode-generator");
  },
  "jsPDF output can be read back by pdf.js": async () => {
    const doc = new window.jspdf.jsPDF({ unit: "in", format: [4, 6] });
    doc.text("HELLO 123", 0.5, 1);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "../vendor/pdf.worker.min.js";
    const pdf = await window.pdfjsLib.getDocument({ data: doc.output("arraybuffer") }).promise;
    const page = await pdf.getPage(1);
    const text = (await page.getTextContent()).items.map((i) => i.str).join(" ");
    eq(pdf.numPages, 1);
    ok(text.includes("HELLO 123"), "text round trip: " + text);
  },
};
