import type { SupabaseClient } from "@supabase/supabase-js";
import { embedText } from "@/lib/vertex-embeddings";

function vectorParam(values: number[]): string {
  return `[${values.join(",")}]`;
}

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

  function parseVec(v: unknown): number[] | null {
    if (Array.isArray(v)) {
      const arr = v.filter((x): x is number => typeof x === "number" && !Number.isNaN(x));
      return arr.length ? arr : null;
    }
    if (typeof v !== "string") return null;
    const t = v.trim();
    if (!t.startsWith("[") || !t.endsWith("]")) return null;
    const body = t.slice(1, -1).trim();
    if (!body) return null;
    const out = body
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => !Number.isNaN(n));
    return out.length ? out : null;
  }

  function cosine(a: number[], b: number[]): number {
    let dot = 0,
      an = 0,
      bn = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      an += a[i] * a[i];
      bn += b[i] * b[i];
    }
    if (an <= 0 || bn <= 0) return 0;
    return dot / (Math.sqrt(an) * Math.sqrt(bn));
  }

  for (const phrase of uniq) {
    let emb: number[];
    try {
      emb = await embedText(phrase);
    } catch {
      continue;
    }
    let merged = false;
    for (const row of existing) {
      const ev = parseVec(row.medoid_embedding);
      if (!ev || ev.length !== emb.length) continue;
      if (cosine(emb, ev) >= TAU_MERGE) {
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
