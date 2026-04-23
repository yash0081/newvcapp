import type { SupabaseClient } from "@supabase/supabase-js";
import type { DealRetrievalEmbeddings, DealRetrievalProfile } from "@/lib/deal-retrieval-profile";
import { parseVector } from "@/lib/data-layer/shared/vector";
import {
  fetchDealOwner,
  fetchDealRetrievalProfile,
  rpcMatchSimilarDealsFromDeal,
} from "@/lib/data-layer/schema-access/similar-deals";
import { SIMILAR_PEERS_TOP_K } from "@/lib/similar-deals/constants";
import { fetchSimilarPeersFromRetrievalProfile } from "@/lib/similar-deals/pipeline";
import type { RpcHybridRow, SimilarPeerForPrompt } from "@/lib/similar-deals/types";

/**
 * Similar deals for deal page — uses stored embedding on source deal.
 */
export async function fetchSimilarDealsFromDealId(
  admin: SupabaseClient,
  sourceDealId: string,
  limit = SIMILAR_PEERS_TOP_K
): Promise<SimilarPeerForPrompt[]> {
  const { data: sourceDeal } = await fetchDealOwner(admin, sourceDealId);
  if (!sourceDeal?.user_id) return [];
  const { data: profileRow } = await fetchDealRetrievalProfile(admin, sourceDealId);
  if (!profileRow) {
    // Legacy fallback until retrieval index has been backfilled.
    const { data, error } = await rpcMatchSimilarDealsFromDeal(admin, sourceDealId, limit);
    if (error) {
      console.error("fetchSimilarDealsFromDealId:", error);
      return [];
    }
    const rows = (data ?? []) as RpcHybridRow[];
    const sliced = rows.slice(0, limit);
    const rrfVals = sliced.map((r) => Number(r.rrf_score ?? 0));
    const min = rrfVals.length ? Math.min(...rrfVals) : 0;
    const max = rrfVals.length ? Math.max(...rrfVals) : 0;
    const denom = max - min;
    const normalize = (rrf: number): number => {
      if (Math.abs(denom) < 1e-9) return max > 0 ? 1 : 0;
      return Math.max(0, Math.min(1, (rrf - min) / denom));
    };

    return sliced.map((r) => {
      const rrf = Number(r.rrf_score ?? 0);
      return {
        deal_id: r.id,
        company_name: r.company_name ?? "Unknown",
        problem_one_liner: null,
        solution_one_liner: null,
        investors: [],
        decision: null,
        pass_reason: null,
        pass_reason_detail: null,
        risk_flags: [],
        rrf_score: rrf,
        similarity_confidence: normalize(rrf),
      };
    });
  }

  const profile: DealRetrievalProfile = {
    problem: {
      normalized_slice:
        typeof profileRow.problem_normalized === "string" ? profileRow.problem_normalized : "unknown",
      search_concepts: [],
    },
    solution: {
      normalized_slice:
        typeof profileRow.solution_normalized === "string" ? profileRow.solution_normalized : "unknown",
      search_concepts: [],
    },
    market_document:
      typeof profileRow.market_normalized === "string" ? profileRow.market_normalized : "unknown market",
  };

  const queryEmbeddings: DealRetrievalEmbeddings = {
    problem: parseVector(profileRow.problem_embedding) ?? [],
    solution: parseVector(profileRow.solution_embedding) ?? [],
    market: parseVector(profileRow.market_embedding) ?? [],
  };
  return fetchSimilarPeersFromRetrievalProfile(admin, {
    userId: sourceDeal.user_id as string,
    profile,
    queryEmbeddings,
    excludeDealId: sourceDealId,
    finalLimit: limit,
  });
}
