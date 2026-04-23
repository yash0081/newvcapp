/** KNN-style top-K for deal page UI. Pipeline injects `similar_companies_overall_top` + section-focused lists into LLM prompts. */
export const SIMILAR_PEERS_TOP_K = 3;
export const TOP_CANDIDATES_FOR_RERANK = 5;

/** Fused P+S vector weights (relative emphasis solution > problem, same ratio as prior 0.35:0.25 over P+S only). */
export const W_SOLUTION = 0.35 / (0.35 + 0.25);
export const W_PROBLEM = 0.25 / (0.35 + 0.25);
export const FUSION_VECTOR = 0.85;
export const FUSION_KEYWORD = 0.15;
export const OVERLAP_MULTIPLIER = 1.4;
