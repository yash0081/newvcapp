-- Hybrid context retrieval for deal_intel.deal_tree_node (vector + FTS), mirroring public.match_deal_tree_nodes_*.
-- Used by the app for chat / research RRF over the deal-intel tree.

CREATE OR REPLACE FUNCTION public.deal_intel_match_deal_tree_nodes_fts(
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
  rank double precision
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = deal_intel, public, extensions
AS $$
  SELECT
    n.id,
    n.deal_id,
    NULL::uuid AS analysis_id,
    n.node_type,
    n.narrative_text,
    ts_rank_cd(n.search_document, plainto_tsquery('english', p_query))::double precision AS rank
  FROM deal_intel.deal_tree_node n
  INNER JOIN deal_intel.deal d ON d.id = n.deal_id
  WHERE d.user_id = p_user_id
    AND length(trim(p_query)) >= 2
    AND n.search_document @@ plainto_tsquery('english', p_query)
  ORDER BY rank DESC NULLS LAST
  LIMIT greatest(1, least(p_match_count, 200));
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_match_deal_tree_nodes_vector(
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
  similarity double precision
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = deal_intel, public, extensions
AS $$
  SELECT
    n.id,
    n.deal_id,
    NULL::uuid AS analysis_id,
    n.node_type,
    n.narrative_text,
    (1 - (coalesce(n.signal_embedding, n.atomic_embedding) <=> p_query_embedding))::double precision AS similarity
  FROM deal_intel.deal_tree_node n
  INNER JOIN deal_intel.deal d ON d.id = n.deal_id
  WHERE d.user_id = p_user_id
    AND coalesce(n.signal_embedding, n.atomic_embedding) IS NOT NULL
    AND (
      p_deal_ids IS NULL
      OR cardinality(p_deal_ids) = 0
      OR n.deal_id = ANY (p_deal_ids)
    )
  ORDER BY coalesce(n.signal_embedding, n.atomic_embedding) <=> p_query_embedding
  LIMIT greatest(1, least(p_match_count, 200));
$$;

GRANT EXECUTE ON FUNCTION public.deal_intel_match_deal_tree_nodes_fts(uuid, text, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_match_deal_tree_nodes_vector(uuid, vector(768), uuid[], int) TO authenticated, service_role;
