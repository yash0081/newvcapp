/**
 * Syntactic splits (conjunctions / light punctuation) on top of semantic chunk boundaries.
 */

export function splitClaimTextOnConjunctions(text: string, minPartLen = 24): string[] {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return [];
  if (t.length < minPartLen * 2) return [t];
  const parts = t
    .split(/\s+(?:\band\b|\bbut\b|\bhowever\b)\s+/i)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);
  if (parts.length <= 1) return [t];
  return parts;
}
