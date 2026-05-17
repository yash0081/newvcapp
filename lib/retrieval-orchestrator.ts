import type { SupabaseClient } from "@supabase/supabase-js";
import { embedText } from "@/lib/vertex-embeddings";
import { extractKeywords } from "@/lib/data-layer/shared/text";
import { parseVectorDim, vectorParam } from "@/lib/data-layer/shared/vector";
import {
  fetchDealTreeChildrenByParentIds,
  fetchDealTreeNodesByIds,
  matchDealTreeNodesFts,
  matchDealTreeNodesVector,
} from "@/lib/data-layer/schema-access/retrieval";
import {
  QUERY_TYPE_NODE_WEIGHTS,
  classifyQueryType,
  mapTaskToQueryType,
  subnodeBlendAlpha,
  type ChatTask,
  type QueryType,
} from "@/lib/data-layer/retrieval/policy";
import {
  keywordNodeTypeMultiplier,
  nodeScoreWithSubnodes,
  rrfMergeNodeIds,
} from "@/lib/data-layer/similarity/ranking";
import { resolveDealIdsFromTabularFilter } from "@/lib/filter-deals-from-query";

function parseEmbedding(raw: unknown): number[] | null {
  return parseVectorDim(raw, 768);
}

export type { ChatTask, QueryType };
export { classifyQueryType, mapTaskToQueryType, rrfMergeNodeIds };

export type ContextChunk = {
  deal_id: string;
  node_type: string;
  raw_text: string | null;
  score: number;
  polarity: string;
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
    /** Reuse a caller-computed embedding so sibling retrieval paths do not embed the same query twice. */
    queryEmbedding?: number[] | Promise<number[] | null>;
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
    queryEmb = (args.queryEmbedding ? await args.queryEmbedding : null) ?? (await embedText(qTrim.slice(0, 8000)));
  } catch {
    return [];
  }

  const fetchCount = limit * 2;

  const vectorRpc = matchDealTreeNodesVector(admin, {
    userId: args.userId,
    queryEmbedding: vectorParam(queryEmb),
    dealIds: tabularDealIds ?? null,
    matchCount: fetchCount,
  });

  const ftsRpc =
    qTrim.length >= 2
      ? matchDealTreeNodesFts(admin, {
          userId: args.userId,
          query: qTrim.slice(0, 500),
          matchCount: fetchCount,
        })
      : Promise.resolve({ rows: [], error: null as unknown });

  const [{ rows: vecRows, error: vecErr }, { rows: ftsRowsRaw, error: ftsErr }] = await Promise.all([
    vectorRpc,
    ftsRpc,
  ]);

  if (vecErr) {
    console.error("retrieveContextNodesForQuery vector rpc:", vecErr);
  }
  if (ftsErr) {
    console.warn("retrieveContextNodesForQuery fts rpc:", ftsErr);
  }

  let ftsRows = ftsRowsRaw;

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

  const { nodes: fullNodes } = await fetchDealTreeNodesByIds(admin, nodeIds);

  const byId = new Map(
    (fullNodes ?? []).map((n) => [
      n.id as string,
      n as {
        id: string;
        deal_id: string;
        parent_id: string | null;
        node_type: string;
        narrative_text: string | null;
        atomic_embedding: unknown;
        signal_embedding: unknown;
        polarity: string;
        node_weight: number;
        keywords: string[] | null;
      },
    ])
  );

  const { rows: children } = await fetchDealTreeChildrenByParentIds(
    admin,
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
    const nodeEmb = parseEmbedding(n.signal_embedding ?? n.atomic_embedding);
    const subs = (childrenByParent.get(n.id) ?? []).map((c) => {
      let w = typeof c.node_weight === "number" ? c.node_weight : 1;
      const raw = (c as { narrative_text?: string | null }).narrative_text;
      if (raw && queryTerms.size) {
        const subKw = extractKeywords(raw, 16);
        let ov = 0;
        for (const kw of subKw) {
          if (queryTerms.has(kw)) ov++;
        }
        w *= 1 + Math.min(0.35, ov * 0.09);
      }
      return {
        embedding: parseEmbedding((c as { signal_embedding?: unknown }).signal_embedding ?? (c as { atomic_embedding?: unknown }).atomic_embedding),
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
      raw_text: n.narrative_text,
      score,
      polarity: n.polarity ?? "neutral",
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
