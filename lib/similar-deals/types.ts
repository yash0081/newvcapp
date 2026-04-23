import type { DealRetrievalProfile } from "@/lib/deal-retrieval-profile";

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
  /** 0..1 cosine-based similarity over positive opportunity child nodes (Deal Tree v1). */
  opportunity_similarity?: number;
  /** 0..1 cosine-based similarity over negative/risks node (Deal Tree v1). */
  risk_similarity?: number;
  /**
   * 0–1 confidence derived from relative `rrf_score` strength within the injected peer set.
   * Prompts can use this to treat the peer as a near-direct comparable vs weakly related.
   */
  similarity_confidence: number;
};

export type RpcHybridRow = {
  id: string;
  company_name: string | null;
  vector_rank: number | null;
  fts_rank: number | null;
  rrf_score: number | null;
};

export type RpcDealTreeHybridRow = {
  deal_id: string;
  company_name: string | null;
  vector_rank: number | null;
  fts_rank: number | null;
  rrf_score: number | null;
};

export type RetrievalIndexRow = {
  deal_id: string;
  problem_embedding: string | number[] | null;
  solution_embedding: string | number[] | null;
  market_embedding: string | number[] | null;
};

export type CandidateMeta = {
  id: string;
  company_name: string;
  sector: string | null;
  stage: string | null;
  decision: string | null;
  pass_reason: string | null;
  pass_reason_detail: string | null;
  moat_type: string | null;
  /** Filled for `deal_intel` corpus (metadata); used when legacy analysis rows are missing. */
  problem_one_liner?: string | null;
  solution_one_liner?: string | null;
};

/** Top-3 overall (fused + LLM rerank) plus top-3 per embedding slot for section-specific prompts. */
export type SimilarPeerBundleForPipeline = {
  overall: SimilarPeerForPrompt[];
  problem_focused: SimilarPeerForPrompt[];
  solution_focused: SimilarPeerForPrompt[];
  market_focused: SimilarPeerForPrompt[];
  risk_focused: SimilarPeerForPrompt[];
};

export type VectorComponents = { p: number; s: number };

export type RerankCandidatePayload = {
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
};
