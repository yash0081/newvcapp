export type ExtractedClaim = {
  claim_type: string;
  key: string | null;
  quote: string;
  confidence: number;
};

function hasNumber(s: string): boolean {
  return /\d/.test(s);
}

function norm(s: string): string {
  return s.toLowerCase();
}

function inferKey(t: string): string | null {
  const s = norm(t);
  if (s.includes("tam")) return "tam";
  if (s.includes("sam")) return "sam";
  if (s.includes("som")) return "som";
  if (s.includes("arr")) return "arr";
  if (s.includes("mrr")) return "mrr";
  if (s.includes("revenue")) return "revenue";
  if (s.includes("customer")) return "customers";
  if (s.includes("user")) return "users";
  if (s.includes("pipeline")) return "pipeline";
  if (s.includes("growth")) return "growth";
  if (s.includes("churn")) return "churn";
  if (s.includes("retention")) return "retention";
  if (s.includes("contract") || s.includes("loi")) return "contracts";
  if (s.includes("raised") || s.includes("funding") || s.includes("seed") || s.includes("series")) return "funding";
  if (s.includes("partner")) return "partnerships";
  return null;
}

function inferType(t: string): string {
  const s = norm(t);
  if (hasNumber(s)) return "metric";
  if (s.includes("will ") || s.includes("plan ") || s.includes("committed")) return "commitment";
  if (s.includes("partner") || s.includes("integrat") || s.includes("signed")) return "relationship";
  if (s.includes("risk") || s.includes("concern")) return "risk";
  if (s.includes("market") || s.includes("industry")) return "market";
  if (s.includes("product") || s.includes("platform")) return "product";
  return "other";
}

export function extractClaimsFromSentences(sentences: string[], max = 120): ExtractedClaim[] {
  const out: ExtractedClaim[] = [];
  for (const raw of sentences) {
    const quote = raw.trim().replaceAll(/\s+/g, " ");
    if (quote.length < 12) continue;
    const claim_type = inferType(quote);
    const key = inferKey(quote);
    // MVP filter: only keep sentences that look fact-ish (numbers, markets, commitments).
    const keep = claim_type !== "other" || hasNumber(quote);
    if (!keep) continue;
    out.push({
      claim_type,
      key,
      quote: quote.length > 800 ? `${quote.slice(0, 800)}…` : quote,
      confidence: hasNumber(quote) ? 0.65 : 0.5,
    });
    if (out.length >= max) break;
  }
  return out;
}

