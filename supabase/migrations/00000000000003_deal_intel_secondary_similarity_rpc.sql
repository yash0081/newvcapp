-- deal_intel: secondary similarity scoring (optional re-rank)
-- Fast path uses root centroid + BM25+RRF. This RPC re-ranks top candidates using
-- whatever child embeddings are already computed (without requiring them).

CREATE OR REPLACE FUNCTION deal_intel.match_similar_deals_secondary(
  p_user_id uuid,
  p_query_embedding extensions.vector,
  p_candidate_deal_ids uuid[],
  p_match_count int DEFAULT 50
) RETURNS TABLE(
  deal_id uuid,
  score double precision
)
LANGUAGE sql
STABLE
SET search_path TO 'deal_intel','public','extensions'
AS $$
  WITH candidates AS (
    SELECT unnest(p_candidate_deal_ids) AS deal_id
  ),
  roots AS (
    SELECT n.deal_id, n.centroid_embedding
    FROM deal_intel.deal_tree_node n
    INNER JOIN candidates c ON c.deal_id = n.deal_id
    INNER JOIN deal_intel.deal d ON d.id = n.deal_id
    WHERE d.user_id = p_user_id
      AND n.kind = 'root'
      AND n.centroid_embedding IS NOT NULL
  ),
  child_centroids AS (
    -- If child narrative embeddings exist, incorporate them lightly.
    SELECT n.deal_id,
           avg(1 - (n.narrative_embedding <=> p_query_embedding)) AS child_sim
    FROM deal_intel.deal_tree_node n
    INNER JOIN candidates c ON c.deal_id = n.deal_id
    INNER JOIN deal_intel.deal d ON d.id = n.deal_id
    WHERE d.user_id = p_user_id
      AND n.kind = 'child'
      AND n.narrative_embedding IS NOT NULL
    GROUP BY n.deal_id
  )
  SELECT
    r.deal_id,
    (1 - (r.centroid_embedding <=> p_query_embedding)) * 0.85
      + coalesce(cc.child_sim, 0) * 0.15 AS score
  FROM roots r
  LEFT JOIN child_centroids cc ON cc.deal_id = r.deal_id
  ORDER BY score DESC
  LIMIT greatest(1, least(p_match_count, 500));
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_match_similar_deals_secondary(
  p_user_id uuid,
  p_query_embedding extensions.vector,
  p_candidate_deal_ids uuid[],
  p_match_count int DEFAULT 50
) RETURNS TABLE(
  deal_id uuid,
  score double precision
)
LANGUAGE sql
STABLE
AS $$
  SELECT * FROM deal_intel.match_similar_deals_secondary(
    p_user_id, p_query_embedding, p_candidate_deal_ids, p_match_count
  );
$$;

GRANT ALL ON FUNCTION deal_intel.match_similar_deals_secondary(uuid, extensions.vector, uuid[], int) TO anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.deal_intel_match_similar_deals_secondary(uuid, extensions.vector, uuid[], int) TO anon, authenticated, service_role;

