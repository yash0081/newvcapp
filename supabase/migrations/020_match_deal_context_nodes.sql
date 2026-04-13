-- Vector search over deal_context_nodes for the retrieval orchestrator (user-scoped).

CREATE OR REPLACE FUNCTION public.match_deal_context_nodes(
  p_user_id uuid,
  p_query_embedding vector(768),
  p_match_count int DEFAULT 20
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
  ORDER BY n.embedding <=> p_query_embedding
  LIMIT greatest(1, least(p_match_count, 100));
$$;
