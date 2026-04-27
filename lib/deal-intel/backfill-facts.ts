import type { SupabaseClient } from "@supabase/supabase-js";
import { extractKeywords } from "@/lib/data-layer/shared/text";
import { vectorParam } from "@/lib/data-layer/shared/vector";
import { embedTexts } from "@/lib/vertex-embeddings";
import { toError } from "@/lib/supabase/error-format";
import { chunkArray, mapWithConcurrency } from "@/lib/async/concurrency";

const EMBEDDING_MODEL = process.env.VERTEX_EMBEDDING_MODEL || "text-embedding-004";

function nodeToEmbeddingInput(row: { path: string; value_text: string | null; value_jsonb: unknown }): string {
  const vt = row.value_text?.trim() ?? "";
  if (vt) return `${row.path}: ${vt}`.slice(0, 8000);
  if (row.value_jsonb == null) return row.path.slice(0, 8000);
  return `${row.path}: ${JSON.stringify(row.value_jsonb)}`.slice(0, 8000);
}

export async function backfillDealIntelFactEmbeddings(
  admin: SupabaseClient,
  dealId: string
): Promise<void> {
  const { data, error } = await admin.rpc("deal_intel_get_fact_nodes", {
    p_deal_id: dealId,
  });

  if (error) throw toError(error, "Failed to load fact nodes");
  const rows = (data ?? []) as Array<{
    id: string;
    path: string;
    value_text: string | null;
    value_jsonb: unknown;
  }>;

  const embeddingInputs = rows.map((r) => nodeToEmbeddingInput(r));
  const keywordsByIdx = embeddingInputs.map((s) => extractKeywords(s, 20));

  const vecs: number[][] = [];
  for (const batch of chunkArray(embeddingInputs, 24)) {
    const bvec = await embedTexts(batch, 24);
    vecs.push(...bvec);
  }

  await mapWithConcurrency(rows, 8, async (row, idx) => {
    const { error: upErr } = await admin.rpc("deal_intel_update_fact_node_enrichment", {
      p_node_id: row.id,
      p_embedding_input: embeddingInputs[idx]!,
      p_embedding_model: EMBEDDING_MODEL,
      p_content_embedding: vectorParam(vecs[idx]!),
      p_keywords: keywordsByIdx[idx]!,
    });
    if (upErr) throw toError(upErr, "Failed to update fact node enrichment");
  });
}

