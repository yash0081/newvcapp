export type LiveAssistantModelTier = "fast" | "big";

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`${name} must be set`);
  return v.trim();
}

/**
 * Live Assistant models are intentionally separate from ingestion/research models.
 *
 * Backward-compat: if LIVE_ASSISTANT_* isn't set, fall back to the older GEMINI_MODEL_* vars.
 * We intentionally do NOT hardcode a model fallback, so misconfiguration is surfaced early.
 */
export function getLiveAssistantModel(tier: LiveAssistantModelTier): string {
  if (tier === "fast") {
    return (
      process.env.LIVE_ASSISTANT_GEMINI_MODEL_FAST?.trim() ||
      process.env.GEMINI_MODEL_FLASH_LITE?.trim() ||
      mustEnv("LIVE_ASSISTANT_GEMINI_MODEL_FAST")
    );
  }
  return (
    process.env.LIVE_ASSISTANT_GEMINI_MODEL_BIG?.trim() ||
    process.env.GEMINI_MODEL_FLASH?.trim() ||
    mustEnv("LIVE_ASSISTANT_GEMINI_MODEL_BIG")
  );
}

