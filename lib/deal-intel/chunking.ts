export type TextChunk = {
  pageStart: number;
  pageEnd: number;
  charStart: number;
  charEnd: number;
  text: string;
};

/**
 * MVP chunking: per-page fixed-size windows with overlap.
 * `charStart/charEnd` are offsets within the page text (since pageStart==pageEnd).
 */
export function chunkPageText(args: {
  pageNumber: number;
  text: string;
  targetChars?: number;
  overlapChars?: number;
}): TextChunk[] {
  const pageNumber = args.pageNumber;
  const text = args.text || "";
  const target = Math.max(800, args.targetChars ?? 3200);
  const overlap = Math.max(0, Math.min(target - 200, args.overlapChars ?? 400));

  if (!text.trim()) return [];
  if (text.length <= target) {
    return [{ pageStart: pageNumber, pageEnd: pageNumber, charStart: 0, charEnd: text.length, text }];
  }

  const out: TextChunk[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + target);
    const slice = text.slice(start, end).trim();
    if (slice) out.push({ pageStart: pageNumber, pageEnd: pageNumber, charStart: start, charEnd: end, text: slice });
    if (end >= text.length) break;
    start = Math.max(0, end - overlap);
  }
  return out;
}

