export type SentenceSpan = {
  text: string;
  charStart: number;
  charEnd: number;
};

function isTerminal(ch: string): boolean {
  return ch === "." || ch === "!" || ch === "?";
}

/**
 * Deterministic, lightweight sentence splitter.
 * Returns spans (char offsets) within the provided page text.
 */
export function splitIntoSentenceSpans(pageText: string): SentenceSpan[] {
  const s = pageText || "";
  const out: SentenceSpan[] = [];
  let start = 0;

  const push = (a: number, b: number) => {
    const raw = s.slice(a, b);
    const text = raw.trim();
    if (!text) return;
    const leftTrim = raw.length - raw.replace(/^\s+/, "").length;
    const rightTrim = raw.length - raw.replace(/\s+$/, "").length;
    out.push({ text, charStart: a + leftTrim, charEnd: b - rightTrim });
  };

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!isTerminal(ch)) continue;
    const next = s[i + 1] ?? "";
    // End a sentence only on whitespace / line break boundary.
    if (next && !/\s/.test(next)) continue;
    push(start, i + 1);
    start = i + 1;
  }

  push(start, s.length);

  // Prevent extremely long sentences (bad PDF layout). Split on double newlines as fallback.
  const maxLen = 600;
  const final: SentenceSpan[] = [];
  for (const span of out) {
    if (span.text.length <= maxLen) {
      final.push(span);
      continue;
    }
    const parts = span.text.split(/\n{2,}/g).map((p) => p.trim()).filter(Boolean);
    if (parts.length <= 1) {
      final.push(span);
      continue;
    }
    let cursor = span.charStart;
    for (const p of parts) {
      const idx = s.indexOf(p, cursor);
      if (idx >= 0) {
        final.push({ text: p, charStart: idx, charEnd: idx + p.length });
        cursor = idx + p.length;
      }
    }
  }

  return final;
}

