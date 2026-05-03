import { vertexRunWithPdf, vertexRunWithText, vertexRunWithTextMulti } from "@/lib/vertex";

// Resolve model IDs lazily at call time (important for scripts loading dotenv in entrypoint).
function geminiEnv() {
  const flashLite = process.env.GEMINI_MODEL_FLASH_LITE;
  const flash = process.env.GEMINI_MODEL_FLASH;
  const summary = process.env.GEMINI_MODEL_FLASH_SUMMARY;
  if (!flashLite) {
    throw new Error("GEMINI_MODEL_FLASH_LITE must be set to a Vertex Gemini model id");
  }
  if (!flash) {
    throw new Error("GEMINI_MODEL_FLASH must be set to a Vertex Gemini model id");
  }
  if (!summary) {
    throw new Error(
      "GEMINI_MODEL_FLASH_SUMMARY is not set (e.g. same lite tier as FLASH_LITE for summaries)."
    );
  }
  return { flashLite, flash, summary };
}
export function getGeminiSummaryModel(): string {
  return geminiEnv().summary;
}

export type ModelTier = "flash_lite" | "flash";

function getModelNameByTier(tier: ModelTier): string {
  const env = geminiEnv();
  return tier === "flash_lite" ? env.flashLite : env.flash;
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
 * When the model returns valid JSON followed by extra text (or two JSON blobs), take only the
 * first balanced `{...}` or `[...]` so JSON.parse succeeds. Respects strings and escapes.
 */
function extractFirstBalancedJson(normalized: string): string | null {
  const firstObj = normalized.indexOf("{");
  const firstArr = normalized.indexOf("[");
  let start = -1;
  if (firstObj === -1) start = firstArr;
  else if (firstArr === -1) start = firstObj;
  else start = Math.min(firstObj, firstArr);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < normalized.length; i++) {
    const ch = normalized[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        return normalized.slice(start, i + 1);
      }
    }
  }
  return null;
}

function repairCommonJsonIssues(s: string): string {
  return s
    .replace(/\bNaN\b/g, "null")
    .replace(/\bInfinity\b/g, "null")
    .replace(/\b-Infinity\b/g, "null")
    .replace(/,\s*([}\]])/g, "$1");
}

function tryParseJson(s: string): unknown | null {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
}

/** Every ``` / ```json fenced block in the response (models often wrap JSON or add prose around it). */
function extractMarkdownCodeFenceBodies(text: string): string[] {
  const out: string[] = [];
  const re = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = m[1]?.trim();
    if (body) out.push(body);
  }
  return out;
}

/**
 * Best-effort parse without throwing (used before optional LLM repair).
 */
export function parseJsonFromResponseOrNull(text: string): unknown | null {
  const trimmed = text.trim();
  const tryParse = (raw: string): unknown | null => {
    const normalized = normalizeModelJson(raw);
    let p = tryParseJson(normalized);
    if (p !== null) return p;
    const balanced = extractFirstBalancedJson(normalized);
    if (balanced) {
      p = tryParseJson(balanced);
      if (p !== null) return p;
      p = tryParseJson(repairCommonJsonIssues(balanced));
      if (p !== null) return p;
    }
    p = tryParseJson(repairCommonJsonIssues(normalized));
    return p;
  };

  // Whole string is one fence
  const singleFence = /^```(?:json)?\s*([\s\S]*?)```$/;
  const single = trimmed.match(singleFence);
  if (single) {
    const p = tryParse(single[1].trim());
    if (p !== null) return p;
  }

  // Any fence in the blob (e.g. "Here is JSON:\n```json\n{...}\n```")
  for (const body of extractMarkdownCodeFenceBodies(trimmed)) {
    const p = tryParse(body);
    if (p !== null) return p;
  }

  return tryParse(trimmed);
}

/**
 * Parse model output into a plain object/array (same as `const data = JSON.parse(jsonString)`).
 * Use `data.field` or `data["field"]` after this returns. We normalize first because models
 * sometimes emit illegal control characters or unescaped newlines inside JSON strings.
 */
export function parseJsonFromResponse(text: string): unknown {
  const p = parseJsonFromResponseOrNull(text);
  if (p !== null) return p;
  throw new Error("Unable to parse model JSON response");
}

/**
 * When Flash + search returns prose-wrapped or broken JSON, ask Flash-Lite to emit strict JSON once.
 */
export async function parseJsonFromResponseWithRepair(text: string): Promise<unknown> {
  const first = parseJsonFromResponseOrNull(text);
  if (first !== null) return first;

  const snippet = text.trim().slice(0, 28_000);
  const model = geminiEnv().flashLite;
  const repairPrompt = `The text below is model output that should contain one JSON object or array for a downstream parser. It may include formatting fences, commentary, or minor JSON syntax errors.

Extract exactly one JSON value (object or array). Output ONLY valid JSON, with no formatting fences, no backticks, and no explanation.

---BEGIN---
${snippet}
---END---`;

  const out = await vertexRunWithText(model, repairPrompt, false);
  if (!out?.trim()) {
    throw new Error("Unable to parse model JSON response (empty repair output)");
  }
  const second = parseJsonFromResponseOrNull(out);
  if (second !== null) return second;
  throw new Error("Unable to parse model JSON response (repair pass failed)");
}

/**
 * Run Gemini via Vertex with PDF (GCS-backed). Returns parsed JSON.
 */
export async function runWithPdf(
  prompt: string,
  pdfBuffer: Buffer,
  modelTier: ModelTier = "flash_lite",
  includeGoogleSearch?: boolean
): Promise<unknown> {
  return withRetry(async () => {
    const modelName = getModelNameByTier(modelTier);
    const text = await vertexRunWithPdf(modelName, pdfBuffer, prompt, includeGoogleSearch);
    if (!text) throw new Error("Empty Gemini response");
    return parseJsonFromResponseWithRepair(text);
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
    return parseJsonFromResponseWithRepair(text);
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
    return parseJsonFromResponseWithRepair(text);
  });
}

/**
 * Run with multiple text inputs (e.g. thesis + JSON).
 * @param includeGoogleSearch When `true`, Vertex attaches Google Search grounding (ignores env default). When omitted, uses `VERTEX_ENABLE_GOOGLE_SEARCH` for text steps.
 */
export async function runWithTextMulti(
  prompt: string,
  inputs: { label: string; value: unknown }[],
  modelTier: ModelTier = "flash_lite",
  includeGoogleSearch?: boolean
): Promise<unknown> {
  return withRetry(async () => {
    const modelName = getModelNameByTier(modelTier);
    const text = await vertexRunWithTextMulti(modelName, prompt, inputs, includeGoogleSearch);
    if (!text) throw new Error("Empty Gemini response");
    return parseJsonFromResponseWithRepair(text);
  });
}

/**
 * Same as `runWithTextMulti`, but returns raw model text (no JSON parsing).
 * Use this for steps where we want a repair/fallback parse pipeline.
 */
export async function runWithTextMultiRaw(
  prompt: string,
  inputs: { label: string; value: unknown }[],
  modelTier: ModelTier = "flash_lite",
  includeGoogleSearch?: boolean
): Promise<string> {
  return withRetry(async () => {
    const modelName = getModelNameByTier(modelTier);
    const text = await vertexRunWithTextMulti(modelName, prompt, inputs, includeGoogleSearch);
    if (!text) throw new Error("Empty Gemini response");
    return text;
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
    return parseJsonFromResponseWithRepair(text);
  });
}
