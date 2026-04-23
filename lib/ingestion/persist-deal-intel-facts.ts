import type { SupabaseClient } from "@supabase/supabase-js";

type FactNodeInsert = {
  path: string;
  depth: number;
  sort_key: number;
  value_text: string | null;
  value_jsonb: unknown | null;
  source_map: Record<string, unknown>;
};

type FactNodeDbInsert = {
  deal_id: string;
  parent_id: string | null;
  path: string;
  depth: number;
  sort_key: number;
  value_text: string | null;
  value_jsonb: unknown | null;
  source_map: Record<string, unknown>;
};

function pathDepth(path: string): number {
  return path.split("/").filter(Boolean).length;
}

function pathTrail(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const p of parts) {
    cur = cur ? `${cur}/${p}` : p;
    out.push(cur);
  }
  return out;
}

function edgeWeightForPath(path: string, depth: number): number {
  const p = path.toLowerCase();
  if (p.includes("negative") || p.includes("rejection") || p.includes("risk")) return 1.2;
  if (p.includes("problem") || p.includes("solution")) return 1.1;
  return Math.max(0.6, 1 - depth * 0.03);
}

let sortCounter = 0;

function walkFacts(value: unknown, path: string, rows: FactNodeInsert[]): void {
  if (value === null || value === undefined) {
    rows.push({
      path: path || "root",
      depth: pathDepth(path || "root"),
      sort_key: sortCounter++,
      value_text: null,
      value_jsonb: null,
      source_map: {},
    });
    return;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    rows.push({
      path: path || "root",
      depth: pathDepth(path || "root"),
      sort_key: sortCounter++,
      value_text: String(value),
      value_jsonb: null,
      source_map: {},
    });
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      rows.push({
        path: path || "root",
        depth: pathDepth(path || "root"),
        sort_key: sortCounter++,
        value_text: null,
        value_jsonb: [],
        source_map: {},
      });
      return;
    }
    if (
      value.every(
        (x) => x !== null && (typeof x === "string" || typeof x === "number" || typeof x === "boolean")
      )
    ) {
      rows.push({
        path: path || "root",
        depth: pathDepth(path || "root"),
        sort_key: sortCounter++,
        value_text: null,
        value_jsonb: value,
        source_map: {},
      });
      return;
    }
    for (let i = 0; i < value.length; i++) {
      walkFacts(value[i], `${path}/${i}`, rows);
    }
    return;
  }
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 0) {
      rows.push({
        path: path || "root",
        depth: pathDepth(path || "root"),
        sort_key: sortCounter++,
        value_text: null,
        value_jsonb: {},
        source_map: {},
      });
      return;
    }
    for (const k of keys) {
      const nextPath = path ? `${path}/${k}` : k;
      walkFacts(o[k], nextPath, rows);
    }
  }
}

function ensureAncestorRows(rows: FactNodeInsert[]): FactNodeInsert[] {
  const byPath = new Map<string, FactNodeInsert>();
  for (const r of rows) {
    byPath.set(r.path, r);
  }
  for (const r of rows) {
    const parts = r.path.split("/").filter(Boolean);
    if (parts.length <= 1) continue;
    let cur = "";
    for (let i = 0; i < parts.length - 1; i++) {
      cur = cur ? `${cur}/${parts[i]}` : parts[i];
      if (!byPath.has(cur)) {
        byPath.set(cur, {
          path: cur,
          depth: pathDepth(cur),
          sort_key: sortCounter++,
          value_text: null,
          value_jsonb: null,
          source_map: { synthetic_container: true, path_trail: pathTrail(cur) },
        });
      }
    }
  }
  return Array.from(byPath.values()).sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.sort_key - b.sort_key;
  });
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

const BATCH = 300;

/**
 * Create `deal_intel.deal` + `deal_revision`, then flatten `facts` into `deal_intel.deal_fact_node` rows.
 */
export async function persistDealIntelFacts(opts: {
  admin: SupabaseClient;
  userId: string;
  /** Normalized or raw parsing JSON. */
  facts: Record<string, unknown>;
  /** Optional metadata on the deal row. */
  dealMetadata?: Record<string, unknown>;
}): Promise<{ dealId: string; revisionId: string }> {
  const { admin, userId, facts, dealMetadata } = opts;
  sortCounter = 0;

  const { data: dr, error: dealErr } = await admin.rpc("deal_intel_create_deal_with_revision", {
    p_user_id: userId,
    p_deal_metadata: {
      source: "phase1_placeholder_ingest",
      ...((dealMetadata ?? {}) as Record<string, unknown>),
    },
    p_revision_label: "ingest:placeholder_layer1",
    p_revision_metadata: { kind: "placeholder_phase1" },
  });
  const first = Array.isArray(dr) ? dr[0] : null;
  if (dealErr || !first) {
    console.error("persistDealIntelFacts: create deal+revision rpc", dealErr);
    throw new Error((dealErr as { message?: string } | null)?.message ?? "Failed to create deal_intel deal/revision");
  }
  const dealId = first.deal_id as string;
  const revisionId = first.revision_id as string;

  const factRowsRaw: FactNodeInsert[] = [];
  walkFacts(facts, "", factRowsRaw);
  const factRows = ensureAncestorRows(factRowsRaw);

  if (factRows.length === 0) {
    return { dealId, revisionId };
  }

  const pathToId = new Map<string, string>();
  const edgeRows: Array<{
    deal_id: string;
    src_node_id: string;
    dst_node_id: string;
    edge_kind: string;
    weight: number;
    metadata: Record<string, unknown>;
  }> = [];

  for (const batch of chunk(factRows, BATCH)) {
    const toInsert: FactNodeDbInsert[] = batch.map((r) => {
      const parts = r.path.split("/").filter(Boolean);
      const parentPath = parts.length > 1 ? parts.slice(0, -1).join("/") : null;
      return {
        deal_id: dealId,
        parent_id: parentPath ? pathToId.get(parentPath) ?? null : null,
        path: r.path,
        depth: r.depth,
        sort_key: r.sort_key,
        value_text: r.value_text,
        value_jsonb: r.value_jsonb,
        source_map: {
          ...(r.source_map ?? {}),
          path_trail: pathTrail(r.path),
          node_path: r.path,
        },
      };
    });

    const { data: inserted, error: nodeErr } = await admin.rpc("deal_intel_insert_fact_nodes", {
      p_rows: toInsert,
    });

    if (nodeErr) {
      await admin.rpc("deal_intel_delete_deal", { p_deal_id: dealId });
      console.error("persistDealIntelFacts: deal_fact_node insert", nodeErr);
      throw new Error(nodeErr.message);
    }
    for (const n of inserted ?? []) {
      const id = n.id as string;
      const path = n.path as string;
      const parentId = (n.parent_id as string | null) ?? null;
      pathToId.set(path, id);
      if (parentId) {
        edgeRows.push({
          deal_id: dealId,
          src_node_id: parentId,
          dst_node_id: id,
          edge_kind: "tree",
          weight: edgeWeightForPath(path, Number(path.split("/").filter(Boolean).length)),
          metadata: {
            path,
          },
        });
      }
    }
  }

  if (edgeRows.length > 0) {
    const { error: edgeErr } = await admin.rpc("deal_intel_insert_fact_edges", {
      p_rows: edgeRows,
    });
    if (edgeErr) {
      await admin.rpc("deal_intel_delete_deal", { p_deal_id: dealId });
      console.error("persistDealIntelFacts: deal_fact_edge insert", edgeErr);
      throw new Error(edgeErr.message);
    }
  }

  return { dealId, revisionId };
}
