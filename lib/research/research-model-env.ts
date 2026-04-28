export type ResearchModelTier = "flash_lite" | "flash" | "summary";

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`${name} must be set`);
  return v.trim();
}

/**
 * Web research models are intentionally separate from:
 * - Live Assistant models (LIVE_ASSISTANT_*)
 * - Deal-intel ingestion models (INGESTION_*)
 *
 * Backward-compat: fall back to existing GEMINI_MODEL_* vars if RESEARCH_* isn't set yet.
 * No hardcoded defaults: misconfig should fail loudly.
 */
export function getResearchModel(tier: ResearchModelTier): string {
  switch (tier) {
    case "flash_lite":
      return (
        process.env.RESEARCH_GEMINI_MODEL_FLASH_LITE?.trim() ||
        process.env.GEMINI_MODEL_FLASH_LITE?.trim() ||
        mustEnv("RESEARCH_GEMINI_MODEL_FLASH_LITE")
      );
    case "flash":
      return (
        process.env.RESEARCH_GEMINI_MODEL_FLASH?.trim() ||
        process.env.GEMINI_MODEL_FLASH?.trim() ||
        mustEnv("RESEARCH_GEMINI_MODEL_FLASH")
      );
    case "summary":
      return (
        process.env.RESEARCH_GEMINI_MODEL_SUMMARY?.trim() ||
        process.env.GEMINI_MODEL_FLASH_SUMMARY?.trim() ||
        mustEnv("RESEARCH_GEMINI_MODEL_SUMMARY")
      );
    default:
      return mustEnv("RESEARCH_GEMINI_MODEL_FLASH");
  }
}

