-- Deal embeddings (768-dim, Vertex text-embedding-004), lexical search document, hybrid RRF RPC, similar peers on analysis.

-- pgvector types/operators live in `extensions`; include it so `<=>` resolves inside functions.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

-- Pin vector dimension (required for HNSW / consistent inserts)
ALTER TABLE public.deals
  ALTER COLUMN deal_embedding TYPE vector(768);

ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS search_document text;

ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(search_document, ''))) STORED;

CREATE INDEX IF NOT EXISTS deals_search_tsv_idx ON public.deals USING gin (search_tsv);

CREATE INDEX IF NOT EXISTS deals_deal_embedding_hnsw_idx
  ON public.deals
  USING hnsw (deal_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

ALTER TABLE public.deal_analyses
  ADD COLUMN IF NOT EXISTS similar_peers_json jsonb;

COMMENT ON COLUMN public.deals.search_document IS 'Canonical text for FTS + embedding; updated when deal is indexed.';
COMMENT ON COLUMN public.deal_analyses.similar_peers_json IS 'Snapshot of hybrid similar-deals at analysis time (portfolio comparables).';

-- Hybrid RRF (k=60): vector KNN + full-text, scoped to user, optional exclude self.
CREATE OR REPLACE FUNCTION public.match_similar_deals_hybrid(
  p_user_id uuid,
  p_query_embedding vector(768),
  p_query_text text,
  p_exclude_deal_id uuid DEFAULT NULL,
  p_vector_limit int DEFAULT 40,
  p_fts_limit int DEFAULT 40,
  p_final_limit int DEFAULT 15
)
RETURNS TABLE (
  id uuid,
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
  WITH vector_results AS (
    SELECT d.id,
           d.company_name,
           ROW_NUMBER() OVER (ORDER BY d.deal_embedding <=> p_query_embedding) AS rank
    FROM public.deals d
    WHERE d.user_id = p_user_id
      AND d.deal_embedding IS NOT NULL
      AND (p_exclude_deal_id IS NULL OR d.id <> p_exclude_deal_id)
    ORDER BY d.deal_embedding <=> p_query_embedding
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
    SELECT d.id,
           d.company_name,
           ROW_NUMBER() OVER (ORDER BY ts_rank_cd(d.search_tsv, fq.q) DESC) AS rank
    FROM public.deals d
    CROSS JOIN fts_query fq
    WHERE fq.q IS NOT NULL
      AND d.user_id = p_user_id
      AND d.search_tsv @@ fq.q
      AND (p_exclude_deal_id IS NULL OR d.id <> p_exclude_deal_id)
    ORDER BY ts_rank_cd(d.search_tsv, fq.q) DESC
    LIMIT p_fts_limit
  ),
  merged AS (
    SELECT COALESCE(v.id, f.id) AS mid,
           COALESCE(v.company_name, f.company_name) AS mcompany,
           v.rank AS vr,
           f.rank AS fr
    FROM vector_results v
    FULL OUTER JOIN fts_results f ON v.id = f.id
  )
  SELECT m.mid AS id,
         m.mcompany AS company_name,
         m.vr::bigint AS vector_rank,
         m.fr::bigint AS fts_rank,
         (
           coalesce(1.0 / (60.0 + m.vr::double precision), 0.0)
           + coalesce(1.0 / (60.0 + m.fr::double precision), 0.0)
         ) AS rrf_score
  FROM merged m
  ORDER BY rrf_score DESC NULLS LAST
  LIMIT p_final_limit;
$$;

-- Convenience: load query vector + text from an existing deal (same user).
CREATE OR REPLACE FUNCTION public.match_similar_deals_from_deal(
  p_source_deal_id uuid,
  p_match_count int DEFAULT 15
)
RETURNS TABLE (
  id uuid,
  company_name text,
  vector_rank bigint,
  fts_rank bigint,
  rrf_score double precision
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $$
DECLARE
  v_user uuid;
  v_emb vector(768);
  v_doc text;
BEGIN
  SELECT d.user_id, d.deal_embedding, d.search_document
  INTO v_user, v_emb, v_doc
  FROM public.deals d
  WHERE d.id = p_source_deal_id;

  IF v_user IS NULL OR v_emb IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT h.id,
         h.company_name,
         h.vector_rank,
         h.fts_rank,
         h.rrf_score
  FROM public.match_similar_deals_hybrid(
    v_user,
    v_emb,
    coalesce(v_doc, ''),
    p_source_deal_id,
    40,
    40,
    p_match_count
  ) h;
END;
$$;

GRANT EXECUTE ON FUNCTION public.match_similar_deals_hybrid(uuid, vector(768), text, uuid, int, int, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.match_similar_deals_from_deal(uuid, int) TO authenticated, service_role;
