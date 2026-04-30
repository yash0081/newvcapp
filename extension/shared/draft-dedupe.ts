/**
 * Near-duplicate detection for auto-draft snippets (paraphrases of the same fact).
 * Keep in sync with lib/copilot/draft-dedupe.ts.
 */

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "all",
  "can",
  "her",
  "was",
  "one",
  "our",
  "out",
  "has",
  "have",
  "been",
  "being",
  "will",
  "with",
  "from",
  "that",
  "this",
  "these",
  "those",
  "such",
  "than",
  "then",
  "them",
  "they",
  "their",
  "also",
  "into",
  "over",
  "more",
  "most",
  "some",
  "very",
  "what",
  "when",
  "where",
  "which",
  "while",
  "about",
  "after",
  "before",
  "between",
  "through",
  "during",
  "under",
  "within",
  "without",
  "other",
]);

export function tokenSetForDraftDedupe(text: string): Set<string> {
  const raw = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/);
  const out = new Set<string>();
  for (const w of raw) {
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    out.add(w);
  }
  return out;
}

function diceSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return (2 * inter) / (a.size + b.size);
}

function overlapCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.min(a.size, b.size);
}

function normalizedCompact(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function isNearDuplicateDraftSnippet(incoming: string, existingTexts: readonly string[]): boolean {
  const inc = incoming.trim();
  if (inc.length < 28) return false;

  const incNorm = normalizedCompact(inc);
  const incTokens = tokenSetForDraftDedupe(inc);
  if (incTokens.size < 6) return false;

  for (const ex of existingTexts) {
    const e = ex.trim();
    if (!e || e.length < 28) continue;

    const exNorm = normalizedCompact(e);
    const exTokens = tokenSetForDraftDedupe(e);
    if (exTokens.size === 0) continue;

    const shorter = incNorm.length <= exNorm.length ? incNorm : exNorm;
    const longer = incNorm.length <= exNorm.length ? exNorm : incNorm;
    if (shorter.length >= 70 && longer.includes(shorter.slice(0, Math.min(140, shorter.length)))) {
      return true;
    }

    const dice = diceSimilarity(incTokens, exTokens);
    const overlap = overlapCoefficient(incTokens, exTokens);
    if (dice >= 0.48 || overlap >= 0.68) return true;
  }

  return false;
}
