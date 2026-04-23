import { cosineSimilarity } from "@/lib/data-layer/shared/vector";

const RRF_K = 60;

/** Keyword-triggered multipliers on base node-type weights (capped). */
const KEYWORD_NODE_WEIGHT_RULES: {
  test: (query: string) => boolean;
  bumps: Partial<Record<string, number>>;
}[] = [
  {
    test: (q) => /\b(arr|mrr|revenue|runway|growth|burn|nrr|retention|cac|ltv)\b/i.test(q),
    bumps: { traction: 0.2, root: 0.04 },
  },
  {
    test: (q) => /\b(moat|defensib|differentiat|ip|patent|barrier|wedge)\b/i.test(q),
    bumps: { solution: 0.2, thesis_fit: 0.06 },
  },
  {
    test: (q) => /\b(founder|ceo|team|hiring|cto)\b/i.test(q),
    bumps: { team: 0.22 },
  },
  {
    test: (q) => /\b(problem|pain|buyer|workflow|icp)\b/i.test(q),
    bumps: { problem: 0.2 },
  },
  {
    test: (q) => /\b(pass|why pass|risk|concern|red flag)\b/i.test(q),
    bumps: { problem: 0.08, solution: 0.08, traction: 0.06 },
  },
];

const KEYWORD_NODE_WEIGHT_CAP = 0.42;

/**
 * Reciprocal rank fusion over ordered node-id lists (plan: hybrid FTS + vector).
 */
export function rrfMergeNodeIds(vectorOrdered: string[], ftsOrdered: string[], k = RRF_K): string[] {
  const score = new Map<string, number>();
  vectorOrdered.forEach((id, i) => {
    score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1));
  });
  ftsOrdered.forEach((id, i) => {
    score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1));
  });
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

export function keywordNodeTypeMultiplier(queryText: string, nodeType: string): number {
  let sum = 0;
  for (const r of KEYWORD_NODE_WEIGHT_RULES) {
    if (!r.test(queryText)) continue;
    sum += r.bumps[nodeType] ?? 0;
  }
  return 1 + Math.min(KEYWORD_NODE_WEIGHT_CAP, sum);
}

/**
 * node_score = a * sim(query, node) + (1-a) * sum_i (w_i * sim(query, subnode_i)), weights normalized.
 */
export function nodeScoreWithSubnodes(
  queryEmb: number[],
  nodeEmb: number[] | null,
  subnodes: { embedding: number[] | null; weight: number }[],
  a = 0.5
): number {
  const simNode = nodeEmb ? cosineSimilarity(queryEmb, nodeEmb) : 0;
  if (subnodes.length === 0) return simNode;
  let wSum = 0;
  let weightedSim = 0;
  for (const s of subnodes) {
    if (!s.embedding) continue;
    const w = Math.max(0, s.weight);
    wSum += w;
    weightedSim += w * cosineSimilarity(queryEmb, s.embedding);
  }
  const subTerm = wSum > 0 ? weightedSim / wSum : 0;
  return a * simNode + (1 - a) * subTerm;
}
