import type { SupabaseClient } from "@supabase/supabase-js";
import { embedText } from "@/lib/vertex-embeddings";
import { cosineSimilarity, parseVector, vectorParam } from "@/lib/data-layer/shared/vector";

const TAU_MERGE = 0.88;

/**
 * Online vocabulary growth (plan A3 DSU-style): merge near-duplicate phrases into existing medoids.
 * Offline global reconcile: `lib/keyword-offline-reconcile.ts` + `scripts/reconcile-keyword-clusters.ts`.
 *
 * Register keyword phrases into the global vocabulary table (one row per distinct phrase as its own medoid cluster).
 * Online merge: if cosine to an existing medoid ≥ TAU_MERGE, skip insert (phrase treated as duplicate of that cluster for future use).
 */
export async function registerKeywordPhrases(
  admin: SupabaseClient | null,
  phrases: string[]
): Promise<void> {
  if (!admin) return;
  const uniq = Array.from(
    new Set(phrases.map((p) => p.trim().toLowerCase()).filter((p) => p.length > 2))
  );
  if (uniq.length === 0) return;

  const { data: rows, error: fetchErr } = await admin
    .from("keyword_clusters")
    .select("id, medoid_phrase, medoid_embedding")
    .limit(5000);
  if (fetchErr) {
    console.warn("keyword_clusters fetch:", fetchErr);
    return;
  }

  const existing = (rows ?? []) as Array<{
    id: string;
    medoid_phrase: string;
    medoid_embedding: string | number[];
  }>;

  for (const phrase of uniq) {
    let emb: number[];
    try {
      emb = await embedText(phrase);
    } catch {
      continue;
    }
    let merged = false;
    for (const row of existing) {
      const ev = parseVector(row.medoid_embedding);
      if (!ev || ev.length !== emb.length) continue;
      if (cosineSimilarity(emb, ev) >= TAU_MERGE) {
        merged = true;
        break;
      }
    }
    if (merged) continue;

    const { error: insErr } = await admin.from("keyword_clusters").insert({
      medoid_phrase: phrase,
      medoid_embedding: vectorParam(emb),
      vocab_version: 1,
    });
    if (insErr && !String(insErr.message).includes("duplicate")) {
      console.warn("keyword_clusters insert:", insErr);
    } else if (!insErr) {
      existing.push({
        id: "",
        medoid_phrase: phrase,
        medoid_embedding: vectorParam(emb),
      });
    }
  }
}
