export type IngestionModelTier = "flash_lite" | "flash" | "summary";

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`${name} must be set`);
  return v.trim();
}

/**
 * Deal-intel ingestion models are intentionally separate from the Live Assistant.
 *
 * Backward-compat: if INGESTION_* isn't set, fall back to existing GEMINI_MODEL_* vars.
 * No hardcoded model defaults: misconfig should fail loudly (you can set envs yourself).
 */
export function getDealIntelIngestionModel(tier: IngestionModelTier): string {
  switch (tier) {
    case "flash_lite":
      return (
        process.env.INGESTION_GEMINI_MODEL_FLASH_LITE?.trim() ||
        process.env.GEMINI_MODEL_FLASH_LITE?.trim() ||
        mustEnv("INGESTION_GEMINI_MODEL_FLASH_LITE")
      );
    case "flash":
      return (
        process.env.INGESTION_GEMINI_MODEL_FLASH?.trim() ||
        process.env.GEMINI_MODEL_FLASH?.trim() ||
        mustEnv("INGESTION_GEMINI_MODEL_FLASH")
      );
    case "summary":
      return (
        process.env.INGESTION_GEMINI_MODEL_SUMMARY?.trim() ||
        process.env.GEMINI_MODEL_FLASH_SUMMARY?.trim() ||
        mustEnv("INGESTION_GEMINI_MODEL_SUMMARY")
      );
    default:
      return mustEnv("INGESTION_GEMINI_MODEL_FLASH_LITE");
  }
}

