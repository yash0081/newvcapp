-- Deal Tree v1: canonical hierarchical index for hybrid retrieval.
-- Root nodes represent a deal; child nodes represent buckets (problem/solution/etc + negatives + delta);
-- sub-child nodes represent atomic key/value signals (plus persona nodes) embedded with a path prefix.
--
-- This migration only creates structure + indexes + RPCs. Data backfill is in 024_*.

-- Ensure pgvector exists (Supabase installs it under `extensions` schema).
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'deal_tree_node_kind') THEN
    CREATE TYPE public.deal_tree_node_kind AS ENUM ('root', 'child', 'sub_child');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'deal_tree_polarity') THEN
    CREATE TYPE public.deal_tree_polarity AS ENUM ('positive', 'negative', 'neutral');
  END IF;
END $$;

-- NOTE: keep node_type as free-form text for forward-compatibility, but standardize expected values in app code:
-- root, problem, solution, market, traction, thesis_fit, team, negatives, delta, persona_skeptic, persona_visionary, persona_incumbent, ...
CREATE TABLE IF NOT EXISTS public.deal_tree_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  deal_id uuid NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
  analysis_id uuid NOT NULL REFERENCES public.deal_analyses(id) ON DELETE CASCADE,

  -- Hierarchy
  parent_id uuid REFERENCES public.deal_tree_nodes(id) ON DELETE CASCADE,
  kind public.deal_tree_node_kind NOT NULL,
  depth int NOT NULL DEFAULT 0,
  node_type text NOT NULL,
  node_path text,

  -- Atomic key/value payload for sub-child nodes (optional)
  node_key text,
  node_value_text text,

  -- Human-readable summaries (optional; used for UI + BM25 + citations)
  narrative_text text,
  structured_text text,

  -- Keywords are normalized, reproducible tokens (lowercase). Cluster IDs are optional (medoid rows in keyword_clusters).
  keywords text[] NOT NULL DEFAULT '{}',
  keyword_cluster_ids uuid[] NOT NULL DEFAULT '{}',

  -- Embeddings
  -- atomic_embedding: path-prepended embedding for sub-child nodes
  -- narrative_embedding: embedding of cleaned 2-3 line prose summary (child nodes)
  -- signal_embedding: weighted centroid of atomic sub-child nodes (child nodes)
  -- anchor_embedding: centroid of keyword-cluster medoid embeddings (child nodes)
  -- centroid_embedding: super-centroid (root nodes)
  -- drift_embedding: optional delta vector (delta nodes / future versioning)
  atomic_embedding vector(768),
  narrative_embedding vector(768),
  signal_embedding vector(768),
  anchor_embedding vector(768),
  centroid_embedding vector(768),
  drift_embedding vector(768),

  -- Weights
  node_weight double precision NOT NULL DEFAULT 1.0,
  edge_weight double precision NOT NULL DEFAULT 1.0,

  polarity public.deal_tree_polarity NOT NULL DEFAULT 'neutral',
  version int NOT NULL DEFAULT 1,

  -- Document citation metadata (document-local citations; web refs live in analysis docs)
  source_map jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- BM25-ish search over node text + keywords (maintained by trigger; generated columns require IMMUTABLE funcs)
  search_document tsvector,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_tree_nodes_deal_analysis_idx
  ON public.deal_tree_nodes (deal_id, analysis_id);

CREATE INDEX IF NOT EXISTS deal_tree_nodes_parent_idx
  ON public.deal_tree_nodes (parent_id);

CREATE INDEX IF NOT EXISTS deal_tree_nodes_kind_type_idx
  ON public.deal_tree_nodes (deal_id, kind, node_type);

CREATE INDEX IF NOT EXISTS deal_tree_nodes_search_gin_idx
  ON public.deal_tree_nodes USING gin (search_document);

-- Maintain search_document via trigger (mirrors `deal_keywords` strategy).
CREATE OR REPLACE FUNCTION public.set_deal_tree_nodes_search_document()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_document :=
    to_tsvector(
      'english',
      coalesce(NEW.narrative_text, '') || ' ' ||
      coalesce(NEW.structured_text, '') || ' ' ||
      coalesce(NEW.node_key, '') || ' ' ||
      coalesce(NEW.node_value_text, '') || ' ' ||
      coalesce(array_to_string(coalesce(NEW.keywords, '{}'::text[]), ' '), '')
    );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deal_tree_nodes_search_document_trigger ON public.deal_tree_nodes;
CREATE TRIGGER deal_tree_nodes_search_document_trigger
BEFORE INSERT OR UPDATE OF narrative_text, structured_text, node_key, node_value_text, keywords
ON public.deal_tree_nodes
FOR EACH ROW
EXECUTE FUNCTION public.set_deal_tree_nodes_search_document();

-- Backfill search_document for any rows inserted before the trigger existed.
UPDATE public.deal_tree_nodes
SET search_document =
  to_tsvector(
    'english',
    coalesce(narrative_text, '') || ' ' ||
    coalesce(structured_text, '') || ' ' ||
    coalesce(node_key, '') || ' ' ||
    coalesce(node_value_text, '') || ' ' ||
    coalesce(array_to_string(coalesce(keywords, '{}'::text[]), ' '), '')
  )
WHERE search_document IS NULL;

-- Vector indexes (HNSW)
CREATE INDEX IF NOT EXISTS deal_tree_nodes_atomic_embedding_hnsw_idx
  ON public.deal_tree_nodes
  USING hnsw (atomic_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS deal_tree_nodes_signal_embedding_hnsw_idx
  ON public.deal_tree_nodes
  USING hnsw (signal_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS deal_tree_nodes_centroid_embedding_hnsw_idx
  ON public.deal_tree_nodes
  USING hnsw (centroid_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- RLS
ALTER TABLE public.deal_tree_nodes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can select own deal_tree_nodes"
  ON public.deal_tree_nodes FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.deals d WHERE d.id = deal_tree_nodes.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own deal_tree_nodes"
  ON public.deal_tree_nodes FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM public.deals d WHERE d.id = deal_tree_nodes.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can update own deal_tree_nodes"
  ON public.deal_tree_nodes FOR UPDATE
  USING (EXISTS (SELECT 1 FROM public.deals d WHERE d.id = deal_tree_nodes.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can delete own deal_tree_nodes"
  ON public.deal_tree_nodes FOR DELETE
  USING (EXISTS (SELECT 1 FROM public.deals d WHERE d.id = deal_tree_nodes.deal_id AND d.user_id = auth.uid()));

-- RPCs for hybrid retrieval (vector + FTS), mirroring the existing deal_context_nodes RPCs.

CREATE OR REPLACE FUNCTION public.match_deal_tree_nodes_fts(
  p_user_id uuid,
  p_query text,
  p_match_count int DEFAULT 40
)
RETURNS TABLE (
  id uuid,
  deal_id uuid,
  analysis_id uuid,
  node_type text,
  narrative_text text,
  rank float
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    n.id,
    n.deal_id,
    n.analysis_id,
    n.node_type,
    n.narrative_text,
    ts_rank_cd(n.search_document, plainto_tsquery('english', p_query))::float AS rank
  FROM public.deal_tree_nodes n
  INNER JOIN public.deals d ON d.id = n.deal_id
  WHERE d.user_id = p_user_id
    AND length(trim(p_query)) >= 2
    AND n.search_document @@ plainto_tsquery('english', p_query)
  ORDER BY rank DESC NULLS LAST
  LIMIT greatest(1, least(p_match_count, 150));
$$;

-- Vector search: prefer signal_embedding (child nodes) else atomic_embedding.
CREATE OR REPLACE FUNCTION public.match_deal_tree_nodes_vector(
  p_user_id uuid,
  p_query_embedding vector(768),
  p_deal_ids uuid[] DEFAULT NULL,
  p_match_count int DEFAULT 40
)
RETURNS TABLE (
  id uuid,
  deal_id uuid,
  analysis_id uuid,
  node_type text,
  narrative_text text,
  similarity float
)
LANGUAGE sql
STABLE
SET search_path = public, extensions
AS $$
  SELECT
    n.id,
    n.deal_id,
    n.analysis_id,
    n.node_type,
    n.narrative_text,
    1 - (coalesce(n.signal_embedding, n.atomic_embedding) <=> p_query_embedding) AS similarity
  FROM public.deal_tree_nodes n
  INNER JOIN public.deals d ON d.id = n.deal_id
  WHERE d.user_id = p_user_id
    AND coalesce(n.signal_embedding, n.atomic_embedding) IS NOT NULL
    AND (
      p_deal_ids IS NULL
      OR cardinality(p_deal_ids) = 0
      OR n.deal_id = ANY (p_deal_ids)
    )
  ORDER BY coalesce(n.signal_embedding, n.atomic_embedding) <=> p_query_embedding
  LIMIT greatest(1, least(p_match_count, 150));
$$;

GRANT EXECUTE ON FUNCTION public.match_deal_tree_nodes_fts(uuid, text, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.match_deal_tree_nodes_vector(uuid, vector(768), uuid[], int) TO authenticated, service_role;

-- Similar company search: restrict to root nodes (centroid_embedding + keywords BM25).
-- This mirrors `match_similar_deals_hybrid` but uses deal_tree_nodes(kind=root) as the retrieval substrate.
CREATE OR REPLACE FUNCTION public.match_similar_deals_deal_tree_hybrid(
  p_user_id uuid,
  p_query_embedding vector(768),
  p_query_text text,
  p_exclude_deal_id uuid DEFAULT NULL,
  p_vector_limit int DEFAULT 60,
  p_fts_limit int DEFAULT 60,
  p_final_limit int DEFAULT 20
)
RETURNS TABLE (
  deal_id uuid,
  company_name text,
  vector_rank bigint,
  fts_rank bigint,
  rrf_score double precision
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $$
  WITH roots AS (
    SELECT n.deal_id, n.centroid_embedding, n.search_document
    FROM public.deal_tree_nodes n
    INNER JOIN public.deals d ON d.id = n.deal_id
    WHERE d.user_id = p_user_id
      AND n.kind = 'root'
      AND n.node_type = 'root'
      AND (p_exclude_deal_id IS NULL OR n.deal_id <> p_exclude_deal_id)
  ),
  vector_results AS (
    SELECT r.deal_id,
           ROW_NUMBER() OVER (ORDER BY r.centroid_embedding <=> p_query_embedding) AS rank
    FROM roots r
    WHERE r.centroid_embedding IS NOT NULL
    ORDER BY r.centroid_embedding <=> p_query_embedding
    LIMIT p_vector_limit
  ),
  fts_query AS (
    SELECT
      CASE
        WHEN length(trim(coalesce(p_query_text, ''))) < 8 THEN NULL::tsquery
        ELSE websearch_to_tsquery('english', left(trim(p_query_text), 4000))
      END AS q
  ),
  fts_results AS (
    SELECT r.deal_id,
           ROW_NUMBER() OVER (ORDER BY ts_rank_cd(r.search_document, fq.q) DESC) AS rank
    FROM roots r
    CROSS JOIN fts_query fq
    WHERE fq.q IS NOT NULL
      AND r.search_document @@ fq.q
    ORDER BY ts_rank_cd(r.search_document, fq.q) DESC
    LIMIT p_fts_limit
  ),
  merged AS (
    SELECT COALESCE(v.deal_id, f.deal_id) AS did,
           v.rank AS vr,
           f.rank AS fr
    FROM vector_results v
    FULL OUTER JOIN fts_results f ON v.deal_id = f.deal_id
  )
  SELECT
    m.did AS deal_id,
    coalesce(d.company_name, 'Unknown') AS company_name,
    m.vr::bigint AS vector_rank,
    m.fr::bigint AS fts_rank,
    (
      coalesce(1.0 / (60.0 + m.vr::double precision), 0.0)
      + coalesce(1.0 / (60.0 + m.fr::double precision), 0.0)
    ) AS rrf_score
  FROM merged m
  INNER JOIN public.deals d ON d.id = m.did
  ORDER BY rrf_score DESC NULLS LAST
  LIMIT p_final_limit;
$$;

GRANT EXECUTE ON FUNCTION public.match_similar_deals_deal_tree_hybrid(uuid, vector(768), text, uuid, int, int, int)
  TO authenticated, service_role;

