import type { SupabaseClient } from "@supabase/supabase-js";

export async function fetchDealTreeNodesForSimilarity(
  admin: SupabaseClient,
  dealIds: string[]
) {
  return admin.rpc("deal_intel_get_tree_nodes_for_similarity", {
    p_deal_ids: dealIds,
  });
}

export async function fetchLatestAnalyses(
  admin: SupabaseClient,
  dealIds: string[]
) {
  return admin
    .from("deal_analyses")
    .select("id, deal_id, run_at")
    .in("deal_id", dealIds)
    .order("run_at", { ascending: false });
}

export async function fetchMoatRows(
  admin: SupabaseClient,
  dealIds: string[]
) {
  return admin
    .from("deal_solution")
    .select("deal_id, analysis_id, moat_type")
    .in("deal_id", dealIds);
}

export async function fetchDealFlags(
  admin: SupabaseClient,
  dealIds: string[]
) {
  return admin.from("deal_flags").select("deal_id, flag_message").in("deal_id", dealIds);
}

export async function fetchProblemRows(
  admin: SupabaseClient,
  dealIds: string[]
) {
  return admin
    .from("deal_problem")
    .select("deal_id, analysis_id, problem_statement, stated_problem_ref, economic_gravity")
    .in("deal_id", dealIds);
}

export async function fetchSolutionRows(
  admin: SupabaseClient,
  dealIds: string[]
) {
  return admin
    .from("deal_solution")
    .select("deal_id, analysis_id, solution_summary, product_type, moat_type, technical_moat_evidence")
    .in("deal_id", dealIds);
}

export async function fetchDealInvestorRows(
  admin: SupabaseClient,
  dealIds: string[]
) {
  return admin
    .from("deal_investors")
    .select("deal_id, investors ( name )")
    .in("deal_id", dealIds);
}

export async function rpcMatchSimilarDealsDealTreeHybrid(
  admin: SupabaseClient,
  args: {
    userId: string;
    queryEmbedding: string;
    queryText: string;
    excludeDealId: string | null | undefined;
    vectorLimit: number;
    ftsLimit: number;
    finalLimit: number;
  }
) {
  return admin.rpc("deal_intel_match_similar_deals_hybrid", {
    p_user_id: args.userId,
    p_query_embedding: args.queryEmbedding,
    p_query_text: args.queryText,
    p_candidate_deal_ids: null,
    p_exclude_deal_id: args.excludeDealId ?? null,
    p_vector_limit: args.vectorLimit,
    p_fts_limit: args.ftsLimit,
    p_final_limit: args.finalLimit,
    p_rrf_k: 60,
  });
}

function flattenMetadata(row: { id: string; metadata: unknown }): {
  id: string;
  company_name: string;
  sector: string | null;
  stage: string | null;
  decision: string | null;
  pass_reason: string | null;
  pass_reason_detail: string | null;
  problem_one_liner: string | null;
  solution_one_liner: string | null;
  moat_type: string | null;
} {
  const m = (row.metadata as Record<string, unknown>) ?? {};
  return {
    id: row.id,
    company_name: String(m.company_name ?? m.display_name ?? "Unknown"),
    sector: m.sector != null ? String(m.sector) : null,
    stage: m.stage != null ? String(m.stage) : null,
    decision: m.decision != null ? String(m.decision) : null,
    pass_reason: m.pass_reason != null ? String(m.pass_reason) : null,
    pass_reason_detail: m.pass_reason_detail != null ? String(m.pass_reason_detail) : null,
    problem_one_liner: m.problem_one_liner != null ? String(m.problem_one_liner) : null,
    solution_one_liner: m.solution_one_liner != null ? String(m.solution_one_liner) : null,
    moat_type: m.moat_type != null ? String(m.moat_type) : null,
  };
}

/** Public for UI layer mapping `deal` rows to `CandidateMeta`. */
export function dealIntelRowToCandidateMeta(
  row: { id: string; metadata: unknown }
) {
  return flattenMetadata(row) as import("@/lib/similar-deals/types").CandidateMeta & { problem_one_liner: string | null; solution_one_liner: string | null };
}

export async function fetchDealsMetaByIds(
  admin: SupabaseClient,
  dealIds: string[]
) {
  return admin.rpc("deal_intel_get_deals_by_ids", {
    p_deal_ids: dealIds,
  });
}

export async function rpcMatchSimilarDealsHybrid(
  admin: SupabaseClient,
  args: {
    userId: string;
    queryEmbedding: string;
    queryText: string;
    excludeDealId: string | null | undefined;
    vectorLimit: number;
    ftsLimit: number;
    finalLimit: number;
  }
) {
  return admin.rpc("deal_intel_match_similar_deals_hybrid", {
    p_user_id: args.userId,
    p_query_embedding: args.queryEmbedding,
    p_query_text: args.queryText,
    p_candidate_deal_ids: null,
    p_exclude_deal_id: args.excludeDealId ?? null,
    p_vector_limit: args.vectorLimit,
    p_fts_limit: args.ftsLimit,
    p_final_limit: args.finalLimit,
    p_rrf_k: 60,
  });
}



/** Same as `rpcMatchSimilarDealsDealTreeHybrid` but optional candidate deal filter (RRF on subset). */
export async function rpcMatchSimilarDealsDealIntel(
  admin: SupabaseClient,
  args: {
    userId: string;
    queryEmbedding: string;
    queryText: string;
    candidateDealIds: string[] | null;
    excludeDealId: string | null | undefined;
    vectorLimit: number;
    ftsLimit: number;
    finalLimit: number;
  }
) {
  return admin.rpc("deal_intel_match_similar_deals_hybrid", {
    p_user_id: args.userId,
    p_query_embedding: args.queryEmbedding,
    p_query_text: args.queryText,
    p_candidate_deal_ids: args.candidateDealIds && args.candidateDealIds.length > 0 ? args.candidateDealIds : null,
    p_exclude_deal_id: args.excludeDealId ?? null,
    p_vector_limit: args.vectorLimit,
    p_fts_limit: args.ftsLimit,
    p_final_limit: args.finalLimit,
    p_rrf_k: 60,
  });
}

export async function rpcDealIntelSimilarity2D(
  admin: SupabaseClient,
  args: { userId: string; sourceDealId: string; candidateDealIds: string[] }
) {
  return admin.rpc("deal_intel_match_similarity_2d", {
    p_user_id: args.userId,
    p_source_deal_id: args.sourceDealId,
    p_candidate_deal_ids: args.candidateDealIds,
  });
}
export async function fetchDealsByUser(
  admin: SupabaseClient,
  userId: string,
  excludeDealId: string | null | undefined,
  limit = 1500
) {
  const { data, error } = await admin
    .rpc("deal_intel_list_deals_for_user", {
      p_user_id: userId,
      p_exclude_deal_id: excludeDealId ?? null,
      p_limit: limit,
    });
  return {
    data: (data ?? []).map(flattenMetadata),
    error,
  };
}

export async function fetchDealRetrievalIndexRows(
  admin: SupabaseClient,
  dealIds: string[]
) {
  return admin
    .from("deal_retrieval_index")
    .select("deal_id, problem_embedding, solution_embedding, market_embedding")
    .in("deal_id", dealIds);
}

export async function textSearchDealKeywords(
  admin: SupabaseClient,
  dealIds: string[],
  query: string
) {
  return admin
    .from("deal_keywords")
    .select("deal_id, section_name")
    .in("deal_id", dealIds)
    .textSearch("concepts_tsv", query, { config: "english", type: "websearch" });
}

export async function fetchLatestPipelineParsing(
  admin: SupabaseClient,
  dealId: string
) {
  return admin
    .from("deal_pipeline_json_parsing")
    .select("analysis_id, parsing_json, created_at")
    .eq("deal_id", dealId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function updateDealSearchEmbedding(
  admin: SupabaseClient,
  dealId: string,
  searchDocument: string,
  embedding: string
) {
  return admin
    .from("deals")
    .update({
      search_document: searchDocument,
      deal_embedding: embedding,
    })
    .eq("id", dealId);
}

export async function fetchDealOwner(
  admin: SupabaseClient,
  dealId: string
) {
  return admin.from("deals").select("id, user_id").eq("id", dealId).maybeSingle();
}

export async function fetchDealRetrievalProfile(
  admin: SupabaseClient,
  dealId: string
) {
  return admin
    .from("deal_retrieval_index")
    .select(
      "problem_normalized, solution_normalized, market_normalized, problem_embedding, solution_embedding, market_embedding"
    )
    .eq("deal_id", dealId)
    .maybeSingle();
}

export async function rpcMatchSimilarDealsFromDeal(
  admin: SupabaseClient,
  dealId: string,
  matchCount: number
) {
  return admin.rpc("match_similar_deals_from_deal", {
    p_source_deal_id: dealId,
    p_match_count: matchCount,
  });
}
