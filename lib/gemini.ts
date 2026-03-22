import { vertexRunWithPdf, vertexRunWithText, vertexRunWithTextMulti } from "@/lib/vertex";

// Vertex model IDs come from env — see docs/PIPELINE_MODELS.md (names in Prompts V2-2.md are descriptive only).
const FLASH_LITE = process.env.GEMINI_MODEL_FLASH_LITE!;
const FLASH_MODEL = process.env.GEMINI_MODEL_FLASH!;

if (!FLASH_LITE) {
  throw new Error("GEMINI_MODEL_FLASH_LITE must be set to a Vertex Gemini model id");
}
if (!FLASH_MODEL) {
  throw new Error("GEMINI_MODEL_FLASH must be set to a Vertex Gemini model id");
}

if (!process.env.GEMINI_MODEL_FLASH_SUMMARY) {
  throw new Error("GEMINI_MODEL_FLASH_SUMMARY is not set (e.g. same lite tier as FLASH_LITE for summaries).");
}
export const GEMINI_MODEL_FLASH_SUMMARY = process.env.GEMINI_MODEL_FLASH_SUMMARY;

export type ModelTier = "flash_lite" | "flash";

function getModelNameByTier(tier: ModelTier): string {
  return tier === "flash_lite" ? FLASH_LITE : FLASH_MODEL;
}

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 2000;

function isRetryableGeminiError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /503|429|rate limit|high demand|try again later/i.test(msg);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES && isRetryableGeminiError(err)) {
       const delayMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        await sleep(delayMs);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Extract JSON from model response (handles optional markdown code blocks).
 */
function normalizeModelJson(raw: string): string {
  // Remove BOM and non-printable control chars that often break JSON parsing.
  let s = raw.replace(/^\uFEFF/, "");

  // Replace illegal control chars with a space, keep tab/newline/carriage return.
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ");

  // Repair unescaped newlines inside quoted strings.
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === "\"") {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString && ch === "\n") {
      out += "\\n";
      continue;
    }
    if (inString && ch === "\r") {
      out += "\\r";
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Parse model output into a plain object/array (same as `const data = JSON.parse(jsonString)`).
 * Use `data.field` or `data["field"]` after this returns. We normalize first because models
 * sometimes emit illegal control characters or unescaped newlines inside JSON strings.
 */
export function parseJsonFromResponse(text: string): unknown {
  const trimmed = text.trim();
  const codeBlock = /^```(?:json)?\s*([\s\S]*?)```$/;
  const match = trimmed.match(codeBlock);
  const jsonStr = match ? match[1].trim() : trimmed;
  const normalized = normalizeModelJson(jsonStr);
  try {
    return JSON.parse(normalized) as unknown;
  } catch {
    // Fallback: try parsing from first object/array boundary in case model prepends noise.
    const firstObj = normalized.indexOf("{");
    const firstArr = normalized.indexOf("[");
    const start =
      firstObj === -1
        ? firstArr
        : firstArr === -1
        ? firstObj
        : Math.min(firstObj, firstArr);
    if (start >= 0) {
      const sliced = normalized.slice(start).trim();
      return JSON.parse(sliced) as unknown;
    }
    throw new Error("Unable to parse model JSON response");
  }
}

/**
 * Run Gemini via Vertex with PDF (GCS-backed). Returns parsed JSON.
 */
export async function runWithPdf(
  prompt: string,
  pdfBuffer: Buffer,
  modelTier: ModelTier = "flash_lite"
): Promise<unknown> {
  return withRetry(async () => {
    const modelName = getModelNameByTier(modelTier);
    const text = await vertexRunWithPdf(modelName, pdfBuffer, prompt);
    if (!text) throw new Error("Empty Gemini response");
    return parseJsonFromResponse(text);
  });
}

/**
 * Run Gemini with prompt only (no JSON payload) via Vertex. Returns parsed JSON.
 * Used for Founder A/B where inputs are injected into the prompt.
 */
export async function runWithPromptOnly(
  prompt: string,
  modelTier: ModelTier = "flash_lite"
): Promise<unknown> {
  return withRetry(async () => {
    const modelName = getModelNameByTier(modelTier);
    const fullPrompt = `${prompt}\n\nReturn strict JSON only, no other text.`;
    const text = await vertexRunWithText(modelName, fullPrompt);
    if (!text) throw new Error("Empty Gemini response");
    return parseJsonFromResponse(text);
  });
}

/**
 * Run Gemini with text/JSON input only. Returns parsed JSON.
 */
export async function runWithText(
  prompt: string,
  inputJson: unknown,
  modelTier: ModelTier = "flash_lite"
): Promise<unknown> {
  return withRetry(async () => {
    const inputStr = typeof inputJson === "string" ? inputJson : JSON.stringify(inputJson, null, 2);
    const fullPrompt = `Input JSON from previous step:\n${inputStr}\n\n${prompt}\n\nReturn strict JSON only, no other text.`;
    const modelName = getModelNameByTier(modelTier);
    const text = await vertexRunWithText(modelName, fullPrompt);
    if (!text) throw new Error("Empty Gemini response");
    return parseJsonFromResponse(text);
  });
}

/** Run with multiple text inputs (e.g. thesis + JSON). */
export async function runWithTextMulti(
  prompt: string,
  inputs: { label: string; value: unknown }[],
  modelTier: ModelTier = "flash_lite"
): Promise<unknown> {
  return withRetry(async () => {
    const modelName = getModelNameByTier(modelTier);
    const text = await vertexRunWithTextMulti(modelName, prompt, inputs);
    if (!text) throw new Error("Empty Gemini response");
    return parseJsonFromResponse(text);
  });
}

/** Run with multiple text inputs on an explicit model name. */
export async function runWithTextMultiOnModel(
  modelName: string,
  prompt: string,
  inputs: { label: string; value: unknown }[]
): Promise<unknown> {
  return withRetry(async () => {
    // Aggregation summaries synthesize already-retrieved JSON — no web search.
    const text = await vertexRunWithTextMulti(modelName, prompt, inputs, false);
    if (!text) throw new Error("Empty model response");
    return parseJsonFromResponse(text);
  });
}
