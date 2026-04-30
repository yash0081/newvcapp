import { embedText, embedTexts } from "@/lib/vertex-embeddings";

const HQ_PREFIX = "Represent this investor diligence question for semantic retrieval:\n";
const LIGHT_PREFIX = "";

/**
 * Higher-quality / retrieval-oriented phrasing for tracked questions (instruction-style prefix).
 */
export async function embedMeetingQuestionText(text: string): Promise<number[]> {
  const t = String(text || "").trim().slice(0, 6000);
  if (!t) throw new Error("embedMeetingQuestionText: empty");
  return embedText(`${HQ_PREFIX}${t}`);
}

/**
 * Lightweight claim embedding: shorter slice, no instructional prefix (same Vertex model; split can be env-driven later).
 */
export async function embedMeetingClaimText(text: string): Promise<number[]> {
  const t = `${LIGHT_PREFIX}${String(text || "").trim()}`.slice(0, 3500);
  if (!t.trim()) throw new Error("embedMeetingClaimText: empty");
  return embedText(t);
}

export async function embedMeetingClaimTexts(texts: string[], batchSize = 16): Promise<number[][]> {
  const inputs = texts.map((x) => `${LIGHT_PREFIX}${String(x || "").trim()}`.slice(0, 3500)).filter((x) => x.trim());
  if (!inputs.length) return [];
  const out: number[][] = [];
  for (let i = 0; i < inputs.length; i += batchSize) {
    const batch = inputs.slice(i, i + batchSize);
    out.push(...(await embedTexts(batch, batchSize)));
  }
  return out;
}
