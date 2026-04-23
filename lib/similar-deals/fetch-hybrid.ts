import type { SupabaseClient } from "@supabase/supabase-js";
import { vectorParam } from "@/lib/data-layer/shared/vector";
import {
  fetchDealInvestorRows,
  dealIntelRowToCandidateMeta,
  fetchDealsMetaByIds,
  fetchLatestAnalyses,
  fetchProblemRows,
  fetchSolutionRows,
  rpcMatchSimilarDealsDealTreeHybrid,
  rpcMatchSimilarDealsHybrid,
} from "@/lib/data-layer/schema-access/similar-deals";
import { computeDealTree2DSimilarity } from "@/lib/similar-deals/deal-tree-similarity";
import { hydrateSimilarPeersBatch, loadDealFlagsBatch } from "@/lib/similar-deals/hydration";
import { SIMILAR_PEERS_TOP_K } from "@/lib/similar-deals/constants";
import type { CandidateMeta, RpcDealTreeHybridRow, RpcHybridRow, SimilarPeerForPrompt } from "@/lib/similar-deals/types";

/**
 * Hybrid similar deals (vector + FTS + RRF). Caller supplies query embedding + text.
 */
export async function fetchSimilarDealsHybrid(
  admin: SupabaseClient,
  args: {
    userId: string;
    queryEmbedding: number[];
    queryText: string;
    excludeDealId?: string | null;
    finalLimit?: number;
  }
): Promise<SimilarPeerForPrompt[]> {
  // Prefer Deal Tree v1 hybrid search when available.
  try {
    const { data: treeData, error: treeErr } = await rpcMatchSimilarDealsDealTreeHybrid(admin, {
      userId: args.userId,
      queryEmbedding: vectorParam(args.queryEmbedding),
      queryText: args.queryText,
      excludeDealId: args.excludeDealId ?? null,
      vectorLimit: 60,
      ftsLimit: 60,
      finalLimit: args.finalLimit ?? SIMILAR_PEERS_TOP_K,
    });

    if (!treeErr && treeData && Array.isArray(treeData) && treeData.length > 0) {
      const rows = (treeData ?? []) as RpcDealTreeHybridRow[];
      const ids = rows.map((r) => r.deal_id);

      const coords =
        args.excludeDealId && ids.length > 0
          ? await computeDealTree2DSimilarity(admin, {
              userId: args.userId,
              queryDealId: args.excludeDealId,
              candidateDealIds: ids,
            })
          : new Map();

      const { data: metaRows } = await fetchDealsMetaByIds(admin, ids);
      const typedMetaRows = (metaRows ?? []) as Array<{ id: string; metadata: unknown }>;
      const metaById = new Map<string, CandidateMeta>(
        typedMetaRows.map((d) => [d.id as string, dealIntelRowToCandidateMeta(d) as CandidateMeta])
      );

      const scoreById = new Map(rows.map((r) => [r.deal_id, Number(r.rrf_score ?? 0)]));
      const flags = await loadDealFlagsBatch(admin, ids);
      const hydrated = await hydrateSimilarPeersBatch(admin, ids, metaById, scoreById, flags);
      return hydrated.map((h) => {
        const c = coords.get(h.deal_id);
        return c ? { ...h, opportunity_similarity: c.opportunity, risk_similarity: c.risk } : h;
      });
    }
  } catch {
    // ignore and fall back to legacy
  }

  const { data, error } = await rpcMatchSimilarDealsHybrid(admin, {
    userId: args.userId,
    queryEmbedding: vectorParam(args.queryEmbedding),
    queryText: args.queryText,
    excludeDealId: args.excludeDealId ?? null,
    vectorLimit: 40,
    ftsLimit: 40,
    finalLimit: args.finalLimit ?? SIMILAR_PEERS_TOP_K,
  });

  if (error) {
    console.error("fetchSimilarDealsHybrid:", error);
    return [];
  }

  const rows = (data ?? []) as RpcHybridRow[];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => (r as { id?: string; deal_id?: string }).deal_id ?? (r as { id: string }).id);
  const { data: problems } = await fetchProblemRows(admin, ids);
  const { data: solutions } = await fetchSolutionRows(admin, ids);
  const { data: invRows } = await fetchDealInvestorRows(admin, ids);

  const latestAnalysisByDeal = new Map<string, string>();
  const { data: analyses } = await fetchLatestAnalyses(admin, ids);

  if (analyses) {
    for (const a of analyses) {
      const did = a.deal_id as string;
      if (!latestAnalysisByDeal.has(did)) {
        latestAnalysisByDeal.set(did, a.id as string);
      }
    }
  }

  const problemByDeal = new Map<string, { statement: string | null; ref: string | null }>();
  for (const p of problems ?? []) {
    const did = p.deal_id as string;
    const aid = p.analysis_id as string;
    if (latestAnalysisByDeal.get(did) !== aid) continue;
    if (!problemByDeal.has(did)) {
      problemByDeal.set(did, {
        statement: typeof p.problem_statement === "string" ? p.problem_statement : null,
        ref: typeof p.stated_problem_ref === "string" ? p.stated_problem_ref : null,
      });
    }
  }

  const solutionByDeal = new Map<string, string | null>();
  for (const s of solutions ?? []) {
    const did = s.deal_id as string;
    const aid = s.analysis_id as string;
    if (latestAnalysisByDeal.get(did) !== aid) continue;
    if (!solutionByDeal.has(did)) {
      const sum =
        typeof s.solution_summary === "string"
          ? s.solution_summary
          : typeof s.product_type === "string"
            ? s.product_type
            : null;
      solutionByDeal.set(did, sum);
    }
  }

  const investorsByDeal = new Map<string, string[]>();
  for (const ir of invRows ?? []) {
    const did = ir.deal_id as string;
    const inv = ir.investors as { name?: string } | null;
    const n = inv?.name;
    if (!n) continue;
    const arr = investorsByDeal.get(did) ?? [];
    if (arr.length < 12) {
      arr.push(n);
      investorsByDeal.set(did, arr);
    }
  }

  const rrfVals = rows.map((r) => Number(r.rrf_score ?? 0));
  const min = rrfVals.length ? Math.min(...rrfVals) : 0;
  const max = rrfVals.length ? Math.max(...rrfVals) : 0;
  const denom = max - min;
  const normalize = (rrf: number): number => {
    if (Math.abs(denom) < 1e-9) return max > 0 ? 1 : 0;
    return Math.max(0, Math.min(1, (rrf - min) / denom));
  };

  return rows.map((r) => {
    const did = (r as { deal_id?: string; id?: string }).deal_id ?? (r as { id: string }).id;
    const pid = problemByDeal.get(did);
    const p1 = pid?.statement?.slice(0, 400) ?? pid?.ref?.slice(0, 400) ?? null;
    const s1 = solutionByDeal.get(did)?.slice(0, 400) ?? null;
    const rrf = Number(r.rrf_score ?? 0);
    return {
      deal_id: did,
      company_name: (r as { company_name?: string }).company_name ?? "Unknown",
      problem_one_liner: p1,
      solution_one_liner: s1,
      investors: investorsByDeal.get(did) ?? [],
      decision: null,
      pass_reason: null,
      pass_reason_detail: null,
      risk_flags: [],
      rrf_score: rrf,
      similarity_confidence: normalize(rrf),
    };
  });
}
