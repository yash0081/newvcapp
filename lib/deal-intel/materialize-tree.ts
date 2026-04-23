import type { SupabaseClient } from "@supabase/supabase-js";
import { embedText } from "@/lib/vertex-embeddings";
import { parseVector, vectorParam, weightedCentroid } from "@/lib/data-layer/shared/vector";
import { extractKeywords } from "@/lib/data-layer/shared/text";
import { toError } from "@/lib/supabase/error-format";

const PERSONAS = [
  "skeptic",
  "visionary",
  "incumbent",
] as const;

const CHILD_WEIGHTS: Record<string, number> = {
  problem: 1.1,
  solution: 1.15,
  market: 1.0,
  traction: 1.0,
  team: 0.95,
  negatives: 1.0,
  other: 0.8,
};

function canonicalChildType(path: string): string {
  const p = path.toLowerCase();
  if (p.includes("negative") || p.includes("rejection") || p.includes("risk")) return "negatives";
  if (p.includes("problem")) return "problem";
  if (p.includes("solution")) return "solution";
  if (p.includes("market") || p.includes("tam") || p.includes("sam") || p.includes("som")) return "market";
  if (p.includes("traction") || p.includes("revenue") || p.includes("investor") || p.includes("customer")) return "traction";
  if (p.includes("founder") || p.includes("team") || p.includes("people")) return "team";
  return firstSegment(path);
}

function firstSegment(path: string): string {
  const p = path.replace(/^\/+/, "");
  if (!p) return "root";
  const i = p.indexOf("/");
  return i < 0 ? p : p.slice(0, i);
}

function factText(v: { value_text: string | null; value_jsonb: unknown }): string {
  if (v.value_text != null && String(v.value_text).trim()) return String(v.value_text);
  if (v.value_jsonb == null) return "";
  if (typeof v.value_jsonb === "string") return v.value_jsonb;
  return JSON.stringify(v.value_jsonb).slice(0, 8000);
}

export async function materializeDealIntelTree(opts: {
  admin: SupabaseClient;
  dealId: string;
  revisionId: string | null;
}): Promise<{ rootId: string; nodeCount: number }> {
  const { admin, dealId, revisionId } = opts;

  const { data: prevRootsSnapshot } = await admin.rpc("deal_intel_get_latest_root", {
    p_deal_id: dealId,
  });

  await admin.rpc("deal_intel_reset_tree", { p_deal_id: dealId });

  const { data: dealRows, error: derr } = await admin.rpc("deal_intel_get_deal_metadata", {
    p_deal_id: dealId,
  });
  if (derr) throw toError(derr, "Failed to load deal metadata");
  const dealRow = Array.isArray(dealRows) ? dealRows[0] : null;
  const meta = (dealRow?.metadata as Record<string, unknown>) ?? {};
  const summary = typeof meta.retrieval_summary === "string" ? meta.retrieval_summary : String(meta.company_name ?? "Deal");

  const { data: factRows, error: ferr } = await admin.rpc("deal_intel_get_fact_nodes", {
    p_deal_id: dealId,
  });
  if (ferr) throw toError(ferr, "Failed to load fact nodes");
  const rows = (factRows ?? []) as Array<{
    id: string;
    path: string;
    sort_key: number;
    value_text: string | null;
    value_jsonb: unknown;
  }>;
  if (rows.length === 0) {
    return { rootId: "", nodeCount: 0 };
  }

  const bySeg = new Map<string, typeof rows>();
  for (const r of rows) {
    const seg = canonicalChildType(r.path);
    if (!bySeg.has(seg)) bySeg.set(seg, []);
    bySeg.get(seg)!.push(r);
  }

  const { data: rootId, error: rerr } = await admin.rpc("deal_intel_insert_tree_node", {
    p_node: {
      deal_id: dealId,
      revision_id: revisionId,
      parent_id: null,
      kind: "root",
      node_type: "company",
      fact_section_root_id: null,
      node_path: "/",
      node_key: "root",
      node_value_text: null,
      narrative_text: summary.slice(0, 12000),
      edge_weight_to_parent: 1,
      node_weight: 1,
      use_for_global_similarity: true,
      keywords: [],
      source_map: { kind: "auto_materialize" },
    },
  });
  if (rerr || !rootId) throw toError(rerr ?? new Error("root insert"));

  // Ensure required negatives child exists even if source facts don't expose explicit negatives.
  if (!bySeg.has("negatives")) {
    const negText =
      typeof meta.pass_reason_detail === "string"
        ? meta.pass_reason_detail
        : typeof meta.pass_reason === "string"
          ? meta.pass_reason
          : "No explicit negatives were extracted yet.";
    bySeg.set("negatives", [
      {
        id: "",
        path: "negative_aspects",
        sort_key: Number.MAX_SAFE_INTEGER - 1,
        value_text: String(negText),
        value_jsonb: null,
      },
    ] as typeof rows);
  }

  const childIdBySeg = new Map<string, { id: string; signal: number[] | null; weight: number }>();
  let ncount = 1;

  for (const [seg, frs] of bySeg) {
    const text = frs
      .map((x) => factText(x))
      .filter((t) => t.trim().length)
      .join(" \n\n ");
    const narrative = (text || seg).slice(0, 12000);
    const firstId = frs[0]?.id;
    const narrative3 = narrative.split(/\n+/).slice(0, 3).join(" ").slice(0, 1500);
    const narrativeEmb = await embedText(narrative3 || seg);

    const { data: cid, error: cerr } = await admin.rpc("deal_intel_insert_tree_node", {
      p_node: {
        deal_id: dealId,
        revision_id: revisionId,
        parent_id: rootId,
        kind: "child",
        node_type: seg,
        fact_section_root_id: firstId ?? null,
        node_path: `/${seg}`,
        node_key: seg,
        node_value_text: null,
        narrative_text: narrative3,
        narrative_embedding: vectorParam(narrativeEmb),
        edge_weight_to_parent: 1,
        node_weight: CHILD_WEIGHTS[seg] ?? CHILD_WEIGHTS.other,
        use_for_global_similarity: true,
        keywords: extractKeywords(`${seg} ${narrative3}`, 24),
        source_map: { section: seg },
      },
    });
    if (cerr || !cid) throw toError(cerr, "Failed to insert child tree node");
    childIdBySeg.set(seg, { id: cid, signal: null, weight: CHILD_WEIGHTS[seg] ?? CHILD_WEIGHTS.other });
    ncount++;

    await admin.rpc("deal_intel_insert_tree_edge", {
      p_edge: {
        deal_id: dealId,
        src_node_id: rootId,
        dst_node_id: cid,
        edge_kind: "tree",
        weight: 1,
        metadata: {},
      },
    });

    for (const r of frs) {
      const parts = r.path.split("/").filter(Boolean);
      if (parts.length <= 1) continue;
      const leaf = factText(r);
      if (!leaf.trim()) continue;
      const prepended = `${seg} > ${r.path}: ${leaf}`.slice(0, 8000);
      const atom = await embedText(prepended);
      const { data: sid, error: serr } = await admin.rpc("deal_intel_insert_tree_node", {
        p_node: {
          deal_id: dealId,
          revision_id: revisionId,
          parent_id: cid,
          kind: "sub_child",
          node_type: r.path,
          fact_section_root_id: r.id,
          node_path: r.path,
          node_key: parts[parts.length - 1] ?? "leaf",
          node_value_text: prepended,
          narrative_text: prepended,
          atomic_embedding: vectorParam(atom),
          edge_weight_to_parent: 1,
          node_weight: 1,
          use_for_global_similarity: true,
          keywords: extractKeywords(prepended, 20),
          source_map: { from_fact_id: r.id },
        },
      });
      if (serr || !sid) throw toError(serr, "Failed to insert sub-child tree node");
      ncount++;
      await admin.rpc("deal_intel_insert_tree_edge", {
        p_edge: {
          deal_id: dealId,
          src_node_id: cid,
          dst_node_id: sid,
          edge_kind: "tree",
          weight: 1,
          metadata: {},
        },
      });
    }

    // Persona sub-child nodes (excluded from global similarity)
    for (const persona of PERSONAS) {
      const personaText = `${seg} (${persona} persona): ${narrative3}`.slice(0, 8000);
      const pvec = await embedText(personaText);
      const { data: pid, error: perr } = await admin.rpc("deal_intel_insert_tree_node", {
        p_node: {
          deal_id: dealId,
          revision_id: revisionId,
          parent_id: cid,
          kind: "persona_subchild",
          node_type: `${seg}:${persona}`,
          fact_section_root_id: firstId ?? null,
          node_path: `/${seg}/persona/${persona}`,
          node_key: persona,
          node_value_text: personaText,
          narrative_text: personaText,
          atomic_embedding: vectorParam(pvec),
          edge_weight_to_parent: 0.5,
          node_weight: 0.5,
          use_for_global_similarity: false,
          keywords: extractKeywords(personaText, 16),
          source_map: { persona, section: seg },
        },
      });
      if (perr || !pid) throw toError(perr, "Failed to insert persona sub-child");
      await admin.rpc("deal_intel_insert_tree_edge", {
        p_edge: {
          deal_id: dealId,
          src_node_id: cid,
          dst_node_id: pid,
          edge_kind: "persona",
          weight: 0.5,
          metadata: { persona },
        },
      });
      ncount++;
    }
  }

  // Compute child signal vectors from non-persona subchildren and anchor vectors from keyword terms.
  for (const [seg, child] of childIdBySeg) {
    const { data: subs, error: subErr } = await admin.rpc("deal_intel_get_tree_children", {
      p_deal_id: dealId,
      p_parent_id: child.id,
    });
    if (subErr) throw toError(subErr, "Failed to load child subnodes");
    const subRows = (subs ?? []) as Array<{
      id: string;
      kind: string;
      atomic_embedding: unknown;
      node_weight: number;
      keywords: string[] | null;
    }>;
    const signal = weightedCentroid(
      subRows
        .filter((s) => s.kind !== "persona_subchild")
        .map((s) => ({ vector: parseVector(s.atomic_embedding), weight: Number(s.node_weight ?? 1) }))
    );
    const kw = Array.from(
      new Set(subRows.flatMap((s) => (Array.isArray(s.keywords) ? s.keywords : [])))
    ).slice(0, 40);
    let anchor: number[] | null = null;
    if (kw.length > 0) {
      const { data: terms } = await admin.rpc("deal_intel_get_keyword_terms", {
        p_normalized_texts: kw,
      });
      anchor = weightedCentroid(
        ((terms ?? []) as Array<{ normalized_text: string; embedding: unknown }>).map((t) => ({
          vector: parseVector(t.embedding),
          weight: 1,
        }))
      );
    }
    const updates: Record<string, unknown> = {
      signal_embedding: signal ? vectorParam(signal) : null,
      keywords: kw,
    };
    if (anchor) updates.anchor_embedding = vectorParam(anchor);
    await admin.rpc("deal_intel_update_tree_node_patch", {
      p_id: child.id,
      p_patch: updates,
    });
    childIdBySeg.set(seg, { ...child, signal });
  }

  // Root super-centroid from child signal vectors.
  const rootCentroid = weightedCentroid(
    Array.from(childIdBySeg.values()).map((c) => ({
      vector: c.signal,
      weight: c.weight,
    }))
  );
  const rootPatch: Record<string, unknown> = {};
  if (rootCentroid) {
    rootPatch.centroid_embedding = vectorParam(rootCentroid);
    rootPatch.narrative_embedding = vectorParam(rootCentroid);
  }

  // Delta/drift support for revisions: compare previous root centroid if available.
  const prev = (
    (prevRootsSnapshot ?? []) as Array<{ id: string; revision_id: string | null; centroid_embedding: unknown }>
  )[0];
  const prevVec = prev ? parseVector(prev.centroid_embedding) : null;
  if (rootCentroid && prevVec && prevVec.length === rootCentroid.length) {
    const drift = rootCentroid.map((v, i) => v - prevVec[i]);
    rootPatch.drift_embedding = vectorParam(drift);
    const driftNorm = Math.sqrt(drift.reduce((a, x) => a + x * x, 0));
    if (driftNorm > 0) {
      const { data: deltaNodeId, error: deltaErr } = await admin.rpc("deal_intel_insert_tree_node", {
        p_node: {
          deal_id: dealId,
          revision_id: revisionId,
          parent_id: rootId,
          kind: "child",
          node_type: "delta",
          node_path: "/delta",
          node_key: "delta",
          narrative_text: "Change between latest and previous revision.",
          drift_embedding: vectorParam(drift),
          signal_embedding: vectorParam(drift),
          edge_weight_to_parent: 0.75,
          node_weight: 0.75,
          use_for_global_similarity: false,
          keywords: ["delta", "drift", "revision"],
          source_map: { previous_revision_id: prev.revision_id },
        },
      });
      if (deltaErr || !deltaNodeId) throw toError(deltaErr, "Failed to insert delta node");
      await admin.rpc("deal_intel_insert_tree_edge", {
        p_edge: {
          deal_id: dealId,
          src_node_id: rootId,
          dst_node_id: deltaNodeId,
          edge_kind: "delta",
          weight: 0.75,
          metadata: { previous_root_id: prev.id },
        },
      });
      ncount++;
    }
  }
  if (Object.keys(rootPatch).length > 0) {
    await admin.rpc("deal_intel_update_tree_node_patch", {
      p_id: rootId,
      p_patch: rootPatch,
    });
  }

  return { rootId, nodeCount: ncount };
}
