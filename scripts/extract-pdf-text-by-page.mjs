import { readFile } from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

function normalizePageText(s) {
  return String(s || "")
    .replaceAll("\u0000", "")
    .replaceAll(/\r\n/g, "\n")
    .replaceAll(/[ \t]+\n/g, "\n")
    .replaceAll(/\n{3,}/g, "\n\n")
    .replaceAll(/[ \t]{2,}/g, " ")
    .trim();
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: node scripts/extract-pdf-text-by-page.mjs <pdf_path>");
    process.exit(2);
  }

  const buf = await readFile(filePath);
  const loadingTask = getDocument({ data: new Uint8Array(buf) });
  const pdf = await loadingTask.promise;

  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const items = content.items || [];
    const raw = items.map((it) => (typeof it?.str === "string" ? it.str : "")).join(" ");
    pages.push({ pageNumber: i, text: normalizePageText(raw) });
  }

  process.stdout.write(JSON.stringify({ pages }));
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});

