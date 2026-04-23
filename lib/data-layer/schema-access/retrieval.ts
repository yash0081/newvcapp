import type { SupabaseClient } from "@supabase/supabase-js";

type RpcRow = {
  id: string;
  deal_id: string;
  analysis_id: string | null;
  node_type: string;
  narrative_text: string | null;
  raw_text: string | null;
  similarity?: number;
  rank?: number;
};

export async function matchDealTreeNodesVector(
  admin: SupabaseClient,
  args: {
    userId: string;
    queryEmbedding: string;
    dealIds: string[] | null;
    matchCount: number;
  }
): Promise<{ rows: RpcRow[]; error: unknown }> {
  const { data, error } = await admin.rpc("deal_intel_match_deal_tree_nodes_vector", {
    p_user_id: args.userId,
    p_query_embedding: args.queryEmbedding,
    p_deal_ids: args.dealIds,
    p_match_count: args.matchCount,
  });
  return { rows: (data ?? []) as RpcRow[], error };
}

export async function matchDealTreeNodesFts(
  admin: SupabaseClient,
  args: { userId: string; query: string; matchCount: number }
): Promise<{ rows: RpcRow[]; error: unknown }> {
  const { data, error } = await admin.rpc("deal_intel_match_deal_tree_nodes_fts", {
    p_user_id: args.userId,
    p_query: args.query,
    p_match_count: args.matchCount,
  });
  return { rows: (data ?? []) as RpcRow[], error };
}

export type DealIntelTreeNodeRow = {
  id: string;
  deal_id: string;
  parent_id: string | null;
  node_type: string;
  narrative_text: string | null;
  atomic_embedding: unknown;
  signal_embedding: unknown;
  node_weight: number;
  keywords: string[] | null;
  value_jsonb: unknown;
  source_map: unknown;
};

export function inferTreePolarity(n: { node_type: string; value_jsonb: unknown; source_map: unknown }): string {
  const vj = n.value_jsonb;
  if (vj && typeof vj === "object" && vj !== null && "polarity" in vj) {
    const p = (vj as { polarity?: string }).polarity;
    if (p === "negative" || p === "positive" || p === "neutral") return p;
  }
  const sm = n.source_map;
  if (sm && typeof sm === "object" && sm !== null && "polarity" in sm) {
    const p = (sm as { polarity?: string }).polarity;
    if (p === "negative" || p === "positive" || p === "neutral") return p;
  }
  const t = n.node_type.toLowerCase();
  if (t.includes("rejection") || t.includes("negatives") || t.includes("risk") || t.includes("hypothetical_investment_rejection")) {
    return "negative";
  }
  return "neutral";
}

export async function fetchDealTreeNodesByIds(
  admin: SupabaseClient,
  nodeIds: string[]
): Promise<{
  nodes: Array<
    DealIntelTreeNodeRow & {
      polarity: string;
    }
  >;
}> {
  const { data } = await admin
    .rpc("deal_intel_get_tree_nodes_by_ids", {
      p_node_ids: nodeIds,
    });

  const raw = (data ?? []) as DealIntelTreeNodeRow[];
  return {
    nodes: raw.map((n) => ({ ...n, polarity: inferTreePolarity(n) })),
  };
}

export async function fetchDealTreeChildrenByParentIds(
  admin: SupabaseClient,
  parentIds: string[]
): Promise<{
  rows: Array<{
    id: string;
    parent_id: string | null;
    atomic_embedding: unknown;
    signal_embedding: unknown;
    node_weight: number;
    narrative_text: string | null;
  }>;
}> {
  const { data } = await admin
    .rpc("deal_intel_get_tree_children_by_parent_ids", {
      p_parent_ids: parentIds,
    });
  return {
    rows: (data ?? []) as Array<{
      id: string;
      parent_id: string | null;
      atomic_embedding: unknown;
      signal_embedding: unknown;
      node_weight: number;
      narrative_text: string | null;
    }>,
  };
}
