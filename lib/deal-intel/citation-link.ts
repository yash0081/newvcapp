export type SentenceRow = {
  id: string;
  page_number: number;
  text: string;
};

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replaceAll(/[^a-z0-9\s]/g, " ")
    .split(/\s+/g)
    .filter((t) => t.length >= 3)
    .slice(0, 40);
}

function overlapScore(a: string[], bSet: Set<string>): number {
  let score = 0;
  for (const t of a) if (bSet.has(t)) score++;
  return score;
}

/**
 * Best-effort matching of an extracted leaf string to an existing `document_sentence` row.
 * Deterministic + local (no embeddings), good enough to attach `sentence_id` for MVP provenance.
 */
export function linkValueToSentence(value: string, sentences: SentenceRow[]): SentenceRow | null {
  const v = value.trim();
  if (!v) return null;
  const needle = v.length > 160 ? v.slice(0, 160) : v;
  const vTokens = tokenize(needle);
  const vSet = new Set(vTokens);

  let best: { row: SentenceRow; score: number } | null = null;
  for (const s of sentences) {
    const st = s.text || "";
    if (!st.trim()) continue;
    // Fast path: direct substring match on a small needle.
    if (needle.length >= 18 && st.toLowerCase().includes(needle.toLowerCase())) {
      return s;
    }
    const stTokens = tokenize(st);
    const score = overlapScore(stTokens, vSet);
    if (!best || score > best.score) best = { row: s, score };
  }

  if (!best) return null;
  // Require some overlap to avoid random links.
  return best.score >= 3 ? best.row : null;
}

export function quoteForProvenance(value: string, max = 220): string {
  const t = value.trim().replaceAll(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

