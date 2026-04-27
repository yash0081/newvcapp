-- deal_intel: use HNSW to propose keyword cluster merges (avoid O(n^2) JS loops)

CREATE OR REPLACE FUNCTION deal_intel.keyword_cluster_neighbors(
  p_threshold double precision DEFAULT 0.96,
  p_k int DEFAULT 8
) RETURNS TABLE(
  from_cluster_id uuid,
  to_cluster_id uuid,
  similarity double precision
)
LANGUAGE sql
STABLE
SET search_path TO 'deal_intel','public','extensions'
AS $$
  WITH base AS (
    SELECT id, cluster_embedding
    FROM deal_intel.keyword_cluster
    WHERE cluster_embedding IS NOT NULL
  ),
  nn AS (
    SELECT
      b1.id AS from_cluster_id,
      b2.id AS to_cluster_id,
      1 - (b1.cluster_embedding <=> b2.cluster_embedding) AS similarity
    FROM base b1
    JOIN LATERAL (
      SELECT id, cluster_embedding
      FROM base b2
      WHERE b2.id <> b1.id
      ORDER BY b1.cluster_embedding <=> b2.cluster_embedding
      LIMIT greatest(1, least(p_k, 25))
    ) b2 ON true
    WHERE (1 - (b1.cluster_embedding <=> b2.cluster_embedding)) >= p_threshold
  )
  SELECT
    LEAST(from_cluster_id, to_cluster_id) AS from_cluster_id,
    GREATEST(from_cluster_id, to_cluster_id) AS to_cluster_id,
    MAX(similarity) AS similarity
  FROM nn
  GROUP BY 1,2
  ORDER BY similarity DESC;
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_keyword_cluster_neighbors(
  p_threshold double precision DEFAULT 0.96,
  p_k int DEFAULT 8
) RETURNS TABLE(
  from_cluster_id uuid,
  to_cluster_id uuid,
  similarity double precision
)
LANGUAGE sql
STABLE
AS $$
  SELECT * FROM deal_intel.keyword_cluster_neighbors(p_threshold, p_k);
$$;

GRANT ALL ON FUNCTION deal_intel.keyword_cluster_neighbors(double precision, int) TO anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.deal_intel_keyword_cluster_neighbors(double precision, int) TO anon, authenticated, service_role;

