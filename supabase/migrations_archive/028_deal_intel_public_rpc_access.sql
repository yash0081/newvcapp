-- Public SECURITY DEFINER RPCs for deal_intel access without exposing deal_intel schema.
-- These are intended for server-side application access patterns.

CREATE OR REPLACE FUNCTION public.deal_intel_create_deal_with_revision(
  p_user_id uuid,
  p_deal_metadata jsonb DEFAULT '{}'::jsonb,
  p_revision_label text DEFAULT 'ingest:placeholder_layer1',
  p_revision_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (deal_id uuid, revision_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
DECLARE
  v_deal_id uuid;
  v_revision_id uuid;
BEGIN
  INSERT INTO deal_intel.deal(user_id, metadata)
  VALUES (p_user_id, coalesce(p_deal_metadata, '{}'::jsonb))
  RETURNING id INTO v_deal_id;

  INSERT INTO deal_intel.deal_revision(deal_id, label, metadata)
  VALUES (v_deal_id, coalesce(p_revision_label, 'ingest:placeholder_layer1'), coalesce(p_revision_metadata, '{}'::jsonb))
  RETURNING id INTO v_revision_id;

  RETURN QUERY SELECT v_deal_id, v_revision_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_delete_deal(
  p_deal_id uuid
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
  DELETE FROM deal_intel.deal WHERE id = p_deal_id;
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_insert_fact_nodes(
  p_rows jsonb
)
RETURNS TABLE (id uuid, path text, parent_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
BEGIN
  RETURN QUERY
  WITH rows AS (
    SELECT
      (r->>'deal_id')::uuid AS deal_id,
      NULLIF(r->>'parent_id', '')::uuid AS parent_id,
      r->>'path' AS path,
      coalesce((r->>'depth')::int, 0) AS depth,
      coalesce((r->>'sort_key')::int, 0) AS sort_key,
      r->>'value_text' AS value_text,
      CASE WHEN r ? 'value_jsonb' THEN r->'value_jsonb' ELSE NULL END AS value_jsonb,
      coalesce(r->'source_map', '{}'::jsonb) AS source_map
    FROM jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  )
  INSERT INTO deal_intel.deal_fact_node(
    deal_id, parent_id, path, depth, sort_key, value_text, value_jsonb, source_map
  )
  SELECT
    rw.deal_id,
    rw.parent_id,
    rw.path,
    rw.depth,
    rw.sort_key,
    rw.value_text,
    rw.value_jsonb,
    rw.source_map
  FROM rows rw
  RETURNING deal_fact_node.id, deal_fact_node.path, deal_fact_node.parent_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_insert_fact_edges(
  p_rows jsonb
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
  INSERT INTO deal_intel.deal_fact_edge(deal_id, src_node_id, dst_node_id, edge_kind, weight, metadata)
  SELECT
    (r->>'deal_id')::uuid,
    (r->>'src_node_id')::uuid,
    (r->>'dst_node_id')::uuid,
    coalesce(r->>'edge_kind', 'tree'),
    coalesce((r->>'weight')::double precision, 1.0),
    coalesce(r->'metadata', '{}'::jsonb)
  FROM jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r;
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_get_deal_metadata(
  p_deal_id uuid
)
RETURNS TABLE (id uuid, metadata jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
  SELECT d.id, d.metadata
  FROM deal_intel.deal d
  WHERE d.id = p_deal_id;
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_get_fact_nodes(
  p_deal_id uuid
)
RETURNS TABLE (
  id uuid,
  path text,
  sort_key int,
  value_text text,
  value_jsonb jsonb,
  parent_id uuid,
  depth int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
  SELECT n.id, n.path, n.sort_key, n.value_text, n.value_jsonb, n.parent_id, n.depth
  FROM deal_intel.deal_fact_node n
  WHERE n.deal_id = p_deal_id
  ORDER BY n.sort_key ASC;
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_update_fact_node_enrichment(
  p_node_id uuid,
  p_embedding_input text,
  p_embedding_model text,
  p_content_embedding vector(768),
  p_keywords text[]
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
  UPDATE deal_intel.deal_fact_node
  SET
    embedding_input = p_embedding_input,
    embedding_model = p_embedding_model,
    content_embedding = p_content_embedding,
    keywords = coalesce(p_keywords, '{}'::text[])
  WHERE id = p_node_id;
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_reset_tree(
  p_deal_id uuid
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
  DELETE FROM deal_intel.deal_tree_edge WHERE deal_id = p_deal_id;
  DELETE FROM deal_intel.deal_tree_node WHERE deal_id = p_deal_id;
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_insert_tree_node(
  p_node jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO deal_intel.deal_tree_node(
    deal_id, revision_id, parent_id, kind, node_type, fact_section_root_id, node_path, node_key,
    node_value_text, narrative_text, centroid_embedding, narrative_embedding, signal_embedding,
    anchor_embedding, drift_embedding, atomic_embedding, edge_weight_to_parent, node_weight,
    use_for_global_similarity, keywords, source_map, value_jsonb
  )
  VALUES (
    (p_node->>'deal_id')::uuid,
    NULLIF(p_node->>'revision_id', '')::uuid,
    NULLIF(p_node->>'parent_id', '')::uuid,
    p_node->>'kind',
    p_node->>'node_type',
    NULLIF(p_node->>'fact_section_root_id', '')::uuid,
    p_node->>'node_path',
    p_node->>'node_key',
    p_node->>'node_value_text',
    p_node->>'narrative_text',
    CASE WHEN p_node ? 'centroid_embedding' THEN (p_node->>'centroid_embedding')::vector(768) ELSE NULL END,
    CASE WHEN p_node ? 'narrative_embedding' THEN (p_node->>'narrative_embedding')::vector(768) ELSE NULL END,
    CASE WHEN p_node ? 'signal_embedding' THEN (p_node->>'signal_embedding')::vector(768) ELSE NULL END,
    CASE WHEN p_node ? 'anchor_embedding' THEN (p_node->>'anchor_embedding')::vector(768) ELSE NULL END,
    CASE WHEN p_node ? 'drift_embedding' THEN (p_node->>'drift_embedding')::vector(768) ELSE NULL END,
    CASE WHEN p_node ? 'atomic_embedding' THEN (p_node->>'atomic_embedding')::vector(768) ELSE NULL END,
    coalesce((p_node->>'edge_weight_to_parent')::double precision, 1.0),
    coalesce((p_node->>'node_weight')::double precision, 1.0),
    coalesce((p_node->>'use_for_global_similarity')::boolean, true),
    coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(p_node->'keywords','[]'::jsonb))), '{}'::text[]),
    coalesce(p_node->'source_map', '{}'::jsonb),
    CASE WHEN p_node ? 'value_jsonb' THEN p_node->'value_jsonb' ELSE NULL END
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_update_tree_node_patch(
  p_id uuid,
  p_patch jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
BEGIN
  UPDATE deal_intel.deal_tree_node n
  SET
    centroid_embedding = CASE WHEN p_patch ? 'centroid_embedding' THEN (p_patch->>'centroid_embedding')::vector(768) ELSE n.centroid_embedding END,
    narrative_embedding = CASE WHEN p_patch ? 'narrative_embedding' THEN (p_patch->>'narrative_embedding')::vector(768) ELSE n.narrative_embedding END,
    signal_embedding = CASE WHEN p_patch ? 'signal_embedding' THEN (p_patch->>'signal_embedding')::vector(768) ELSE n.signal_embedding END,
    anchor_embedding = CASE WHEN p_patch ? 'anchor_embedding' THEN (p_patch->>'anchor_embedding')::vector(768) ELSE n.anchor_embedding END,
    drift_embedding = CASE WHEN p_patch ? 'drift_embedding' THEN (p_patch->>'drift_embedding')::vector(768) ELSE n.drift_embedding END,
    atomic_embedding = CASE WHEN p_patch ? 'atomic_embedding' THEN (p_patch->>'atomic_embedding')::vector(768) ELSE n.atomic_embedding END,
    keywords = CASE WHEN p_patch ? 'keywords' THEN ARRAY(SELECT jsonb_array_elements_text(coalesce(p_patch->'keywords','[]'::jsonb))) ELSE n.keywords END,
    source_map = CASE WHEN p_patch ? 'source_map' THEN coalesce(p_patch->'source_map', '{}'::jsonb) ELSE n.source_map END
  WHERE n.id = p_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_insert_tree_edge(
  p_edge jsonb
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
  INSERT INTO deal_intel.deal_tree_edge(deal_id, src_node_id, dst_node_id, edge_kind, weight, metadata)
  VALUES (
    (p_edge->>'deal_id')::uuid,
    (p_edge->>'src_node_id')::uuid,
    (p_edge->>'dst_node_id')::uuid,
    coalesce(p_edge->>'edge_kind', 'tree'),
    coalesce((p_edge->>'weight')::double precision, 1.0),
    coalesce(p_edge->'metadata', '{}'::jsonb)
  );
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_get_tree_nodes(
  p_deal_id uuid
)
RETURNS TABLE (
  id uuid,
  deal_id uuid,
  parent_id uuid,
  kind text,
  node_type text,
  node_path text,
  node_key text,
  node_value_text text,
  narrative_text text,
  centroid_embedding vector(768),
  narrative_embedding vector(768),
  signal_embedding vector(768),
  anchor_embedding vector(768),
  drift_embedding vector(768),
  atomic_embedding vector(768),
  node_weight double precision,
  use_for_global_similarity boolean,
  keywords text[],
  source_map jsonb,
  value_jsonb jsonb,
  created_at timestamptz,
  revision_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
  SELECT
    n.id, n.deal_id, n.parent_id, n.kind, n.node_type, n.node_path, n.node_key, n.node_value_text, n.narrative_text,
    n.centroid_embedding, n.narrative_embedding, n.signal_embedding, n.anchor_embedding, n.drift_embedding, n.atomic_embedding,
    n.node_weight, n.use_for_global_similarity, n.keywords, n.source_map, n.value_jsonb, n.created_at, n.revision_id
  FROM deal_intel.deal_tree_node n
  WHERE n.deal_id = p_deal_id
  ORDER BY n.created_at ASC;
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_get_tree_children(
  p_deal_id uuid,
  p_parent_id uuid
)
RETURNS TABLE (
  id uuid,
  kind text,
  atomic_embedding vector(768),
  node_weight double precision,
  keywords text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
  SELECT n.id, n.kind, n.atomic_embedding, n.node_weight, n.keywords
  FROM deal_intel.deal_tree_node n
  WHERE n.deal_id = p_deal_id
    AND n.parent_id = p_parent_id;
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_get_latest_root(
  p_deal_id uuid
)
RETURNS TABLE (id uuid, revision_id uuid, centroid_embedding vector(768))
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
  SELECT n.id, n.revision_id, n.centroid_embedding
  FROM deal_intel.deal_tree_node n
  WHERE n.deal_id = p_deal_id
    AND n.kind = 'root'
  ORDER BY n.created_at DESC
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_upsert_keyword_term(
  p_normalized_text text,
  p_raw_text text,
  p_fixed_token_count int,
  p_embedding vector(768),
  p_embedding_model text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO deal_intel.keyword_term(normalized_text, raw_text, fixed_token_count, embedding, embedding_model)
  VALUES (p_normalized_text, p_raw_text, p_fixed_token_count, p_embedding, p_embedding_model)
  ON CONFLICT (normalized_text)
  DO UPDATE SET
    raw_text = EXCLUDED.raw_text,
    fixed_token_count = EXCLUDED.fixed_token_count,
    embedding = EXCLUDED.embedding,
    embedding_model = EXCLUDED.embedding_model
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_get_keyword_terms(
  p_normalized_texts text[]
)
RETURNS TABLE (id uuid, normalized_text text, embedding vector(768))
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
  SELECT t.id, t.normalized_text, t.embedding
  FROM deal_intel.keyword_term t
  WHERE t.normalized_text = ANY (coalesce(p_normalized_texts, '{}'::text[]));
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_get_keyword_memberships(
  p_term_ids uuid[]
)
RETURNS TABLE (term_id uuid, cluster_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
  SELECT m.term_id, m.cluster_id
  FROM deal_intel.keyword_term_cluster_membership m
  WHERE m.term_id = ANY (coalesce(p_term_ids, '{}'::uuid[]));
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_insert_keyword_cluster(
  p_representative_term_id uuid,
  p_cluster_embedding vector(768),
  p_produced_by text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO deal_intel.keyword_cluster(representative_term_id, cluster_embedding, produced_by, metadata)
  VALUES (p_representative_term_id, p_cluster_embedding, p_produced_by, coalesce(p_metadata, '{}'::jsonb))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_update_keyword_cluster_embedding(
  p_cluster_id uuid,
  p_cluster_embedding vector(768)
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
  UPDATE deal_intel.keyword_cluster
  SET cluster_embedding = p_cluster_embedding
  WHERE id = p_cluster_id;
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_upsert_keyword_membership(
  p_term_id uuid,
  p_cluster_id uuid,
  p_weight double precision DEFAULT 1.0
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
  INSERT INTO deal_intel.keyword_term_cluster_membership(term_id, cluster_id, weight)
  VALUES (p_term_id, p_cluster_id, coalesce(p_weight, 1.0))
  ON CONFLICT (term_id)
  DO UPDATE SET cluster_id = EXCLUDED.cluster_id, weight = EXCLUDED.weight;
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_list_keyword_clusters()
RETURNS TABLE (id uuid, representative_term_id uuid, cluster_embedding vector(768), created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
  SELECT c.id, c.representative_term_id, c.cluster_embedding, c.created_at
  FROM deal_intel.keyword_cluster c
  ORDER BY c.created_at ASC;
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_update_keyword_memberships_cluster(
  p_from_cluster_id uuid,
  p_to_cluster_id uuid
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
  UPDATE deal_intel.keyword_term_cluster_membership
  SET cluster_id = p_to_cluster_id
  WHERE cluster_id = p_from_cluster_id;
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_delete_keyword_cluster(
  p_cluster_id uuid
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
  DELETE FROM deal_intel.keyword_cluster WHERE id = p_cluster_id;
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_list_deal_ids(
  p_deal_id uuid DEFAULT NULL,
  p_limit int DEFAULT 5000
)
RETURNS TABLE (id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
  SELECT d.id
  FROM deal_intel.deal d
  WHERE (p_deal_id IS NULL OR d.id = p_deal_id)
  ORDER BY d.created_at DESC
  LIMIT greatest(1, least(coalesce(p_limit, 5000), 20000));
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_list_deals_for_user(
  p_user_id uuid,
  p_exclude_deal_id uuid DEFAULT NULL,
  p_limit int DEFAULT 1500
)
RETURNS TABLE (id uuid, metadata jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
  SELECT d.id, d.metadata
  FROM deal_intel.deal d
  WHERE d.user_id = p_user_id
    AND (p_exclude_deal_id IS NULL OR d.id <> p_exclude_deal_id)
  ORDER BY d.created_at DESC
  LIMIT greatest(1, least(coalesce(p_limit, 1500), 5000));
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_get_deals_by_ids(
  p_deal_ids uuid[]
)
RETURNS TABLE (id uuid, metadata jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
  SELECT d.id, d.metadata
  FROM deal_intel.deal d
  WHERE d.id = ANY (coalesce(p_deal_ids, '{}'::uuid[]));
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_get_tree_nodes_by_ids(
  p_node_ids uuid[]
)
RETURNS TABLE (
  id uuid,
  deal_id uuid,
  parent_id uuid,
  node_type text,
  narrative_text text,
  atomic_embedding vector(768),
  signal_embedding vector(768),
  node_weight double precision,
  keywords text[],
  value_jsonb jsonb,
  source_map jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
  SELECT
    n.id, n.deal_id, n.parent_id, n.node_type, n.narrative_text,
    n.atomic_embedding, n.signal_embedding, n.node_weight, n.keywords, n.value_jsonb, n.source_map
  FROM deal_intel.deal_tree_node n
  WHERE n.id = ANY (coalesce(p_node_ids, '{}'::uuid[]));
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_get_tree_nodes_for_similarity(
  p_deal_ids uuid[]
)
RETURNS TABLE (deal_id uuid, kind text, node_type text, signal_embedding vector(768))
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
  SELECT n.deal_id, n.kind, n.node_type, n.signal_embedding
  FROM deal_intel.deal_tree_node n
  WHERE n.deal_id = ANY (coalesce(p_deal_ids, '{}'::uuid[]))
    AND n.signal_embedding IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_get_tree_children_by_parent_ids(
  p_parent_ids uuid[]
)
RETURNS TABLE (
  id uuid,
  parent_id uuid,
  atomic_embedding vector(768),
  signal_embedding vector(768),
  node_weight double precision,
  narrative_text text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
  SELECT n.id, n.parent_id, n.atomic_embedding, n.signal_embedding, n.node_weight, n.narrative_text
  FROM deal_intel.deal_tree_node n
  WHERE n.parent_id = ANY (coalesce(p_parent_ids, '{}'::uuid[]));
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_get_fact_nodes_for_view(
  p_deal_id uuid
)
RETURNS TABLE (
  path text,
  depth int,
  value_text text,
  value_jsonb jsonb,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
  SELECT n.path, n.depth, n.value_text, n.value_jsonb, n.created_at
  FROM deal_intel.deal_fact_node n
  WHERE n.deal_id = p_deal_id
  ORDER BY n.path ASC;
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_parity_counts(
  p_deal_id uuid
)
RETURNS TABLE (
  facts bigint,
  fact_edges bigint,
  tree_nodes bigint,
  tree_edges bigint,
  fact_embedded bigint,
  root_nodes bigint,
  negatives_children bigint,
  anchor_filled bigint,
  persona_nodes bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = deal_intel, public, extensions
AS $$
  SELECT
    (SELECT count(*) FROM deal_intel.deal_fact_node n WHERE n.deal_id = p_deal_id) AS facts,
    (SELECT count(*) FROM deal_intel.deal_fact_edge e WHERE e.deal_id = p_deal_id) AS fact_edges,
    (SELECT count(*) FROM deal_intel.deal_tree_node n WHERE n.deal_id = p_deal_id) AS tree_nodes,
    (SELECT count(*) FROM deal_intel.deal_tree_edge e WHERE e.deal_id = p_deal_id) AS tree_edges,
    (SELECT count(*) FROM deal_intel.deal_fact_node n WHERE n.deal_id = p_deal_id AND n.content_embedding IS NOT NULL) AS fact_embedded,
    (SELECT count(*) FROM deal_intel.deal_tree_node n WHERE n.deal_id = p_deal_id AND n.kind = 'root') AS root_nodes,
    (SELECT count(*) FROM deal_intel.deal_tree_node n WHERE n.deal_id = p_deal_id AND n.kind = 'child' AND n.node_type = 'negatives') AS negatives_children,
    (SELECT count(*) FROM deal_intel.deal_tree_node n WHERE n.deal_id = p_deal_id AND n.kind = 'child' AND n.anchor_embedding IS NOT NULL) AS anchor_filled,
    (SELECT count(*) FROM deal_intel.deal_tree_node n WHERE n.deal_id = p_deal_id AND n.kind = 'persona_subchild') AS persona_nodes;
$$;

GRANT EXECUTE ON FUNCTION public.deal_intel_create_deal_with_revision(uuid, jsonb, text, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_delete_deal(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_insert_fact_nodes(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_insert_fact_edges(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_get_deal_metadata(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_get_fact_nodes(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_update_fact_node_enrichment(uuid, text, text, vector(768), text[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_reset_tree(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_insert_tree_node(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_update_tree_node_patch(uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_insert_tree_edge(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_get_tree_nodes(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_get_tree_children(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_get_latest_root(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_upsert_keyword_term(text, text, int, vector(768), text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_get_keyword_terms(text[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_get_keyword_memberships(uuid[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_insert_keyword_cluster(uuid, vector(768), text, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_update_keyword_cluster_embedding(uuid, vector(768)) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_upsert_keyword_membership(uuid, uuid, double precision) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_list_keyword_clusters() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_update_keyword_memberships_cluster(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_delete_keyword_cluster(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_list_deal_ids(uuid, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_list_deals_for_user(uuid, uuid, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_get_deals_by_ids(uuid[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_get_tree_nodes_by_ids(uuid[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_get_tree_nodes_for_similarity(uuid[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_get_tree_children_by_parent_ids(uuid[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_get_fact_nodes_for_view(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_parity_counts(uuid) TO authenticated, service_role;

