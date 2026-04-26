import { runWithPdf } from "@/lib/gemini";
import { normalizePhase1Parsing } from "@/lib/phase1-normalize";
import { PROMPT_DEAL_INTEL_SCHEMA_FACTS } from "@/lib/deal-intel/schema-facts-prompt";

function asRecord(raw: unknown): Record<string, unknown> {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  throw new Error("Schema facts extractor did not return a JSON object");
}

/**
 * Facts-only PDF extractor (Schema.pdf).
 *
 * Returns a normalized object suitable for:
 * - persistence into normalized relational deal_intel tables
 * - flattening into deal_intel.deal_fact_node (paths/values)
 */
export async function extractDealIntelSchemaFactsFromPdf(opts: {
  pdfBuffer: Buffer;
  modelTier?: "flash_lite" | "flash";
}): Promise<Record<string, unknown>> {
  const { pdfBuffer, modelTier } = opts;
  const parsed = await runWithPdf(PROMPT_DEAL_INTEL_SCHEMA_FACTS, pdfBuffer, modelTier ?? "flash_lite", false);
  const obj = asRecord(parsed);
  // Reuse deterministic normalizer: trims + lowercases prose, preserves `name` keys’ casing.
  return normalizePhase1Parsing(obj);
}

