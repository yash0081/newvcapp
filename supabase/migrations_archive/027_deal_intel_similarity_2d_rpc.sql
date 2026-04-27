-- deal_intel: 2D opportunity/risk coordinates for candidate deals.
-- Opportunity: weighted cosine over child signal vectors (problem/solution/market/traction/team).
-- Risk: cosine similarity of negatives child signal vectors.

CREATE OR REPLACE FUNCTION public.deal_intel_match_similarity_2d(
  p_user_id uuid,
  p_source_deal_id uuid,
  p_candidate_deal_ids uuid[]
)
RETURNS TABLE (
  deal_id uuid,
  opportunity_similarity double precision,
  risk_similarity double precision
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = deal_intel, public, extensions
AS $$
  WITH source_children AS (
    SELECT
      n.node_type,
      n.signal_embedding,
      CASE
        WHEN lower(n.node_type) = 'problem' THEN 0.20
        WHEN lower(n.node_type) = 'solution' THEN 0.25
        WHEN lower(n.node_type) = 'market' THEN 0.20
        WHEN lower(n.node_type) = 'traction' THEN 0.15
        WHEN lower(n.node_type) = 'team' THEN 0.10
        ELSE 0.0
      END AS w
    FROM deal_intel.deal_tree_node n
    INNER JOIN deal_intel.deal d ON d.id = n.deal_id
    WHERE d.user_id = p_user_id
      AND n.deal_id = p_source_deal_id
      AND n.kind = 'child'
      AND n.signal_embedding IS NOT NULL
  ),
  source_neg AS (
    SELECT n.signal_embedding AS v
    FROM deal_intel.deal_tree_node n
    INNER JOIN deal_intel.deal d ON d.id = n.deal_id
    WHERE d.user_id = p_user_id
      AND n.deal_id = p_source_deal_id
      AND n.kind = 'child'
      AND lower(n.node_type) = 'negatives'
      AND n.signal_embedding IS NOT NULL
    LIMIT 1
  ),
  cand_children AS (
    SELECT
      n.deal_id,
      lower(n.node_type) AS node_type,
      n.signal_embedding
    FROM deal_intel.deal_tree_node n
    INNER JOIN deal_intel.deal d ON d.id = n.deal_id
    WHERE d.user_id = p_user_id
      AND n.deal_id = ANY (p_candidate_deal_ids)
      AND n.kind = 'child'
      AND n.signal_embedding IS NOT NULL
  ),
  opp AS (
    SELECT
      c.deal_id,
      SUM(s.w * (1 - (c.signal_embedding <=> s.signal_embedding))) / NULLIF(SUM(s.w), 0) AS opportunity_similarity
    FROM cand_children c
    INNER JOIN source_children s ON lower(s.node_type) = c.node_type
    WHERE s.w > 0
    GROUP BY c.deal_id
  ),
  risk AS (
    SELECT
      c.deal_id,
      (1 - (c.signal_embedding <=> sn.v))::double precision AS risk_similarity
    FROM cand_children c
    CROSS JOIN source_neg sn
    WHERE c.node_type = 'negatives'
  )
  SELECT
    o.deal_id,
    COALESCE(o.opportunity_similarity, 0)::double precision AS opportunity_similarity,
    COALESCE(r.risk_similarity, 0)::double precision AS risk_similarity
  FROM opp o
  LEFT JOIN risk r ON r.deal_id = o.deal_id
  ORDER BY opportunity_similarity DESC, risk_similarity DESC;
$$;

GRANT EXECUTE ON FUNCTION public.deal_intel_match_similarity_2d(uuid, uuid, uuid[])
  TO authenticated, service_role;

