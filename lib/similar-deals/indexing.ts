import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchDealSearchDocumentInput } from "@/lib/deal-search-document";
import {
  buildRetrievalProfileFromParsing,
  embedRetrievalProfile,
  upsertDealRetrievalArtifacts,
} from "@/lib/deal-retrieval-profile";
import { embedText } from "@/lib/vertex-embeddings";
import { normalizePhase1Parsing } from "@/lib/phase1-normalize";
import { registerKeywordPhrases } from "@/lib/keyword-vocabulary-graph";
import { vectorParam } from "@/lib/data-layer/shared/vector";
import { fetchLatestPipelineParsing, updateDealSearchEmbedding } from "@/lib/data-layer/schema-access/similar-deals";

export async function afterPersistIndexDealEmbedding(admin: SupabaseClient, dealId: string): Promise<boolean> {
  const doc = await fetchDealSearchDocumentInput(admin, dealId);
  const searchDocumentIndexed = doc ? await indexDealEmbedding(admin, dealId, doc) : false;

  try {
    // Prefer `deal_pipeline_json_parsing` (normalized, persisted by pipeline)
    // because older `deal_analyses.raw_output` blobs may not contain `parsing_json`.
    const { data: parsingRow } = await fetchLatestPipelineParsing(admin, dealId);

    const parsing = (parsingRow?.parsing_json ?? null) as Record<string, unknown> | null;
    const analysisId = parsingRow?.analysis_id as string | undefined;

    if (analysisId && parsing && typeof parsing === "object" && Object.keys(parsing).length > 0) {
      const profile = await buildRetrievalProfileFromParsing(
        normalizePhase1Parsing(parsing as Record<string, unknown>)
      );
      const embeddings = await embedRetrievalProfile(profile);
      await registerKeywordPhrases(admin, [
        ...profile.problem.search_concepts,
        ...profile.solution.search_concepts,
      ]);
      await upsertDealRetrievalArtifacts({
        admin,
        dealId,
        analysisId,
        profile,
        embeddings,
      });
    }
  } catch (e) {
    console.warn("afterPersistIndexDealEmbedding: retrieval index skipped:", e);
  }

  return searchDocumentIndexed;
}

/**
 * Persist `search_document` + embedding on `deals` after analysis data exists.
 */
export async function indexDealEmbedding(admin: SupabaseClient, dealId: string, searchDocument: string): Promise<boolean> {
  const doc = searchDocument.trim().slice(0, 12000);
  if (!doc) return false;
  try {
    const emb = await embedText(doc);
    const { error } = await updateDealSearchEmbedding(admin, dealId, doc, vectorParam(emb));
    if (error) {
      console.error("indexDealEmbedding update:", error);
      return false;
    }
    return true;
  } catch (e) {
    console.error("indexDealEmbedding:", e);
    return false;
  }
}
