import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { embedText } from "@/lib/vertex-embeddings";
import { vectorParam } from "@/lib/data-layer/shared/vector";
import { retrieveContextNodesForQuery } from "@/lib/retrieval-orchestrator";

type RankedHit =
  | { kind: "claim"; id: string; score: number; document_id: string; page_number: number | null; quote: string; claim_type: string; key: string | null }
  | { kind: "chunk"; id: string; score: number; document_id: string; page_start: number; page_end: number; text: string }
  | { kind: "tree_node"; id: string; score: number; deal_id: string; node_type: string; raw_text: string | null; polarity: string; source_map?: unknown };

function rrfMerge<T extends { id: string }>(a: T[], b: T[], k = 60): Array<{ id: string; score: number }> {
  const score = new Map<string, number>();
  const add = (arr: T[]) => {
    for (let i = 0; i < arr.length; i++) {
      const id = arr[i].id;
      score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1));
    }
  };
  add(a);
  add(b);
  return Array.from(score.entries())
    .map(([id, s]) => ({ id, score: s }))
    .sort((x, y) => y.score - x.score);
}

export async function POST(req: Request, ctx: { params: Promise<{ dealId: string }> }) {
  const { dealId } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { queryText?: string; limit?: number } | null;
  const queryText = typeof body?.queryText === "string" ? body.queryText.trim() : "";
  const limit = Math.max(5, Math.min(60, Number(body?.limit) || 18));
  if (!queryText) return NextResponse.json({ error: "Missing queryText" }, { status: 400 });

  const admin = createAdminClient();

  // Validate deal ownership
  const { data: deal, error: dealErr } = await admin
    .schema("deal_intel")
    .from("deal")
    .select("id")
    .eq("id", dealId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (dealErr) return NextResponse.json({ error: dealErr.message || "Failed to validate company" }, { status: 500 });
  if (!deal) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let queryEmb: number[] | null = null;
  try {
    queryEmb = await embedText(queryText.slice(0, 8000));
  } catch {
    queryEmb = null;
  }

  const matchCount = Math.max(10, limit * 2);

  const [chunksVec, chunksFts, claimsVec, claimsFts, treeNodes] = await Promise.all([
    queryEmb
      ? admin.rpc("deal_intel_match_document_chunks_vector", {
          p_user_id: user.id,
          p_query_embedding: vectorParam(queryEmb),
          p_match_count: matchCount,
          p_deal_id: dealId,
        })
      : Promise.resolve({ data: [] as unknown[], error: null }),
    admin.rpc("deal_intel_match_document_chunks_fts", {
      p_user_id: user.id,
      p_query: queryText.slice(0, 500),
      p_match_count: matchCount,
      p_deal_id: dealId,
    }),
    queryEmb
      ? admin.rpc("deal_intel_match_claims_vector", {
          p_user_id: user.id,
          p_query_embedding: vectorParam(queryEmb),
          p_match_count: matchCount,
          p_deal_id: dealId,
        })
      : Promise.resolve({ data: [] as unknown[], error: null }),
    admin.rpc("deal_intel_match_claims_fts", {
      p_user_id: user.id,
      p_query: queryText.slice(0, 500),
      p_match_count: matchCount,
      p_deal_id: dealId,
    }),
    retrieveContextNodesForQuery(admin, { userId: user.id, queryText, focusDealId: dealId, limit: matchCount }),
  ]);

  const chunksVecRows = ((chunksVec as { data?: unknown[] }).data ?? []) as Array<{ id: string; similarity: number } & Record<string, unknown>>;
  const chunksFtsRows = ((chunksFts as { data?: unknown[] }).data ?? []) as Array<{ id: string; score: number } & Record<string, unknown>>;
  const claimsVecRows = ((claimsVec as { data?: unknown[] }).data ?? []) as Array<{ id: string; similarity: number } & Record<string, unknown>>;
  const claimsFtsRows = ((claimsFts as { data?: unknown[] }).data ?? []) as Array<{ id: string; score: number } & Record<string, unknown>>;

  const chunkOrder = rrfMerge(
    chunksVecRows.map((r) => ({ id: r.id })),
    chunksFtsRows.map((r) => ({ id: r.id })),
  );
  const claimOrder = rrfMerge(
    claimsVecRows.map((r) => ({ id: r.id })),
    claimsFtsRows.map((r) => ({ id: r.id })),
  );

  const chunkById = new Map<string, Record<string, unknown>>();
  for (const r of [...chunksVecRows, ...chunksFtsRows]) chunkById.set(String(r.id), r);
  const claimById = new Map<string, Record<string, unknown>>();
  for (const r of [...claimsVecRows, ...claimsFtsRows]) claimById.set(String(r.id), r);

  const out: RankedHit[] = [];

  // Mix: claims 40%, chunks 40%, tree 20%
  const claimTake = Math.max(2, Math.floor(limit * 0.4));
  const chunkTake = Math.max(2, Math.floor(limit * 0.4));
  const treeTake = Math.max(1, limit - claimTake - chunkTake);

  for (const it of claimOrder.slice(0, claimTake)) {
    const r = claimById.get(it.id);
    if (!r) continue;
    out.push({
      kind: "claim",
      id: it.id,
      score: it.score,
      document_id: String(r.document_id),
      page_number: r.page_number == null ? null : Number(r.page_number),
      quote: String(r.quote ?? ""),
      claim_type: String(r.claim_type ?? ""),
      key: r.key == null ? null : String(r.key),
    });
  }

  for (const it of chunkOrder.slice(0, chunkTake)) {
    const r = chunkById.get(it.id);
    if (!r) continue;
    out.push({
      kind: "chunk",
      id: it.id,
      score: it.score,
      document_id: String(r.document_id),
      page_start: Number(r.page_start),
      page_end: Number(r.page_end),
      text: String(r.text ?? ""),
    });
  }

  for (const n of (treeNodes ?? []).slice(0, treeTake)) {
    out.push({
      kind: "tree_node",
      id: (n as unknown as { id: string }).id,
      score: n.score ?? 0,
      deal_id: n.deal_id,
      node_type: n.node_type,
      raw_text: n.raw_text,
      polarity: n.polarity,
    });
  }

  return NextResponse.json({ dealId, queryText, hits: out });
}

