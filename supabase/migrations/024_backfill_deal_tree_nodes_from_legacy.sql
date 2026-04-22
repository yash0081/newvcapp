-- Backfill Deal Tree v1 from existing tables.
-- Source tables:
-- - deal_context_nodes (legacy hierarchy + embeddings)
-- - deals (root centroid via deals.deal_embedding)
-- - deal_retrieval_index (section vectors)
-- - deal_keywords (section concepts)
--
-- This keeps legacy nodes as-is and migrates them 1:1 into deal_tree_nodes, then enriches.
-- You can later stop writing to deal_context_nodes once the app is fully switched to deal_tree_nodes.

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

-- 1) Create mapping from legacy node IDs -> new deal_tree_nodes IDs
CREATE TABLE IF NOT EXISTS public._deal_tree_legacy_map (
  legacy_id uuid PRIMARY KEY,
  new_id uuid NOT NULL UNIQUE
);

-- Internal migration helper only: not for client apps. RLS on + no policies => deny for anon/authenticated via PostgREST.
ALTER TABLE public._deal_tree_legacy_map ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public._deal_tree_legacy_map FROM anon, authenticated;

-- 2) Seed mapping table deterministically, then insert using explicit IDs.
INSERT INTO public._deal_tree_legacy_map (legacy_id, new_id)
SELECT n.id AS legacy_id, gen_random_uuid() AS new_id
FROM public.deal_context_nodes n
ON CONFLICT (legacy_id) DO NOTHING;

INSERT INTO public.deal_tree_nodes (
  id,
  deal_id,
  analysis_id,
  parent_id,
  kind,
  depth,
  node_type,
  node_path,
  node_key,
  node_value_text,
  narrative_text,
  structured_text,
  keywords,
  keyword_cluster_ids,
  atomic_embedding,
  narrative_embedding,
  signal_embedding,
  anchor_embedding,
  centroid_embedding,
  drift_embedding,
  node_weight,
  edge_weight,
  polarity,
  version,
  source_map,
  created_at,
  updated_at
)
SELECT
  m.new_id AS id,
  n.deal_id,
  n.analysis_id,
  NULL::uuid AS parent_id,
  CASE
    WHEN n.depth = 0 THEN 'root'::public.deal_tree_node_kind
    WHEN n.depth = 1 THEN 'child'::public.deal_tree_node_kind
    ELSE 'sub_child'::public.deal_tree_node_kind
  END AS kind,
  n.depth,
  n.node_type,
  NULL::text AS node_path,
  NULL::text AS node_key,
  NULL::text AS node_value_text,
  n.raw_text AS narrative_text,
  n.structured_text,
  coalesce(n.keywords, '{}'::text[]) AS keywords,
  '{}'::uuid[] AS keyword_cluster_ids,
  n.embedding AS atomic_embedding,
  NULL::vector(768) AS narrative_embedding,
  NULL::vector(768) AS signal_embedding,
  NULL::vector(768) AS anchor_embedding,
  NULL::vector(768) AS centroid_embedding,
  NULL::vector(768) AS drift_embedding,
  coalesce(n.node_weight, 1.0) AS node_weight,
  1.0 AS edge_weight,
  CASE
    WHEN n.polarity = 'negative' THEN 'negative'::public.deal_tree_polarity
    WHEN n.polarity = 'positive' THEN 'positive'::public.deal_tree_polarity
    ELSE 'neutral'::public.deal_tree_polarity
  END AS polarity,
  coalesce(n.version, 1),
  '{}'::jsonb AS source_map,
  coalesce(n.created_at, now()),
  coalesce(n.updated_at, now())
FROM public.deal_context_nodes n
JOIN public._deal_tree_legacy_map m ON m.legacy_id = n.id
LEFT JOIN public.deal_tree_nodes existing ON existing.id = m.new_id
WHERE existing.id IS NULL;

-- 3) Repair parent_id pointers using the mapping table (idempotent update)
UPDATE public.deal_tree_nodes dst
SET parent_id = m_parent.new_id
FROM public._deal_tree_legacy_map m_self
JOIN public.deal_context_nodes src ON src.id = m_self.legacy_id
JOIN public._deal_tree_legacy_map m_parent ON m_parent.legacy_id = src.parent_id
WHERE dst.id = m_self.new_id
  AND src.parent_id IS NOT NULL
  AND (dst.parent_id IS DISTINCT FROM m_parent.new_id);

-- 4) Enrich root centroid_embedding from deals.deal_embedding
UPDATE public.deal_tree_nodes n
SET centroid_embedding = d.deal_embedding
FROM public.deals d
WHERE n.deal_id = d.id
  AND n.kind = 'root'
  AND n.node_type = 'root'
  AND n.centroid_embedding IS NULL
  AND d.deal_embedding IS NOT NULL;

-- 5) Enrich child signal_embedding from deal_retrieval_index where it matches node_type
UPDATE public.deal_tree_nodes n
SET signal_embedding =
  CASE
    WHEN n.node_type = 'problem' THEN dri.problem_embedding
    WHEN n.node_type = 'solution' THEN dri.solution_embedding
    WHEN n.node_type = 'market' THEN dri.market_embedding
    WHEN n.node_type IN ('risk', 'negatives', 'risk_negative') THEN dri.risk_embedding
    ELSE n.signal_embedding
  END
FROM public.deal_retrieval_index dri
WHERE n.deal_id = dri.deal_id
  AND n.kind = 'child'
  AND n.signal_embedding IS NULL;

-- 6) Merge keywords from deal_keywords into matching child nodes (concepts array is already normalized downstream)
WITH kw AS (
  SELECT
    dk.deal_id,
    dk.section_name,
    dk.concepts
  FROM public.deal_keywords dk
)
UPDATE public.deal_tree_nodes n
SET keywords = (
  SELECT ARRAY(
    SELECT DISTINCT lower(trim(x))
    FROM unnest(coalesce(n.keywords, '{}'::text[]) || coalesce(kw.concepts, '{}'::text[])) AS x
    WHERE length(trim(x)) > 0
    ORDER BY lower(trim(x))
  )
)
FROM kw
WHERE n.deal_id = kw.deal_id
  AND n.kind = 'child'
  AND (
    (kw.section_name = 'problem' AND n.node_type = 'problem')
    OR (kw.section_name = 'solution' AND n.node_type = 'solution')
    OR (kw.section_name = 'market' AND n.node_type IN ('market', 'thesis_fit', 'traction'))
    OR (kw.section_name = 'risk' AND n.node_type IN ('risk', 'negatives', 'risk_negative'))
  );

-- 7) Populate node_path for sub-child nodes (best-effort): concatenate ancestor node_types.
-- This is purely a convenience; the app should still compute a canonical path from parent links.
WITH RECURSIVE walk AS (
  SELECT
    n.id,
    n.parent_id,
    n.node_type,
    n.node_type::text AS path,
    0 AS hops
  FROM public.deal_tree_nodes n
  WHERE n.parent_id IS NULL
  UNION ALL
  SELECT
    c.id,
    c.parent_id,
    c.node_type,
    (w.path || ' > ' || c.node_type) AS path,
    w.hops + 1 AS hops
  FROM public.deal_tree_nodes c
  JOIN walk w ON w.id = c.parent_id
  WHERE w.hops < 12
)
UPDATE public.deal_tree_nodes n
SET node_path = w.path
FROM walk w
WHERE n.id = w.id
  AND n.node_path IS NULL;

