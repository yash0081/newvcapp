import { runWithTextMulti } from "@/lib/gemini";
import { PROMPT_SIMILAR_DEALS_RERANK } from "@/lib/deal-sourcing-prompts";
import { SIMILAR_PEERS_TOP_K } from "@/lib/similar-deals/constants";
import type { RerankCandidatePayload } from "@/lib/similar-deals/types";

export async function rerankTop3(args: RerankCandidatePayload): Promise<string[]> {
  const { profile, topCandidates } = args;
  if (topCandidates.length <= SIMILAR_PEERS_TOP_K) return topCandidates.map((c) => c.deal_id);
  try {
    const payload = {
      top_indices: topCandidates.map((c, i) => ({
        index: i,
        company_name: c.company_name,
        sector: c.sector,
        stage: c.stage,
        moat_type: c.moat_type,
        decision: c.decision,
        pass_reason: c.pass_reason,
        pass_reason_detail: c.pass_reason_detail,
        risk_flags: c.risk_flags,
        pre_score: c.pre_score,
      })),
    };
    const summary = {
      problem: profile.problem.normalized_slice,
      solution: profile.solution.normalized_slice,
      market: profile.market_document ?? "",
    };
    const raw = (await runWithTextMulti(
      PROMPT_SIMILAR_DEALS_RERANK,
      [
        { label: "new_deal_summary", value: summary },
        { label: "candidate_deals", value: payload },
      ],
      "flash_lite",
      false
    )) as Record<string, unknown>;

    const idxs = Array.isArray(raw.top_indices)
      ? raw.top_indices.filter((x): x is number => typeof x === "number" && Number.isInteger(x))
      : [];
    const unique = Array.from(new Set(idxs)).filter((i) => i >= 0 && i < topCandidates.length).slice(0, 3);
    if (unique.length === 3) {
      return unique.map((i) => topCandidates[i].deal_id);
    }
  } catch (e) {
    console.warn("rerankTop3:", e);
  }
  return topCandidates.slice(0, SIMILAR_PEERS_TOP_K).map((c) => c.deal_id);
}
