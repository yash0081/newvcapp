import type { SupabaseClient } from "@supabase/supabase-js";
import { extractDealIntelSchemaFactsFromPdf } from "@/lib/deal-intel/extract-schema-facts";
import { persistDealIntelFacts } from "@/lib/ingestion/persist-deal-intel-facts";
import { persistDealIntelSchemaRelational } from "@/lib/deal-intel/persist-schema-relational";
import { backfillDealIntelFactEmbeddings } from "@/lib/deal-intel/backfill-facts";
import { materializeDealIntelTree } from "@/lib/deal-intel/materialize-tree";
import { backfillDealIntelKeywordGraph } from "@/lib/deal-intel/keywords";

export async function ingestDealIntelSchemaFactsFromPdf(opts: {
  admin: SupabaseClient;
  userId: string;
  pdfBuffer: Buffer;
  dealMetadata?: Record<string, unknown>;
}): Promise<{ dealId: string; revisionId: string }> {
  const { admin, userId, pdfBuffer, dealMetadata } = opts;

  const facts = await extractDealIntelSchemaFactsFromPdf({ pdfBuffer, modelTier: "flash_lite" });

  // Create deal + revision up front (so we can write relational tables against it).
  const { data: dr, error: derr } = await admin.rpc("deal_intel_create_deal_with_revision", {
    p_user_id: userId,
    p_deal_metadata: {
      source: "pdf_schema_facts_ingest",
      ...(dealMetadata ?? {}),
    },
    p_revision_label: "ingest:schema_facts_pdf",
    p_revision_metadata: { kind: "schema_facts_pdf" },
  });
  const first = Array.isArray(dr) ? dr[0] : null;
  if (derr || !first) {
    throw new Error((derr as { message?: string } | null)?.message ?? "Failed to create deal_intel deal/revision");
  }
  const dealId = first.deal_id as string;
  const revisionId = first.revision_id as string;

  // 1) Persist into normalized relational tables
  await persistDealIntelSchemaRelational({ admin, dealId, revisionId, facts });

  // 2) Persist flattened fact nodes into deal_intel.deal_fact_node (reusing existing pipeline)
  await persistDealIntelFacts({
    admin,
    userId,
    existing: { dealId, revisionId },
    facts,
    dealMetadata,
  });

  // 3) Enrich vector layers + build deal tree + keyword graph
  await backfillDealIntelFactEmbeddings(admin, dealId);
  await materializeDealIntelTree({ admin, dealId, revisionId });
  await backfillDealIntelKeywordGraph(admin, dealId);

  return { dealId, revisionId };
}

