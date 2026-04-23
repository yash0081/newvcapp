import type { SupabaseClient } from "@supabase/supabase-js";
import { cosineSimilarity, parseVector } from "@/lib/data-layer/shared/vector";

/**
 * Offline reconcile: transitive merge of near-duplicate medoids (single-link via union–find),
 * keeping the oldest cluster row. Caps row count for O(n²) pairwise similarity.
 */
const MERGE_THRESHOLD = 0.97;
const MAX_MEDOIDS_FOR_PAIRWISE = 900;

class UnionFind {
  private parent = new Map<string, string>();

  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    const p = this.parent.get(x)!;
    if (p !== x) {
      this.parent.set(x, this.find(p));
    }
    return this.parent.get(x)!;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export async function reconcileKeywordClustersMedoids(admin: SupabaseClient): Promise<{ merged: number }> {
  const { data: rows, error } = await admin
    .from("keyword_clusters")
    .select("id, medoid_embedding")
    .order("created_at", { ascending: true })
    .limit(MAX_MEDOIDS_FOR_PAIRWISE);
  if (error || !rows?.length) {
    console.warn("reconcileKeywordClustersMedoids:", error);
    return { merged: 0 };
  }

  const parsed = rows
    .map((r) => ({
      id: r.id as string,
      v: parseVector(r.medoid_embedding),
    }))
    .filter((r): r is { id: string; v: number[] } => r.v != null && r.v.length > 0);

  const uf = new UnionFind();
  const n = parsed.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (cosineSimilarity(parsed[i].v, parsed[j].v) >= MERGE_THRESHOLD) {
        uf.union(parsed[i].id, parsed[j].id);
      }
    }
  }

  const idToIndex = new Map(parsed.map((p, idx) => [p.id, idx]));
  const rootKeep = new Map<string, string>();
  for (const p of parsed) {
    const r = uf.find(p.id);
    const cur = rootKeep.get(r);
    if (!cur || idToIndex.get(p.id)! < idToIndex.get(cur)!) {
      rootKeep.set(r, p.id);
    }
  }

  const remove = new Set<string>();
  for (const p of parsed) {
    const r = uf.find(p.id);
    const keep = rootKeep.get(r)!;
    if (p.id !== keep) remove.add(p.id);
  }

  let merged = 0;
  for (const id of remove) {
    const { error: delErr } = await admin.from("keyword_clusters").delete().eq("id", id);
    if (!delErr) merged++;
  }
  return { merged };
}
