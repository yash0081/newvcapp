export type PdfPageText = {
  pageNumber: number; // 1-indexed
  text: string;
};

type ExtractScriptOutput = {
  pages: PdfPageText[];
};

function normalizePageText(s: string): string {
  // Keep it deterministic and readable; citations rely on stable strings.
  return s
    .replaceAll("\u0000", "")
    .replaceAll(/\r\n/g, "\n")
    .replaceAll(/[ \t]+\n/g, "\n")
    .replaceAll(/\n{3,}/g, "\n\n")
    .replaceAll(/[ \t]{2,}/g, " ")
    .trim();
}

export async function extractPdfTextByPage(pdfBuffer: Buffer): Promise<PdfPageText[]> {
  // Running pdfjs inside Next.js' server bundle can crash in some runtimes
  // (e.g. "Object.defineProperty called on non-object"). To make parsing
  // robust, run extraction in a plain Node process outside the bundler.
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");

  const run = promisify(execFile);
  const dir = await mkdtemp(join(tmpdir(), "crm-pdf-"));
  const pdfPath = join(dir, "document.pdf");

  try {
    await writeFile(pdfPath, pdfBuffer);

    const scriptPath = join(process.cwd(), "scripts", "extract-pdf-text-by-page.mjs");
    const { stdout, stderr } = await run(process.execPath, [scriptPath, pdfPath], {
      maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, NODE_ENV: "production" },
    });

    const out = String(stdout || "").trim();
    if (!out) {
      const errText = String(stderr || "").trim();
      throw new Error(errText ? `PDF extract script produced no output: ${errText}` : "PDF extract script produced no output");
    }

    let parsed: ExtractScriptOutput;
    try {
      parsed = JSON.parse(out) as ExtractScriptOutput;
    } catch {
      const errText = String(stderr || "").trim();
      throw new Error(
        `PDF extract script returned non-JSON output.${errText ? ` stderr: ${errText}` : ""} stdout: ${out.slice(0, 5000)}`,
      );
    }
    const pages = Array.isArray(parsed.pages) ? parsed.pages : [];
    return pages.map((p) => ({
      pageNumber: Number(p.pageNumber),
      text: normalizePageText(String(p.text || "")),
    }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

