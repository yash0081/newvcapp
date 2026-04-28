import { VertexAI } from "@google-cloud/vertexai";
import type { Tool } from "@google-cloud/vertexai";
import { Storage } from "@google-cloud/storage";

type VertexEnv = {
  projectId: string;
  location: string;
  apiEndpoint: string;
  gcsBucket: string | null;
};

function vertexEnv(): VertexEnv {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) throw new Error("GOOGLE_CLOUD_PROJECT is not set");
  const location = process.env.VERTEX_GENERATIVE_LOCATION || process.env.GOOGLE_CLOUD_LOCATION || "global";
  return {
    projectId,
    // Generative Gemini calls: default to global endpoint for best availability.
    // Keep embeddings separate via `VERTEX_EMBEDDING_LOCATION` in `lib/vertex-embeddings.ts`.
    location,
    // IMPORTANT: Vertex "global" uses `aiplatform.googleapis.com` (NOT `global-aiplatform.googleapis.com`).
    apiEndpoint: location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`,
    gcsBucket: process.env.VERTEX_GCS_BUCKET ?? null,
  };
}

const vertexClients = new Map<string, VertexAI>();
let storage: Storage | null = null;

function getVertexClient(): VertexAI {
  const env = vertexEnv();
  const key = `${env.projectId}:${env.location}`;
  const cached = vertexClients.get(key);
  if (cached) return cached;
  const client = new VertexAI({
    project: env.projectId,
    location: env.location,
    apiEndpoint: env.apiEndpoint,
  });
  vertexClients.set(key, client);
  return client;
}

function getStorageClient(): Storage {
  if (!storage) storage = new Storage();
  return storage;
}

/**
 * When true, Vertex `generateContent` requests attach the Google Search grounding tool
 * so the model can retrieve web results. Used for text steps (thesis, traction, resolve
 * founding team, Founder A/B, …). **Phase 1 PDF parse** runs with search **off** (deck-only).
 *
 * @see https://cloud.google.com/vertex-ai/generative-ai/docs/grounding/grounding-with-google-search
 */
export function isVertexGoogleSearchGroundingEnabled(): boolean {
  const v = process.env.VERTEX_ENABLE_GOOGLE_SEARCH;
  return v === "true" || v === "1";
}

/** Vertex REST / newer Gemini use `googleSearch`; SDK Tool union may lag — cast is intentional. */
function groundingTools(): Tool[] {
  return [{ googleSearch: {} } as Tool];
}

function resolveUseGrounding(includeGoogleSearch?: boolean): boolean {
  if (includeGoogleSearch !== undefined) return includeGoogleSearch;
  return isVertexGoogleSearchGroundingEnabled();
}

export function getVertexModel(modelName: string) {
  return getVertexClient().getGenerativeModel({ model: modelName });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableVertexStreamError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /429|RESOURCE_EXHAUSTED|resource exhausted|unavailable|UNAVAILABLE|DEADLINE_EXCEEDED|503|502/i.test(
    msg
  );
}

/**
 * Stream plain text from a single user message (chat answers). No grounding by default.
 * Retries the **whole** stream on rate limits / transient errors (exponential backoff + jitter).
 */
export async function* vertexStreamText(
  modelName: string,
  fullPrompt: string,
  includeGoogleSearch?: boolean
): AsyncGenerator<string, void, unknown> {
  const useGrounding = resolveUseGrounding(includeGoogleSearch);
  const req = {
    contents: [
      {
        role: "user" as const,
        parts: [{ text: fullPrompt }],
      },
    ],
    ...(useGrounding ? { tools: groundingTools() } : {}),
  };

  const maxAttempts = 5;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const model = getVertexModel(modelName);
      const streamResult = await model.generateContentStream(req);
      for await (const chunk of streamResult.stream) {
        const cands = chunk.candidates ?? [];
        for (const c of cands) {
          const parts = c?.content?.parts ?? [];
          for (const p of parts) {
            const t = (p as { text?: unknown }).text;
            if (typeof t === "string" && t.length) yield t;
          }
        }
      }
      return;
    } catch (e) {
      lastErr = e;
      if (attempt >= maxAttempts || !isRetryableVertexStreamError(e)) {
        throw e;
      }
      const base = Math.min(32_000, 1000 * 2 ** attempt);
      await sleep(base + Math.random() * 500);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function vertexRunWithText(
  modelName: string,
  fullPrompt: string,
  includeGoogleSearch?: boolean
): Promise<string> {
  const model = getVertexModel(modelName);
  const useGrounding = resolveUseGrounding(includeGoogleSearch);
  const buildRequest = (withGrounding: boolean) => ({
    contents: [
      {
        role: "user" as const,
        parts: [{ text: fullPrompt }],
      },
    ],
    ...(withGrounding ? { tools: groundingTools() } : {}),
  });

  const pickText = (result: unknown): string => {
    const candidates = ((result as { response?: { candidates?: unknown[] } })?.response?.candidates ?? []) as Array<{
      content?: { parts?: unknown[] };
    }>;

    // Vertex sometimes returns strict JSON in a non-first candidate (especially with tools/grounding).
    // We must pick a single best text span; concatenating multiple spans can corrupt JSON.
    const candidateTexts: string[] = [];
    for (const c of candidates) {
      const parts = c?.content?.parts ?? [];
      for (const p of parts) {
        const t = (p as { text?: unknown }).text;
        if (typeof t === "string") {
          const tt = t.trim();
          if (tt) candidateTexts.push(tt);
        }
      }
    }

    const directText =
      typeof (result as { response?: { text?: unknown } }).response?.text === "string"
        ? ((result as { response: { text: string } }).response.text as string).trim()
        : "";

    const scoreJsonish = (t: string): number => {
      const s = t.trim();
      let score = 0;
      if (s.startsWith("```")) score += 100;
      if (s.startsWith("{") || s.startsWith("[")) score += 60;
      if (s.includes("\"overall_thesis_alignment_reasoning\"")) score += 20;
      if (s.includes("\"critical_assumptions\"")) score += 20;
      score += Math.min(30, (s.match(/{/g) ?? []).length * 2 + (s.match(/}/g) ?? []).length * 2);
      score += Math.min(30, (s.match(/\[/g) ?? []).length + (s.match(/\]/g) ?? []).length);
      score += Math.min(20, s.length / 200);
      return score;
    };

    const bestCandidate =
      candidateTexts.length > 0
        ? candidateTexts.slice().sort((a, b) => scoreJsonish(b) - scoreJsonish(a))[0]
        : "";

    return (bestCandidate || directText).trim();
  };

  // Primary attempt (grounded or ungrounded based on caller).
  const first = await model.generateContent(buildRequest(useGrounding));
  const firstText = pickText(first);
  if (firstText) return firstText;

  // Retry same request once: Vertex occasionally returns empty candidate text payloads.
  const second = await model.generateContent(buildRequest(useGrounding));
  const secondText = pickText(second);
  if (secondText) return secondText;

  // If grounded mode produced no text, run one ungrounded fallback call.
  if (useGrounding) {
    const third = await model.generateContent(buildRequest(false));
    const thirdText = pickText(third);
    if (thirdText) return thirdText;
  }

  throw new Error("Empty Vertex AI response (no usable JSON-ish text found)");
}

export async function vertexRunWithTextMulti(
  modelName: string,
  prompt: string,
  inputs: { label: string; value: unknown }[],
  includeGoogleSearch?: boolean
): Promise<string> {
  const partsText = inputs
    .map(({ label, value }) => {
      const str =
        typeof value === "string" ? value : JSON.stringify(value, null, 2);
      return `${label}:\n${str}`;
    })
    .join("\n\n");
  const fullPrompt = `${partsText}\n\n---\n\n${prompt}\n\nReturn strict JSON only, no other text.`;
  return vertexRunWithText(modelName, fullPrompt, includeGoogleSearch);
}

export async function vertexRunWithPdf(
  modelName: string,
  pdfBuffer: Buffer,
  prompt: string,
  includeGoogleSearch?: boolean
): Promise<string> {
  const { gcsBucket } = vertexEnv();
  if (!gcsBucket) {
    throw new Error("VERTEX_GCS_BUCKET is not set");
  }
  const bucket = getStorageClient().bucket(gcsBucket);
  const fileName = `pitch-decks/${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.pdf`;
  const file = bucket.file(fileName);

  await file.save(pdfBuffer, {
    contentType: "application/pdf",
  });

  const fileUri = `gs://${gcsBucket}/${fileName}`;

  try {
    const model = getVertexModel(modelName);
    const useGrounding = resolveUseGrounding(includeGoogleSearch);
    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            {
              fileData: {
                fileUri,
                mimeType: "application/pdf",
              },
            },
            {
              text: `${prompt}\n\nReturn strict JSON only, no other text.`,
            },
          ],
        },
      ],
      ...(useGrounding ? { tools: groundingTools() } : {}),
    });

    const candidates = result.response.candidates ?? [];
    const candidateTexts: string[] = [];
    for (const c of candidates) {
      const parts = c?.content?.parts ?? [];
      for (const p of parts) {
        const t = (p as { text?: unknown }).text;
        if (typeof t === "string") {
          const tt = t.trim();
          if (tt) candidateTexts.push(tt);
        }
      }
    }

    const directText =
      typeof (result as { response?: { text?: unknown } }).response?.text === "string"
        ? ((result as { response: { text: string } }).response.text as string).trim()
        : "";

    const bestCandidate =
      candidateTexts.length > 0
        ? candidateTexts.slice().sort((a, b) => b.length - a.length)[0]
        : "";

    const text = (bestCandidate || directText).trim();
    if (!text) throw new Error("Empty Vertex AI PDF response (no usable text found)");
    return text;
  } finally {
    // Best-effort cleanup; ignore errors
    file.delete().catch(() => {});
  }
}

/**
 * Run a Gemini multimodal request with one inline image (base64) plus a prompt.
 * Used by the research copilot to extract text/claims from a screen capture without
 * round-tripping through GCS like `vertexRunWithPdf`.
 */
export async function vertexRunWithImage(
  modelName: string,
  imageBase64: string,
  imageMimeType: string,
  prompt: string
): Promise<string> {
  const model = getVertexModel(modelName);
  const buildRequest = () => ({
    contents: [
      {
        role: "user" as const,
        parts: [
          { inlineData: { data: imageBase64, mimeType: imageMimeType } },
          { text: `${prompt}\n\nReturn strict JSON only, no other text.` },
        ],
      },
    ],
  });

  const pickText = (result: unknown): string => {
    const candidates = ((result as { response?: { candidates?: unknown[] } })?.response?.candidates ?? []) as Array<{
      content?: { parts?: unknown[] };
    }>;
    const candidateTexts: string[] = [];
    for (const c of candidates) {
      const parts = c?.content?.parts ?? [];
      for (const p of parts) {
        const t = (p as { text?: unknown }).text;
        if (typeof t === "string") {
          const tt = t.trim();
          if (tt) candidateTexts.push(tt);
        }
      }
    }
    const directText =
      typeof (result as { response?: { text?: unknown } }).response?.text === "string"
        ? ((result as { response: { text: string } }).response.text as string).trim()
        : "";
    const bestCandidate =
      candidateTexts.length > 0
        ? candidateTexts.slice().sort((a, b) => b.length - a.length)[0]
        : "";
    return (bestCandidate || directText).trim();
  };

  const first = await model.generateContent(buildRequest());
  const text = pickText(first);
  if (text) return text;

  const second = await model.generateContent(buildRequest());
  const text2 = pickText(second);
  if (text2) return text2;

  throw new Error("Empty Vertex AI image response (no usable text found)");
}

