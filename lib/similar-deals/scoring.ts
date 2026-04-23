import type { DealRetrievalProfile } from "@/lib/deal-retrieval-profile";
import {
  FUSION_KEYWORD,
  FUSION_VECTOR,
  OVERLAP_MULTIPLIER,
  W_PROBLEM,
  W_SOLUTION,
} from "@/lib/similar-deals/constants";
import type { VectorComponents } from "@/lib/similar-deals/types";

export function normalize01(scores: Map<string, number>): Map<string, number> {
  const vals = Array.from(scores.values());
  if (vals.length === 0) return new Map<string, number>();
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  if (Math.abs(max - min) < 1e-9) {
    return new Map(Array.from(scores.entries()).map(([k]) => [k, max > 0 ? 1 : 0]));
  }
  return new Map(Array.from(scores.entries()).map(([k, v]) => [k, (v - min) / (max - min)]));
}

/** Same 85/15 vector/keyword + overlap fusion; vector = weighted problem + solution cosine only. */
export function mergedScoreList(
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

export function keywordQueryFromProfile(profile: DealRetrievalProfile): string {
  const all = [...profile.problem.search_concepts, ...profile.solution.search_concepts]
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 18);
  if (all.length === 0) return "";
  return all.map((s) => `"${s.replace(/"/g, "")}"`).join(" OR ");
}

/** Export fusion weights for bundle pipeline (problem/solution emphasis). */
export function fusionWeightsProblemSolution(): { wp: number; ws: number } {
  return { wp: W_PROBLEM, ws: W_SOLUTION };
}
