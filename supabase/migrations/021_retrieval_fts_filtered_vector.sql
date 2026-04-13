-- Hybrid retrieval: FTS on deal_context_nodes.search_document + optional deal_id prefilter for vector leg.

CREATE OR REPLACE FUNCTION public.match_deal_context_nodes_fts(
  p_user_id uuid,
  p_query text,
  p_match_count int DEFAULT 40
)
RETURNS TABLE (
  id uuid,
  deal_id uuid,
  analysis_id uuid,
  node_type text,
  raw_text text,
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
    n.raw_text,
    ts_rank_cd(n.search_document, plainto_tsquery('english', p_query))::float AS rank
  FROM deal_context_nodes n
  INNER JOIN deals d ON d.id = n.deal_id
  WHERE d.user_id = p_user_id
    AND length(trim(p_query)) >= 2
    AND n.search_document @@ plainto_tsquery('english', p_query)
  ORDER BY rank DESC NULLS LAST
  LIMIT greatest(1, least(p_match_count, 150));
$$;

-- Vector search restricted to a set of deals (tabular / keyword prefilter).
CREATE OR REPLACE FUNCTION public.match_deal_context_nodes_in_deals(
  p_user_id uuid,
  p_query_embedding vector(768),
  p_deal_ids uuid[],
  p_match_count int DEFAULT 40
)
RETURNS TABLE (
  id uuid,
  deal_id uuid,
  analysis_id uuid,
  node_type text,
  raw_text text,
  similarity float
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    n.id,
    n.deal_id,
    n.analysis_id,
    n.node_type,
    n.raw_text,
    1 - (n.embedding <=> p_query_embedding) AS similarity
  FROM deal_context_nodes n
  INNER JOIN deals d ON d.id = n.deal_id
  WHERE d.user_id = p_user_id
    AND n.embedding IS NOT NULL
    AND (
      p_deal_ids IS NULL
      OR cardinality(p_deal_ids) = 0
      OR n.deal_id = ANY (p_deal_ids)
    )
  ORDER BY n.embedding <=> p_query_embedding
  LIMIT greatest(1, least(p_match_count, 100));
$$;

GRANT EXECUTE ON FUNCTION public.match_deal_context_nodes_fts(uuid, text, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.match_deal_context_nodes_in_deals(uuid, vector(768), uuid[], int) TO authenticated, service_role;
