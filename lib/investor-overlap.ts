import type { SimilarPeerForPrompt } from "@/lib/similar-deals";

export type InvestorOverlapSignal = {
  investor_name: string;
  matched_peer_company: string;
  matched_peer_decision: string | null;
  matched_peer_pass_reason_detail: string | null;
  matched_peer_similarity_confidence: number;
};

function norm(s: string): string {
  return s.trim().toLowerCase();
}

export function extractInvestorNamesFromAny(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) {
    const out: string[] = [];
    for (const item of v) {
      if (typeof item === "string" && item.trim()) out.push(item.trim());
      else if (item && typeof item === "object") {
        const r = item as Record<string, unknown>;
        if (typeof r.name === "string" && r.name.trim()) out.push(r.name.trim());
      }
    }
    return Array.from(new Set(out));
  }
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  if (v && typeof v === "object") {
    const r = v as Record<string, unknown>;
    const out: string[] = [];
    for (const key of ["investors", "investor_list", "notable_investors"]) {
      out.push(...extractInvestorNamesFromAny(r[key]));
    }
    return Array.from(new Set(out));
  }
  return [];
}

export function computeInvestorOverlapSignals(
  investorNames: string[],
  peers: SimilarPeerForPrompt[]
): InvestorOverlapSignal[] {
  const names = Array.from(new Set(investorNames.map(norm)));
  if (names.length === 0 || peers.length === 0) return [];
  const signals: InvestorOverlapSignal[] = [];
  for (const p of peers) {
    // Overlap can be with any similar company (passed or invested); decision is carried through as context.
    const peerInvestorMap = new Map((p.investors ?? []).map((i) => [norm(i), i]));
    for (const n of names) {
      if (!peerInvestorMap.has(n)) continue;
      signals.push({
        investor_name: peerInvestorMap.get(n) ?? n,
        matched_peer_company: p.company_name,
        matched_peer_decision: p.decision ?? null,
        matched_peer_pass_reason_detail: p.pass_reason_detail ?? null,
        matched_peer_similarity_confidence: p.similarity_confidence,
      });
    }
  }
  // Prefer highest-similarity matches first to keep the context compact.
  signals.sort((a, b) => b.matched_peer_similarity_confidence - a.matched_peer_similarity_confidence);
  return signals.slice(0, 30);
}

