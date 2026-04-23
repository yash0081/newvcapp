import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildRetrievalProfileFromParsing,
  embedRetrievalProfile,
  type DealRetrievalEmbeddings,
  type DealRetrievalProfile,
} from "@/lib/deal-retrieval-profile";
import { cosineSimilarity, parseVector } from "@/lib/data-layer/shared/vector";
import {
  fetchDealRetrievalIndexRows,
  fetchDealsByUser,
  textSearchDealKeywords,
  rpcMatchSimilarDealsDealIntel,
} from "@/lib/data-layer/schema-access/similar-deals";
import { vectorParam } from "@/lib/data-layer/shared/vector";
import { normalizePhase1Parsing } from "@/lib/phase1-normalize";
import { SIMILAR_PEERS_TOP_K, TOP_CANDIDATES_FOR_RERANK } from "@/lib/similar-deals/constants";
import { fusionWeightsProblemSolution, keywordQueryFromProfile, mergedScoreList, normalize01 } from "@/lib/similar-deals/scoring";
import { filterStructurally, slotFromNormalized, structuralSlotsFromParsing } from "@/lib/similar-deals/prefilter";
import { hydrateSimilarPeersBatch, loadDealFlagsBatch, loadMoatByDeal } from "@/lib/similar-deals/hydration";
import { rerankTop3 } from "@/lib/similar-deals/rerank";
import type { CandidateMeta, RetrievalIndexRow, SimilarPeerBundleForPipeline, SimilarPeerForPrompt } from "@/lib/similar-deals/types";

function safeCosineSimilarity(a: number[] | null, b: number[] | null): number {
  if (!a || !b || a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  return cosineSimilarity(a, b);
}

function rrfRowsToMap(
  data: { deal_id: string; rrf_score: number | null }[] | null
): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of data ?? []) {
    m.set(r.deal_id, Number(r.rrf_score ?? 0));
  }
  return normalize01(m);
}

async function buildCompFromDealIntelHybrid(
  admin: import("@supabase/supabase-js").SupabaseClient,
  args: {
    userId: string;
    profile: import("@/lib/deal-retrieval-profile").DealRetrievalProfile;
    queryEmbeddings: import("@/lib/deal-retrieval-profile").DealRetrievalEmbeddings;
    excludeDealId: string | null | undefined;
    filteredIds: string[];
  }
): Promise<{
  compById: Map<string, { p: number; s: number }>;
  marketSimById: Map<string, number>;
}> {
  const { userId, profile, queryEmbeddings, excludeDealId, filteredIds } = args;
  const pText = profile.problem.normalized_slice || "";
  const sText = profile.solution.normalized_slice || "";
  const mText = (profile.market_document || "").trim();

  const [pRes, sRes, mRes] = await Promise.all([
    rpcMatchSimilarDealsDealIntel(admin, {
      userId,
      queryEmbedding: vectorParam(queryEmbeddings.problem),
      queryText: pText.slice(0, 4000),
      candidateDealIds: filteredIds,
      excludeDealId,
      vectorLimit: 200,
      ftsLimit: 200,
      finalLimit: 80,
    }),
    rpcMatchSimilarDealsDealIntel(admin, {
      userId,
      queryEmbedding: vectorParam(queryEmbeddings.solution),
      queryText: sText.slice(0, 4000),
      candidateDealIds: filteredIds,
      excludeDealId,
      vectorLimit: 200,
      ftsLimit: 200,
      finalLimit: 80,
    }),
    rpcMatchSimilarDealsDealIntel(admin, {
      userId,
      queryEmbedding: vectorParam(queryEmbeddings.market),
      queryText: mText.slice(0, 4000),
      candidateDealIds: filteredIds,
      excludeDealId,
      vectorLimit: 200,
      ftsLimit: 200,
      finalLimit: 80,
    }),
  ]);

  const rrfP = rrfRowsToMap((pRes.data ?? null) as { deal_id: string; rrf_score: number | null }[]);
  const rrfS = rrfRowsToMap((sRes.data ?? null) as { deal_id: string; rrf_score: number | null }[]);
  const rrfM = rrfRowsToMap((mRes.data ?? null) as { deal_id: string; rrf_score: number | null }[]);

  const compById = new Map<string, { p: number; s: number }>();
  const marketSimById = new Map<string, number>();
  for (const id of filteredIds) {
    compById.set(id, { p: rrfP.get(id) ?? 0, s: rrfS.get(id) ?? 0 });
    marketSimById.set(id, rrfM.get(id) ?? 0);
  }
  return { compById, marketSimById };
}


const EMPTY_PEER_BUNDLE: SimilarPeerBundleForPipeline = {
  overall: [],
  problem_focused: [],
  solution_focused: [],
  market_focused: [],
  risk_focused: [],
};

/**
 * Hybrid retrieval v2:
 * - section profile extraction
 * - structural prefilter (sector/stage/moat)
 * - weighted section-vector similarity
 * - keyword FTS on section concepts
 * - 85/15 vector/keyword merge + overlap multiplier
 * - LLM rerank top10 -> top3
 */
export async function fetchSimilarPeersAfterPhase1Parse(
  admin: SupabaseClient,
  userId: string,
  parsing: Record<string, unknown>,
  excludeDealId: string | null
): Promise<SimilarPeerForPrompt[]> {
  if (!parsing || typeof parsing !== "object") return [];
  try {
    const normalized = normalizePhase1Parsing(parsing as Record<string, unknown>);
    const profile = await buildRetrievalProfileFromParsing(normalized);
    const queryEmb = await embedRetrievalProfile(profile);
    return fetchSimilarPeersFromRetrievalProfile(admin, {
      userId,
      profile,
      queryEmbeddings: queryEmb,
      parsing: normalized,
      excludeDealId,
      finalLimit: SIMILAR_PEERS_TOP_K,
    });
  } catch (e) {
    console.warn("fetchSimilarPeersAfterPhase1Parse:", e);
    return [];
  }
}

/**
 * Hybrid retrieval: fused top-3 (with LLM rerank) plus section-weighted top-3 lists so each pipeline phase
 * can receive both **overall** peers and **slot-specific** peers (problem / solution / market / risk embeddings).
 */
export async function fetchSimilarPeerBundlesForPipeline(
  admin: SupabaseClient,
  args: {
    userId: string;
    profile: DealRetrievalProfile;
    queryEmbeddings: DealRetrievalEmbeddings;
    /** Phase 1 JSON for structural prefilter; optional when loading from DB-only profile. */
    parsing?: Record<string, unknown> | null;
    excludeDealId?: string | null;
    finalLimit?: number;
  }
): Promise<SimilarPeerBundleForPipeline> {
  const { wp, ws } = fusionWeightsProblemSolution();
  const finalLimit = args.finalLimit ?? SIMILAR_PEERS_TOP_K;
  const slots = structuralSlotsFromParsing(args.parsing ?? null);
  const querySector = slots.sector ?? slotFromNormalized(args.profile.problem.normalized_slice, 0);
  const queryStage = slots.stage;
  const queryMoat = slots.moat ?? slotFromNormalized(args.profile.solution.normalized_slice, 2);

  const { data: dealsRows, error: dealsErr } = await fetchDealsByUser(
    admin,
    args.userId,
    args.excludeDealId ?? null,
    1500
  );
  if (dealsErr) {
    console.error("fetchSimilarPeerBundlesForPipeline: deals", dealsErr);
    return { ...EMPTY_PEER_BUNDLE };
  }
  const metas: CandidateMeta[] = ((dealsRows ?? []) as Array<Record<string, unknown>>).map((d) => ({
    id: d.id as string,
    company_name: (d.company_name as string) ?? "Unknown",
    sector: (d.sector as string | null) ?? null,
    stage: (d.stage as string | null) ?? null,
    decision: (d.decision as string | null) ?? null,
    pass_reason: (d.pass_reason as string | null) ?? null,
    pass_reason_detail: (d.pass_reason_detail as string | null) ?? null,
    moat_type: (d as { moat_type?: string | null }).moat_type ?? null,
    problem_one_liner: (d as { problem_one_liner?: string | null }).problem_one_liner ?? null,
    solution_one_liner: (d as { solution_one_liner?: string | null }).solution_one_liner ?? null,
  }));
  if (metas.length === 0) return { ...EMPTY_PEER_BUNDLE };
  const allIds = metas.map((m) => m.id);
  const moatByDeal = await loadMoatByDeal(admin, allIds);
  for (const m of metas) m.moat_type = moatByDeal.get(m.id) ?? m.moat_type ?? null;

  const filtered = filterStructurally(metas, querySector, queryStage, queryMoat).slice(0, 500);
  const filteredIds = filtered.map((f) => f.id);
  if (filteredIds.length === 0) return { ...EMPTY_PEER_BUNDLE };

  const { data: idxRows, error: idxErr } = await fetchDealRetrievalIndexRows(admin, filteredIds);
  if (idxErr) {
    console.warn("fetchSimilarPeerBundlesForPipeline: retrieval_index (falling back to deal_intel):", idxErr);
  }
  const idxByDeal = new Map<string, RetrievalIndexRow>();
  for (const r of (idxRows ?? []) as unknown as RetrievalIndexRow[]) {
    idxByDeal.set(r.deal_id, r);
  }

  const compById = new Map<string, { p: number; s: number }>();
  const marketSimById = new Map<string, number>();
  for (const c of filtered) {
    const row = idxByDeal.get(c.id);
    if (!row) continue;
    const p = safeCosineSimilarity(parseVector(row.problem_embedding), args.queryEmbeddings.problem);
    const s = safeCosineSimilarity(parseVector(row.solution_embedding), args.queryEmbeddings.solution);
    compById.set(c.id, { p, s });
    const mSim = safeCosineSimilarity(parseVector(row.market_embedding), args.queryEmbeddings.market);
    marketSimById.set(c.id, mSim);
  }
  if (compById.size === 0) {
    const alt = await buildCompFromDealIntelHybrid(admin, {
      userId: args.userId,
      profile: args.profile,
      queryEmbeddings: args.queryEmbeddings,
      excludeDealId: args.excludeDealId ?? null,
      filteredIds,
    });
    for (const [id, v] of alt.compById) compById.set(id, v);
    for (const [id, v] of alt.marketSimById) marketSimById.set(id, v);
  }
  if (compById.size === 0) return { ...EMPTY_PEER_BUNDLE };

  const keywordRaw = new Map<string, number>();
  const kwQuery = keywordQueryFromProfile(args.profile);
  if (kwQuery) {
    const { data: kwRows } = await textSearchDealKeywords(admin, Array.from(compById.keys()), kwQuery);
    for (const row of kwRows ?? []) {
      const did = row.deal_id as string;
      keywordRaw.set(did, (keywordRaw.get(did) ?? 0) + 1);
    }
  }

  const mergedOverall = mergedScoreList(compById, keywordRaw, wp, ws);
  if (mergedOverall.length === 0) return { ...EMPTY_PEER_BUNDLE };

  const topForRerank = mergedOverall.slice(0, TOP_CANDIDATES_FOR_RERANK);
  const metaById = new Map(filtered.map((m) => [m.id, m]));
  const flagsForRerank = await loadDealFlagsBatch(admin, topForRerank.map((x) => x.dealId));

  const rerankPayload = topForRerank.map((x) => {
    const m = metaById.get(x.dealId)!;
    return {
      deal_id: x.dealId,
      company_name: m.company_name,
      decision: m.decision,
      pass_reason: m.pass_reason,
      pass_reason_detail: m.pass_reason_detail,
      moat_type: m.moat_type,
      stage: m.stage,
      sector: m.sector,
      risk_flags: flagsForRerank.get(x.dealId) ?? [],
      pre_score: x.score,
    };
  });
  const rerankedIds = await rerankTop3({ profile: args.profile, topCandidates: rerankPayload });
  const overallIds = rerankedIds.slice(0, finalLimit);

  const problemIds = mergedScoreList(compById, keywordRaw, 1, 0)
    .slice(0, SIMILAR_PEERS_TOP_K)
    .map((x) => x.dealId);
  const solutionIds = mergedScoreList(compById, keywordRaw, 0, 1)
    .slice(0, SIMILAR_PEERS_TOP_K)
    .map((x) => x.dealId);
  const marketIds = Array.from(marketSimById.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, SIMILAR_PEERS_TOP_K)
    .map(([id]) => id);
  const riskIds: string[] = [];

  const scoreById = new Map(mergedOverall.map((m) => [m.dealId, m.score]));
  const marketScoreById = (() => {
    const vals = marketIds.map((id) => marketSimById.get(id) ?? 0);
    const min = vals.length ? Math.min(...vals) : 0;
    const max = vals.length ? Math.max(...vals) : 0;
    const denom = max - min;
    const norm = (v: number) => {
      if (Math.abs(denom) < 1e-9) return max > 0 ? 1 : 0;
      return Math.max(0, Math.min(1, (v - min) / denom));
    };
    return new Map(marketIds.map((id) => [id, norm(marketSimById.get(id) ?? 0)]));
  })();

  const allHydrateIds = [
    ...new Set([
      ...overallIds,
      ...problemIds,
      ...solutionIds,
      ...marketIds,
      ...riskIds,
      ...topForRerank.map((x) => x.dealId),
    ]),
  ];
  const flagsAll = await loadDealFlagsBatch(admin, allHydrateIds);

  const [overall, problem_focused, solution_focused, market_focused, risk_focused] = await Promise.all([
    hydrateSimilarPeersBatch(admin, overallIds, metaById, scoreById, flagsAll),
    hydrateSimilarPeersBatch(admin, problemIds, metaById, scoreById, flagsAll),
    hydrateSimilarPeersBatch(admin, solutionIds, metaById, scoreById, flagsAll),
    hydrateSimilarPeersBatch(admin, marketIds, metaById, marketScoreById, flagsAll),
    hydrateSimilarPeersBatch(admin, riskIds, metaById, scoreById, flagsAll),
  ]);

  return { overall, problem_focused, solution_focused, market_focused, risk_focused };
}

export async function fetchSimilarPeersFromRetrievalProfile(
  admin: SupabaseClient,
  args: {
    userId: string;
    profile: DealRetrievalProfile;
    queryEmbeddings: DealRetrievalEmbeddings;
    parsing?: Record<string, unknown> | null;
    excludeDealId?: string | null;
    finalLimit?: number;
  }
): Promise<SimilarPeerForPrompt[]> {
  const bundle = await fetchSimilarPeerBundlesForPipeline(admin, args);
  return bundle.overall;
}
