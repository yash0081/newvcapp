import type { SupabaseClient } from "@supabase/supabase-js";
import { extractKeywords } from "@/lib/data-layer/shared/text";
import { cosineSimilarity, parseVector, vectorParam, weightedCentroid } from "@/lib/data-layer/shared/vector";
import { embedTexts } from "@/lib/vertex-embeddings";
import { toError } from "@/lib/supabase/error-format";
import { chunkArray, mapWithConcurrency } from "@/lib/async/concurrency";

const EMBEDDING_MODEL = process.env.VERTEX_EMBEDDING_MODEL || "text-embedding-004";
const ONLINE_MERGE_THRESHOLD = Number(process.env.DEAL_INTEL_KEYWORD_MERGE_THRESHOLD ?? "0.88");
const OFFLINE_RECONCILE_THRESHOLD = Number(process.env.DEAL_INTEL_KEYWORD_OFFLINE_THRESHOLD ?? "0.96");

function tokenCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function uniq(xs: string[]): string[] {
  return Array.from(new Set(xs));
}

class UnionFind {
  private parent = new Map<string, string>();

  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    const p = this.parent.get(x)!;
    if (p !== x) this.parent.set(x, this.find(p));
    return this.parent.get(x)!;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export async function backfillDealIntelKeywordGraph(
  admin: SupabaseClient,
  dealId: string
): Promise<void> {
  const [{ data: factRows, error: factErr }, { data: treeRows, error: treeErr }] = await Promise.all([
    admin.rpc("deal_intel_get_fact_nodes", { p_deal_id: dealId }),
    admin.rpc("deal_intel_get_tree_nodes", { p_deal_id: dealId }),
  ]);

  if (factErr) throw toError(factErr, "Failed to load fact rows for keyword graph");
  if (treeErr) throw toError(treeErr, "Failed to load tree rows for keyword graph");

  const fact = (factRows ?? []) as Array<{
    id: string;
    path: string;
    value_text: string | null;
    value_jsonb: unknown;
    keywords: string[] | null;
  }>;
  const tree = (treeRows ?? []) as Array<{
    id: string;
    node_path: string | null;
    narrative_text: string | null;
    node_value_text: string | null;
    keywords: string[] | null;
  }>;

  const allTerms = new Set<string>();

  for (const r of fact) {
    const base =
      r.value_text?.trim() ||
      (r.value_jsonb != null ? JSON.stringify(r.value_jsonb) : "") ||
      r.path;
    const kws = uniq(extractKeywords(base, 20));
    if (kws.length) {
      const { error } = await admin.rpc("deal_intel_update_fact_node_enrichment", {
        p_node_id: r.id,
        p_embedding_input: `${r.path}: ${(r.value_text ?? "").slice(0, 4000)}`,
        p_embedding_model: EMBEDDING_MODEL,
        p_content_embedding: null,
        p_keywords: kws,
      });
      if (error) throw toError(error, "Failed to update fact keywords");
      for (const k of kws) allTerms.add(k);
    }
  }

  for (const r of tree) {
    const base = r.narrative_text?.trim() || r.node_value_text?.trim() || r.node_path || "";
    const kws = uniq(extractKeywords(base, 20));
    if (kws.length) {
      const { error } = await admin.rpc("deal_intel_update_tree_node_patch", {
        p_id: r.id,
        p_patch: { keywords: kws },
      });
      if (error) throw toError(error, "Failed to update tree keywords");
      for (const k of kws) allTerms.add(k);
    }
  }

  const terms = Array.from(allTerms);
  if (terms.length === 0) return;

  const termToVec = new Map<string, number[]>();
  // Batched embeddings
  const vecs: number[][] = [];
  for (const batch of chunkArray(terms, 32)) {
    const bvec = await embedTexts(batch, 32);
    vecs.push(...bvec);
  }
  for (let i = 0; i < terms.length; i++) {
    termToVec.set(terms[i]!, vecs[i]!);
  }

  // Parallelize upserts (DB-bound)
  await mapWithConcurrency(terms, 10, async (term, idx) => {
    const vec = vecs[idx]!;
    const { error } = await admin.rpc("deal_intel_upsert_keyword_term", {
      p_normalized_text: term,
      p_raw_text: term,
      p_fixed_token_count: tokenCount(term),
      p_embedding: vectorParam(vec),
      p_embedding_model: EMBEDDING_MODEL,
    });
    if (error) throw toError(error, "Failed to upsert keyword term");
  });

  const { data: termRows, error: termErr } = await admin.rpc("deal_intel_get_keyword_terms", {
    p_normalized_texts: terms,
  });
  if (termErr) throw toError(termErr, "Failed to fetch keyword terms");

  const termByText = new Map<string, string>();
  for (const r of (termRows ?? []) as Array<{ id: string; normalized_text: string }>) {
    termByText.set(r.normalized_text, r.id);
  }
  const textByTermId = new Map<string, string>();
  for (const [t, id] of termByText.entries()) textByTermId.set(id, t);

  const termIds = Array.from(termByText.values());
  if (termIds.length === 0) return;

  const { data: existingMembership, error: memErr } = await admin.rpc("deal_intel_get_keyword_memberships", {
    p_term_ids: termIds,
  });
  if (memErr) throw toError(memErr, "Failed to fetch keyword memberships");

  const existingTermToCluster = new Map<string, string>(
    ((existingMembership ?? []) as Array<{ term_id: string; cluster_id: string }>).map((r) => [
      r.term_id,
      r.cluster_id,
    ])
  );

  const { data: clusterRows, error: clusterErr } = await admin.rpc("deal_intel_list_keyword_clusters");
  if (clusterErr) throw toError(clusterErr, "Failed to list keyword clusters");

  const clusterVectors = new Map<string, number[] | null>();
  for (const c of (clusterRows ?? []) as Array<{ id: string; cluster_embedding: unknown }>) {
    clusterVectors.set(c.id, parseVector(c.cluster_embedding));
  }

  for (const termId of termIds) {
    if (existingTermToCluster.has(termId)) continue;
    const termText = textByTermId.get(termId) ?? "";
    const tVec = termToVec.get(termText) ?? null;

    let bestCluster: string | null = null;
    let bestSim = -1;
    if (tVec) {
      for (const [cid, cvec] of clusterVectors.entries()) {
        if (!cvec || cvec.length !== tVec.length) continue;
        const sim = cosineSimilarity(tVec, cvec);
        if (sim > bestSim) {
          bestSim = sim;
          bestCluster = cid;
        }
      }
    }

    let clusterId = bestCluster;
    if (!clusterId || bestSim < ONLINE_MERGE_THRESHOLD) {
      const { data: newCluster, error: newErr } = await admin.rpc("deal_intel_insert_keyword_cluster", {
        p_representative_term_id: termId,
        p_cluster_embedding: tVec ? vectorParam(tVec) : null,
        p_produced_by: "online_dsu",
        p_metadata: { source: "deal_intel_ingest_online_dsu" },
      });
      if (newErr || !newCluster) throw toError(newErr ?? new Error("keyword cluster insert failed"));
      clusterId = newCluster as string;
      clusterVectors.set(clusterId, tVec);
    } else if (clusterId && tVec) {
      const prev = clusterVectors.get(clusterId) ?? null;
      const next = weightedCentroid([
        { vector: prev, weight: 1 },
        { vector: tVec, weight: 1 },
      ]);
      clusterVectors.set(clusterId, next);
      await admin.rpc("deal_intel_update_keyword_cluster_embedding", {
        p_cluster_id: clusterId,
        p_cluster_embedding: next ? vectorParam(next) : null,
      });
    }

    const { error: linkErr } = await admin.rpc("deal_intel_upsert_keyword_membership", {
      p_term_id: termId,
      p_cluster_id: clusterId,
      p_weight: 1,
    });
    if (linkErr) throw toError(linkErr, "Failed to upsert keyword membership");
  }
}

export async function reconcileDealIntelKeywordClustersOffline(
  admin: SupabaseClient
): Promise<{ merged: number }> {
  // Old implementation was O(n^2) pairwise cosine in JS.
  // New implementation uses Postgres HNSW to propose near-neighbor merge candidates.
  const { data: pairs, error } = await admin.rpc("deal_intel_keyword_cluster_neighbors", {
    p_threshold: OFFLINE_RECONCILE_THRESHOLD,
    p_k: 8,
  });
  if (error || !pairs?.length) return { merged: 0 };

  const uf = new UnionFind();
  for (const r of pairs as Array<{ from_cluster_id: string; to_cluster_id: string }>) {
    uf.union(String(r.from_cluster_id), String(r.to_cluster_id));
  }

  // Choose a canonical cluster to keep per union root: pick lexical-min cluster id for determinism.
  const keepByRoot = new Map<string, string>();
  const clusters = new Set<string>();
  for (const r of pairs as Array<{ from_cluster_id: string; to_cluster_id: string }>) {
    clusters.add(String(r.from_cluster_id));
    clusters.add(String(r.to_cluster_id));
  }
  for (const id of clusters) {
    const root = uf.find(id);
    const cur = keepByRoot.get(root);
    if (!cur || id < cur) keepByRoot.set(root, id);
  }

  let merged = 0;
  for (const id of clusters) {
    const root = uf.find(id);
    const keep = keepByRoot.get(root)!;
    if (id === keep) continue;
    await admin.rpc("deal_intel_update_keyword_memberships_cluster", {
      p_from_cluster_id: id,
      p_to_cluster_id: keep,
    });
    const { error: delErr } = await admin.rpc("deal_intel_delete_keyword_cluster", {
      p_cluster_id: id,
    });
    if (!delErr) merged++;
  }

  return { merged };
}

