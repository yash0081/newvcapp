import type { SupabaseClient } from "@supabase/supabase-js";
import { runWithPdf, runWithTextMulti } from "@/lib/gemini";
import { normalizePhase1Parsing } from "@/lib/phase1-normalize";
import { PLACEHOLDER_PROMPT_PHASE1_JSON } from "@/lib/ingestion/placeholder-phase1-prompt";
import { persistDealIntelFacts } from "@/lib/ingestion/persist-deal-intel-facts";
import { materializeDealIntelTree } from "@/lib/deal-intel/materialize-tree";
import { backfillDealIntelFactEmbeddings } from "@/lib/deal-intel/backfill-facts";
import { backfillDealIntelKeywordGraph } from "@/lib/deal-intel/keywords";

function asParsingRecord(raw: unknown): Record<string, unknown> {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  throw new Error("Model did not return a JSON object");
}

async function enrichDealIntelAfterPersist(
  admin: SupabaseClient,
  ids: { dealId: string; revisionId: string }
): Promise<void> {
  await backfillDealIntelFactEmbeddings(admin, ids.dealId);
  await materializeDealIntelTree({ admin, dealId: ids.dealId, revisionId: ids.revisionId });
  await backfillDealIntelKeywordGraph(admin, ids.dealId);
}

export async function ingestPhase1PlaceholderFromText(
  admin: SupabaseClient,
  userId: string,
  text: string
): Promise<{ dealId: string; revisionId: string }> {
  const raw = await runWithTextMulti(
    PLACEHOLDER_PROMPT_PHASE1_JSON,
    [{ label: "source_document", value: text }],
    "flash_lite",
    false
  );
  const parsed = asParsingRecord(raw);
  const normalized = normalizePhase1Parsing(parsed);
  const ids = await persistDealIntelFacts({
    admin,
    userId,
    facts: normalized,
    dealMetadata: { ingest_kind: "text" },
  });
  await enrichDealIntelAfterPersist(admin, ids);
  return ids;
}

export async function ingestPhase1PlaceholderFromPdf(
  admin: SupabaseClient,
  userId: string,
  _pdfBuffer: Buffer
): Promise<{ dealId: string; revisionId: string }> {
  const raw = await runWithPdf(PLACEHOLDER_PROMPT_PHASE1_JSON, _pdfBuffer, "flash_lite", false);
  const parsed = asParsingRecord(raw);
  const normalized = normalizePhase1Parsing(parsed);
  const ids = await persistDealIntelFacts({
    admin,
    userId,
    facts: normalized,
    dealMetadata: { ingest_kind: "pdf" },
  });
  await enrichDealIntelAfterPersist(admin, ids);
  return ids;
}
