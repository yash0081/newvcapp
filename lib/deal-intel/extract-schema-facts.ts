import { parseJsonFromResponseWithRepair } from "@/lib/gemini";
import { normalizePhase1Parsing } from "@/lib/phase1-normalize";
import { PROMPT_DEAL_INTEL_SCHEMA_FACTS } from "@/lib/deal-intel/schema-facts-prompt";
import { vertexRunWithPdf, vertexRunWithTextMulti } from "@/lib/vertex";
import { getDealIntelIngestionModel } from "@/lib/deal-intel/ingestion-model-env";

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
  const modelName = getDealIntelIngestionModel(modelTier ?? "flash_lite");
  const raw = await vertexRunWithPdf(modelName, pdfBuffer, PROMPT_DEAL_INTEL_SCHEMA_FACTS, false);
  const parsed = (await parseJsonFromResponseWithRepair(raw)) as unknown;
  const obj = asRecord(parsed);
  // Reuse deterministic normalizer: trims + lowercases prose, preserves `name` keys’ casing.
  return normalizePhase1Parsing(obj);
}

/**
 * Text-based facts extractor used by copilot finalize.
 *
 * Input is already-extracted accepted snippets (not a PDF). The model must map
 * this text to the same Schema.pdf facts object so persistence can reuse the
 * relational writer unchanged.
 */
export async function extractDealIntelSchemaFactsFromText(opts: {
  sourceText: string;
  modelTier?: "flash_lite" | "flash";
  existingFacts?: Record<string, unknown> | null;
}): Promise<Record<string, unknown>> {
  const sourceText = String(opts.sourceText ?? "").trim();
  if (!sourceText) {
    throw new Error("No source text provided for schema facts extraction");
  }
  const modelName = getDealIntelIngestionModel(opts.modelTier ?? "flash_lite");
  const raw = await vertexRunWithTextMulti(
    modelName,
    `${PROMPT_DEAL_INTEL_SCHEMA_FACTS}

The source is accepted research snippets from a browsing copilot session (not a pitch deck PDF).
Use only the provided text plus existing saved facts context.

Merge policy:
- Prefer additive merges for arrays/lists (do not drop prior valid entries).
- For prose/description fields, merge old+new information into one richer description.
- Do not overwrite existing single-value fields unless the new snippet clearly provides a better/more-specific value or an explicit contradiction resolution.
- If a contradiction appears explicitly in accepted snippets (e.g. "Current: ... | New: ..."), prefer the new accepted value.
- Keep unknowns as null/[] per schema.`,
    [
      { label: "Existing saved facts (merge baseline)", value: opts.existingFacts ?? {} },
      { label: "Accepted research snippets", value: sourceText.slice(0, 30000) },
    ],
    false
  );
  const parsed = (await parseJsonFromResponseWithRepair(raw)) as unknown;
  const obj = asRecord(parsed);
  return normalizePhase1Parsing(obj);
}

