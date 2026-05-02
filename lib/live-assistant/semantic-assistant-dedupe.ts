import { embedTexts } from "@/lib/vertex-embeddings";
import { cosineSimilarity } from "@/lib/data-layer/shared/vector";

/** Vertex embed batch for assistant cards / claims (aligned with notes tick). */
const EMBED_BATCH = 40;

export function assistantSemanticDedupeEmbedEnabled(): boolean {
  if (!process.env.GOOGLE_CLOUD_PROJECT?.trim()) return false;
  const v = process.env.LIVE_ASSISTANT_ASSISTANT_SEM_DEDUPE_EMBED?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return true;
}

export function contradictionSweepSemanticEnabled(): boolean {
  if (!assistantSemanticDedupeEmbedEnabled()) return false;
  const v = process.env.LIVE_ASSISTANT_CONTRADICTION_SWEEP_EMBED?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function contradictionEmbedSimThreshold(): number {
  const raw = Number(process.env.LIVE_ASSISTANT_CONTRADICTION_EMBED_SIM ?? 0.87);
  return Number.isFinite(raw) ? Math.min(0.99, Math.max(0.75, raw)) : 0.87;
}

export function claimSemanticDedupeSimThreshold(): number {
  const raw = Number(process.env.LIVE_ASSISTANT_CLAIM_SEM_DEDUPE_SIM ?? 0.9);
  return Number.isFinite(raw) ? Math.min(0.995, Math.max(0.82, raw)) : 0.9;
}

/** `claim_verification` cards: slightly stricter than contradictions to avoid suppressing legit updates. */
export function claimVerificationEmbedSimThreshold(): number {
  const raw = Number(process.env.LIVE_ASSISTANT_CLAIM_VERIFICATION_EMBED_SIM ?? 0.88);
  return Number.isFinite(raw) ? Math.min(0.99, Math.max(0.78, raw)) : 0.88;
}

export function claimSemanticDedupeEnabled(): boolean {
  if (!process.env.GOOGLE_CLOUD_PROJECT?.trim()) return false;
  const v = process.env.LIVE_ASSISTANT_CLAIM_SEM_DEDUPE?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return true;
}

/**
 * Single Vertex predict call: embed `[query, ...corpus]` and return max cosine(query, corpus[i]).
 * Mirrors notes batching (`embedTexts` once, then local similarity).
 */
export async function embeddingMaxSimilarityToCorpus(
  query: string,
  corpus: string[],
): Promise<{ maxSim: number; bestIndex: number }> {
  const q = query.trim().slice(0, 3500);
  const c = corpus.map((t) => String(t || "").trim().slice(0, 3500)).filter(Boolean);
  if (!q || !c.length) return { maxSim: 0, bestIndex: -1 };
  try {
    const vecs = await embedTexts([q, ...c], EMBED_BATCH);
    if (!vecs.length || vecs.length !== c.length + 1) return { maxSim: 0, bestIndex: -1 };
    const qv = vecs[0]!;
    let max = 0;
    let best = -1;
    for (let i = 0; i < c.length; i++) {
      const sim = cosineSimilarity(qv, vecs[i + 1]!);
      if (sim > max) {
        max = sim;
        best = i;
      }
    }
    return { maxSim: max, bestIndex: best };
  } catch {
    return { maxSim: 0, bestIndex: -1 };
  }
}

/**
 * All bodies ordered **newest first**. Returns indices to drop when an older row is semantically
 * dup of a newer kept row (same convention as notes merge).
 */
export async function embeddingDedupeIndicesNewestFirst(
  bodiesNewestFirst: string[],
  threshold: number,
): Promise<Set<number>> {
  const drop = new Set<number>();
  const n = bodiesNewestFirst.length;
  if (n < 2) return drop;
  const inputs = bodiesNewestFirst.map((b) => String(b || "").trim().slice(0, 3500));
  try {
    const vecs = await embedTexts(inputs, EMBED_BATCH);
    if (vecs.length !== n) return drop;
    const kept: number[] = [];
    for (let i = 0; i < n; i++) {
      const vi = vecs[i]!;
      let dup = false;
      for (const j of kept) {
        if (cosineSimilarity(vi, vecs[j]!) >= threshold) {
          dup = true;
          break;
        }
      }
      if (dup) drop.add(i);
      else kept.push(i);
    }
    return drop;
  } catch {
    return drop;
  }
}
