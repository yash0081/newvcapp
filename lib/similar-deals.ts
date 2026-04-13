import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchDealSearchDocumentInput } from "@/lib/deal-search-document";
import {
  buildRetrievalProfileFromParsing,
  embedRetrievalProfile,
  upsertDealRetrievalArtifacts,
  type DealRetrievalEmbeddings,
  type DealRetrievalProfile,
} from "@/lib/deal-retrieval-profile";
import { runWithTextMulti } from "@/lib/gemini";
import { PROMPT_SIMILAR_DEALS_RERANK } from "@/lib/deal-sourcing-prompts";
import { embedText } from "@/lib/vertex-embeddings";
import { normalizePhase1Parsing } from "@/lib/phase1-normalize";
import { registerKeywordPhrases } from "@/lib/keyword-vocabulary-graph";

/** KNN-style top-K for deal page UI. Pipeline injects `similar_companies_overall_top` + section-focused lists into LLM prompts. */
export const SIMILAR_PEERS_TOP_K = 3;
const TOP_CANDIDATES_FOR_RERANK = 5;

/** Fused P+S vector weights (relative emphasis solution > problem, same ratio as prior 0.35:0.25 over P+S only). */
const W_SOLUTION = 0.35 / (0.35 + 0.25);
const W_PROBLEM = 0.25 / (0.35 + 0.25);
const FUSION_VECTOR = 0.85;
const FUSION_KEYWORD = 0.15;
const OVERLAP_MULTIPLIER = 1.4;

export type SimilarPeerForPrompt = {
  deal_id: string;
  company_name: string;
  problem_one_liner: string | null;
  solution_one_liner: string | null;
  investors: string[];
  decision: string | null;
  pass_reason: string | null;
  pass_reason_detail: string | null;
  risk_flags: string[];
  rrf_score: number;
  /**
   * 0–1 confidence derived from relative `rrf_score` strength within the injected peer set.
   * Prompts can use this to treat the peer as a near-direct comparable vs weakly related.
   */
  similarity_confidence: number;
};

type RpcHybridRow = {
  id: string;
  company_name: string | null;
  vector_rank: number | null;
  fts_rank: number | null;
  rrf_score: number | null;
};

type RetrievalIndexRow = {
  deal_id: string;
  problem_embedding: string | number[] | null;
  solution_embedding: string | number[] | null;
  market_embedding: string | number[] | null;
};

function vectorParam(values: number[]): string {
  return `[${values.join(",")}]`;
}

function parseVector(v: unknown): number[] | null {
  if (Array.isArray(v)) {
    const arr = v.filter((x): x is number => typeof x === "number" && !Number.isNaN(x));
    return arr.length ? arr : null;
  }
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) return null;
  const body = t.slice(1, -1).trim();
  if (!body) return null;
  const out = body
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => !Number.isNaN(n));
  return out.length ? out : null;
}

function cosineSimilarity(a: number[] | null, b: number[] | null): number {
  if (!a || !b || a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let an = 0;
  let bn = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    an += a[i] * a[i];
    bn += b[i] * b[i];
  }
  if (an <= 0 || bn <= 0) return 0;
  return dot / (Math.sqrt(an) * Math.sqrt(bn));
}

function normalize01(scores: Map<string, number>): Map<string, number> {
  const vals = Array.from(scores.values());
  if (vals.length === 0) return new Map<string, number>();
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  if (Math.abs(max - min) < 1e-9) {
    return new Map(Array.from(scores.entries()).map(([k]) => [k, max > 0 ? 1 : 0]));
  }
  return new Map(Array.from(scores.entries()).map(([k, v]) => [k, (v - min) / (max - min)]));
}

function slotFromNormalized(normalized: string, idx: number): string | null {
  const parts = normalized
    .split("|")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (idx >= parts.length) return null;
  const v = parts[idx];
  if (!v || v === "unknown" || v === "n/a") return null;
  return v;
}

/** Structural prefilter from Phase 1 parse (no LLM retrieval slices). */
function structuralSlotsFromParsing(parsing: Record<string, unknown> | null | undefined): {
  sector: string | null;
  stage: string | null;
  moat: string | null;
} {
  if (!parsing || typeof parsing !== "object") {
    return { sector: null, stage: null, moat: null };
  }
  const co = (parsing.company_overview ?? {}) as Record<string, unknown>;
  const sol = (parsing.solution ?? {}) as Record<string, unknown>;
  const sector = typeof co.sector_category === "string" ? co.sector_category.trim().toLowerCase() : null;
  const stage = typeof co.stage === "string" ? co.stage.trim().toLowerCase() : null;
  const moat = typeof sol.product_type === "string" ? sol.product_type.trim().toLowerCase() : null;
  return { sector, stage, moat };
}

function keywordQueryFromProfile(profile: DealRetrievalProfile): string {
  const all = [...profile.problem.search_concepts, ...profile.solution.search_concepts]
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 18);
  if (all.length === 0) return "";
  return all.map((s) => `"${s.replace(/"/g, "")}"`).join(" OR ");
}

type CandidateMeta = {
  id: string;
  company_name: string;
  sector: string | null;
  stage: string | null;
  decision: string | null;
  pass_reason: string | null;
  pass_reason_detail: string | null;
  moat_type: string | null;
};

async function loadLatestAnalysisByDeal(admin: SupabaseClient, dealIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (dealIds.length === 0) return out;
  const { data } = await admin
    .from("deal_analyses")
    .select("id, deal_id, run_at")
    .in("deal_id", dealIds)
    .order("run_at", { ascending: false });
  for (const row of data ?? []) {
    const did = row.deal_id as string;
    if (!out.has(did)) out.set(did, row.id as string);
  }
  return out;
}

async function loadMoatByDeal(admin: SupabaseClient, dealIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (dealIds.length === 0) return out;
  const latest = await loadLatestAnalysisByDeal(admin, dealIds);
  const { data } = await admin
    .from("deal_solution")
    .select("deal_id, analysis_id, moat_type")
    .in("deal_id", dealIds);
  for (const s of data ?? []) {
    const did = s.deal_id as string;
    const aid = s.analysis_id as string;
    if (latest.get(did) !== aid) continue;
    if (!out.has(did)) out.set(did, typeof s.moat_type === "string" ? s.moat_type : null);
  }
  return out;
}

type VectorComponents = { p: number; s: number };

/** Same 85/15 vector/keyword + overlap fusion; vector = weighted problem + solution cosine only. */
function mergedScoreList(
  compById: Map<string, VectorComponents>,
  keywordRaw: Map<string, number>,
  wp: number,
  ws: number
): Array<{ dealId: string; score: number; vectorScore: number; keywordScore: number }> {
  const vectorRaw = new Map<string, number>();
  for (const [id, c] of compById) {
    vectorRaw.set(id, wp * c.p + ws * c.s);
  }
  if (vectorRaw.size === 0) return [];
  const vectorNorm = normalize01(vectorRaw);
  const keywordNorm = normalize01(keywordRaw);
  return Array.from(vectorRaw.keys())
    .map((dealId) => {
      const v = vectorNorm.get(dealId) ?? 0;
      const k = keywordNorm.get(dealId) ?? 0;
      let finalScore = FUSION_VECTOR * v + FUSION_KEYWORD * k;
      if (k > 0 && v > 0) finalScore *= OVERLAP_MULTIPLIER;
      return { dealId, score: finalScore, vectorScore: v, keywordScore: k };
    })
    .sort((a, b) => b.score - a.score);
}

/** Richer than summary alone so "Unified API"–style matches survive in prompts when summary is empty or generic. */
function buildSolutionOneLinerFromRow(s: {
  solution_summary: string | null;
  product_type: string | null;
  moat_type: string | null;
  technical_moat_evidence: string | null;
}): string | null {
  const parts: string[] = [];
  if (s.product_type?.trim()) parts.push(`Product type: ${s.product_type.trim()}`);
  if (s.solution_summary?.trim()) parts.push(s.solution_summary.trim());
  if (s.moat_type?.trim()) parts.push(`Moat: ${s.moat_type.trim()}`);
  if (parts.length === 0 && s.technical_moat_evidence?.trim()) {
    parts.push(s.technical_moat_evidence.trim().slice(0, 400));
  }
  const out = parts.join(" | ");
  return out.length ? out.slice(0, 520) : null;
}

function buildProblemOneLinerFromRow(p: {
  problem_statement: string | null;
  stated_problem_ref: string | null;
  economic_gravity: string | null;
}): string | null {
  const a = p.problem_statement?.trim();
  const b = p.stated_problem_ref?.trim();
  const g = p.economic_gravity?.trim();
  const parts: string[] = [];
  if (a) parts.push(a);
  if (b && b !== a) parts.push(b);
  if (g && g !== a && g !== b) parts.push(g);
  const out = parts.join(" — ");
  return out.length ? out.slice(0, 520) : null;
}

async function loadDealFlagsBatch(admin: SupabaseClient, dealIds: string[]): Promise<Map<string, string[]>> {
  const flagsByDeal = new Map<string, string[]>();
  if (dealIds.length === 0) return flagsByDeal;
  const { data: flagsRows } = await admin
    .from("deal_flags")
    .select("deal_id, flag_message")
    .in("deal_id", dealIds);
  for (const f of flagsRows ?? []) {
    const did = f.deal_id as string;
    const msg = typeof f.flag_message === "string" ? f.flag_message.trim() : "";
    if (!msg) continue;
    const arr = flagsByDeal.get(did) ?? [];
    if (arr.length < 5) arr.push(msg);
    flagsByDeal.set(did, arr);
  }
  return flagsByDeal;
}

async function hydrateSimilarPeersBatch(
  admin: SupabaseClient,
  orderedDealIds: string[],
  metaById: Map<string, CandidateMeta>,
  scoreById: Map<string, number>,
  flagsByDeal: Map<string, string[]>
): Promise<SimilarPeerForPrompt[]> {
  const unique = [...new Set(orderedDealIds)];
  if (unique.length === 0) return [];

  // Normalize `rrf_score` -> 0..1 within this peer batch so prompts can gate thresholds.
  const scoreVals = unique.map((id) => Number(scoreById.get(id) ?? 0));
  const min = scoreVals.length ? Math.min(...scoreVals) : 0;
  const max = scoreVals.length ? Math.max(...scoreVals) : 0;
  const denom = max - min;
  const normalize = (rrf: number): number => {
    if (Math.abs(denom) < 1e-9) return max > 0 ? 1 : 0;
    return Math.max(0, Math.min(1, (rrf - min) / denom));
  };

  const latest = await loadLatestAnalysisByDeal(admin, unique);
  const { data: problems } = await admin
    .from("deal_problem")
    .select("deal_id, analysis_id, problem_statement, stated_problem_ref, economic_gravity")
    .in("deal_id", unique);
  const { data: solutions } = await admin
    .from("deal_solution")
    .select(
      "deal_id, analysis_id, solution_summary, product_type, moat_type, technical_moat_evidence"
    )
    .in("deal_id", unique);
  const { data: invRows } = await admin
    .from("deal_investors")
    .select("deal_id, investors ( name )")
    .in("deal_id", unique);

  const problemByDeal = new Map<
    string,
    { statement: string | null; ref: string | null; economic_gravity: string | null }
  >();
  for (const p of problems ?? []) {
    const did = p.deal_id as string;
    if (latest.get(did) !== (p.analysis_id as string)) continue;
    if (!problemByDeal.has(did)) {
      problemByDeal.set(did, {
        statement: typeof p.problem_statement === "string" ? p.problem_statement : null,
        ref: typeof p.stated_problem_ref === "string" ? p.stated_problem_ref : null,
        economic_gravity: typeof p.economic_gravity === "string" ? p.economic_gravity : null,
      });
    }
  }
  const solutionByDeal = new Map<
    string,
    {
      solution_summary: string | null;
      product_type: string | null;
      moat_type: string | null;
      technical_moat_evidence: string | null;
    }
  >();
  for (const s of solutions ?? []) {
    const did = s.deal_id as string;
    if (latest.get(did) !== (s.analysis_id as string)) continue;
    if (!solutionByDeal.has(did)) {
      solutionByDeal.set(did, {
        solution_summary: typeof s.solution_summary === "string" ? s.solution_summary : null,
        product_type: typeof s.product_type === "string" ? s.product_type : null,
        moat_type: typeof s.moat_type === "string" ? s.moat_type : null,
        technical_moat_evidence:
          typeof s.technical_moat_evidence === "string" ? s.technical_moat_evidence : null,
      });
    }
  }
  const investorsByDeal = new Map<string, string[]>();
  for (const ir of invRows ?? []) {
    const did = ir.deal_id as string;
    const n = (ir.investors as { name?: string } | null)?.name;
    if (!n) continue;
    const arr = investorsByDeal.get(did) ?? [];
    if (arr.length < 12) arr.push(n);
    investorsByDeal.set(did, arr);
  }

  const byId = new Map<string, SimilarPeerForPrompt>();
  for (const dealId of unique) {
    const meta = metaById.get(dealId);
    if (!meta) continue;
    const pid = problemByDeal.get(dealId);
    const solRow = solutionByDeal.get(dealId);
    const solLine = solRow
      ? buildSolutionOneLinerFromRow(solRow)
      : null;
    const probLine = pid
      ? buildProblemOneLinerFromRow({
          problem_statement: pid.statement,
          stated_problem_ref: pid.ref,
          economic_gravity: pid.economic_gravity,
        })
      : null;
    byId.set(dealId, {
      deal_id: dealId,
      company_name: meta.company_name,
      problem_one_liner: probLine,
      solution_one_liner: solLine,
      investors: investorsByDeal.get(dealId) ?? [],
      decision: meta.decision,
      pass_reason: meta.pass_reason,
      pass_reason_detail: meta.pass_reason_detail,
      risk_flags: flagsByDeal.get(dealId) ?? [],
      rrf_score: Number(scoreById.get(dealId) ?? 0),
      similarity_confidence: normalize(Number(scoreById.get(dealId) ?? 0)),
    });
  }

  return orderedDealIds.map((id) => byId.get(id)).filter((x): x is SimilarPeerForPrompt => x != null);
}

/** Top-3 overall (fused + LLM rerank) plus top-3 per embedding slot for section-specific prompts. */
export type SimilarPeerBundleForPipeline = {
  overall: SimilarPeerForPrompt[];
  problem_focused: SimilarPeerForPrompt[];
  solution_focused: SimilarPeerForPrompt[];
  market_focused: SimilarPeerForPrompt[];
  risk_focused: SimilarPeerForPrompt[];
};

function filterStructurally(
  candidates: CandidateMeta[],
  querySector: string | null,
  queryStage: string | null,
  queryMoat: string | null
): CandidateMeta[] {
  const sec = querySector?.toLowerCase() ?? null;
  const stg = queryStage?.toLowerCase() ?? null;
  const moat = queryMoat?.toLowerCase() ?? null;

  const strict = candidates.filter((c) => {
    const cSector = c.sector?.toLowerCase() ?? "";
    const cStage = c.stage?.toLowerCase() ?? "";
    const cMoat = c.moat_type?.toLowerCase() ?? "";
    const sectorOk = sec ? cSector === sec : true;
    const stageOk = stg ? cStage === stg : true;
    const moatOk = moat ? cMoat.includes(moat) || moat.includes(cMoat) : true;
    return sectorOk && stageOk && moatOk;
  });
  if (strict.length > 0) return strict;

  const relaxed = candidates.filter((c) => {
    if (!sec) return true;
    return (c.sector?.toLowerCase() ?? "") === sec;
  });
  return relaxed.length > 0 ? relaxed : candidates;
}

async function rerankTop3(args: {
  profile: DealRetrievalProfile;
  topCandidates: Array<{
    deal_id: string;
    company_name: string;
    decision: string | null;
    pass_reason: string | null;
    pass_reason_detail: string | null;
    moat_type: string | null;
    stage: string | null;
    sector: string | null;
    risk_flags: string[];
    pre_score: number;
  }>;
}): Promise<string[]> {
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
  const { data, error } = await admin.rpc("match_similar_deals_hybrid", {
    p_user_id: args.userId,
    p_query_embedding: vectorParam(args.queryEmbedding),
    p_query_text: args.queryText,
    p_exclude_deal_id: args.excludeDealId ?? null,
    p_vector_limit: 40,
    p_fts_limit: 40,
    p_final_limit: args.finalLimit ?? SIMILAR_PEERS_TOP_K,
  });

  if (error) {
    console.error("fetchSimilarDealsHybrid:", error);
    return [];
  }

  const rows = (data ?? []) as RpcHybridRow[];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const { data: problems } = await admin
    .from("deal_problem")
    .select("deal_id, analysis_id, problem_statement, stated_problem_ref")
    .in("deal_id", ids);

  const { data: solutions } = await admin
    .from("deal_solution")
    .select("deal_id, analysis_id, solution_summary, product_type")
    .in("deal_id", ids);

  const { data: invRows } = await admin
    .from("deal_investors")
    .select("deal_id, investors ( name )")
    .in("deal_id", ids);

  const latestAnalysisByDeal = new Map<string, string>();
  const { data: analyses } = await admin
    .from("deal_analyses")
    .select("id, deal_id, run_at")
    .in("deal_id", ids)
    .order("run_at", { ascending: false });

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
    const pid = problemByDeal.get(r.id);
    const p1 =
      pid?.statement?.slice(0, 400) ?? pid?.ref?.slice(0, 400) ?? null;
    const s1 = solutionByDeal.get(r.id)?.slice(0, 400) ?? null;
    const rrf = Number(r.rrf_score ?? 0);
    return {
      deal_id: r.id,
      company_name: r.company_name ?? "Unknown",
      problem_one_liner: p1,
      solution_one_liner: s1,
      investors: investorsByDeal.get(r.id) ?? [],
      decision: null,
      pass_reason: null,
      pass_reason_detail: null,
      risk_flags: [],
      rrf_score: rrf,
      similarity_confidence: normalize(rrf),
    };
  });
}

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

const EMPTY_PEER_BUNDLE: SimilarPeerBundleForPipeline = {
  overall: [],
  problem_focused: [],
  solution_focused: [],
  market_focused: [],
  risk_focused: [],
};

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
  const finalLimit = args.finalLimit ?? SIMILAR_PEERS_TOP_K;
  const slots = structuralSlotsFromParsing(args.parsing ?? null);
  const querySector = slots.sector ?? slotFromNormalized(args.profile.problem.normalized_slice, 0);
  const queryStage = slots.stage;
  const queryMoat = slots.moat ?? slotFromNormalized(args.profile.solution.normalized_slice, 2);

  const { data: dealsRows, error: dealsErr } = await admin
    .from("deals")
    .select("id, company_name, sector, stage, decision, pass_reason, pass_reason_detail")
    .eq("user_id", args.userId)
    .neq("id", args.excludeDealId ?? "00000000-0000-0000-0000-000000000000")
    .limit(1500);
  if (dealsErr) {
    console.error("fetchSimilarPeerBundlesForPipeline: deals", dealsErr);
    return { ...EMPTY_PEER_BUNDLE };
  }
  const metas: CandidateMeta[] = (dealsRows ?? []).map((d) => ({
    id: d.id as string,
    company_name: (d.company_name as string) ?? "Unknown",
    sector: (d.sector as string | null) ?? null,
    stage: (d.stage as string | null) ?? null,
    decision: (d.decision as string | null) ?? null,
    pass_reason: (d.pass_reason as string | null) ?? null,
    pass_reason_detail: (d.pass_reason_detail as string | null) ?? null,
    moat_type: null,
  }));
  if (metas.length === 0) return { ...EMPTY_PEER_BUNDLE };
  const allIds = metas.map((m) => m.id);
  const moatByDeal = await loadMoatByDeal(admin, allIds);
  for (const m of metas) m.moat_type = moatByDeal.get(m.id) ?? null;

  const filtered = filterStructurally(metas, querySector, queryStage, queryMoat).slice(0, 500);
  const filteredIds = filtered.map((f) => f.id);
  if (filteredIds.length === 0) return { ...EMPTY_PEER_BUNDLE };

  const { data: idxRows, error: idxErr } = await admin
    .from("deal_retrieval_index")
    .select("deal_id, problem_embedding, solution_embedding, market_embedding")
    .in("deal_id", filteredIds);
  if (idxErr) {
    console.error("fetchSimilarPeerBundlesForPipeline: retrieval_index", idxErr);
    return { ...EMPTY_PEER_BUNDLE };
  }
  const idxByDeal = new Map<string, RetrievalIndexRow>();
  for (const r of (idxRows ?? []) as unknown as RetrievalIndexRow[]) {
    idxByDeal.set(r.deal_id, r);
  }

  const compById = new Map<string, VectorComponents>();
  const marketSimById = new Map<string, number>();
  for (const c of filtered) {
    const row = idxByDeal.get(c.id);
    if (!row) continue;
    const p = cosineSimilarity(parseVector(row.problem_embedding), args.queryEmbeddings.problem);
    const s = cosineSimilarity(parseVector(row.solution_embedding), args.queryEmbeddings.solution);
    compById.set(c.id, { p, s });
    const mSim = cosineSimilarity(parseVector(row.market_embedding), args.queryEmbeddings.market);
    marketSimById.set(c.id, mSim);
  }
  if (compById.size === 0) return { ...EMPTY_PEER_BUNDLE };

  const keywordRaw = new Map<string, number>();
  const kwQuery = keywordQueryFromProfile(args.profile);
  if (kwQuery) {
    const { data: kwRows } = await admin
      .from("deal_keywords")
      .select("deal_id, section_name")
      .in("deal_id", Array.from(compById.keys()))
      .textSearch("concepts_tsv", kwQuery, { config: "english", type: "websearch" });
    for (const row of kwRows ?? []) {
      const did = row.deal_id as string;
      keywordRaw.set(did, (keywordRaw.get(did) ?? 0) + 1);
    }
  }

  const mergedOverall = mergedScoreList(compById, keywordRaw, W_PROBLEM, W_SOLUTION);
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

function formatPeerDigestLine(p: SimilarPeerForPrompt, rank: number): string {
  const pb = [p.problem_one_liner, p.solution_one_liner].filter(Boolean).join(" | ");
  const inv = p.investors.length ? `investors: ${p.investors.slice(0, 12).join(", ")}` : "";
  const sim = Number.isFinite(p.similarity_confidence)
    ? `sim:${Math.round(p.similarity_confidence * 100)}%`
    : "";
  return `${rank}. ${p.company_name} — ${pb || "(no one-liners)"}${inv ? ` — ${inv}` : ""}${
    sim ? ` — ${sim}` : ""
  }`;
}

function buildCorpusPeersDigest(
  bundle: SimilarPeerBundleForPipeline,
  section: "thesis" | "traction" | "problem" | "solution" | "assumptions"
): string {
  const lines: string[] = [
    "PORTFOLIO COMPARABLES — read this block first. Deck JSON below is authoritative; peers are for pattern context only.",
    "",
    "OVERALL (fused similarity, top 3):",
  ];
  bundle.overall.forEach((p, i) => lines.push(formatPeerDigestLine(p, i + 1)));
  const secPeers =
    section === "thesis" || section === "traction"
      ? bundle.market_focused
      : section === "problem"
        ? bundle.problem_focused
        : section === "solution"
          ? bundle.solution_focused
          : bundle.risk_focused;
  const secTitle =
    section === "thesis" || section === "traction"
      ? "MARKET-FOCUSED (top 3)"
      : section === "problem"
        ? "PROBLEM-FOCUSED (top 3)"
        : section === "solution"
          ? "SOLUTION-FOCUSED (top 3)"
          : "RISK-FOCUSED (top 3)";
  if (secPeers.length > 0) {
    lines.push("", `${secTitle} (mirrors the second peer JSON array when present):`);
    secPeers.forEach((p, i) => lines.push(formatPeerDigestLine(p, i + 1)));
  }
  return lines.join("\n");
}

/** Digest (plain text) + JSON arrays for `runWithTextMulti`. Digest is listed first so the model sees peers before long deck JSON. */
export function labeledSimilarCompanyInputs(
  bundle: SimilarPeerBundleForPipeline | null,
  section: "thesis" | "traction" | "problem" | "solution" | "assumptions"
): { label: string; value: unknown }[] {
  if (!bundle || bundle.overall.length === 0) return [];
  const digest = buildCorpusPeersDigest(bundle, section);
  const out: { label: string; value: unknown }[] = [
    { label: "corpus_peers_digest", value: digest },
    { label: "similar_companies_overall_top", value: bundle.overall },
  ];
  switch (section) {
    case "thesis":
    case "traction":
      if (bundle.market_focused.length > 0) {
        out.push({ label: "similar_companies_market_focused", value: bundle.market_focused });
      }
      break;
    case "problem":
      if (bundle.problem_focused.length > 0) {
        out.push({ label: "similar_companies_problem_focused", value: bundle.problem_focused });
      }
      break;
    case "solution":
      if (bundle.solution_focused.length > 0) {
        out.push({ label: "similar_companies_solution_focused", value: bundle.solution_focused });
      }
      break;
    case "assumptions":
      if (bundle.risk_focused.length > 0) {
        out.push({ label: "similar_companies_risk_focused", value: bundle.risk_focused });
      }
      break;
  }
  return out;
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

export async function afterPersistIndexDealEmbedding(
  admin: SupabaseClient,
  dealId: string
): Promise<boolean> {
  const doc = await fetchDealSearchDocumentInput(admin, dealId);
  const searchDocumentIndexed = doc ? await indexDealEmbedding(admin, dealId, doc) : false;

  try {
    // Prefer `deal_pipeline_json_parsing` (normalized, persisted by pipeline)
    // because older `deal_analyses.raw_output` blobs may not contain `parsing_json`.
    const { data: parsingRow } = await admin
      .from("deal_pipeline_json_parsing")
      .select("analysis_id, parsing_json, created_at")
      .eq("deal_id", dealId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const parsing = (parsingRow?.parsing_json ?? null) as Record<string, unknown> | null;
    const analysisId = parsingRow?.analysis_id as string | undefined;

    if (analysisId && parsing && typeof parsing === "object" && Object.keys(parsing).length > 0) {
      const profile = await buildRetrievalProfileFromParsing(
        normalizePhase1Parsing(parsing as Record<string, unknown>)
      );
      const embeddings = await embedRetrievalProfile(profile);
      await registerKeywordPhrases(admin, [
        ...profile.problem.search_concepts,
        ...profile.solution.search_concepts,
      ]);
      await upsertDealRetrievalArtifacts({
        admin,
        dealId,
        analysisId,
        profile,
        embeddings,
      });
    }
  } catch (e) {
    console.warn("afterPersistIndexDealEmbedding: retrieval index skipped:", e);
  }

  return searchDocumentIndexed;
}

/**
 * Persist `search_document` + embedding on `deals` after analysis data exists.
 */
export async function indexDealEmbedding(admin: SupabaseClient, dealId: string, searchDocument: string): Promise<boolean> {
  const doc = searchDocument.trim().slice(0, 12000);
  if (!doc) return false;
  try {
    const emb = await embedText(doc);
    const { error } = await admin
      .from("deals")
      .update({
        search_document: doc,
        deal_embedding: vectorParam(emb),
      })
      .eq("id", dealId);
    if (error) {
      console.error("indexDealEmbedding update:", error);
      return false;
    }
    return true;
  } catch (e) {
    console.error("indexDealEmbedding:", e);
    return false;
  }
}

/**
 * Similar deals for deal page — uses stored embedding on source deal.
 */
export async function fetchSimilarDealsFromDealId(
  admin: SupabaseClient,
  sourceDealId: string,
  limit = SIMILAR_PEERS_TOP_K
): Promise<SimilarPeerForPrompt[]> {
  const { data: sourceDeal } = await admin
    .from("deals")
    .select("id, user_id")
    .eq("id", sourceDealId)
    .maybeSingle();
  if (!sourceDeal?.user_id) return [];
  const { data: profileRow } = await admin
    .from("deal_retrieval_index")
    .select(
      "problem_normalized, solution_normalized, market_normalized, problem_embedding, solution_embedding, market_embedding"
    )
    .eq("deal_id", sourceDealId)
    .maybeSingle();
  if (!profileRow) {
    // Legacy fallback until retrieval index has been backfilled.
    const { data, error } = await admin.rpc("match_similar_deals_from_deal", {
      p_source_deal_id: sourceDealId,
      p_match_count: limit,
    });
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
        typeof profileRow.problem_normalized === "string"
          ? profileRow.problem_normalized
          : "unknown",
      search_concepts: [],
    },
    solution: {
      normalized_slice:
        typeof profileRow.solution_normalized === "string"
          ? profileRow.solution_normalized
          : "unknown",
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
