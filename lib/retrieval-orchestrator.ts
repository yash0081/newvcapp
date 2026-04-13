import type { SupabaseClient } from "@supabase/supabase-js";
import { embedText } from "@/lib/vertex-embeddings";
import { extractKeywords } from "@/lib/materialize-deal-context";
import { resolveDealIdsFromTabularFilter } from "@/lib/filter-deals-from-query";

export type QueryType = "similar_company" | "filter_semantic" | "analytical" | "exploratory";

export type ChatTask =
  | "similar_deal"
  | "filtering"
  | "deep_reasoning"
  | "why"
  | "questions";

/** Per plan A4: weight node types when ranking context for the LLM. */
const QUERY_TYPE_NODE_WEIGHTS: Record<
  QueryType,
  Record<string, number>
> = {
  similar_company: {
    root: 0.15,
    problem: 0.2,
    solution: 0.2,
    traction: 0.15,
    thesis_fit: 0.15,
    team: 0.15,
  },
  filter_semantic: {
    root: 0.1,
    problem: 0.15,
    solution: 0.15,
    traction: 0.25,
    thesis_fit: 0.2,
    team: 0.15,
  },
  analytical: {
    root: 0.1,
    problem: 0.2,
    solution: 0.2,
    traction: 0.2,
    thesis_fit: 0.15,
    team: 0.15,
  },
  exploratory: {
    root: 0.2,
    problem: 0.18,
    solution: 0.18,
    traction: 0.16,
    thesis_fit: 0.14,
    team: 0.14,
  },
};

const RRF_K = 60;

function vectorParam(values: number[]): string {
  return `[${values.join(",")}]`;
}

function parseEmbedding(raw: unknown): number[] | null {
  if (Array.isArray(raw)) {
    const arr = raw.filter((x): x is number => typeof x === "number" && !Number.isNaN(x));
    return arr.length === 768 ? arr : null;
  }
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) return null;
  const body = t.slice(1, -1).trim();
  if (!body) return null;
  const out = body
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => !Number.isNaN(n));
  return out.length === 768 ? out : null;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0,
    an = 0,
    bn = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    an += a[i] * a[i];
    bn += b[i] * b[i];
  }
  if (an <= 0 || bn <= 0) return 0;
  return dot / (Math.sqrt(an) * Math.sqrt(bn));
}

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

/**
 * Heuristic query type (plan: hardcoded keywords); extend with classifier later.
 */
export function classifyQueryType(userText: string): QueryType {
  const t = userText.toLowerCase();
  if (/\b(filter|where|stage|sector|only|list all)\b/.test(t)) return "filter_semantic";
  if (/\b(compare|versus|vs\.?|difference|benchmark)\b/.test(t)) return "analytical";
  if (/\b(similar|like this|comps?|comparable)\b/.test(t)) return "similar_company";
  return "exploratory";
}

export function mapTaskToQueryType(task: ChatTask): QueryType {
  switch (task) {
    case "similar_deal":
      return "similar_company";
    case "filtering":
      return "filter_semantic";
    case "deep_reasoning":
    case "why":
    case "questions":
      return "analytical";
    default:
      return "exploratory";
  }
}

/** Blend α in nodeScoreWithSubnodes: higher α weights the parent node embedding vs subnodes. */
const SUBNODE_BLEND_ALPHA_BY_TASK: Record<ChatTask, number> = {
  similar_deal: 0.38,
  filtering: 0.58,
  deep_reasoning: 0.48,
  why: 0.42,
  questions: 0.44,
};

const SUBNODE_BLEND_ALPHA_BY_QUERY: Record<QueryType, number> = {
  similar_company: 0.4,
  filter_semantic: 0.55,
  analytical: 0.48,
  exploratory: 0.5,
};

export function subnodeBlendAlpha(chatTask: ChatTask | undefined, queryType: QueryType): number {
  if (chatTask && chatTask in SUBNODE_BLEND_ALPHA_BY_TASK) {
    return SUBNODE_BLEND_ALPHA_BY_TASK[chatTask];
  }
  return SUBNODE_BLEND_ALPHA_BY_QUERY[queryType] ?? 0.5;
}

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
  const simNode = nodeEmb ? cosine(queryEmb, nodeEmb) : 0;
  if (subnodes.length === 0) return simNode;
  let wSum = 0;
  let weightedSim = 0;
  for (const s of subnodes) {
    if (!s.embedding) continue;
    const w = Math.max(0, s.weight);
    wSum += w;
    weightedSim += w * cosine(queryEmb, s.embedding);
  }
  const subTerm = wSum > 0 ? weightedSim / wSum : 0;
  return a * simNode + (1 - a) * subTerm;
}

export type ContextChunk = {
  deal_id: string;
  node_type: string;
  raw_text: string | null;
  score: number;
  polarity: string;
};

type RpcRow = {
  id: string;
  deal_id: string;
  analysis_id: string;
  node_type: string;
  raw_text: string | null;
  similarity?: number;
  rank?: number;
};

/**
 * Hybrid: vector + FTS RRF, optional tabular deal prefilter, subnode re-rank + polarity.
 */
export async function retrieveContextNodesForQuery(
  admin: SupabaseClient,
  args: {
    userId: string;
    queryText: string;
    queryType?: QueryType;
    chatTask?: ChatTask;
    limit?: number;
    /** When set, bias toward this deal's nodes first */
    focusDealId?: string | null;
    /** Skip second tabular resolve when caller already computed deal IDs */
    precomputedTabularDealIds?: string[];
  }
): Promise<ContextChunk[]> {
  const queryType = args.queryType ?? classifyQueryType(args.queryText);
  const typeWeights = QUERY_TYPE_NODE_WEIGHTS[queryType];
  const blendAlpha = subnodeBlendAlpha(args.chatTask, queryType);
  const limit = args.limit ?? 24;
  const qTrim = args.queryText.trim();

  const useTabular =
    queryType === "filter_semantic" || args.chatTask === "filtering";
  let tabularDealIds: string[] | null = null;
  if (useTabular) {
    const raw =
      args.precomputedTabularDealIds !== undefined
        ? args.precomputedTabularDealIds
        : await resolveDealIdsFromTabularFilter(admin, args.userId, qTrim);
    tabularDealIds = raw.length ? raw.slice(0, 500) : null;
  }

  let queryEmb: number[];
  try {
    queryEmb = await embedText(qTrim.slice(0, 8000));
  } catch {
    return [];
  }

  const fetchCount = limit * 2;

  const vectorRpc =
    tabularDealIds && tabularDealIds.length > 0
      ? admin.rpc("match_deal_context_nodes_in_deals", {
          p_user_id: args.userId,
          p_query_embedding: vectorParam(queryEmb),
          p_deal_ids: tabularDealIds,
          p_match_count: fetchCount,
        })
      : admin.rpc("match_deal_context_nodes", {
          p_user_id: args.userId,
          p_query_embedding: vectorParam(queryEmb),
          p_match_count: fetchCount,
        });

  const ftsRpc =
    qTrim.length >= 2
      ? admin.rpc("match_deal_context_nodes_fts", {
          p_user_id: args.userId,
          p_query: qTrim.slice(0, 500),
          p_match_count: fetchCount,
        })
      : Promise.resolve({ data: null, error: null });

  const [{ data: vecData, error: vecErr }, { data: ftsData, error: ftsErr }] = await Promise.all([
    vectorRpc,
    ftsRpc,
  ]);

  if (vecErr) {
    console.error("retrieveContextNodesForQuery vector rpc:", vecErr);
  }
  if (ftsErr) {
    console.warn("retrieveContextNodesForQuery fts rpc:", ftsErr);
  }

  let vecRows = (vecData ?? []) as RpcRow[];
  let ftsRows = (ftsData ?? []) as RpcRow[];

  if (tabularDealIds && tabularDealIds.length > 0) {
    const allow = new Set(tabularDealIds);
    ftsRows = ftsRows.filter((r) => allow.has(r.deal_id));
  }

  const vectorOrdered = vecRows.map((r) => r.id);
  const ftsOrdered = ftsRows.map((r) => r.id);

  let mergedIds: string[];
  if (ftsOrdered.length === 0) {
    mergedIds = vectorOrdered;
  } else if (vectorOrdered.length === 0) {
    mergedIds = ftsOrdered;
  } else {
    mergedIds = rrfMergeNodeIds(vectorOrdered, ftsOrdered);
  }

  const ftsTopDeals = new Set<string>();
  for (const r of ftsRows.slice(0, 10)) {
    ftsTopDeals.add(r.deal_id);
  }

  const nodeIds = mergedIds.slice(0, Math.max(fetchCount, limit * 2));
  if (nodeIds.length === 0) return [];

  const simById = new Map<string, number>();
  for (const r of vecRows) {
    if (typeof r.similarity === "number") simById.set(r.id, r.similarity);
  }

  const queryTerms = new Set(extractKeywords(args.queryText, 24));

  const { data: fullNodes } = await admin
    .from("deal_context_nodes")
    .select("id, deal_id, parent_id, node_type, raw_text, embedding, polarity, node_weight, keywords")
    .in("id", nodeIds);

  const byId = new Map(
    (fullNodes ?? []).map((n) => [
      n.id as string,
      n as {
        id: string;
        deal_id: string;
        parent_id: string | null;
        node_type: string;
        raw_text: string | null;
        embedding: unknown;
        polarity: string;
        node_weight: number;
        keywords: string[] | null;
      },
    ])
  );

  const { data: children } = await admin
    .from("deal_context_nodes")
    .select("id, parent_id, embedding, node_weight, raw_text")
    .in(
      "parent_id",
      nodeIds.filter(Boolean)
    );

  const childrenByParent = new Map<string, NonNullable<typeof children>>();
  for (const c of children ?? []) {
    const pid = c.parent_id as string;
    if (!childrenByParent.has(pid)) childrenByParent.set(pid, []);
    childrenByParent.get(pid)!.push(c);
  }

  const scored: ContextChunk[] = [];

  for (const id of nodeIds) {
    const n = byId.get(id);
    if (!n) continue;
    const nodeEmb = parseEmbedding(n.embedding);
    const subs = (childrenByParent.get(n.id) ?? []).map((c) => {
      let w = typeof c.node_weight === "number" ? c.node_weight : 1;
      const raw = (c as { raw_text?: string | null }).raw_text;
      if (raw && queryTerms.size) {
        const subKw = extractKeywords(raw, 16);
        let ov = 0;
        for (const kw of subKw) {
          if (queryTerms.has(kw)) ov++;
        }
        w *= 1 + Math.min(0.35, ov * 0.09);
      }
      return {
        embedding: parseEmbedding(c.embedding),
        weight: w,
      };
    });
    const base = nodeScoreWithSubnodes(queryEmb, nodeEmb, subs, blendAlpha);
    const tw =
      (typeWeights[n.node_type] ?? 0.12) * keywordNodeTypeMultiplier(qTrim, n.node_type);
    const rpcSim = simById.get(id) ?? 0;
    let score = base * tw * (1 + Number(rpcSim));
    const kws = Array.isArray(n.keywords) ? n.keywords : [];
    let overlap = 0;
    for (const kw of kws) {
      if (queryTerms.has(String(kw).toLowerCase())) overlap++;
    }
    score *= 1 + Math.min(0.45, overlap * 0.12);
    if (n.polarity === "negative") score *= 0.35;
    if (ftsTopDeals.has(n.deal_id)) score *= 1.08;
    if (args.focusDealId && n.deal_id === args.focusDealId) {
      score *= 1.35;
    }

    scored.push({
      deal_id: n.deal_id,
      node_type: n.node_type,
      raw_text: n.raw_text,
      score,
      polarity: n.polarity ?? "neutral",
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
