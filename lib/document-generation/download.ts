import "server-only";

export type DownloadFormat = "markdown" | "text" | "docx" | "pdf";

function sanitizeFilename(name: string): string {
  const safe = name.trim().replaceAll(/[^a-zA-Z0-9._-]+/g, "_").replaceAll(/^_+|_+$/g, "");
  return (safe || "generated-document").slice(0, 120);
}

function stripMarkdown(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

function htmlEscape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function markdownToWordHtml(title: string, content: string): string {
  const body = content
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return "";
      const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
      if (heading) {
        const level = Math.min(3, heading[1]!.length);
        return `<h${level}>${htmlEscape(heading[2] ?? "")}</h${level}>`;
      }
      return `<p>${htmlEscape(trimmed).replaceAll("\n", "<br>")}</p>`;
    })
    .join("\n");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${htmlEscape(title)}</title>
  <style>
    body { font-family: Arial, sans-serif; font-size: 11pt; line-height: 1.45; color: #111827; }
    h1, h2, h3 { color: #111827; margin: 18pt 0 8pt; }
    p { margin: 0 0 10pt; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

function documentPreviewHtml(title: string, content: string): string {
  const body = content
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return "";
      const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
      if (heading) {
        const level = Math.min(3, heading[1]!.length);
        return `<h${level}>${htmlEscape(stripMarkdown(heading[2] ?? ""))}</h${level}>`;
      }
      return `<p>${htmlEscape(stripMarkdown(trimmed)).replaceAll("\n", "<br>")}</p>`;
    })
    .join("\n");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${htmlEscape(title)}</title>
  <style>
    :root { color-scheme: light; }
    body {
      margin: 0;
      padding: 32px;
      background: #ffffff;
      color: #18181b;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 15px;
      line-height: 1.65;
    }
    main { max-width: 860px; margin: 0 auto; }
    h1, h2, h3 {
      margin: 22px 0 10px;
      color: #09090b;
      font-weight: 650;
      letter-spacing: 0;
      line-height: 1.25;
    }
    h1 { font-size: 25px; }
    h2 { font-size: 20px; }
    h3 { font-size: 17px; }
    p { margin: 0 0 14px; }
  </style>
</head>
<body>
  <main>
    <h1>${htmlEscape(title)}</h1>
    ${body}
  </main>
</body>
</html>`;
}

function pdfEscape(s: string): string {
  return s.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function wrapLine(line: string, maxChars: number): string[] {
  const words = line.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const out: string[] = [];
  let cur = "";
  for (const word of words) {
    if (!cur) {
      cur = word;
    } else if ((cur.length + 1 + word.length) <= maxChars) {
      cur += ` ${word}`;
    } else {
      out.push(cur);
      cur = word;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function makeSimplePdf(title: string, content: string): Buffer {
  const plain = `${title}\n\n${stripMarkdown(content)}`;
  const wrapped = plain.split(/\n/).flatMap((line) => wrapLine(line, 92));
  const linesPerPage = 48;
  const pages: string[][] = [];
  for (let i = 0; i < wrapped.length; i += linesPerPage) pages.push(wrapped.slice(i, i + linesPerPage));
  if (!pages.length) pages.push([""]);

  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };

  const catalogId = add("<< /Type /Catalog /Pages 2 0 R >>");
  void catalogId;
  const pagesId = add("PAGES_PLACEHOLDER");
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds: number[] = [];

  for (const pageLines of pages) {
    const streamLines = [
      "BT",
      "/F1 10 Tf",
      "54 738 Td",
      "14 TL",
      ...pageLines.map((line) => `(${pdfEscape(line)}) Tj T*`),
      "ET",
    ];
    const stream = streamLines.join("\n");
    const contentId = add(`<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`);
    const pageId = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  }

  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

export function buildGeneratedDocumentDownload(args: {
  title: string;
  content: string;
  format: string;
}): { body: Buffer | string; filename: string; contentType: string } {
  const format = args.format === "pdf" || args.format === "docx" || args.format === "text" ? args.format : "markdown";
  const base = sanitizeFilename(args.title);
  if (format === "pdf") {
    return {
      body: makeSimplePdf(args.title, args.content),
      filename: `${base}.pdf`,
      contentType: "application/pdf",
    };
  }
  if (format === "docx") {
    return {
      body: markdownToWordHtml(args.title, args.content),
      filename: `${base}.doc`,
      contentType: "application/msword; charset=utf-8",
    };
  }
  if (format === "text") {
    return {
      body: stripMarkdown(args.content),
      filename: `${base}.txt`,
      contentType: "text/plain; charset=utf-8",
    };
  }
  return {
    body: args.content,
    filename: `${base}.md`,
    contentType: "text/markdown; charset=utf-8",
  };
}

export function buildGeneratedDocumentPreview(args: {
  title: string;
  content: string;
  format: string;
}): { body: Buffer | string; contentType: string } {
  const format = args.format === "pdf" || args.format === "docx" || args.format === "text" ? args.format : "markdown";
  if (format === "pdf") {
    return {
      body: makeSimplePdf(args.title, args.content),
      contentType: "application/pdf",
    };
  }
  if (format === "docx") {
    return {
      body: markdownToWordHtml(args.title, args.content),
      contentType: "text/html; charset=utf-8",
    };
  }
  if (format === "text") {
    return {
      body: documentPreviewHtml(args.title, stripMarkdown(args.content)),
      contentType: "text/html; charset=utf-8",
    };
  }
  return {
    body: documentPreviewHtml(args.title, args.content),
    contentType: "text/html; charset=utf-8",
  };
}
