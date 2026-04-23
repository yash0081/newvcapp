import type { SupabaseClient } from "@supabase/supabase-js";
import { cosineSimilarity, parseVector } from "@/lib/data-layer/shared/vector";
import {
  fetchDealTreeNodesForSimilarity,
  rpcDealIntelSimilarity2D,
} from "@/lib/data-layer/schema-access/similar-deals";

const DEAL_TREE_OPPORTUNITY_WEIGHTS: Record<string, number> = {
  problem: 0.2,
  solution: 0.25,
  market: 0.2,
  traction: 0.15,
  thesis_fit: 0.1,
  team: 0.1,
};

function safeCosineSimilarity(a: number[] | null, b: number[] | null): number {
  if (!a || !b || a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  return cosineSimilarity(a, b);
}

function slotKey(nodeType: string): keyof typeof DEAL_TREE_OPPORTUNITY_WEIGHTS | null {
  const t = nodeType.toLowerCase();
  if (t.includes("problem")) return "problem";
  if (t.includes("solution")) return "solution";
  if (t.includes("market")) return "market";
  if (t.includes("traction")) return "traction";
  if (t.includes("thesis")) return "thesis_fit";
  if (t.includes("team") || t.includes("founder")) return "team";
  if (t in DEAL_TREE_OPPORTUNITY_WEIGHTS) return t as keyof typeof DEAL_TREE_OPPORTUNITY_WEIGHTS;
  return null;
}

export async function computeDealTree2DSimilarity(
  admin: SupabaseClient,
  args: { userId?: string; queryDealId: string; candidateDealIds: string[] }
): Promise<Map<string, { opportunity: number; risk: number }>> {
  const out = new Map<string, { opportunity: number; risk: number }>();
  const ids = Array.from(new Set([args.queryDealId, ...args.candidateDealIds]));
  if (ids.length === 0) return out;

  if (args.userId) {
    const { data, error } = await rpcDealIntelSimilarity2D(admin, {
      userId: args.userId,
      sourceDealId: args.queryDealId,
      candidateDealIds: args.candidateDealIds,
    });
    if (!error && Array.isArray(data) && data.length > 0) {
      for (const row of data as Array<{
        deal_id: string;
        opportunity_similarity: number | null;
        risk_similarity: number | null;
      }>) {
        out.set(row.deal_id, {
          opportunity: Math.max(0, Number(row.opportunity_similarity ?? 0)),
          risk: Math.max(0, Number(row.risk_similarity ?? 0)),
        });
      }
      return out;
    }
  }

  const { data: nodes } = await fetchDealTreeNodesForSimilarity(admin, ids);

  const byDeal = new Map<
    string,
    {
      opp: Map<string, number[]>;
      risk: number[] | null;
    }
  >();

  const ensure = (dealId: string) => {
    if (!byDeal.has(dealId)) byDeal.set(dealId, { opp: new Map(), risk: null });
    return byDeal.get(dealId)!;
  };

  for (const n of nodes ?? []) {
    const dealId = n.deal_id as string;
    const kind = n.kind as string;
    if (kind !== "child") continue;
    const nodeType = n.node_type as string;
    const pol = (n as { polarity?: string }).polarity;
    const sig = parseVector(n.signal_embedding);
    if (!sig) continue;
    const bag = ensure(dealId);
    const sk = slotKey(nodeType);
    if (sk) bag.opp.set(sk, sig);
    const nt = nodeType.toLowerCase();
    if (
      nt.includes("negatives") ||
      nt.includes("risk") ||
      nt.includes("rejection") ||
      nt.includes("hypothetical_investment_rejection") ||
      pol === "negative"
    ) {
      if (!bag.risk) bag.risk = sig;
    }
  }

  const q = byDeal.get(args.queryDealId);
  if (!q) return out;

  for (const cid of args.candidateDealIds) {
    const c = byDeal.get(cid);
    if (!c) continue;
    let wSum = 0;
    let oppSum = 0;
    for (const [t, w] of Object.entries(DEAL_TREE_OPPORTUNITY_WEIGHTS)) {
      const qa = q.opp.get(t) ?? null;
      const cb = c.opp.get(t) ?? null;
      if (!qa || !cb) continue;
      wSum += w;
      oppSum += w * safeCosineSimilarity(qa, cb);
    }
    const opportunity = wSum > 0 ? oppSum / wSum : 0;
    const risk = q.risk && c.risk ? Math.max(0, safeCosineSimilarity(q.risk, c.risk)) : 0;
    out.set(cid, { opportunity: Math.max(0, opportunity), risk });
  }
  return out;
}
