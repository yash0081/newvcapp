import { VertexAI } from "@google-cloud/vertexai";
import type { Tool } from "@google-cloud/vertexai";
import { Storage } from "@google-cloud/storage";

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT;
const LOCATION = process.env.GOOGLE_CLOUD_LOCATION || "global";
const GCS_BUCKET = process.env.VERTEX_GCS_BUCKET;

if (!PROJECT_ID) {
  throw new Error("GOOGLE_CLOUD_PROJECT is not set");
}

const vertex = new VertexAI({
  project: PROJECT_ID,
  location: LOCATION,
});

const storage = new Storage();

/**
 * When true, Vertex `generateContent` requests attach the Google Search grounding tool
 * so the model can retrieve web results. Used for text steps (thesis, founders, …)
 * and, when enabled, **Phase 1 PDF parse** — `PROMPT_PHASE_1_PARSER` instructs searching
 * founders (e.g. CEO/CTO) to fill team fields, not only slide text.
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
  return vertex.getGenerativeModel({ model: modelName });
}

export async function vertexRunWithText(
  modelName: string,
  fullPrompt: string,
  includeGoogleSearch?: boolean
): Promise<string> {
  const model = getVertexModel(modelName);
  const useGrounding = resolveUseGrounding(includeGoogleSearch);
  const result = await model.generateContent({
    contents: [
      {
        role: "user",
        parts: [{ text: fullPrompt }],
      },
    ],
    ...(useGrounding ? { tools: groundingTools() } : {}),
  });

  const candidates = result.response.candidates ?? [];
  const parts = candidates[0]?.content?.parts ?? [];
  const text = parts
    .map((p) => (p as { text?: string }).text ?? "")
    .join("")
    .trim();
  if (!text) {
    throw new Error("Empty Vertex AI response");
  }
  return text;
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
  if (!GCS_BUCKET) {
    throw new Error("VERTEX_GCS_BUCKET is not set");
  }
  const bucket = storage.bucket(GCS_BUCKET);
  const fileName = `pitch-decks/${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.pdf`;
  const file = bucket.file(fileName);

  await file.save(pdfBuffer, {
    contentType: "application/pdf",
  });

  const fileUri = `gs://${GCS_BUCKET}/${fileName}`;

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
    const parts = candidates[0]?.content?.parts ?? [];
    const text = parts
      .map((p) => (p as { text?: string }).text ?? "")
      .join("")
      .trim();
    if (!text) {
      throw new Error("Empty Vertex AI PDF response");
    }
    return text;
  } finally {
    // Best-effort cleanup; ignore errors
    file.delete().catch(() => {});
  }
}

