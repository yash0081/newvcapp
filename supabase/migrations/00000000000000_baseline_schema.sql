


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "deal_intel";


ALTER SCHEMA "deal_intel" OWNER TO "postgres";

CREATE SCHEMA IF NOT EXISTS "extensions";
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA "extensions";
SET search_path = public, extensions;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE TYPE "public"."deal_tree_node_kind" AS ENUM (
    'root',
    'child',
    'sub_child'
);


ALTER TYPE "public"."deal_tree_node_kind" OWNER TO "postgres";


CREATE TYPE "public"."deal_tree_polarity" AS ENUM (
    'positive',
    'negative',
    'neutral'
);


ALTER TYPE "public"."deal_tree_polarity" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "deal_intel"."build_fts_document"("p_value_text" "text", "p_value_jsonb" "jsonb", "p_embedding_input" "text", "p_keywords" "text"[]) RETURNS "tsvector"
    LANGUAGE "sql" STABLE
    AS $$
  SELECT to_tsvector(
    'english',
    coalesce(p_value_text, '') || ' ' ||
    coalesce(p_embedding_input, '') || ' ' ||
    coalesce(array_to_string(coalesce(p_keywords, '{}'::text[]), ' '), '') || ' ' ||
    coalesce(left(p_value_jsonb::text, 8000), '')
  );
$$;


ALTER FUNCTION "deal_intel"."build_fts_document"("p_value_text" "text", "p_value_jsonb" "jsonb", "p_embedding_input" "text", "p_keywords" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "deal_intel"."match_deal_tree_subnodes_vector"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_deal_ids" "uuid"[], "p_include_personas" boolean DEFAULT false, "p_match_count" integer DEFAULT 40) RETURNS TABLE("id" "uuid", "deal_id" "uuid", "node_type" "text", "node_path" "text", "narrative_text" "text", "similarity" double precision)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
    AS $$
  SELECT
    n.id,
    n.deal_id,
    n.node_type,
    n.node_path,
    n.narrative_text,
    1 - (n.atomic_embedding <=> p_query_embedding) AS similarity
  FROM deal_intel.deal_tree_node n
  INNER JOIN deal_intel.deal d ON d.id = n.deal_id
  WHERE d.user_id = p_user_id
    AND n.atomic_embedding IS NOT NULL
    AND n.deal_id = ANY (p_deal_ids)
    AND (
      n.kind = 'sub_child'
      OR (p_include_personas AND n.kind = 'persona_subchild')
    )
  ORDER BY n.atomic_embedding <=> p_query_embedding
  LIMIT greatest(1, least(p_match_count, 200));
$$;


ALTER FUNCTION "deal_intel"."match_deal_tree_subnodes_vector"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_deal_ids" "uuid"[], "p_include_personas" boolean, "p_match_count" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "deal_intel"."match_similar_deals_hybrid"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_query_text" "text", "p_candidate_deal_ids" "uuid"[] DEFAULT NULL::"uuid"[], "p_exclude_deal_id" "uuid" DEFAULT NULL::"uuid", "p_vector_limit" integer DEFAULT 200, "p_fts_limit" integer DEFAULT 200, "p_final_limit" integer DEFAULT 50, "p_rrf_k" integer DEFAULT 60) RETURNS TABLE("deal_id" "uuid", "vector_rank" bigint, "fts_rank" bigint, "rrf_score" double precision)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
    AS $$
  WITH candidates AS (
    SELECT d.id
    FROM deal_intel.deal d
    WHERE d.user_id = p_user_id
      AND (p_exclude_deal_id IS NULL OR d.id <> p_exclude_deal_id)
      AND (
        p_candidate_deal_ids IS NULL
        OR cardinality(p_candidate_deal_ids) = 0
        OR d.id = ANY (p_candidate_deal_ids)
      )
  ),
  roots AS (
    SELECT n.deal_id, n.centroid_embedding, n.search_document
    FROM deal_intel.deal_tree_node n
    INNER JOIN candidates c ON c.id = n.deal_id
    WHERE n.kind = 'root'
      AND n.centroid_embedding IS NOT NULL
  ),
  vector_results AS (
    SELECT r.deal_id,
           ROW_NUMBER() OVER (ORDER BY r.centroid_embedding <=> p_query_embedding) AS rank
    FROM roots r
    ORDER BY r.centroid_embedding <=> p_query_embedding
    LIMIT greatest(1, least(p_vector_limit, 500))
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
    LIMIT greatest(1, least(p_fts_limit, 500))
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
    m.vr::bigint AS vector_rank,
    m.fr::bigint AS fts_rank,
    (
      coalesce(1.0 / (p_rrf_k::double precision + m.vr::double precision), 0.0)
      + coalesce(1.0 / (p_rrf_k::double precision + m.fr::double precision), 0.0)
    ) AS rrf_score
  FROM merged m
  ORDER BY rrf_score DESC NULLS LAST
  LIMIT greatest(1, least(p_final_limit, 500));
$$;


ALTER FUNCTION "deal_intel"."match_similar_deals_hybrid"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_query_text" "text", "p_candidate_deal_ids" "uuid"[], "p_exclude_deal_id" "uuid", "p_vector_limit" integer, "p_fts_limit" integer, "p_final_limit" integer, "p_rrf_k" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "deal_intel"."set_claim_search_document"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.search_document := to_tsvector('english', coalesce(NEW.quote, '') || ' ' || coalesce(NEW.key, '') || ' ' || coalesce(NEW.claim_type, ''));
  RETURN NEW;
END;
$$;


ALTER FUNCTION "deal_intel"."set_claim_search_document"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "deal_intel"."set_deal_fact_node_search_document"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.search_document := deal_intel.build_fts_document(
    NEW.value_text,
    NEW.value_jsonb,
    NEW.embedding_input,
    NEW.keywords
  );
  RETURN NEW;
END;
$$;


ALTER FUNCTION "deal_intel"."set_deal_fact_node_search_document"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "deal_intel"."set_deal_tree_node_search_document"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.search_document := deal_intel.build_fts_document(
    NEW.narrative_text,
    NEW.value_jsonb,
    NEW.node_path,
    NEW.keywords
  );
  RETURN NEW;
END;
$$;


ALTER FUNCTION "deal_intel"."set_deal_tree_node_search_document"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "deal_intel"."set_document_chunk_search_document"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.search_document := to_tsvector('english', coalesce(NEW.text, '') || ' ' || coalesce(array_to_string(NEW.keywords, ' '), ''));
  RETURN NEW;
END;
$$;


ALTER FUNCTION "deal_intel"."set_document_chunk_search_document"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "deal_intel"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "deal_intel"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "deal_intel"."user_can_access_meeting"("p_meeting_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'deal_intel', 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM deal_intel.meeting_session ms
    JOIN deal_intel.deal d ON d.id = ms.deal_id
    WHERE ms.id = p_meeting_id
      AND d.user_id = auth.uid()
  );
$$;


ALTER FUNCTION "deal_intel"."user_can_access_meeting"("p_meeting_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "deal_intel"."user_can_access_research_workflow"("p_workflow_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'deal_intel', 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM deal_intel.deal_research_workflow rw
    JOIN deal_intel.deal d ON d.id = rw.deal_id
    WHERE rw.id = p_workflow_id
      AND d.user_id = auth.uid()
  );
$$;


ALTER FUNCTION "deal_intel"."user_can_access_research_workflow"("p_workflow_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_create_deal_with_revision"("p_user_id" "uuid", "p_deal_metadata" "jsonb" DEFAULT '{}'::"jsonb", "p_revision_label" "text" DEFAULT 'ingest:placeholder_layer1'::"text", "p_revision_metadata" "jsonb" DEFAULT '{}'::"jsonb") RETURNS TABLE("deal_id" "uuid", "revision_id" "uuid")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
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


ALTER FUNCTION "public"."deal_intel_create_deal_with_revision"("p_user_id" "uuid", "p_deal_metadata" "jsonb", "p_revision_label" "text", "p_revision_metadata" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_delete_deal"("p_deal_id" "uuid") RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
    AS $$
  DELETE FROM deal_intel.deal WHERE id = p_deal_id;
$$;


ALTER FUNCTION "public"."deal_intel_delete_deal"("p_deal_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_delete_keyword_cluster"("p_cluster_id" "uuid") RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
    AS $$
  DELETE FROM deal_intel.keyword_cluster WHERE id = p_cluster_id;
$$;


ALTER FUNCTION "public"."deal_intel_delete_keyword_cluster"("p_cluster_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_get_deal_metadata"("p_deal_id" "uuid") RETURNS TABLE("id" "uuid", "metadata" "jsonb")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
    AS $$
  SELECT d.id, d.metadata
  FROM deal_intel.deal d
  WHERE d.id = p_deal_id;
$$;


ALTER FUNCTION "public"."deal_intel_get_deal_metadata"("p_deal_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_get_deals_by_ids"("p_deal_ids" "uuid"[]) RETURNS TABLE("id" "uuid", "metadata" "jsonb")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
    AS $$
  SELECT d.id, d.metadata
  FROM deal_intel.deal d
  WHERE d.id = ANY (coalesce(p_deal_ids, '{}'::uuid[]));
$$;


ALTER FUNCTION "public"."deal_intel_get_deals_by_ids"("p_deal_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_get_fact_nodes"("p_deal_id" "uuid") RETURNS TABLE("id" "uuid", "path" "text", "sort_key" integer, "value_text" "text", "value_jsonb" "jsonb", "parent_id" "uuid", "depth" integer)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
    AS $$
  SELECT n.id, n.path, n.sort_key, n.value_text, n.value_jsonb, n.parent_id, n.depth
  FROM deal_intel.deal_fact_node n
  WHERE n.deal_id = p_deal_id
  ORDER BY n.sort_key ASC;
$$;


ALTER FUNCTION "public"."deal_intel_get_fact_nodes"("p_deal_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_get_fact_nodes_for_view"("p_deal_id" "uuid") RETURNS TABLE("path" "text", "depth" integer, "value_text" "text", "value_jsonb" "jsonb", "created_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
    AS $$
  SELECT n.path, n.depth, n.value_text, n.value_jsonb, n.created_at
  FROM deal_intel.deal_fact_node n
  WHERE n.deal_id = p_deal_id
  ORDER BY n.path ASC;
$$;


ALTER FUNCTION "public"."deal_intel_get_fact_nodes_for_view"("p_deal_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_get_keyword_memberships"("p_term_ids" "uuid"[]) RETURNS TABLE("term_id" "uuid", "cluster_id" "uuid")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
    AS $$
  SELECT m.term_id, m.cluster_id
  FROM deal_intel.keyword_term_cluster_membership m
  WHERE m.term_id = ANY (coalesce(p_term_ids, '{}'::uuid[]));
$$;


ALTER FUNCTION "public"."deal_intel_get_keyword_memberships"("p_term_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_get_keyword_terms"("p_normalized_texts" "text"[]) RETURNS TABLE("id" "uuid", "normalized_text" "text", "embedding" "extensions"."vector")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
    AS $$
  SELECT t.id, t.normalized_text, t.embedding
  FROM deal_intel.keyword_term t
  WHERE t.normalized_text = ANY (coalesce(p_normalized_texts, '{}'::text[]));
$$;


ALTER FUNCTION "public"."deal_intel_get_keyword_terms"("p_normalized_texts" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_get_latest_root"("p_deal_id" "uuid") RETURNS TABLE("id" "uuid", "revision_id" "uuid", "centroid_embedding" "extensions"."vector")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
    AS $$
  SELECT n.id, n.revision_id, n.centroid_embedding
  FROM deal_intel.deal_tree_node n
  WHERE n.deal_id = p_deal_id
    AND n.kind = 'root'
  ORDER BY n.created_at DESC
  LIMIT 1;
$$;


ALTER FUNCTION "public"."deal_intel_get_latest_root"("p_deal_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_get_tree_children"("p_deal_id" "uuid", "p_parent_id" "uuid") RETURNS TABLE("id" "uuid", "kind" "text", "atomic_embedding" "extensions"."vector", "node_weight" double precision, "keywords" "text"[])
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
    AS $$
  SELECT n.id, n.kind, n.atomic_embedding, n.node_weight, n.keywords
  FROM deal_intel.deal_tree_node n
  WHERE n.deal_id = p_deal_id
    AND n.parent_id = p_parent_id;
$$;


ALTER FUNCTION "public"."deal_intel_get_tree_children"("p_deal_id" "uuid", "p_parent_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_get_tree_children_by_parent_ids"("p_parent_ids" "uuid"[]) RETURNS TABLE("id" "uuid", "parent_id" "uuid", "atomic_embedding" "extensions"."vector", "signal_embedding" "extensions"."vector", "node_weight" double precision, "narrative_text" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
    AS $$
  SELECT n.id, n.parent_id, n.atomic_embedding, n.signal_embedding, n.node_weight, n.narrative_text
  FROM deal_intel.deal_tree_node n
  WHERE n.parent_id = ANY (coalesce(p_parent_ids, '{}'::uuid[]));
$$;


ALTER FUNCTION "public"."deal_intel_get_tree_children_by_parent_ids"("p_parent_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_get_tree_nodes"("p_deal_id" "uuid") RETURNS TABLE("id" "uuid", "deal_id" "uuid", "parent_id" "uuid", "kind" "text", "node_type" "text", "node_path" "text", "node_key" "text", "node_value_text" "text", "narrative_text" "text", "centroid_embedding" "extensions"."vector", "narrative_embedding" "extensions"."vector", "signal_embedding" "extensions"."vector", "anchor_embedding" "extensions"."vector", "drift_embedding" "extensions"."vector", "atomic_embedding" "extensions"."vector", "node_weight" double precision, "use_for_global_similarity" boolean, "keywords" "text"[], "source_map" "jsonb", "value_jsonb" "jsonb", "created_at" timestamp with time zone, "revision_id" "uuid")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
    AS $$
  SELECT
    n.id, n.deal_id, n.parent_id, n.kind, n.node_type, n.node_path, n.node_key, n.node_value_text, n.narrative_text,
    n.centroid_embedding, n.narrative_embedding, n.signal_embedding, n.anchor_embedding, n.drift_embedding, n.atomic_embedding,
    n.node_weight, n.use_for_global_similarity, n.keywords, n.source_map, n.value_jsonb, n.created_at, n.revision_id
  FROM deal_intel.deal_tree_node n
  WHERE n.deal_id = p_deal_id
  ORDER BY n.created_at ASC;
$$;


ALTER FUNCTION "public"."deal_intel_get_tree_nodes"("p_deal_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_get_tree_nodes_by_ids"("p_node_ids" "uuid"[]) RETURNS TABLE("id" "uuid", "deal_id" "uuid", "parent_id" "uuid", "node_type" "text", "narrative_text" "text", "atomic_embedding" "extensions"."vector", "signal_embedding" "extensions"."vector", "node_weight" double precision, "keywords" "text"[], "value_jsonb" "jsonb", "source_map" "jsonb")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
    AS $$
  SELECT
    n.id, n.deal_id, n.parent_id, n.node_type, n.narrative_text,
    n.atomic_embedding, n.signal_embedding, n.node_weight, n.keywords, n.value_jsonb, n.source_map
  FROM deal_intel.deal_tree_node n
  WHERE n.id = ANY (coalesce(p_node_ids, '{}'::uuid[]));
$$;


ALTER FUNCTION "public"."deal_intel_get_tree_nodes_by_ids"("p_node_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_get_tree_nodes_for_similarity"("p_deal_ids" "uuid"[]) RETURNS TABLE("deal_id" "uuid", "kind" "text", "node_type" "text", "signal_embedding" "extensions"."vector")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
    AS $$
  SELECT n.deal_id, n.kind, n.node_type, n.signal_embedding
  FROM deal_intel.deal_tree_node n
  WHERE n.deal_id = ANY (coalesce(p_deal_ids, '{}'::uuid[]))
    AND n.signal_embedding IS NOT NULL;
$$;


ALTER FUNCTION "public"."deal_intel_get_tree_nodes_for_similarity"("p_deal_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_insert_fact_edges"("p_rows" "jsonb") RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
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


ALTER FUNCTION "public"."deal_intel_insert_fact_edges"("p_rows" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_insert_fact_nodes"("p_rows" "jsonb") RETURNS TABLE("id" "uuid", "path" "text", "parent_id" "uuid")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
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


ALTER FUNCTION "public"."deal_intel_insert_fact_nodes"("p_rows" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_insert_keyword_cluster"("p_representative_term_id" "uuid", "p_cluster_embedding" "extensions"."vector", "p_produced_by" "text", "p_metadata" "jsonb" DEFAULT '{}'::"jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
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


ALTER FUNCTION "public"."deal_intel_insert_keyword_cluster"("p_representative_term_id" "uuid", "p_cluster_embedding" "extensions"."vector", "p_produced_by" "text", "p_metadata" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_insert_tree_edge"("p_edge" "jsonb") RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
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


ALTER FUNCTION "public"."deal_intel_insert_tree_edge"("p_edge" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_insert_tree_node"("p_node" "jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
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


ALTER FUNCTION "public"."deal_intel_insert_tree_node"("p_node" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_list_deal_ids"("p_deal_id" "uuid" DEFAULT NULL::"uuid", "p_limit" integer DEFAULT 5000) RETURNS TABLE("id" "uuid")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
    AS $$
  SELECT d.id
  FROM deal_intel.deal d
  WHERE (p_deal_id IS NULL OR d.id = p_deal_id)
  ORDER BY d.created_at DESC
  LIMIT greatest(1, least(coalesce(p_limit, 5000), 20000));
$$;


ALTER FUNCTION "public"."deal_intel_list_deal_ids"("p_deal_id" "uuid", "p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_list_deals_for_user"("p_user_id" "uuid", "p_exclude_deal_id" "uuid" DEFAULT NULL::"uuid", "p_limit" integer DEFAULT 1500) RETURNS TABLE("id" "uuid", "metadata" "jsonb")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
    AS $$
  SELECT d.id, d.metadata
  FROM deal_intel.deal d
  WHERE d.user_id = p_user_id
    AND (p_exclude_deal_id IS NULL OR d.id <> p_exclude_deal_id)
  ORDER BY d.created_at DESC
  LIMIT greatest(1, least(coalesce(p_limit, 1500), 5000));
$$;


ALTER FUNCTION "public"."deal_intel_list_deals_for_user"("p_user_id" "uuid", "p_exclude_deal_id" "uuid", "p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_list_keyword_clusters"() RETURNS TABLE("id" "uuid", "representative_term_id" "uuid", "cluster_embedding" "extensions"."vector", "created_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
    AS $$
  SELECT c.id, c.representative_term_id, c.cluster_embedding, c.created_at
  FROM deal_intel.keyword_cluster c
  ORDER BY c.created_at ASC;
$$;


ALTER FUNCTION "public"."deal_intel_list_keyword_clusters"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_match_claims_fts"("p_user_id" "uuid", "p_query" "text", "p_match_count" integer DEFAULT 20, "p_deal_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("id" "uuid", "document_id" "uuid", "page_number" integer, "sentence_id" "uuid", "quote" "text", "claim_type" "text", "key" "text", "score" double precision)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
    AS $$
  SELECT
    c.id,
    c.document_id,
    c.page_number,
    c.sentence_id,
    c.quote,
    c.claim_type,
    c.key,
    ts_rank_cd(c.search_document, plainto_tsquery('english', p_query)) AS score
  FROM deal_intel.claim c
  WHERE c.user_id = p_user_id
    AND (p_deal_id IS NULL OR c.deal_id = p_deal_id)
    AND c.search_document @@ plainto_tsquery('english', p_query)
  ORDER BY score DESC
  LIMIT greatest(1, least(coalesce(p_match_count, 20), 200));
$$;


ALTER FUNCTION "public"."deal_intel_match_claims_fts"("p_user_id" "uuid", "p_query" "text", "p_match_count" integer, "p_deal_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_match_claims_vector"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_match_count" integer DEFAULT 20, "p_deal_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("id" "uuid", "document_id" "uuid", "page_number" integer, "sentence_id" "uuid", "quote" "text", "claim_type" "text", "key" "text", "similarity" double precision)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
    AS $$
  SELECT
    c.id,
    c.document_id,
    c.page_number,
    c.sentence_id,
    c.quote,
    c.claim_type,
    c.key,
    1 - (c.embedding <=> p_query_embedding) AS similarity
  FROM deal_intel.claim c
  WHERE c.user_id = p_user_id
    AND c.embedding IS NOT NULL
    AND (p_deal_id IS NULL OR c.deal_id = p_deal_id)
  ORDER BY c.embedding <=> p_query_embedding ASC
  LIMIT greatest(1, least(coalesce(p_match_count, 20), 200));
$$;


ALTER FUNCTION "public"."deal_intel_match_claims_vector"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_match_count" integer, "p_deal_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_match_deal_tree_nodes_fts"("p_user_id" "uuid", "p_query" "text", "p_match_count" integer DEFAULT 40) RETURNS TABLE("id" "uuid", "deal_id" "uuid", "analysis_id" "uuid", "node_type" "text", "narrative_text" "text", "rank" double precision)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
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


ALTER FUNCTION "public"."deal_intel_match_deal_tree_nodes_fts"("p_user_id" "uuid", "p_query" "text", "p_match_count" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_match_deal_tree_nodes_vector"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_deal_ids" "uuid"[] DEFAULT NULL::"uuid"[], "p_match_count" integer DEFAULT 40) RETURNS TABLE("id" "uuid", "deal_id" "uuid", "analysis_id" "uuid", "node_type" "text", "narrative_text" "text", "similarity" double precision)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
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


ALTER FUNCTION "public"."deal_intel_match_deal_tree_nodes_vector"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_deal_ids" "uuid"[], "p_match_count" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_match_deal_tree_subnodes_vector"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_deal_ids" "uuid"[], "p_include_personas" boolean DEFAULT false, "p_match_count" integer DEFAULT 40) RETURNS TABLE("id" "uuid", "deal_id" "uuid", "node_type" "text", "node_path" "text", "narrative_text" "text", "similarity" double precision)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
    AS $$
  SELECT * FROM deal_intel.match_deal_tree_subnodes_vector(
    p_user_id,
    p_query_embedding,
    p_deal_ids,
    p_include_personas,
    p_match_count
  );
$$;


ALTER FUNCTION "public"."deal_intel_match_deal_tree_subnodes_vector"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_deal_ids" "uuid"[], "p_include_personas" boolean, "p_match_count" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_match_document_chunks_fts"("p_user_id" "uuid", "p_query" "text", "p_match_count" integer DEFAULT 20, "p_deal_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("id" "uuid", "document_id" "uuid", "page_start" integer, "page_end" integer, "text" "text", "score" double precision)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
    AS $$
  SELECT
    c.id,
    c.document_id,
    c.page_start,
    c.page_end,
    c.text,
    ts_rank_cd(c.search_document, plainto_tsquery('english', p_query)) AS score
  FROM deal_intel.document_chunk c
  JOIN deal_intel.document d ON d.id = c.document_id
  WHERE d.user_id = p_user_id
    AND (p_deal_id IS NULL OR d.deal_id = p_deal_id)
    AND c.search_document @@ plainto_tsquery('english', p_query)
  ORDER BY score DESC
  LIMIT greatest(1, least(coalesce(p_match_count, 20), 200));
$$;


ALTER FUNCTION "public"."deal_intel_match_document_chunks_fts"("p_user_id" "uuid", "p_query" "text", "p_match_count" integer, "p_deal_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_match_document_chunks_vector"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_match_count" integer DEFAULT 20, "p_deal_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("id" "uuid", "document_id" "uuid", "page_start" integer, "page_end" integer, "text" "text", "similarity" double precision)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
    AS $$
  SELECT
    c.id,
    c.document_id,
    c.page_start,
    c.page_end,
    c.text,
    1 - (c.embedding <=> p_query_embedding) AS similarity
  FROM deal_intel.document_chunk c
  JOIN deal_intel.document d ON d.id = c.document_id
  WHERE d.user_id = p_user_id
    AND c.embedding IS NOT NULL
    AND (p_deal_id IS NULL OR d.deal_id = p_deal_id)
  ORDER BY c.embedding <=> p_query_embedding ASC
  LIMIT greatest(1, least(coalesce(p_match_count, 20), 200));
$$;


ALTER FUNCTION "public"."deal_intel_match_document_chunks_vector"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_match_count" integer, "p_deal_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_match_similar_deals_hybrid"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_query_text" "text", "p_candidate_deal_ids" "uuid"[] DEFAULT NULL::"uuid"[], "p_exclude_deal_id" "uuid" DEFAULT NULL::"uuid", "p_vector_limit" integer DEFAULT 200, "p_fts_limit" integer DEFAULT 200, "p_final_limit" integer DEFAULT 50, "p_rrf_k" integer DEFAULT 60) RETURNS TABLE("deal_id" "uuid", "vector_rank" bigint, "fts_rank" bigint, "rrf_score" double precision)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
    AS $$
  SELECT * FROM deal_intel.match_similar_deals_hybrid(
    p_user_id,
    p_query_embedding,
    p_query_text,
    p_candidate_deal_ids,
    p_exclude_deal_id,
    p_vector_limit,
    p_fts_limit,
    p_final_limit,
    p_rrf_k
  );
$$;


ALTER FUNCTION "public"."deal_intel_match_similar_deals_hybrid"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_query_text" "text", "p_candidate_deal_ids" "uuid"[], "p_exclude_deal_id" "uuid", "p_vector_limit" integer, "p_fts_limit" integer, "p_final_limit" integer, "p_rrf_k" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_match_similarity_2d"("p_user_id" "uuid", "p_source_deal_id" "uuid", "p_candidate_deal_ids" "uuid"[]) RETURNS TABLE("deal_id" "uuid", "opportunity_similarity" double precision, "risk_similarity" double precision)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
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


ALTER FUNCTION "public"."deal_intel_match_similarity_2d"("p_user_id" "uuid", "p_source_deal_id" "uuid", "p_candidate_deal_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_parity_counts"("p_deal_id" "uuid") RETURNS TABLE("facts" bigint, "fact_edges" bigint, "tree_nodes" bigint, "tree_edges" bigint, "fact_embedded" bigint, "root_nodes" bigint, "negatives_children" bigint, "anchor_filled" bigint, "persona_nodes" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
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


ALTER FUNCTION "public"."deal_intel_parity_counts"("p_deal_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_reset_tree"("p_deal_id" "uuid") RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
    AS $$
  DELETE FROM deal_intel.deal_tree_edge WHERE deal_id = p_deal_id;
  DELETE FROM deal_intel.deal_tree_node WHERE deal_id = p_deal_id;
$$;


ALTER FUNCTION "public"."deal_intel_reset_tree"("p_deal_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_update_fact_node_enrichment"("p_node_id" "uuid", "p_embedding_input" "text", "p_embedding_model" "text", "p_content_embedding" "extensions"."vector", "p_keywords" "text"[]) RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
    AS $$
  UPDATE deal_intel.deal_fact_node
  SET
    embedding_input = p_embedding_input,
    embedding_model = p_embedding_model,
    content_embedding = p_content_embedding,
    keywords = coalesce(p_keywords, '{}'::text[])
  WHERE id = p_node_id;
$$;


ALTER FUNCTION "public"."deal_intel_update_fact_node_enrichment"("p_node_id" "uuid", "p_embedding_input" "text", "p_embedding_model" "text", "p_content_embedding" "extensions"."vector", "p_keywords" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_update_keyword_cluster_embedding"("p_cluster_id" "uuid", "p_cluster_embedding" "extensions"."vector") RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
    AS $$
  UPDATE deal_intel.keyword_cluster
  SET cluster_embedding = p_cluster_embedding
  WHERE id = p_cluster_id;
$$;


ALTER FUNCTION "public"."deal_intel_update_keyword_cluster_embedding"("p_cluster_id" "uuid", "p_cluster_embedding" "extensions"."vector") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_update_keyword_memberships_cluster"("p_from_cluster_id" "uuid", "p_to_cluster_id" "uuid") RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
    AS $$
  UPDATE deal_intel.keyword_term_cluster_membership
  SET cluster_id = p_to_cluster_id
  WHERE cluster_id = p_from_cluster_id;
$$;


ALTER FUNCTION "public"."deal_intel_update_keyword_memberships_cluster"("p_from_cluster_id" "uuid", "p_to_cluster_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_update_tree_node_patch"("p_id" "uuid", "p_patch" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
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


ALTER FUNCTION "public"."deal_intel_update_tree_node_patch"("p_id" "uuid", "p_patch" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_upsert_keyword_membership"("p_term_id" "uuid", "p_cluster_id" "uuid", "p_weight" double precision DEFAULT 1.0) RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
    AS $$
  INSERT INTO deal_intel.keyword_term_cluster_membership(term_id, cluster_id, weight)
  VALUES (p_term_id, p_cluster_id, coalesce(p_weight, 1.0))
  ON CONFLICT (term_id)
  DO UPDATE SET cluster_id = EXCLUDED.cluster_id, weight = EXCLUDED.weight;
$$;


ALTER FUNCTION "public"."deal_intel_upsert_keyword_membership"("p_term_id" "uuid", "p_cluster_id" "uuid", "p_weight" double precision) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_intel_upsert_keyword_term"("p_normalized_text" "text", "p_raw_text" "text", "p_fixed_token_count" integer, "p_embedding" "extensions"."vector", "p_embedding_model" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'deal_intel', 'public', 'extensions'
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


ALTER FUNCTION "public"."deal_intel_upsert_keyword_term"("p_normalized_text" "text", "p_raw_text" "text", "p_fixed_token_count" integer, "p_embedding" "extensions"."vector", "p_embedding_model" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_deal_context_nodes"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_match_count" integer DEFAULT 20) RETURNS TABLE("id" "uuid", "deal_id" "uuid", "analysis_id" "uuid", "node_type" "text", "raw_text" "text", "similarity" double precision)
    LANGUAGE "sql" STABLE
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


ALTER FUNCTION "public"."match_deal_context_nodes"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_match_count" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_deal_context_nodes_fts"("p_user_id" "uuid", "p_query" "text", "p_match_count" integer DEFAULT 40) RETURNS TABLE("id" "uuid", "deal_id" "uuid", "analysis_id" "uuid", "node_type" "text", "raw_text" "text", "rank" double precision)
    LANGUAGE "sql" STABLE
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


ALTER FUNCTION "public"."match_deal_context_nodes_fts"("p_user_id" "uuid", "p_query" "text", "p_match_count" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_deal_context_nodes_in_deals"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_deal_ids" "uuid"[], "p_match_count" integer DEFAULT 40) RETURNS TABLE("id" "uuid", "deal_id" "uuid", "analysis_id" "uuid", "node_type" "text", "raw_text" "text", "similarity" double precision)
    LANGUAGE "sql" STABLE
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


ALTER FUNCTION "public"."match_deal_context_nodes_in_deals"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_deal_ids" "uuid"[], "p_match_count" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_deal_tree_nodes_fts"("p_user_id" "uuid", "p_query" "text", "p_match_count" integer DEFAULT 40) RETURNS TABLE("id" "uuid", "deal_id" "uuid", "analysis_id" "uuid", "node_type" "text", "narrative_text" "text", "rank" double precision)
    LANGUAGE "sql" STABLE
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


ALTER FUNCTION "public"."match_deal_tree_nodes_fts"("p_user_id" "uuid", "p_query" "text", "p_match_count" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_deal_tree_nodes_vector"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_deal_ids" "uuid"[] DEFAULT NULL::"uuid"[], "p_match_count" integer DEFAULT 40) RETURNS TABLE("id" "uuid", "deal_id" "uuid", "analysis_id" "uuid", "node_type" "text", "narrative_text" "text", "similarity" double precision)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public', 'extensions'
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


ALTER FUNCTION "public"."match_deal_tree_nodes_vector"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_deal_ids" "uuid"[], "p_match_count" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_similar_deals_deal_tree_hybrid"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_query_text" "text", "p_exclude_deal_id" "uuid" DEFAULT NULL::"uuid", "p_vector_limit" integer DEFAULT 60, "p_fts_limit" integer DEFAULT 60, "p_final_limit" integer DEFAULT 20) RETURNS TABLE("deal_id" "uuid", "company_name" "text", "vector_rank" bigint, "fts_rank" bigint, "rrf_score" double precision)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public', 'extensions'
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


ALTER FUNCTION "public"."match_similar_deals_deal_tree_hybrid"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_query_text" "text", "p_exclude_deal_id" "uuid", "p_vector_limit" integer, "p_fts_limit" integer, "p_final_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_similar_deals_from_deal"("p_source_deal_id" "uuid", "p_match_count" integer DEFAULT 15) RETURNS TABLE("id" "uuid", "company_name" "text", "vector_rank" bigint, "fts_rank" bigint, "rrf_score" double precision)
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'public', 'extensions'
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


ALTER FUNCTION "public"."match_similar_deals_from_deal"("p_source_deal_id" "uuid", "p_match_count" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_similar_deals_hybrid"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_query_text" "text", "p_exclude_deal_id" "uuid" DEFAULT NULL::"uuid", "p_vector_limit" integer DEFAULT 40, "p_fts_limit" integer DEFAULT 40, "p_final_limit" integer DEFAULT 15) RETURNS TABLE("id" "uuid", "company_name" "text", "vector_rank" bigint, "fts_rank" bigint, "rrf_score" double precision)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public', 'extensions'
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


ALTER FUNCTION "public"."match_similar_deals_hybrid"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_query_text" "text", "p_exclude_deal_id" "uuid", "p_vector_limit" integer, "p_fts_limit" integer, "p_final_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_deal_keywords_tsv"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.concepts_text := coalesce(array_to_string(NEW.concepts, ' '), '');
  NEW.concepts_tsv := to_tsvector('english', NEW.concepts_text);
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_deal_keywords_tsv"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_deal_tree_nodes_search_document"() RETURNS "trigger"
    LANGUAGE "plpgsql"
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


ALTER FUNCTION "public"."set_deal_tree_nodes_search_document"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "deal_intel"."claim" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "deal_id" "uuid",
    "document_id" "uuid" NOT NULL,
    "page_number" integer,
    "sentence_id" "uuid",
    "quote" "text" NOT NULL,
    "claim_type" "text" NOT NULL,
    "key" "text",
    "value_text" "text",
    "value_number" numeric,
    "value_jsonb" "jsonb",
    "time_start" "date",
    "time_end" "date",
    "confidence" numeric,
    "embedding" "extensions"."vector"(768),
    "embedding_model" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "search_document" "tsvector",
    CONSTRAINT "claim_page_number_check" CHECK (("page_number" >= 1))
);


ALTER TABLE "deal_intel"."claim" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."company_fact" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "fact_path" "text" NOT NULL,
    "canonical_value_text" "text",
    "canonical_value_jsonb" "jsonb",
    "source_claim_id" "uuid",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "company_fact_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'superseded'::"text", 'conflicted'::"text", 'needs_review'::"text"])))
);


ALTER TABLE "deal_intel"."company_fact" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."company_makeup" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "revision_id" "uuid",
    "general_description" "text",
    "general_education_history" "text",
    "general_work_background" "text",
    "company_size" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "deal_intel"."company_makeup" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."company_negative" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "revision_id" "uuid",
    "negative_aspects" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "deal_intel"."company_negative" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."company_origin_story" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "revision_id" "uuid",
    "general_description" "text",
    "cohesion_signals" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "deal_intel"."company_origin_story" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."company_person" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "revision_id" "uuid",
    "person_kind" "text" DEFAULT 'notable_company_person'::"text" NOT NULL,
    "name" "text" NOT NULL,
    "company_role" "text",
    "general_description" "text",
    "age" integer,
    "location" "text",
    "misc" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "education_general_description" "text",
    "education_institutions" "text"[],
    "education_majors" "text"[],
    "education_gpa" "text",
    "experience_general_description" "text",
    "past_companies_worked_at" "text"[],
    "past_companies_founded_or_previous_exits" "text"[],
    "relevant_achievements" "text"[],
    "research" "text"[],
    "patents" "text"[],
    "projects" "text"[],
    CONSTRAINT "company_person_person_kind_check" CHECK (("person_kind" = ANY (ARRAY['founder'::"text", 'team_member'::"text", 'notable_company_person'::"text"])))
);


ALTER TABLE "deal_intel"."company_person" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."company_problem" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "revision_id" "uuid",
    "general_problem_description" "text",
    "urgency" "text",
    "current_cost_for_customers" "text",
    "tam" "text",
    "sam" "text",
    "som" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "all_potential_customers" "text"[],
    "actual_intended_customers_for_solution" "text"[]
);


ALTER TABLE "deal_intel"."company_problem" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."company_solution" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "revision_id" "uuid",
    "general_description" "text",
    "novelty_or_uniqueness" "text",
    "timeline_description" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "who_are_the_customers" "text"[],
    "cost_to_customer_to_buy_product" "text",
    "customer_benefit" "text"[],
    "solution_price_for_company" "text",
    "price_per_customer_build_and_serve" "text",
    "distinguishing_factors" "text"[],
    "defensibility" "text",
    "patent_ip" "text"[],
    "proprietary_tech_or_solution" "text"[],
    "competitors" "jsonb"
);


ALTER TABLE "deal_intel"."company_solution" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."company_traction" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "revision_id" "uuid",
    "revenue_data" "text",
    "company_stage" "text",
    "product_stage" "text",
    "customer_size_and_count" "text",
    "growth_trends_description" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "money_raised_per_stage" "text"[],
    "investor_list" "text"[],
    "notable_partners_or_customors" "text"[],
    "notable_partners_or_customers" "text"[]
);


ALTER TABLE "deal_intel"."company_traction" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."deal" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL
);


ALTER TABLE "deal_intel"."deal" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."deal_fact_edge" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "src_node_id" "uuid" NOT NULL,
    "dst_node_id" "uuid" NOT NULL,
    "edge_kind" "text" NOT NULL,
    "weight" double precision DEFAULT 1.0 NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "deal_intel"."deal_fact_edge" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."deal_fact_node" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "parent_id" "uuid",
    "path" "text" NOT NULL,
    "depth" integer DEFAULT 0 NOT NULL,
    "sort_key" integer DEFAULT 0 NOT NULL,
    "value_text" "text",
    "value_jsonb" "jsonb",
    "content_embedding" "extensions"."vector"(768),
    "embedding_model" "text",
    "embedding_input" "text",
    "edge_weight_to_parent" double precision DEFAULT 1.0 NOT NULL,
    "source_map" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "keywords" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "search_document" "tsvector",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "deal_intel"."deal_fact_node" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."deal_research_feedback" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "workflow_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "action" "text" NOT NULL,
    "rationale" "text",
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "deal_research_feedback_action_check" CHECK (("action" = ANY (ARRAY['accept_update'::"text", 'reject_update'::"text", 'manual_edit'::"text"])))
);


ALTER TABLE "deal_intel"."deal_research_feedback" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."deal_research_step" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "workflow_id" "uuid" NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    "status" "text" DEFAULT 'todo'::"text" NOT NULL,
    "website" "text" NOT NULL,
    "task" "text" NOT NULL,
    "notes" "text",
    "depends_on_step_ids" "uuid"[] DEFAULT '{}'::"uuid"[] NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "deal_research_step_position_check" CHECK (("position" >= 0)),
    CONSTRAINT "deal_research_step_status_check" CHECK (("status" = ANY (ARRAY['todo'::"text", 'blocked'::"text", 'queued'::"text", 'running'::"text", 'done'::"text", 'failed'::"text"])))
);


ALTER TABLE "deal_intel"."deal_research_step" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."deal_research_step_run" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "workflow_id" "uuid" NOT NULL,
    "step_id" "uuid" NOT NULL,
    "run_status" "text" DEFAULT 'done'::"text" NOT NULL,
    "output_notes" "text",
    "sources" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "error_message" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "deal_research_step_run_run_status_check" CHECK (("run_status" = ANY (ARRAY['running'::"text", 'done'::"text", 'failed'::"text"])))
);


ALTER TABLE "deal_intel"."deal_research_step_run" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."deal_research_workflow" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "title" "text" DEFAULT 'Research workflow'::"text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "deal_research_workflow_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'ready'::"text", 'running'::"text", 'done'::"text", 'archived'::"text"])))
);


ALTER TABLE "deal_intel"."deal_research_workflow" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."deal_revision" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "label" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL
);


ALTER TABLE "deal_intel"."deal_revision" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."deal_tree_edge" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "src_node_id" "uuid" NOT NULL,
    "dst_node_id" "uuid" NOT NULL,
    "edge_kind" "text" NOT NULL,
    "weight" double precision DEFAULT 1.0 NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "deal_intel"."deal_tree_edge" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."deal_tree_node" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "revision_id" "uuid",
    "parent_id" "uuid",
    "kind" "text" NOT NULL,
    "node_type" "text" NOT NULL,
    "fact_section_root_id" "uuid",
    "node_path" "text",
    "node_key" "text",
    "node_value_text" "text",
    "narrative_text" "text",
    "centroid_embedding" "extensions"."vector"(768),
    "narrative_embedding" "extensions"."vector"(768),
    "signal_embedding" "extensions"."vector"(768),
    "anchor_embedding" "extensions"."vector"(768),
    "drift_embedding" "extensions"."vector"(768),
    "atomic_embedding" "extensions"."vector"(768),
    "edge_weight_to_parent" double precision DEFAULT 1.0 NOT NULL,
    "node_weight" double precision DEFAULT 1.0 NOT NULL,
    "use_for_global_similarity" boolean DEFAULT true NOT NULL,
    "keywords" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "search_document" "tsvector",
    "source_map" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "value_jsonb" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "deal_tree_node_kind_check" CHECK (("kind" = ANY (ARRAY['root'::"text", 'child'::"text", 'sub_child'::"text", 'persona_subchild'::"text"])))
);


ALTER TABLE "deal_intel"."deal_tree_node" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."document" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "deal_id" "uuid",
    "source_kind" "text" DEFAULT 'pitch_deck'::"text" NOT NULL,
    "original_filename" "text",
    "mime_type" "text" DEFAULT 'application/pdf'::"text" NOT NULL,
    "byte_size" integer,
    "sha256" "text",
    "storage_provider" "text" DEFAULT 'supabase_storage'::"text" NOT NULL,
    "storage_bucket" "text" NOT NULL,
    "storage_path" "text" NOT NULL,
    "folder_path" "text",
    "status" "text" DEFAULT 'uploaded'::"text" NOT NULL,
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "document_status_check" CHECK (("status" = ANY (ARRAY['uploaded'::"text", 'parsed'::"text", 'chunked'::"text", 'claims_extracted'::"text", 'ready'::"text", 'error'::"text"])))
);


ALTER TABLE "deal_intel"."document" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."document_chunk" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "document_id" "uuid" NOT NULL,
    "page_start" integer NOT NULL,
    "page_end" integer NOT NULL,
    "char_start" integer NOT NULL,
    "char_end" integer NOT NULL,
    "text" "text" NOT NULL,
    "embedding" "extensions"."vector"(768),
    "embedding_model" "text",
    "keywords" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "search_document" "tsvector",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "document_chunk_char_end_check" CHECK (("char_end" >= 0)),
    CONSTRAINT "document_chunk_char_start_check" CHECK (("char_start" >= 0)),
    CONSTRAINT "document_chunk_page_end_check" CHECK (("page_end" >= 1)),
    CONSTRAINT "document_chunk_page_start_check" CHECK (("page_start" >= 1))
);


ALTER TABLE "deal_intel"."document_chunk" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."document_page" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "document_id" "uuid" NOT NULL,
    "page_number" integer NOT NULL,
    "text" "text" NOT NULL,
    "char_count" integer DEFAULT 0 NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "document_page_page_number_check" CHECK (("page_number" >= 1))
);


ALTER TABLE "deal_intel"."document_page" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."document_sentence" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "document_id" "uuid" NOT NULL,
    "page_number" integer NOT NULL,
    "sentence_index" integer NOT NULL,
    "text" "text" NOT NULL,
    "char_start" integer NOT NULL,
    "char_end" integer NOT NULL,
    "embedding" "extensions"."vector"(768),
    "embedding_model" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "document_sentence_char_end_check" CHECK (("char_end" >= 0)),
    CONSTRAINT "document_sentence_char_start_check" CHECK (("char_start" >= 0)),
    CONSTRAINT "document_sentence_page_number_check" CHECK (("page_number" >= 1)),
    CONSTRAINT "document_sentence_sentence_index_check" CHECK (("sentence_index" >= 0))
);


ALTER TABLE "deal_intel"."document_sentence" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."keyword_cluster" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "vocab_version" integer DEFAULT 1 NOT NULL,
    "representative_term_id" "uuid",
    "cluster_embedding" "extensions"."vector"(768),
    "produced_by" "text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "keyword_cluster_produced_by_check" CHECK (("produced_by" = ANY (ARRAY['online_dsu'::"text", 'offline_hdbscan'::"text", 'offline_hierarchical'::"text"])))
);


ALTER TABLE "deal_intel"."keyword_cluster" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."keyword_term" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "normalized_text" "text" NOT NULL,
    "raw_text" "text",
    "fixed_token_count" integer NOT NULL,
    "embedding" "extensions"."vector"(768) NOT NULL,
    "embedding_model" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "deal_intel"."keyword_term" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."keyword_term_cluster_membership" (
    "term_id" "uuid" NOT NULL,
    "cluster_id" "uuid" NOT NULL,
    "weight" double precision DEFAULT 1.0 NOT NULL
);


ALTER TABLE "deal_intel"."keyword_term_cluster_membership" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."meeting_assistant_event" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "meeting_id" "uuid" NOT NULL,
    "kind" "text" NOT NULL,
    "title" "text",
    "body" "text" NOT NULL,
    "severity" "text" DEFAULT 'low'::"text" NOT NULL,
    "source_map" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "meeting_assistant_event_kind_check" CHECK (("kind" = ANY (ARRAY['contradiction'::"text", 'crm_fact'::"text", 'key_point'::"text", 'suggested_question'::"text", 'action_prompt'::"text"]))),
    CONSTRAINT "meeting_assistant_event_severity_check" CHECK (("severity" = ANY (ARRAY['low'::"text", 'med'::"text", 'high'::"text"])))
);


ALTER TABLE "deal_intel"."meeting_assistant_event" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."meeting_participant" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "meeting_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "display_name" "text",
    "livekit_identity" "text",
    "joined_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "left_at" timestamp with time zone,
    CONSTRAINT "meeting_participant_role_check" CHECK (("role" = ANY (ARRAY['host'::"text", 'guest'::"text"])))
);


ALTER TABLE "deal_intel"."meeting_participant" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."meeting_session" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "host_user_id" "uuid" NOT NULL,
    "livekit_room_name" "text" NOT NULL,
    "status" "text" DEFAULT 'created'::"text" NOT NULL,
    "started_at" timestamp with time zone,
    "ended_at" timestamp with time zone,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "meeting_session_status_check" CHECK (("status" = ANY (ARRAY['created'::"text", 'live'::"text", 'ended'::"text", 'error'::"text"])))
);


ALTER TABLE "deal_intel"."meeting_session" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."meeting_transcript_segment" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "meeting_id" "uuid" NOT NULL,
    "segment_key" "text" NOT NULL,
    "revision" integer DEFAULT 0 NOT NULL,
    "speaker" "text",
    "t_start_ms" integer NOT NULL,
    "t_end_ms" integer NOT NULL,
    "text" "text" NOT NULL,
    "is_final" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "meeting_transcript_segment_t_end_ms_check" CHECK (("t_end_ms" >= 0)),
    CONSTRAINT "meeting_transcript_segment_t_start_ms_check" CHECK (("t_start_ms" >= 0))
);


ALTER TABLE "deal_intel"."meeting_transcript_segment" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."user_agent_preference" (
    "user_id" "uuid" NOT NULL,
    "tone_language_rules" "text",
    "forbidden_actions_behaviors" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "general_agent_behavior_preferences" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "deal_intel"."user_agent_preference" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."user_investment_preference" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "preference" "text" NOT NULL,
    "care_like_dislike" "text" NOT NULL,
    "how_much_they_care" numeric NOT NULL,
    "confidence_score" numeric NOT NULL,
    "stated_or_inferred" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "user_investment_preference_stated_or_inferred_check" CHECK (("stated_or_inferred" = ANY (ARRAY['stated'::"text", 'inferred'::"text"])))
);


ALTER TABLE "deal_intel"."user_investment_preference" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."user_research_site_preference" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "domain" "text" NOT NULL,
    "category" "text" DEFAULT 'general'::"text" NOT NULL,
    "preference_score" numeric DEFAULT 0 NOT NULL,
    "success_rate" numeric DEFAULT 0.5 NOT NULL,
    "usage_count" integer DEFAULT 0 NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "user_research_site_preference_preference_score_check" CHECK ((("preference_score" >= ('-1'::integer)::numeric) AND ("preference_score" <= (1)::numeric))),
    CONSTRAINT "user_research_site_preference_success_rate_check" CHECK ((("success_rate" >= (0)::numeric) AND ("success_rate" <= (1)::numeric))),
    CONSTRAINT "user_research_site_preference_usage_count_check" CHECK (("usage_count" >= 0))
);


ALTER TABLE "deal_intel"."user_research_site_preference" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."user_website_preference" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "website" "text" NOT NULL,
    "situations_good_for" "text",
    "focus_info_by_situation" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "how_often_user_prefers_website" "text",
    "how_often_user_likes_data_returned" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "deal_intel"."user_website_preference" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "deal_intel"."user_website_preference_embedding" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "website" "text" NOT NULL,
    "profile_embedding" "extensions"."vector"(768),
    "embedding_model" "text",
    "embedding_input" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "deal_intel"."user_website_preference_embedding" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."_deal_tree_legacy_map" (
    "legacy_id" "uuid" NOT NULL,
    "new_id" "uuid" NOT NULL
);


ALTER TABLE "public"."_deal_tree_legacy_map" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."analysis_status" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "analysis_id" "uuid" NOT NULL,
    "current_step" "text",
    "status" "text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."analysis_status" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."chat_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "thread_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "content" "text" NOT NULL,
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "chat_messages_role_check" CHECK (("role" = ANY (ARRAY['user'::"text", 'assistant'::"text", 'system'::"text", 'tool'::"text"])))
);


ALTER TABLE "public"."chat_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."chat_threads" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "deal_id" "uuid",
    "title" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."chat_threads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contact_edges" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "founder_id" "uuid",
    "contact_id" "uuid",
    "connection_type" "text",
    "shared_entity" "text",
    "overlap_start" "date",
    "overlap_end" "date",
    "confidence" "text",
    "warm_path_note" "text",
    "deal_id" "uuid"
);


ALTER TABLE "public"."contact_edges" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contact_employment" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "contact_id" "uuid" NOT NULL,
    "company_name" "text",
    "title" "text",
    "start_date" "date",
    "end_date" "date"
);


ALTER TABLE "public"."contact_employment" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contradictions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "analysis_id" "uuid" NOT NULL,
    "claim_a_id" "uuid",
    "claim_b_id" "uuid",
    "conflict_description" "text",
    "severity" "text"
);


ALTER TABLE "public"."contradictions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deal_analyses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "pipeline_version" integer DEFAULT 2 NOT NULL,
    "raw_output" "jsonb",
    "run_at" timestamp with time zone DEFAULT "now"(),
    "similar_peers_json" "jsonb",
    "user_corpus_thesis_context_json" "jsonb",
    "user_corpus_risk_context_json" "jsonb"
);


ALTER TABLE "public"."deal_analyses" OWNER TO "postgres";


COMMENT ON COLUMN "public"."deal_analyses"."similar_peers_json" IS 'Snapshot of hybrid similar-deals at analysis time (portfolio comparables).';



CREATE TABLE IF NOT EXISTS "public"."deal_assumptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "analysis_id" "uuid" NOT NULL,
    "assumption_text" "text",
    "assumption_type" "text",
    "inversion" "text",
    "must_be_true" "text",
    "is_linchpin" boolean,
    "fragility_score" integer,
    "why_fragile" "text",
    "failure_mode" "text"
);


ALTER TABLE "public"."deal_assumptions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deal_claims" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "analysis_id" "uuid" NOT NULL,
    "agent_source" "text",
    "claim_type" "text",
    "subject" "text",
    "predicate" "text",
    "object" "text",
    "confidence" double precision,
    "source_type" "text",
    "flagged" boolean
);


ALTER TABLE "public"."deal_claims" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deal_competitors" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "competitor_name" "text",
    "category" "text",
    "threat_level" "text",
    "threat_assessment" "text",
    "analysis_id" "uuid"
);


ALTER TABLE "public"."deal_competitors" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deal_context_nodes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "analysis_id" "uuid" NOT NULL,
    "parent_id" "uuid",
    "node_type" "text" NOT NULL,
    "depth" integer DEFAULT 0 NOT NULL,
    "raw_text" "text",
    "structured_text" "text",
    "keywords" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "embedding" "extensions"."vector"(768),
    "node_weight" double precision DEFAULT 1.0 NOT NULL,
    "subnode_weights_json" "jsonb",
    "polarity" "text" DEFAULT 'neutral'::"text" NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "search_document" "tsvector" GENERATED ALWAYS AS ("to_tsvector"('"english"'::"regconfig", ((COALESCE("raw_text", ''::"text") || ' '::"text") || COALESCE("structured_text", ''::"text")))) STORED,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "deal_context_nodes_polarity_check" CHECK (("polarity" = ANY (ARRAY['positive'::"text", 'negative'::"text", 'neutral'::"text"])))
);


ALTER TABLE "public"."deal_context_nodes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deal_differentiation" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "proof_point" "text",
    "proof_type" "text",
    "analysis_id" "uuid"
);


ALTER TABLE "public"."deal_differentiation" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deal_entities" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "entity_type" "text",
    "entity_name" "text",
    "role" "text",
    "source" "text"
);


ALTER TABLE "public"."deal_entities" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deal_feature_definitions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "key" "text" NOT NULL,
    "label" "text" NOT NULL,
    "data_type" "text" NOT NULL,
    "origin" "text" DEFAULT 'explicit_user'::"text" NOT NULL,
    "compute_tier" "text" DEFAULT 'cheap'::"text" NOT NULL,
    "formula_or_prompt_ref" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "deal_feature_definitions_compute_tier_check" CHECK (("compute_tier" = ANY (ARRAY['cheap'::"text", 'expensive'::"text"]))),
    CONSTRAINT "deal_feature_definitions_data_type_check" CHECK (("data_type" = ANY (ARRAY['number'::"text", 'text'::"text", 'bool'::"text", 'json'::"text"]))),
    CONSTRAINT "deal_feature_definitions_origin_check" CHECK (("origin" = ANY (ARRAY['explicit_user'::"text", 'pipeline'::"text", 'inferred_llm'::"text"])))
);


ALTER TABLE "public"."deal_feature_definitions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deal_feature_provenance" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "feature_id" "uuid" NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "node_id" "uuid",
    "prompt_run_id" "uuid",
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."deal_feature_provenance" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deal_feature_values" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "feature_id" "uuid" NOT NULL,
    "value_jsonb" "jsonb",
    "status" "text" DEFAULT 'done'::"text" NOT NULL,
    "cache_key" "text",
    "error_message" "text",
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "deal_feature_values_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'done'::"text", 'error'::"text"])))
);


ALTER TABLE "public"."deal_feature_values" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deal_flags" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "analysis_id" "uuid",
    "flag_type" "text",
    "flag_message" "text",
    "auto_reject" boolean,
    "triggered_by" "text"
);


ALTER TABLE "public"."deal_flags" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deal_investors" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "investor_id" "uuid" NOT NULL,
    "role" "text",
    "round_name" "text",
    "amount" bigint
);


ALTER TABLE "public"."deal_investors" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deal_keywords" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "analysis_id" "uuid" NOT NULL,
    "section_name" "text" NOT NULL,
    "concepts" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "concepts_text" "text",
    "concepts_tsv" "tsvector",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "deal_keywords_section_name_check" CHECK (("section_name" = ANY (ARRAY['problem'::"text", 'solution'::"text", 'market'::"text", 'risk'::"text"])))
);


ALTER TABLE "public"."deal_keywords" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deal_metrics" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "metric_name" "text",
    "metric_value" "text",
    "confidence" "text",
    "source_type" "text",
    "is_verified" boolean
);


ALTER TABLE "public"."deal_metrics" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deal_pipeline_json_core_assumptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "analysis_id" "uuid" NOT NULL,
    "core_assumption_json" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "past_deal_comparisons_json" "jsonb",
    "assumption_comparisons_json" "jsonb"
);


ALTER TABLE "public"."deal_pipeline_json_core_assumptions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deal_pipeline_json_founder_signals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "analysis_id" "uuid" NOT NULL,
    "founder_signal_json" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."deal_pipeline_json_founder_signals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deal_pipeline_json_market_power" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "analysis_id" "uuid" NOT NULL,
    "market_power_json" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."deal_pipeline_json_market_power" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deal_pipeline_json_parsing" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "analysis_id" "uuid" NOT NULL,
    "parsing_json" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."deal_pipeline_json_parsing" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deal_pipeline_json_problem_3c" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "analysis_id" "uuid" NOT NULL,
    "problem_quality_3c_json" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "past_deal_comparisons_json" "jsonb"
);


ALTER TABLE "public"."deal_pipeline_json_problem_3c" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deal_pipeline_json_questions_combined" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "analysis_id" "uuid" NOT NULL,
    "questions_combined_json" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."deal_pipeline_json_questions_combined" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deal_pipeline_json_solution_3d" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "analysis_id" "uuid" NOT NULL,
    "solution_defensibility_json" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "past_deal_comparisons_json" "jsonb"
);


ALTER TABLE "public"."deal_pipeline_json_solution_3d" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deal_pipeline_json_summaries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "analysis_id" "uuid" NOT NULL,
    "pipeline_summaries_json" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."deal_pipeline_json_summaries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deal_pipeline_json_thesis_fit" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "analysis_id" "uuid" NOT NULL,
    "thesis_fit_json" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "past_deal_comparisons_json" "jsonb"
);


ALTER TABLE "public"."deal_pipeline_json_thesis_fit" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deal_pipeline_json_traction_signals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "analysis_id" "uuid" NOT NULL,
    "traction_signal_json" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "past_deal_comparisons_json" "jsonb"
);


ALTER TABLE "public"."deal_pipeline_json_traction_signals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deal_problem" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "analysis_id" "uuid" NOT NULL,
    "problem_statement" "text",
    "root_cause_depth" "text",
    "economic_gravity" "text",
    "structural_urgency" "text",
    "persona_clarity" "text",
    "economic_buyer_persona" "text",
    "budget_priority_validation" "text",
    "pain_severity_score" integer,
    "buyer_authority_score" integer,
    "structural_tailwinds_score" integer,
    "venture_scale_plausibility" integer,
    "stated_problem_ref" "text",
    "signal_completeness" "text",
    "user_corpus_context_json" "jsonb"
);


ALTER TABLE "public"."deal_problem" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deal_prompt_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "analysis_id" "uuid" NOT NULL,
    "step_name" "text" NOT NULL,
    "model_name" "text",
    "model_tier" "text",
    "input_context" "jsonb",
    "output_json" "jsonb",
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."deal_prompt_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deal_questions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "analysis_id" "uuid" NOT NULL,
    "template_id" "uuid",
    "contradiction_id" "uuid",
    "assumption_id" "uuid",
    "question_text" "text",
    "source_signal" "text",
    "question_type" "text",
    "asked_in_meeting" boolean DEFAULT false,
    "meeting_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."deal_questions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deal_retrieval_index" (
    "deal_id" "uuid" NOT NULL,
    "analysis_id" "uuid" NOT NULL,
    "problem_normalized" "text",
    "solution_normalized" "text",
    "market_normalized" "text",
    "risk_normalized" "text",
    "concepts_json" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "normalized_json" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "problem_embedding" "extensions"."vector"(768),
    "solution_embedding" "extensions"."vector"(768),
    "market_embedding" "extensions"."vector"(768),
    "risk_embedding" "extensions"."vector"(768),
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."deal_retrieval_index" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deal_scores" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "analysis_id" "uuid" NOT NULL,
    "dimension" "text" NOT NULL,
    "raw_score" double precision,
    "weighted_score" double precision,
    "rubric_weight" double precision,
    "scoring_stage" "text"
);


ALTER TABLE "public"."deal_scores" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deal_solution" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "analysis_id" "uuid" NOT NULL,
    "solution_summary" "text",
    "product_type" "text",
    "moat_type" "text",
    "replication_difficulty" "text",
    "compounding_potential" "text",
    "technical_moat_evidence" "text",
    "ten_x_improvement_score" integer,
    "defensibility_potential" integer,
    "competitive_edge_score" integer,
    "signal_completeness" "text",
    "differentiation_proof_points" "jsonb",
    "competitor_landscape_json" "jsonb",
    "user_corpus_context_json" "jsonb"
);


ALTER TABLE "public"."deal_solution" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deal_traction" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "analysis_id" "uuid" NOT NULL,
    "inferred_stage" "text",
    "benchmark_context" "text",
    "traction_strength_score" integer,
    "growth_acceleration_score" integer,
    "stage_adjusted_signal_score" integer,
    "signal_completeness" "text",
    "traction_evidence_json" "jsonb",
    "phase1_traction_json" "jsonb",
    "revenue_data" "text",
    "growth_signals" "text",
    "customer_depth" "text",
    "user_traction" "text",
    "notable_partners_and_validation" "jsonb",
    "investor_list" "jsonb",
    "milestones_detected" "jsonb"
);


ALTER TABLE "public"."deal_traction" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deal_tree_nodes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "analysis_id" "uuid" NOT NULL,
    "parent_id" "uuid",
    "kind" "public"."deal_tree_node_kind" NOT NULL,
    "depth" integer DEFAULT 0 NOT NULL,
    "node_type" "text" NOT NULL,
    "node_path" "text",
    "node_key" "text",
    "node_value_text" "text",
    "narrative_text" "text",
    "structured_text" "text",
    "keywords" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "keyword_cluster_ids" "uuid"[] DEFAULT '{}'::"uuid"[] NOT NULL,
    "atomic_embedding" "extensions"."vector"(768),
    "narrative_embedding" "extensions"."vector"(768),
    "signal_embedding" "extensions"."vector"(768),
    "anchor_embedding" "extensions"."vector"(768),
    "centroid_embedding" "extensions"."vector"(768),
    "drift_embedding" "extensions"."vector"(768),
    "node_weight" double precision DEFAULT 1.0 NOT NULL,
    "edge_weight" double precision DEFAULT 1.0 NOT NULL,
    "polarity" "public"."deal_tree_polarity" DEFAULT 'neutral'::"public"."deal_tree_polarity" NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "source_map" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "search_document" "tsvector",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."deal_tree_nodes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "company_name" "text",
    "website" "text",
    "sector" "text",
    "subsector" "text",
    "stage" "text",
    "business_model" "text",
    "geography" "text",
    "check_size_requested" integer,
    "source" "text",
    "decision" "text",
    "pass_reason" "text",
    "pass_reason_detail" "text",
    "sourced_by" "uuid",
    "deck_url" "text",
    "deal_embedding" "extensions"."vector"(768),
    "decision_date" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "search_document" "text",
    "search_tsv" "tsvector" GENERATED ALWAYS AS ("to_tsvector"('"english"'::"regconfig", COALESCE("search_document", ''::"text"))) STORED,
    "pass_reason_enum" "text",
    "key_risks" "text"[],
    "moat_type" "text",
    "replication_difficulty" "text",
    "product_type" "text",
    "crm_notes" "text",
    "crm_stage" "text",
    "crm_next_step" "text"
);


ALTER TABLE "public"."deals" OWNER TO "postgres";


COMMENT ON COLUMN "public"."deals"."search_document" IS 'Canonical text for FTS + embedding; updated when deal is indexed.';



CREATE TABLE IF NOT EXISTS "public"."emails" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "gmail_connection_id" "uuid" NOT NULL,
    "gmail_message_id" "text" NOT NULL,
    "subject" "text",
    "from_address" "text",
    "date" timestamp with time zone,
    "snippet" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "deleted_at" timestamp with time zone
);


ALTER TABLE "public"."emails" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."founder_employment" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "founder_id" "uuid" NOT NULL,
    "company_name" "text",
    "title" "text",
    "start_date" "date",
    "end_date" "date",
    "is_current" boolean
);


ALTER TABLE "public"."founder_employment" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."founders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "name" "text",
    "linkedin_url" "text",
    "email" "text",
    "role" "text",
    "enrichment_source" "text",
    "enrichment_raw" "jsonb",
    "universities" "text"[],
    "yc_batch" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "background_summary" "text",
    "previous_companies" "jsonb",
    "institutions" "jsonb",
    "awards_and_honors" "jsonb",
    "past_exits" "jsonb"
);


ALTER TABLE "public"."founders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."fund_contacts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text",
    "role" "text",
    "firm" "text",
    "linkedin_url" "text",
    "email" "text"
);


ALTER TABLE "public"."fund_contacts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."fund_thesis" (
    "user_id" "uuid" NOT NULL,
    "thesis_text" "text" DEFAULT ''::"text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."fund_thesis" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."fund_thesis_v2" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "fund_name" "text",
    "version" integer,
    "stage_focus" "text"[],
    "sector_focus" "text"[],
    "check_size_min" integer,
    "check_size_max" integer,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."fund_thesis_v2" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."gmail_connections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "access_token" "text" NOT NULL,
    "refresh_token" "text",
    "watch_expiration" timestamp with time zone,
    "history_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."gmail_connections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."investment_memos" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "analysis_id" "uuid",
    "content" "text",
    "memo_embedding" "extensions"."vector",
    "authored_by" "text",
    "partner_notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."investment_memos" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."investment_rule_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "storage_path" "text" NOT NULL,
    "original_filename" "text",
    "mime_type" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "investment_rule_documents_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'processing'::"text", 'processed'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."investment_rule_documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."investment_rules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "document_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "rule_text" "text" NOT NULL,
    "condition_text" "text" DEFAULT ''::"text" NOT NULL,
    "rule_section" "text" NOT NULL,
    "condition_section" "text" NOT NULL,
    "polarity" "text" NOT NULL,
    "target_score_key" "text" NOT NULL,
    "specific_score_change" numeric,
    "keywords" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "rule_json" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "investment_rules_condition_section_check" CHECK (("condition_section" = ANY (ARRAY['problem'::"text", 'solution'::"text", 'founder'::"text", 'market'::"text"]))),
    CONSTRAINT "investment_rules_polarity_check" CHECK (("polarity" = ANY (ARRAY['positive'::"text", 'negative'::"text"]))),
    CONSTRAINT "investment_rules_rule_section_check" CHECK (("rule_section" = ANY (ARRAY['problem'::"text", 'solution'::"text", 'founder'::"text"])))
);


ALTER TABLE "public"."investment_rules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."investor_patterns" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "investor_id" "uuid" NOT NULL,
    "pattern_type" "text",
    "evidence_deal_ids" "uuid"[],
    "confidence_score" double precision,
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."investor_patterns" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."investors" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text",
    "investor_type" "text",
    "typical_stage" "text",
    "typical_sectors" "text"[],
    "crunchbase_id" "text"
);


ALTER TABLE "public"."investors" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."keyword_clusters" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "vocab_version" integer DEFAULT 1 NOT NULL,
    "medoid_phrase" "text" NOT NULL,
    "medoid_embedding" "extensions"."vector"(768) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."keyword_clusters" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."meetings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deal_id" "uuid" NOT NULL,
    "meeting_date" "date",
    "fund_attendees" "text"[],
    "founder_attendees" "text"[],
    "notes" "text",
    "transcript" "text",
    "meeting_type" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."meetings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pitch_deck_results" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "email_id" "uuid" NOT NULL,
    "gmail_message_id" "text" NOT NULL,
    "gmail_attachment_id" "text",
    "pdf_size_bytes" integer,
    "parsing_json" "jsonb",
    "problem_extraction_json" "jsonb",
    "solution_extraction_json" "jsonb",
    "problem_quality_score" numeric,
    "solution_quality_score" numeric,
    "founder_team_quality_score" numeric,
    "metrics_quality_score" numeric,
    "composite_score" numeric,
    "problem_web_json" "jsonb",
    "solution_web_json" "jsonb",
    "founder_web_json" "jsonb",
    "metrics_web_json" "jsonb",
    "processed_at" timestamp with time zone DEFAULT "now"(),
    "thesis_fit_json" "jsonb",
    "founder_signal_json" "jsonb",
    "traction_signal_json" "jsonb",
    "problem_quality_3c_json" "jsonb",
    "solution_defensibility_json" "jsonb",
    "market_power_json" "jsonb",
    "core_assumption_json" "jsonb",
    "thesis_fit_score" numeric,
    "founder_signal_score" numeric,
    "traction_signal_score" numeric,
    "solution_defensibility_score" numeric,
    "market_power_score" numeric
);


ALTER TABLE "public"."pitch_deck_results" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."question_outcomes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "question_id" "uuid" NOT NULL,
    "meeting_id" "uuid",
    "was_asked" boolean,
    "answer_summary" "text",
    "conviction_delta" "text",
    "led_to_pass" boolean,
    "led_to_invest" boolean,
    "analyst_rating" integer,
    "follow_up_needed" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."question_outcomes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."question_templates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "question_type" "text",
    "trigger_condition" "text",
    "template_text" "text",
    "applicable_stages" "text"[],
    "applicable_sectors" "text"[],
    "signal_yield" double precision,
    "use_count" integer,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."question_templates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scoring_rubrics" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "thesis_id" "uuid" NOT NULL,
    "stage" "text",
    "dimension" "text",
    "weight" double precision,
    "description" "text"
);


ALTER TABLE "public"."scoring_rubrics" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."thesis_rules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "thesis_id" "uuid" NOT NULL,
    "rule_type" "text",
    "dimension" "text",
    "condition" "text",
    "machine_condition" "jsonb",
    "weight" double precision,
    "auto_reject" boolean,
    "flag_message" "text"
);


ALTER TABLE "public"."thesis_rules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_investment_rules_context" (
    "user_id" "uuid" NOT NULL,
    "aggregated_by_section" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."user_investment_rules_context" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_spreadsheets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "name" "text" DEFAULT 'Untitled'::"text" NOT NULL,
    "deal_ids" "uuid"[] DEFAULT '{}'::"uuid"[] NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."user_spreadsheets" OWNER TO "postgres";


ALTER TABLE ONLY "deal_intel"."claim"
    ADD CONSTRAINT "claim_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "deal_intel"."company_fact"
    ADD CONSTRAINT "company_fact_deal_id_fact_path_key" UNIQUE ("deal_id", "fact_path");



ALTER TABLE ONLY "deal_intel"."company_fact"
    ADD CONSTRAINT "company_fact_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "deal_intel"."company_makeup"
    ADD CONSTRAINT "company_makeup_deal_id_revision_id_key" UNIQUE ("deal_id", "revision_id");



ALTER TABLE ONLY "deal_intel"."company_makeup"
    ADD CONSTRAINT "company_makeup_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "deal_intel"."company_negative"
    ADD CONSTRAINT "company_negative_deal_id_revision_id_key" UNIQUE ("deal_id", "revision_id");



ALTER TABLE ONLY "deal_intel"."company_negative"
    ADD CONSTRAINT "company_negative_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "deal_intel"."company_origin_story"
    ADD CONSTRAINT "company_origin_story_deal_id_revision_id_key" UNIQUE ("deal_id", "revision_id");



ALTER TABLE ONLY "deal_intel"."company_origin_story"
    ADD CONSTRAINT "company_origin_story_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "deal_intel"."company_person"
    ADD CONSTRAINT "company_person_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "deal_intel"."company_problem"
    ADD CONSTRAINT "company_problem_deal_id_revision_id_key" UNIQUE ("deal_id", "revision_id");



ALTER TABLE ONLY "deal_intel"."company_problem"
    ADD CONSTRAINT "company_problem_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "deal_intel"."company_solution"
    ADD CONSTRAINT "company_solution_deal_id_revision_id_key" UNIQUE ("deal_id", "revision_id");



ALTER TABLE ONLY "deal_intel"."company_solution"
    ADD CONSTRAINT "company_solution_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "deal_intel"."company_traction"
    ADD CONSTRAINT "company_traction_deal_id_revision_id_key" UNIQUE ("deal_id", "revision_id");



ALTER TABLE ONLY "deal_intel"."company_traction"
    ADD CONSTRAINT "company_traction_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "deal_intel"."deal_fact_edge"
    ADD CONSTRAINT "deal_fact_edge_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "deal_intel"."deal_fact_node"
    ADD CONSTRAINT "deal_fact_node_deal_id_path_key" UNIQUE ("deal_id", "path");



ALTER TABLE ONLY "deal_intel"."deal_fact_node"
    ADD CONSTRAINT "deal_fact_node_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "deal_intel"."deal"
    ADD CONSTRAINT "deal_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "deal_intel"."deal_research_feedback"
    ADD CONSTRAINT "deal_research_feedback_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "deal_intel"."deal_research_step"
    ADD CONSTRAINT "deal_research_step_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "deal_intel"."deal_research_step_run"
    ADD CONSTRAINT "deal_research_step_run_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "deal_intel"."deal_research_workflow"
    ADD CONSTRAINT "deal_research_workflow_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "deal_intel"."deal_revision"
    ADD CONSTRAINT "deal_revision_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "deal_intel"."deal_tree_edge"
    ADD CONSTRAINT "deal_tree_edge_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "deal_intel"."deal_tree_node"
    ADD CONSTRAINT "deal_tree_node_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "deal_intel"."document_chunk"
    ADD CONSTRAINT "document_chunk_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "deal_intel"."document_page"
    ADD CONSTRAINT "document_page_document_id_page_number_key" UNIQUE ("document_id", "page_number");



ALTER TABLE ONLY "deal_intel"."document_page"
    ADD CONSTRAINT "document_page_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "deal_intel"."document"
    ADD CONSTRAINT "document_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "deal_intel"."document_sentence"
    ADD CONSTRAINT "document_sentence_document_id_page_number_sentence_index_key" UNIQUE ("document_id", "page_number", "sentence_index");



ALTER TABLE ONLY "deal_intel"."document_sentence"
    ADD CONSTRAINT "document_sentence_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "deal_intel"."keyword_cluster"
    ADD CONSTRAINT "keyword_cluster_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "deal_intel"."keyword_term_cluster_membership"
    ADD CONSTRAINT "keyword_term_cluster_membership_pkey" PRIMARY KEY ("term_id");



ALTER TABLE ONLY "deal_intel"."keyword_term"
    ADD CONSTRAINT "keyword_term_normalized_text_key" UNIQUE ("normalized_text");



ALTER TABLE ONLY "deal_intel"."keyword_term"
    ADD CONSTRAINT "keyword_term_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "deal_intel"."meeting_assistant_event"
    ADD CONSTRAINT "meeting_assistant_event_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "deal_intel"."meeting_participant"
    ADD CONSTRAINT "meeting_participant_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "deal_intel"."meeting_session"
    ADD CONSTRAINT "meeting_session_livekit_room_name_key" UNIQUE ("livekit_room_name");



ALTER TABLE ONLY "deal_intel"."meeting_session"
    ADD CONSTRAINT "meeting_session_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "deal_intel"."meeting_transcript_segment"
    ADD CONSTRAINT "meeting_transcript_segment_meeting_id_segment_key_revision_key" UNIQUE ("meeting_id", "segment_key", "revision");



ALTER TABLE ONLY "deal_intel"."meeting_transcript_segment"
    ADD CONSTRAINT "meeting_transcript_segment_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "deal_intel"."user_agent_preference"
    ADD CONSTRAINT "user_agent_preference_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "deal_intel"."user_investment_preference"
    ADD CONSTRAINT "user_investment_preference_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "deal_intel"."user_research_site_preference"
    ADD CONSTRAINT "user_research_site_preference_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "deal_intel"."user_research_site_preference"
    ADD CONSTRAINT "user_research_site_preference_user_id_domain_category_key" UNIQUE ("user_id", "domain", "category");



ALTER TABLE ONLY "deal_intel"."user_website_preference_embedding"
    ADD CONSTRAINT "user_website_preference_embedding_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "deal_intel"."user_website_preference_embedding"
    ADD CONSTRAINT "user_website_preference_embedding_user_id_website_key" UNIQUE ("user_id", "website");



ALTER TABLE ONLY "deal_intel"."user_website_preference"
    ADD CONSTRAINT "user_website_preference_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "deal_intel"."user_website_preference"
    ADD CONSTRAINT "user_website_preference_user_id_website_key" UNIQUE ("user_id", "website");



ALTER TABLE ONLY "public"."_deal_tree_legacy_map"
    ADD CONSTRAINT "_deal_tree_legacy_map_new_id_key" UNIQUE ("new_id");



ALTER TABLE ONLY "public"."_deal_tree_legacy_map"
    ADD CONSTRAINT "_deal_tree_legacy_map_pkey" PRIMARY KEY ("legacy_id");



ALTER TABLE ONLY "public"."analysis_status"
    ADD CONSTRAINT "analysis_status_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."chat_messages"
    ADD CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."chat_threads"
    ADD CONSTRAINT "chat_threads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contact_edges"
    ADD CONSTRAINT "contact_edges_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contact_employment"
    ADD CONSTRAINT "contact_employment_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contradictions"
    ADD CONSTRAINT "contradictions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deal_analyses"
    ADD CONSTRAINT "deal_analyses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deal_assumptions"
    ADD CONSTRAINT "deal_assumptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deal_claims"
    ADD CONSTRAINT "deal_claims_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deal_competitors"
    ADD CONSTRAINT "deal_competitors_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deal_context_nodes"
    ADD CONSTRAINT "deal_context_nodes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deal_differentiation"
    ADD CONSTRAINT "deal_differentiation_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deal_entities"
    ADD CONSTRAINT "deal_entities_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deal_feature_definitions"
    ADD CONSTRAINT "deal_feature_definitions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deal_feature_definitions"
    ADD CONSTRAINT "deal_feature_definitions_user_id_key_key" UNIQUE ("user_id", "key");



ALTER TABLE ONLY "public"."deal_feature_provenance"
    ADD CONSTRAINT "deal_feature_provenance_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deal_feature_values"
    ADD CONSTRAINT "deal_feature_values_deal_id_feature_id_key" UNIQUE ("deal_id", "feature_id");



ALTER TABLE ONLY "public"."deal_feature_values"
    ADD CONSTRAINT "deal_feature_values_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deal_flags"
    ADD CONSTRAINT "deal_flags_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deal_investors"
    ADD CONSTRAINT "deal_investors_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deal_keywords"
    ADD CONSTRAINT "deal_keywords_deal_id_section_name_key" UNIQUE ("deal_id", "section_name");



ALTER TABLE ONLY "public"."deal_keywords"
    ADD CONSTRAINT "deal_keywords_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deal_metrics"
    ADD CONSTRAINT "deal_metrics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deal_pipeline_json_core_assumptions"
    ADD CONSTRAINT "deal_pipeline_json_core_assumptions_analysis_id_key" UNIQUE ("analysis_id");



ALTER TABLE ONLY "public"."deal_pipeline_json_core_assumptions"
    ADD CONSTRAINT "deal_pipeline_json_core_assumptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deal_pipeline_json_founder_signals"
    ADD CONSTRAINT "deal_pipeline_json_founder_signals_analysis_id_key" UNIQUE ("analysis_id");



ALTER TABLE ONLY "public"."deal_pipeline_json_founder_signals"
    ADD CONSTRAINT "deal_pipeline_json_founder_signals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deal_pipeline_json_market_power"
    ADD CONSTRAINT "deal_pipeline_json_market_power_analysis_id_key" UNIQUE ("analysis_id");



ALTER TABLE ONLY "public"."deal_pipeline_json_market_power"
    ADD CONSTRAINT "deal_pipeline_json_market_power_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deal_pipeline_json_parsing"
    ADD CONSTRAINT "deal_pipeline_json_parsing_analysis_id_key" UNIQUE ("analysis_id");



ALTER TABLE ONLY "public"."deal_pipeline_json_parsing"
    ADD CONSTRAINT "deal_pipeline_json_parsing_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deal_pipeline_json_problem_3c"
    ADD CONSTRAINT "deal_pipeline_json_problem_3c_analysis_id_key" UNIQUE ("analysis_id");



ALTER TABLE ONLY "public"."deal_pipeline_json_problem_3c"
    ADD CONSTRAINT "deal_pipeline_json_problem_3c_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deal_pipeline_json_questions_combined"
    ADD CONSTRAINT "deal_pipeline_json_questions_combined_analysis_id_key" UNIQUE ("analysis_id");



ALTER TABLE ONLY "public"."deal_pipeline_json_questions_combined"
    ADD CONSTRAINT "deal_pipeline_json_questions_combined_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deal_pipeline_json_solution_3d"
    ADD CONSTRAINT "deal_pipeline_json_solution_3d_analysis_id_key" UNIQUE ("analysis_id");



ALTER TABLE ONLY "public"."deal_pipeline_json_solution_3d"
    ADD CONSTRAINT "deal_pipeline_json_solution_3d_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deal_pipeline_json_summaries"
    ADD CONSTRAINT "deal_pipeline_json_summaries_analysis_id_key" UNIQUE ("analysis_id");



ALTER TABLE ONLY "public"."deal_pipeline_json_summaries"
    ADD CONSTRAINT "deal_pipeline_json_summaries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deal_pipeline_json_thesis_fit"
    ADD CONSTRAINT "deal_pipeline_json_thesis_fit_analysis_id_key" UNIQUE ("analysis_id");



ALTER TABLE ONLY "public"."deal_pipeline_json_thesis_fit"
    ADD CONSTRAINT "deal_pipeline_json_thesis_fit_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deal_pipeline_json_traction_signals"
    ADD CONSTRAINT "deal_pipeline_json_traction_signals_analysis_id_key" UNIQUE ("analysis_id");



ALTER TABLE ONLY "public"."deal_pipeline_json_traction_signals"
    ADD CONSTRAINT "deal_pipeline_json_traction_signals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deal_problem"
    ADD CONSTRAINT "deal_problem_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deal_prompt_runs"
    ADD CONSTRAINT "deal_prompt_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deal_questions"
    ADD CONSTRAINT "deal_questions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deal_retrieval_index"
    ADD CONSTRAINT "deal_retrieval_index_pkey" PRIMARY KEY ("deal_id");



ALTER TABLE ONLY "public"."deal_scores"
    ADD CONSTRAINT "deal_scores_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deal_solution"
    ADD CONSTRAINT "deal_solution_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deal_traction"
    ADD CONSTRAINT "deal_traction_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deal_tree_nodes"
    ADD CONSTRAINT "deal_tree_nodes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deals"
    ADD CONSTRAINT "deals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."emails"
    ADD CONSTRAINT "emails_gmail_connection_id_gmail_message_id_key" UNIQUE ("gmail_connection_id", "gmail_message_id");



ALTER TABLE ONLY "public"."emails"
    ADD CONSTRAINT "emails_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."founder_employment"
    ADD CONSTRAINT "founder_employment_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."founders"
    ADD CONSTRAINT "founders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."fund_contacts"
    ADD CONSTRAINT "fund_contacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."fund_thesis"
    ADD CONSTRAINT "fund_thesis_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."fund_thesis_v2"
    ADD CONSTRAINT "fund_thesis_v2_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."gmail_connections"
    ADD CONSTRAINT "gmail_connections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."gmail_connections"
    ADD CONSTRAINT "gmail_connections_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."investment_memos"
    ADD CONSTRAINT "investment_memos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."investment_rule_documents"
    ADD CONSTRAINT "investment_rule_documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."investment_rules"
    ADD CONSTRAINT "investment_rules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."investor_patterns"
    ADD CONSTRAINT "investor_patterns_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."investors"
    ADD CONSTRAINT "investors_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."keyword_clusters"
    ADD CONSTRAINT "keyword_clusters_medoid_phrase_key" UNIQUE ("medoid_phrase");



ALTER TABLE ONLY "public"."keyword_clusters"
    ADD CONSTRAINT "keyword_clusters_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."meetings"
    ADD CONSTRAINT "meetings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pitch_deck_results"
    ADD CONSTRAINT "pitch_deck_results_email_id_key" UNIQUE ("email_id");



ALTER TABLE ONLY "public"."pitch_deck_results"
    ADD CONSTRAINT "pitch_deck_results_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."question_outcomes"
    ADD CONSTRAINT "question_outcomes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."question_templates"
    ADD CONSTRAINT "question_templates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scoring_rubrics"
    ADD CONSTRAINT "scoring_rubrics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."thesis_rules"
    ADD CONSTRAINT "thesis_rules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_investment_rules_context"
    ADD CONSTRAINT "user_investment_rules_context_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."user_spreadsheets"
    ADD CONSTRAINT "user_spreadsheets_pkey" PRIMARY KEY ("id");



CREATE INDEX "deal_intel_claim_deal_key_idx" ON "deal_intel"."claim" USING "btree" ("deal_id", "key");



CREATE INDEX "deal_intel_claim_document_page_idx" ON "deal_intel"."claim" USING "btree" ("document_id", "page_number");



CREATE INDEX "deal_intel_claim_embedding_hnsw_idx" ON "deal_intel"."claim" USING "hnsw" ("embedding" "extensions"."vector_cosine_ops") WITH ("m"='16', "ef_construction"='64') WHERE ("embedding" IS NOT NULL);



CREATE INDEX "deal_intel_claim_search_gin_idx" ON "deal_intel"."claim" USING "gin" ("search_document");



CREATE INDEX "deal_intel_claim_user_idx" ON "deal_intel"."claim" USING "btree" ("user_id");



CREATE INDEX "deal_intel_company_fact_deal_idx" ON "deal_intel"."company_fact" USING "btree" ("deal_id");



CREATE INDEX "deal_intel_company_makeup_deal_idx" ON "deal_intel"."company_makeup" USING "btree" ("deal_id");



CREATE INDEX "deal_intel_company_negative_deal_idx" ON "deal_intel"."company_negative" USING "btree" ("deal_id");



CREATE INDEX "deal_intel_company_origin_story_deal_idx" ON "deal_intel"."company_origin_story" USING "btree" ("deal_id");



CREATE INDEX "deal_intel_company_person_deal_idx" ON "deal_intel"."company_person" USING "btree" ("deal_id");



CREATE INDEX "deal_intel_company_person_name_idx" ON "deal_intel"."company_person" USING "btree" ("deal_id", "name");



CREATE INDEX "deal_intel_company_person_revision_idx" ON "deal_intel"."company_person" USING "btree" ("revision_id");



CREATE INDEX "deal_intel_company_problem_deal_idx" ON "deal_intel"."company_problem" USING "btree" ("deal_id");



CREATE INDEX "deal_intel_company_solution_deal_idx" ON "deal_intel"."company_solution" USING "btree" ("deal_id");



CREATE INDEX "deal_intel_company_traction_deal_idx" ON "deal_intel"."company_traction" USING "btree" ("deal_id");



CREATE INDEX "deal_intel_deal_fact_edge_deal_idx" ON "deal_intel"."deal_fact_edge" USING "btree" ("deal_id");



CREATE INDEX "deal_intel_deal_fact_edge_dst_idx" ON "deal_intel"."deal_fact_edge" USING "btree" ("dst_node_id");



CREATE INDEX "deal_intel_deal_fact_edge_src_idx" ON "deal_intel"."deal_fact_edge" USING "btree" ("src_node_id");



CREATE INDEX "deal_intel_deal_fact_node_deal_idx" ON "deal_intel"."deal_fact_node" USING "btree" ("deal_id");



CREATE INDEX "deal_intel_deal_fact_node_embedding_hnsw_idx" ON "deal_intel"."deal_fact_node" USING "hnsw" ("content_embedding" "extensions"."vector_cosine_ops") WITH ("m"='16', "ef_construction"='64') WHERE ("content_embedding" IS NOT NULL);



CREATE INDEX "deal_intel_deal_fact_node_keywords_gin_idx" ON "deal_intel"."deal_fact_node" USING "gin" ("keywords");



CREATE INDEX "deal_intel_deal_fact_node_parent_idx" ON "deal_intel"."deal_fact_node" USING "btree" ("parent_id");



CREATE INDEX "deal_intel_deal_fact_node_path_idx" ON "deal_intel"."deal_fact_node" USING "btree" ("deal_id", "path");



CREATE INDEX "deal_intel_deal_fact_node_search_gin_idx" ON "deal_intel"."deal_fact_node" USING "gin" ("search_document");



CREATE INDEX "deal_intel_deal_revision_deal_idx" ON "deal_intel"."deal_revision" USING "btree" ("deal_id");



CREATE INDEX "deal_intel_deal_tree_edge_deal_idx" ON "deal_intel"."deal_tree_edge" USING "btree" ("deal_id");



CREATE INDEX "deal_intel_deal_tree_edge_dst_idx" ON "deal_intel"."deal_tree_edge" USING "btree" ("dst_node_id");



CREATE INDEX "deal_intel_deal_tree_edge_src_idx" ON "deal_intel"."deal_tree_edge" USING "btree" ("src_node_id");



CREATE INDEX "deal_intel_deal_tree_node_anchor_hnsw_idx" ON "deal_intel"."deal_tree_node" USING "hnsw" ("anchor_embedding" "extensions"."vector_cosine_ops") WITH ("m"='16', "ef_construction"='64') WHERE ("anchor_embedding" IS NOT NULL);



CREATE INDEX "deal_intel_deal_tree_node_atomic_hnsw_idx" ON "deal_intel"."deal_tree_node" USING "hnsw" ("atomic_embedding" "extensions"."vector_cosine_ops") WITH ("m"='16', "ef_construction"='64') WHERE ("atomic_embedding" IS NOT NULL);



CREATE INDEX "deal_intel_deal_tree_node_centroid_hnsw_idx" ON "deal_intel"."deal_tree_node" USING "hnsw" ("centroid_embedding" "extensions"."vector_cosine_ops") WITH ("m"='16', "ef_construction"='64') WHERE ("centroid_embedding" IS NOT NULL);



CREATE INDEX "deal_intel_deal_tree_node_deal_idx" ON "deal_intel"."deal_tree_node" USING "btree" ("deal_id");



CREATE INDEX "deal_intel_deal_tree_node_kind_type_idx" ON "deal_intel"."deal_tree_node" USING "btree" ("deal_id", "kind", "node_type");



CREATE INDEX "deal_intel_deal_tree_node_parent_idx" ON "deal_intel"."deal_tree_node" USING "btree" ("parent_id");



CREATE INDEX "deal_intel_deal_tree_node_search_gin_idx" ON "deal_intel"."deal_tree_node" USING "gin" ("search_document");



CREATE INDEX "deal_intel_deal_tree_node_signal_hnsw_idx" ON "deal_intel"."deal_tree_node" USING "hnsw" ("signal_embedding" "extensions"."vector_cosine_ops") WITH ("m"='16', "ef_construction"='64') WHERE ("signal_embedding" IS NOT NULL);



CREATE INDEX "deal_intel_deal_user_idx" ON "deal_intel"."deal" USING "btree" ("user_id");



CREATE INDEX "deal_intel_document_chunk_document_idx" ON "deal_intel"."document_chunk" USING "btree" ("document_id");



CREATE INDEX "deal_intel_document_chunk_embedding_hnsw_idx" ON "deal_intel"."document_chunk" USING "hnsw" ("embedding" "extensions"."vector_cosine_ops") WITH ("m"='16', "ef_construction"='64') WHERE ("embedding" IS NOT NULL);



CREATE INDEX "deal_intel_document_chunk_search_gin_idx" ON "deal_intel"."document_chunk" USING "gin" ("search_document");



CREATE INDEX "deal_intel_document_deal_idx" ON "deal_intel"."document" USING "btree" ("deal_id");



CREATE INDEX "deal_intel_document_page_document_idx" ON "deal_intel"."document_page" USING "btree" ("document_id");



CREATE INDEX "deal_intel_document_sentence_document_idx" ON "deal_intel"."document_sentence" USING "btree" ("document_id");



CREATE INDEX "deal_intel_document_sentence_document_page_idx" ON "deal_intel"."document_sentence" USING "btree" ("document_id", "page_number");



CREATE INDEX "deal_intel_document_sentence_embedding_hnsw_idx" ON "deal_intel"."document_sentence" USING "hnsw" ("embedding" "extensions"."vector_cosine_ops") WITH ("m"='16', "ef_construction"='64') WHERE ("embedding" IS NOT NULL);



CREATE INDEX "deal_intel_document_user_created_idx" ON "deal_intel"."document" USING "btree" ("user_id", "created_at" DESC);



CREATE UNIQUE INDEX "deal_intel_document_user_sha256_uniq" ON "deal_intel"."document" USING "btree" ("user_id", "sha256") WHERE ("sha256" IS NOT NULL);



CREATE INDEX "deal_intel_keyword_cluster_embedding_hnsw_idx" ON "deal_intel"."keyword_cluster" USING "hnsw" ("cluster_embedding" "extensions"."vector_cosine_ops") WITH ("m"='16', "ef_construction"='64') WHERE ("cluster_embedding" IS NOT NULL);



CREATE INDEX "deal_intel_keyword_cluster_version_idx" ON "deal_intel"."keyword_cluster" USING "btree" ("vocab_version");



CREATE INDEX "deal_intel_keyword_membership_cluster_idx" ON "deal_intel"."keyword_term_cluster_membership" USING "btree" ("cluster_id");



CREATE INDEX "deal_intel_keyword_term_embedding_hnsw_idx" ON "deal_intel"."keyword_term" USING "hnsw" ("embedding" "extensions"."vector_cosine_ops") WITH ("m"='16', "ef_construction"='64');



CREATE INDEX "deal_intel_meeting_assistant_event_meeting_created_idx" ON "deal_intel"."meeting_assistant_event" USING "btree" ("meeting_id", "created_at");



CREATE INDEX "deal_intel_meeting_participant_meeting_idx" ON "deal_intel"."meeting_participant" USING "btree" ("meeting_id");



CREATE INDEX "deal_intel_meeting_session_deal_idx" ON "deal_intel"."meeting_session" USING "btree" ("deal_id");



CREATE INDEX "deal_intel_meeting_session_host_idx" ON "deal_intel"."meeting_session" USING "btree" ("host_user_id");



CREATE INDEX "deal_intel_meeting_transcript_segment_meeting_key_idx" ON "deal_intel"."meeting_transcript_segment" USING "btree" ("meeting_id", "segment_key");



CREATE INDEX "deal_intel_meeting_transcript_segment_meeting_time_idx" ON "deal_intel"."meeting_transcript_segment" USING "btree" ("meeting_id", "t_start_ms");



CREATE INDEX "deal_intel_research_feedback_workflow_created_idx" ON "deal_intel"."deal_research_feedback" USING "btree" ("workflow_id", "created_at" DESC);



CREATE INDEX "deal_intel_research_step_run_step_created_idx" ON "deal_intel"."deal_research_step_run" USING "btree" ("step_id", "created_at" DESC);



CREATE INDEX "deal_intel_research_step_run_workflow_created_idx" ON "deal_intel"."deal_research_step_run" USING "btree" ("workflow_id", "created_at" DESC);



CREATE INDEX "deal_intel_research_step_workflow_position_idx" ON "deal_intel"."deal_research_step" USING "btree" ("workflow_id", "position");



CREATE INDEX "deal_intel_research_step_workflow_status_idx" ON "deal_intel"."deal_research_step" USING "btree" ("workflow_id", "status");



CREATE INDEX "deal_intel_research_workflow_deal_updated_idx" ON "deal_intel"."deal_research_workflow" USING "btree" ("deal_id", "updated_at" DESC);



CREATE UNIQUE INDEX "deal_intel_research_workflow_deal_user_active_idx" ON "deal_intel"."deal_research_workflow" USING "btree" ("deal_id", "user_id") WHERE ("status" <> 'archived'::"text");



CREATE INDEX "deal_intel_user_investment_preference_user_idx" ON "deal_intel"."user_investment_preference" USING "btree" ("user_id");



CREATE INDEX "deal_intel_user_research_pref_user_category_idx" ON "deal_intel"."user_research_site_preference" USING "btree" ("user_id", "category");



CREATE INDEX "deal_intel_user_website_preference_user_idx" ON "deal_intel"."user_website_preference" USING "btree" ("user_id");



CREATE INDEX "chat_messages_thread_idx" ON "public"."chat_messages" USING "btree" ("thread_id", "created_at");



CREATE INDEX "chat_threads_user_idx" ON "public"."chat_threads" USING "btree" ("user_id", "updated_at" DESC);



CREATE INDEX "deal_competitors_deal_analysis_idx" ON "public"."deal_competitors" USING "btree" ("deal_id", "analysis_id");



CREATE INDEX "deal_context_nodes_deal_analysis_idx" ON "public"."deal_context_nodes" USING "btree" ("deal_id", "analysis_id");



CREATE INDEX "deal_context_nodes_embedding_hnsw_idx" ON "public"."deal_context_nodes" USING "hnsw" ("embedding" "extensions"."vector_cosine_ops") WITH ("m"='16', "ef_construction"='64');



CREATE INDEX "deal_context_nodes_parent_idx" ON "public"."deal_context_nodes" USING "btree" ("parent_id");



CREATE INDEX "deal_context_nodes_search_gin_idx" ON "public"."deal_context_nodes" USING "gin" ("search_document");



CREATE INDEX "deal_context_nodes_type_idx" ON "public"."deal_context_nodes" USING "btree" ("deal_id", "node_type");



CREATE INDEX "deal_differentiation_deal_analysis_idx" ON "public"."deal_differentiation" USING "btree" ("deal_id", "analysis_id");



CREATE INDEX "deal_feature_provenance_feature_deal_idx" ON "public"."deal_feature_provenance" USING "btree" ("feature_id", "deal_id");



CREATE INDEX "deal_feature_values_deal_idx" ON "public"."deal_feature_values" USING "btree" ("deal_id");



CREATE INDEX "deal_feature_values_feature_idx" ON "public"."deal_feature_values" USING "btree" ("feature_id");



CREATE INDEX "deal_keywords_concepts_arr_idx" ON "public"."deal_keywords" USING "gin" ("concepts");



CREATE INDEX "deal_keywords_concepts_tsv_idx" ON "public"."deal_keywords" USING "gin" ("concepts_tsv");



CREATE INDEX "deal_tree_nodes_atomic_embedding_hnsw_idx" ON "public"."deal_tree_nodes" USING "hnsw" ("atomic_embedding" "extensions"."vector_cosine_ops") WITH ("m"='16', "ef_construction"='64');



CREATE INDEX "deal_tree_nodes_centroid_embedding_hnsw_idx" ON "public"."deal_tree_nodes" USING "hnsw" ("centroid_embedding" "extensions"."vector_cosine_ops") WITH ("m"='16', "ef_construction"='64');



CREATE INDEX "deal_tree_nodes_deal_analysis_idx" ON "public"."deal_tree_nodes" USING "btree" ("deal_id", "analysis_id");



CREATE INDEX "deal_tree_nodes_kind_type_idx" ON "public"."deal_tree_nodes" USING "btree" ("deal_id", "kind", "node_type");



CREATE INDEX "deal_tree_nodes_parent_idx" ON "public"."deal_tree_nodes" USING "btree" ("parent_id");



CREATE INDEX "deal_tree_nodes_search_gin_idx" ON "public"."deal_tree_nodes" USING "gin" ("search_document");



CREATE INDEX "deal_tree_nodes_signal_embedding_hnsw_idx" ON "public"."deal_tree_nodes" USING "hnsw" ("signal_embedding" "extensions"."vector_cosine_ops") WITH ("m"='16', "ef_construction"='64');



CREATE INDEX "deals_deal_embedding_hnsw_idx" ON "public"."deals" USING "hnsw" ("deal_embedding" "extensions"."vector_cosine_ops") WITH ("m"='16', "ef_construction"='64');



CREATE INDEX "deals_search_tsv_idx" ON "public"."deals" USING "gin" ("search_tsv");



CREATE INDEX "dri_analysis_idx" ON "public"."deal_retrieval_index" USING "btree" ("analysis_id");



CREATE INDEX "dri_market_embedding_hnsw_idx" ON "public"."deal_retrieval_index" USING "hnsw" ("market_embedding" "extensions"."vector_cosine_ops") WITH ("m"='16', "ef_construction"='64');



CREATE INDEX "dri_problem_embedding_hnsw_idx" ON "public"."deal_retrieval_index" USING "hnsw" ("problem_embedding" "extensions"."vector_cosine_ops") WITH ("m"='16', "ef_construction"='64');



CREATE INDEX "dri_risk_embedding_hnsw_idx" ON "public"."deal_retrieval_index" USING "hnsw" ("risk_embedding" "extensions"."vector_cosine_ops") WITH ("m"='16', "ef_construction"='64');



CREATE INDEX "dri_solution_embedding_hnsw_idx" ON "public"."deal_retrieval_index" USING "hnsw" ("solution_embedding" "extensions"."vector_cosine_ops") WITH ("m"='16', "ef_construction"='64');



CREATE INDEX "emails_deleted_at_idx" ON "public"."emails" USING "btree" ("deleted_at") WHERE ("deleted_at" IS NULL);



CREATE INDEX "gmail_connections_email_idx" ON "public"."gmail_connections" USING "btree" ("email");



CREATE INDEX "idx_user_spreadsheets_user_updated" ON "public"."user_spreadsheets" USING "btree" ("user_id", "updated_at" DESC);



CREATE INDEX "investment_rule_documents_user_id_idx" ON "public"."investment_rule_documents" USING "btree" ("user_id");



CREATE INDEX "investment_rules_document_id_idx" ON "public"."investment_rules" USING "btree" ("document_id");



CREATE INDEX "investment_rules_user_id_idx" ON "public"."investment_rules" USING "btree" ("user_id");



CREATE INDEX "keyword_clusters_medoid_embedding_hnsw_idx" ON "public"."keyword_clusters" USING "hnsw" ("medoid_embedding" "extensions"."vector_cosine_ops") WITH ("m"='16', "ef_construction"='64');



CREATE INDEX "pitch_deck_results_composite_score_idx" ON "public"."pitch_deck_results" USING "btree" ("composite_score" DESC);



CREATE INDEX "pitch_deck_results_email_id_idx" ON "public"."pitch_deck_results" USING "btree" ("email_id");



CREATE OR REPLACE TRIGGER "deal_intel_claim_fts" BEFORE INSERT OR UPDATE OF "quote", "key", "claim_type" ON "deal_intel"."claim" FOR EACH ROW EXECUTE FUNCTION "deal_intel"."set_claim_search_document"();



CREATE OR REPLACE TRIGGER "deal_intel_company_makeup_updated_at" BEFORE UPDATE ON "deal_intel"."company_makeup" FOR EACH ROW EXECUTE FUNCTION "deal_intel"."set_updated_at"();



CREATE OR REPLACE TRIGGER "deal_intel_company_negative_updated_at" BEFORE UPDATE ON "deal_intel"."company_negative" FOR EACH ROW EXECUTE FUNCTION "deal_intel"."set_updated_at"();



CREATE OR REPLACE TRIGGER "deal_intel_company_origin_story_updated_at" BEFORE UPDATE ON "deal_intel"."company_origin_story" FOR EACH ROW EXECUTE FUNCTION "deal_intel"."set_updated_at"();



CREATE OR REPLACE TRIGGER "deal_intel_company_person_updated_at" BEFORE UPDATE ON "deal_intel"."company_person" FOR EACH ROW EXECUTE FUNCTION "deal_intel"."set_updated_at"();



CREATE OR REPLACE TRIGGER "deal_intel_company_problem_updated_at" BEFORE UPDATE ON "deal_intel"."company_problem" FOR EACH ROW EXECUTE FUNCTION "deal_intel"."set_updated_at"();



CREATE OR REPLACE TRIGGER "deal_intel_company_solution_updated_at" BEFORE UPDATE ON "deal_intel"."company_solution" FOR EACH ROW EXECUTE FUNCTION "deal_intel"."set_updated_at"();



CREATE OR REPLACE TRIGGER "deal_intel_company_traction_updated_at" BEFORE UPDATE ON "deal_intel"."company_traction" FOR EACH ROW EXECUTE FUNCTION "deal_intel"."set_updated_at"();



CREATE OR REPLACE TRIGGER "deal_intel_deal_fact_node_fts" BEFORE INSERT OR UPDATE OF "value_text", "value_jsonb", "embedding_input", "keywords" ON "deal_intel"."deal_fact_node" FOR EACH ROW EXECUTE FUNCTION "deal_intel"."set_deal_fact_node_search_document"();



CREATE OR REPLACE TRIGGER "deal_intel_deal_fact_node_updated_at" BEFORE UPDATE ON "deal_intel"."deal_fact_node" FOR EACH ROW EXECUTE FUNCTION "deal_intel"."set_updated_at"();



CREATE OR REPLACE TRIGGER "deal_intel_deal_tree_node_fts" BEFORE INSERT OR UPDATE OF "narrative_text", "value_jsonb", "node_path", "keywords" ON "deal_intel"."deal_tree_node" FOR EACH ROW EXECUTE FUNCTION "deal_intel"."set_deal_tree_node_search_document"();



CREATE OR REPLACE TRIGGER "deal_intel_deal_tree_node_updated_at" BEFORE UPDATE ON "deal_intel"."deal_tree_node" FOR EACH ROW EXECUTE FUNCTION "deal_intel"."set_updated_at"();



CREATE OR REPLACE TRIGGER "deal_intel_deal_updated_at" BEFORE UPDATE ON "deal_intel"."deal" FOR EACH ROW EXECUTE FUNCTION "deal_intel"."set_updated_at"();



CREATE OR REPLACE TRIGGER "deal_intel_document_chunk_fts" BEFORE INSERT OR UPDATE OF "text", "keywords" ON "deal_intel"."document_chunk" FOR EACH ROW EXECUTE FUNCTION "deal_intel"."set_document_chunk_search_document"();



CREATE OR REPLACE TRIGGER "deal_intel_document_updated_at" BEFORE UPDATE ON "deal_intel"."document" FOR EACH ROW EXECUTE FUNCTION "deal_intel"."set_updated_at"();



CREATE OR REPLACE TRIGGER "deal_intel_meeting_session_updated_at" BEFORE UPDATE ON "deal_intel"."meeting_session" FOR EACH ROW EXECUTE FUNCTION "deal_intel"."set_updated_at"();



CREATE OR REPLACE TRIGGER "deal_intel_research_step_updated_at" BEFORE UPDATE ON "deal_intel"."deal_research_step" FOR EACH ROW EXECUTE FUNCTION "deal_intel"."set_updated_at"();



CREATE OR REPLACE TRIGGER "deal_intel_research_workflow_updated_at" BEFORE UPDATE ON "deal_intel"."deal_research_workflow" FOR EACH ROW EXECUTE FUNCTION "deal_intel"."set_updated_at"();



CREATE OR REPLACE TRIGGER "deal_intel_user_agent_preference_updated_at" BEFORE UPDATE ON "deal_intel"."user_agent_preference" FOR EACH ROW EXECUTE FUNCTION "deal_intel"."set_updated_at"();



CREATE OR REPLACE TRIGGER "deal_intel_user_investment_preference_updated_at" BEFORE UPDATE ON "deal_intel"."user_investment_preference" FOR EACH ROW EXECUTE FUNCTION "deal_intel"."set_updated_at"();



CREATE OR REPLACE TRIGGER "deal_intel_user_research_pref_updated_at" BEFORE UPDATE ON "deal_intel"."user_research_site_preference" FOR EACH ROW EXECUTE FUNCTION "deal_intel"."set_updated_at"();



CREATE OR REPLACE TRIGGER "deal_intel_user_website_preference_embedding_updated_at" BEFORE UPDATE ON "deal_intel"."user_website_preference_embedding" FOR EACH ROW EXECUTE FUNCTION "deal_intel"."set_updated_at"();



CREATE OR REPLACE TRIGGER "deal_intel_user_website_preference_updated_at" BEFORE UPDATE ON "deal_intel"."user_website_preference" FOR EACH ROW EXECUTE FUNCTION "deal_intel"."set_updated_at"();



CREATE OR REPLACE TRIGGER "deal_keywords_tsv_trigger" BEFORE INSERT OR UPDATE OF "concepts" ON "public"."deal_keywords" FOR EACH ROW EXECUTE FUNCTION "public"."set_deal_keywords_tsv"();



CREATE OR REPLACE TRIGGER "deal_tree_nodes_search_document_trigger" BEFORE INSERT OR UPDATE OF "narrative_text", "structured_text", "node_key", "node_value_text", "keywords" ON "public"."deal_tree_nodes" FOR EACH ROW EXECUTE FUNCTION "public"."set_deal_tree_nodes_search_document"();



ALTER TABLE ONLY "deal_intel"."claim"
    ADD CONSTRAINT "claim_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal_intel"."deal"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "deal_intel"."claim"
    ADD CONSTRAINT "claim_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "deal_intel"."document"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."claim"
    ADD CONSTRAINT "claim_sentence_id_fkey" FOREIGN KEY ("sentence_id") REFERENCES "deal_intel"."document_sentence"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "deal_intel"."claim"
    ADD CONSTRAINT "claim_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."company_fact"
    ADD CONSTRAINT "company_fact_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal_intel"."deal"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."company_fact"
    ADD CONSTRAINT "company_fact_source_claim_id_fkey" FOREIGN KEY ("source_claim_id") REFERENCES "deal_intel"."claim"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "deal_intel"."company_makeup"
    ADD CONSTRAINT "company_makeup_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal_intel"."deal"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."company_makeup"
    ADD CONSTRAINT "company_makeup_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "deal_intel"."deal_revision"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "deal_intel"."company_negative"
    ADD CONSTRAINT "company_negative_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal_intel"."deal"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."company_negative"
    ADD CONSTRAINT "company_negative_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "deal_intel"."deal_revision"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "deal_intel"."company_origin_story"
    ADD CONSTRAINT "company_origin_story_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal_intel"."deal"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."company_origin_story"
    ADD CONSTRAINT "company_origin_story_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "deal_intel"."deal_revision"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "deal_intel"."company_person"
    ADD CONSTRAINT "company_person_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal_intel"."deal"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."company_person"
    ADD CONSTRAINT "company_person_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "deal_intel"."deal_revision"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "deal_intel"."company_problem"
    ADD CONSTRAINT "company_problem_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal_intel"."deal"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."company_problem"
    ADD CONSTRAINT "company_problem_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "deal_intel"."deal_revision"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "deal_intel"."company_solution"
    ADD CONSTRAINT "company_solution_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal_intel"."deal"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."company_solution"
    ADD CONSTRAINT "company_solution_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "deal_intel"."deal_revision"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "deal_intel"."company_traction"
    ADD CONSTRAINT "company_traction_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal_intel"."deal"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."company_traction"
    ADD CONSTRAINT "company_traction_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "deal_intel"."deal_revision"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "deal_intel"."deal_fact_edge"
    ADD CONSTRAINT "deal_fact_edge_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal_intel"."deal"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."deal_fact_edge"
    ADD CONSTRAINT "deal_fact_edge_dst_node_id_fkey" FOREIGN KEY ("dst_node_id") REFERENCES "deal_intel"."deal_fact_node"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."deal_fact_edge"
    ADD CONSTRAINT "deal_fact_edge_src_node_id_fkey" FOREIGN KEY ("src_node_id") REFERENCES "deal_intel"."deal_fact_node"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."deal_fact_node"
    ADD CONSTRAINT "deal_fact_node_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal_intel"."deal"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."deal_fact_node"
    ADD CONSTRAINT "deal_fact_node_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "deal_intel"."deal_fact_node"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."deal_research_feedback"
    ADD CONSTRAINT "deal_research_feedback_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."deal_research_feedback"
    ADD CONSTRAINT "deal_research_feedback_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "deal_intel"."deal_research_workflow"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."deal_research_step_run"
    ADD CONSTRAINT "deal_research_step_run_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "deal_intel"."deal_research_step"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."deal_research_step_run"
    ADD CONSTRAINT "deal_research_step_run_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "deal_intel"."deal_research_workflow"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."deal_research_step"
    ADD CONSTRAINT "deal_research_step_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "deal_intel"."deal_research_workflow"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."deal_research_workflow"
    ADD CONSTRAINT "deal_research_workflow_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal_intel"."deal"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."deal_research_workflow"
    ADD CONSTRAINT "deal_research_workflow_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."deal_revision"
    ADD CONSTRAINT "deal_revision_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal_intel"."deal"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."deal_tree_edge"
    ADD CONSTRAINT "deal_tree_edge_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal_intel"."deal"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."deal_tree_edge"
    ADD CONSTRAINT "deal_tree_edge_dst_node_id_fkey" FOREIGN KEY ("dst_node_id") REFERENCES "deal_intel"."deal_tree_node"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."deal_tree_edge"
    ADD CONSTRAINT "deal_tree_edge_src_node_id_fkey" FOREIGN KEY ("src_node_id") REFERENCES "deal_intel"."deal_tree_node"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."deal_tree_node"
    ADD CONSTRAINT "deal_tree_node_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal_intel"."deal"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."deal_tree_node"
    ADD CONSTRAINT "deal_tree_node_fact_section_root_id_fkey" FOREIGN KEY ("fact_section_root_id") REFERENCES "deal_intel"."deal_fact_node"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "deal_intel"."deal_tree_node"
    ADD CONSTRAINT "deal_tree_node_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "deal_intel"."deal_tree_node"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."deal_tree_node"
    ADD CONSTRAINT "deal_tree_node_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "deal_intel"."deal_revision"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "deal_intel"."deal"
    ADD CONSTRAINT "deal_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."document_chunk"
    ADD CONSTRAINT "document_chunk_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "deal_intel"."document"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."document"
    ADD CONSTRAINT "document_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal_intel"."deal"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "deal_intel"."document_page"
    ADD CONSTRAINT "document_page_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "deal_intel"."document"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."document_sentence"
    ADD CONSTRAINT "document_sentence_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "deal_intel"."document"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."document"
    ADD CONSTRAINT "document_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."keyword_cluster"
    ADD CONSTRAINT "keyword_cluster_representative_term_id_fkey" FOREIGN KEY ("representative_term_id") REFERENCES "deal_intel"."keyword_term"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "deal_intel"."keyword_term_cluster_membership"
    ADD CONSTRAINT "keyword_term_cluster_membership_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "deal_intel"."keyword_cluster"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."keyword_term_cluster_membership"
    ADD CONSTRAINT "keyword_term_cluster_membership_term_id_fkey" FOREIGN KEY ("term_id") REFERENCES "deal_intel"."keyword_term"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."meeting_assistant_event"
    ADD CONSTRAINT "meeting_assistant_event_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "deal_intel"."meeting_session"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."meeting_participant"
    ADD CONSTRAINT "meeting_participant_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "deal_intel"."meeting_session"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."meeting_session"
    ADD CONSTRAINT "meeting_session_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal_intel"."deal"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."meeting_session"
    ADD CONSTRAINT "meeting_session_host_user_id_fkey" FOREIGN KEY ("host_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."meeting_transcript_segment"
    ADD CONSTRAINT "meeting_transcript_segment_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "deal_intel"."meeting_session"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."user_agent_preference"
    ADD CONSTRAINT "user_agent_preference_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."user_investment_preference"
    ADD CONSTRAINT "user_investment_preference_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."user_research_site_preference"
    ADD CONSTRAINT "user_research_site_preference_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."user_website_preference_embedding"
    ADD CONSTRAINT "user_website_preference_embedding_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "deal_intel"."user_website_preference"
    ADD CONSTRAINT "user_website_preference_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."analysis_status"
    ADD CONSTRAINT "analysis_status_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "public"."deal_analyses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."chat_messages"
    ADD CONSTRAINT "chat_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."chat_threads"
    ADD CONSTRAINT "chat_threads_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."chat_threads"
    ADD CONSTRAINT "chat_threads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contact_edges"
    ADD CONSTRAINT "contact_edges_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."fund_contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contact_edges"
    ADD CONSTRAINT "contact_edges_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contact_edges"
    ADD CONSTRAINT "contact_edges_founder_id_fkey" FOREIGN KEY ("founder_id") REFERENCES "public"."founders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contact_employment"
    ADD CONSTRAINT "contact_employment_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."fund_contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contradictions"
    ADD CONSTRAINT "contradictions_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "public"."deal_analyses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contradictions"
    ADD CONSTRAINT "contradictions_claim_a_id_fkey" FOREIGN KEY ("claim_a_id") REFERENCES "public"."deal_claims"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contradictions"
    ADD CONSTRAINT "contradictions_claim_b_id_fkey" FOREIGN KEY ("claim_b_id") REFERENCES "public"."deal_claims"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contradictions"
    ADD CONSTRAINT "contradictions_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_analyses"
    ADD CONSTRAINT "deal_analyses_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_assumptions"
    ADD CONSTRAINT "deal_assumptions_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "public"."deal_analyses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_assumptions"
    ADD CONSTRAINT "deal_assumptions_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_claims"
    ADD CONSTRAINT "deal_claims_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "public"."deal_analyses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_claims"
    ADD CONSTRAINT "deal_claims_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_competitors"
    ADD CONSTRAINT "deal_competitors_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "public"."deal_analyses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_competitors"
    ADD CONSTRAINT "deal_competitors_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_context_nodes"
    ADD CONSTRAINT "deal_context_nodes_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "public"."deal_analyses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_context_nodes"
    ADD CONSTRAINT "deal_context_nodes_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_context_nodes"
    ADD CONSTRAINT "deal_context_nodes_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."deal_context_nodes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_differentiation"
    ADD CONSTRAINT "deal_differentiation_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "public"."deal_analyses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_differentiation"
    ADD CONSTRAINT "deal_differentiation_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_entities"
    ADD CONSTRAINT "deal_entities_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_feature_definitions"
    ADD CONSTRAINT "deal_feature_definitions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_feature_provenance"
    ADD CONSTRAINT "deal_feature_provenance_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_feature_provenance"
    ADD CONSTRAINT "deal_feature_provenance_feature_id_fkey" FOREIGN KEY ("feature_id") REFERENCES "public"."deal_feature_definitions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_feature_provenance"
    ADD CONSTRAINT "deal_feature_provenance_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "public"."deal_context_nodes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."deal_feature_provenance"
    ADD CONSTRAINT "deal_feature_provenance_prompt_run_id_fkey" FOREIGN KEY ("prompt_run_id") REFERENCES "public"."deal_prompt_runs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."deal_feature_values"
    ADD CONSTRAINT "deal_feature_values_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_feature_values"
    ADD CONSTRAINT "deal_feature_values_feature_id_fkey" FOREIGN KEY ("feature_id") REFERENCES "public"."deal_feature_definitions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_flags"
    ADD CONSTRAINT "deal_flags_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "public"."deal_analyses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_flags"
    ADD CONSTRAINT "deal_flags_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_investors"
    ADD CONSTRAINT "deal_investors_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_investors"
    ADD CONSTRAINT "deal_investors_investor_id_fkey" FOREIGN KEY ("investor_id") REFERENCES "public"."investors"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_keywords"
    ADD CONSTRAINT "deal_keywords_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "public"."deal_analyses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_keywords"
    ADD CONSTRAINT "deal_keywords_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_metrics"
    ADD CONSTRAINT "deal_metrics_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_pipeline_json_core_assumptions"
    ADD CONSTRAINT "deal_pipeline_json_core_assumptions_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "public"."deal_analyses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_pipeline_json_core_assumptions"
    ADD CONSTRAINT "deal_pipeline_json_core_assumptions_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_pipeline_json_founder_signals"
    ADD CONSTRAINT "deal_pipeline_json_founder_signals_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "public"."deal_analyses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_pipeline_json_founder_signals"
    ADD CONSTRAINT "deal_pipeline_json_founder_signals_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_pipeline_json_market_power"
    ADD CONSTRAINT "deal_pipeline_json_market_power_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "public"."deal_analyses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_pipeline_json_market_power"
    ADD CONSTRAINT "deal_pipeline_json_market_power_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_pipeline_json_parsing"
    ADD CONSTRAINT "deal_pipeline_json_parsing_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "public"."deal_analyses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_pipeline_json_parsing"
    ADD CONSTRAINT "deal_pipeline_json_parsing_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_pipeline_json_problem_3c"
    ADD CONSTRAINT "deal_pipeline_json_problem_3c_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "public"."deal_analyses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_pipeline_json_problem_3c"
    ADD CONSTRAINT "deal_pipeline_json_problem_3c_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_pipeline_json_questions_combined"
    ADD CONSTRAINT "deal_pipeline_json_questions_combined_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "public"."deal_analyses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_pipeline_json_questions_combined"
    ADD CONSTRAINT "deal_pipeline_json_questions_combined_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_pipeline_json_solution_3d"
    ADD CONSTRAINT "deal_pipeline_json_solution_3d_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "public"."deal_analyses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_pipeline_json_solution_3d"
    ADD CONSTRAINT "deal_pipeline_json_solution_3d_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_pipeline_json_summaries"
    ADD CONSTRAINT "deal_pipeline_json_summaries_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "public"."deal_analyses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_pipeline_json_summaries"
    ADD CONSTRAINT "deal_pipeline_json_summaries_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_pipeline_json_thesis_fit"
    ADD CONSTRAINT "deal_pipeline_json_thesis_fit_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "public"."deal_analyses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_pipeline_json_thesis_fit"
    ADD CONSTRAINT "deal_pipeline_json_thesis_fit_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_pipeline_json_traction_signals"
    ADD CONSTRAINT "deal_pipeline_json_traction_signals_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "public"."deal_analyses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_pipeline_json_traction_signals"
    ADD CONSTRAINT "deal_pipeline_json_traction_signals_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_problem"
    ADD CONSTRAINT "deal_problem_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "public"."deal_analyses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_problem"
    ADD CONSTRAINT "deal_problem_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_prompt_runs"
    ADD CONSTRAINT "deal_prompt_runs_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "public"."deal_analyses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_prompt_runs"
    ADD CONSTRAINT "deal_prompt_runs_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_questions"
    ADD CONSTRAINT "deal_questions_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "public"."deal_analyses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_questions"
    ADD CONSTRAINT "deal_questions_assumption_id_fkey" FOREIGN KEY ("assumption_id") REFERENCES "public"."deal_assumptions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."deal_questions"
    ADD CONSTRAINT "deal_questions_contradiction_id_fkey" FOREIGN KEY ("contradiction_id") REFERENCES "public"."contradictions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."deal_questions"
    ADD CONSTRAINT "deal_questions_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_questions"
    ADD CONSTRAINT "deal_questions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "public"."question_templates"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."deal_retrieval_index"
    ADD CONSTRAINT "deal_retrieval_index_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "public"."deal_analyses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_retrieval_index"
    ADD CONSTRAINT "deal_retrieval_index_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_scores"
    ADD CONSTRAINT "deal_scores_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "public"."deal_analyses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_scores"
    ADD CONSTRAINT "deal_scores_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_solution"
    ADD CONSTRAINT "deal_solution_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "public"."deal_analyses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_solution"
    ADD CONSTRAINT "deal_solution_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_traction"
    ADD CONSTRAINT "deal_traction_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "public"."deal_analyses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_traction"
    ADD CONSTRAINT "deal_traction_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_tree_nodes"
    ADD CONSTRAINT "deal_tree_nodes_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "public"."deal_analyses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_tree_nodes"
    ADD CONSTRAINT "deal_tree_nodes_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deal_tree_nodes"
    ADD CONSTRAINT "deal_tree_nodes_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."deal_tree_nodes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deals"
    ADD CONSTRAINT "deals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."emails"
    ADD CONSTRAINT "emails_gmail_connection_id_fkey" FOREIGN KEY ("gmail_connection_id") REFERENCES "public"."gmail_connections"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."founder_employment"
    ADD CONSTRAINT "founder_employment_founder_id_fkey" FOREIGN KEY ("founder_id") REFERENCES "public"."founders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."founders"
    ADD CONSTRAINT "founders_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."fund_thesis"
    ADD CONSTRAINT "fund_thesis_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."fund_thesis_v2"
    ADD CONSTRAINT "fund_thesis_v2_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."gmail_connections"
    ADD CONSTRAINT "gmail_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."investment_memos"
    ADD CONSTRAINT "investment_memos_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "public"."deal_analyses"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."investment_memos"
    ADD CONSTRAINT "investment_memos_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."investment_rule_documents"
    ADD CONSTRAINT "investment_rule_documents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."investment_rules"
    ADD CONSTRAINT "investment_rules_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."investment_rule_documents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."investment_rules"
    ADD CONSTRAINT "investment_rules_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."investor_patterns"
    ADD CONSTRAINT "investor_patterns_investor_id_fkey" FOREIGN KEY ("investor_id") REFERENCES "public"."investors"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."meetings"
    ADD CONSTRAINT "meetings_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pitch_deck_results"
    ADD CONSTRAINT "pitch_deck_results_email_id_fkey" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."question_outcomes"
    ADD CONSTRAINT "question_outcomes_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."question_outcomes"
    ADD CONSTRAINT "question_outcomes_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "public"."deal_questions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."scoring_rubrics"
    ADD CONSTRAINT "scoring_rubrics_thesis_id_fkey" FOREIGN KEY ("thesis_id") REFERENCES "public"."fund_thesis_v2"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."thesis_rules"
    ADD CONSTRAINT "thesis_rules_thesis_id_fkey" FOREIGN KEY ("thesis_id") REFERENCES "public"."fund_thesis_v2"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_investment_rules_context"
    ADD CONSTRAINT "user_investment_rules_context_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_spreadsheets"
    ADD CONSTRAINT "user_spreadsheets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE "deal_intel"."claim" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "deal_intel"."company_fact" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "deal_intel"."company_makeup" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "deal_intel"."company_negative" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "deal_intel"."company_origin_story" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "deal_intel"."company_person" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "deal_intel"."company_problem" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "deal_intel"."company_solution" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "deal_intel"."company_traction" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "deal_intel"."deal" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "deal_intel"."deal_fact_edge" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "deal_intel"."deal_fact_node" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "deal_intel.claim delete own" ON "deal_intel"."claim" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "deal_intel.claim insert own" ON "deal_intel"."claim" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "deal_intel.claim select own" ON "deal_intel"."claim" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "deal_intel.claim update own" ON "deal_intel"."claim" FOR UPDATE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "deal_intel.company_fact delete own" ON "deal_intel"."company_fact" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "company_fact"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.company_fact insert own" ON "deal_intel"."company_fact" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "company_fact"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.company_fact select own" ON "deal_intel"."company_fact" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "company_fact"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.company_fact update own" ON "deal_intel"."company_fact" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "company_fact"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.company_makeup select own" ON "deal_intel"."company_makeup" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "company_makeup"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.company_makeup upsert own" ON "deal_intel"."company_makeup" USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "company_makeup"."deal_id") AND ("d"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "company_makeup"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.company_negative select own" ON "deal_intel"."company_negative" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "company_negative"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.company_negative upsert own" ON "deal_intel"."company_negative" USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "company_negative"."deal_id") AND ("d"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "company_negative"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.company_origin_story select own" ON "deal_intel"."company_origin_story" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "company_origin_story"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.company_origin_story upsert own" ON "deal_intel"."company_origin_story" USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "company_origin_story"."deal_id") AND ("d"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "company_origin_story"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.company_person delete own" ON "deal_intel"."company_person" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "company_person"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.company_person insert own" ON "deal_intel"."company_person" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "company_person"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.company_person select own" ON "deal_intel"."company_person" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "company_person"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.company_person update own" ON "deal_intel"."company_person" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "company_person"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.company_problem select own" ON "deal_intel"."company_problem" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "company_problem"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.company_problem upsert own" ON "deal_intel"."company_problem" USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "company_problem"."deal_id") AND ("d"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "company_problem"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.company_solution select own" ON "deal_intel"."company_solution" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "company_solution"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.company_solution upsert own" ON "deal_intel"."company_solution" USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "company_solution"."deal_id") AND ("d"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "company_solution"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.company_traction select own" ON "deal_intel"."company_traction" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "company_traction"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.company_traction upsert own" ON "deal_intel"."company_traction" USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "company_traction"."deal_id") AND ("d"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "company_traction"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.deal delete own" ON "deal_intel"."deal" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "deal_intel.deal insert own" ON "deal_intel"."deal" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "deal_intel.deal select own" ON "deal_intel"."deal" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "deal_intel.deal update own" ON "deal_intel"."deal" FOR UPDATE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "deal_intel.deal_fact_edge delete own" ON "deal_intel"."deal_fact_edge" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "deal_fact_edge"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.deal_fact_edge insert own" ON "deal_intel"."deal_fact_edge" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "deal_fact_edge"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.deal_fact_edge select own" ON "deal_intel"."deal_fact_edge" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "deal_fact_edge"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.deal_fact_edge update own" ON "deal_intel"."deal_fact_edge" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "deal_fact_edge"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.deal_fact_node delete own" ON "deal_intel"."deal_fact_node" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "deal_fact_node"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.deal_fact_node insert own" ON "deal_intel"."deal_fact_node" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "deal_fact_node"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.deal_fact_node select own" ON "deal_intel"."deal_fact_node" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "deal_fact_node"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.deal_fact_node update own" ON "deal_intel"."deal_fact_node" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "deal_fact_node"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.deal_revision delete own" ON "deal_intel"."deal_revision" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "deal_revision"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.deal_revision insert own" ON "deal_intel"."deal_revision" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "deal_revision"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.deal_revision select own" ON "deal_intel"."deal_revision" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "deal_revision"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.deal_revision update own" ON "deal_intel"."deal_revision" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "deal_revision"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.deal_tree_edge delete own" ON "deal_intel"."deal_tree_edge" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "deal_tree_edge"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.deal_tree_edge insert own" ON "deal_intel"."deal_tree_edge" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "deal_tree_edge"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.deal_tree_edge select own" ON "deal_intel"."deal_tree_edge" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "deal_tree_edge"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.deal_tree_edge update own" ON "deal_intel"."deal_tree_edge" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "deal_tree_edge"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.deal_tree_node delete own" ON "deal_intel"."deal_tree_node" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "deal_tree_node"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.deal_tree_node insert own" ON "deal_intel"."deal_tree_node" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "deal_tree_node"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.deal_tree_node select own" ON "deal_intel"."deal_tree_node" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "deal_tree_node"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.deal_tree_node update own" ON "deal_intel"."deal_tree_node" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "deal_tree_node"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.document delete own" ON "deal_intel"."document" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "deal_intel.document insert own" ON "deal_intel"."document" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "deal_intel.document select own" ON "deal_intel"."document" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "deal_intel.document update own" ON "deal_intel"."document" FOR UPDATE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "deal_intel.document_chunk delete own" ON "deal_intel"."document_chunk" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."document" "d"
  WHERE (("d"."id" = "document_chunk"."document_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.document_chunk insert own" ON "deal_intel"."document_chunk" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "deal_intel"."document" "d"
  WHERE (("d"."id" = "document_chunk"."document_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.document_chunk select own" ON "deal_intel"."document_chunk" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."document" "d"
  WHERE (("d"."id" = "document_chunk"."document_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.document_chunk update own" ON "deal_intel"."document_chunk" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."document" "d"
  WHERE (("d"."id" = "document_chunk"."document_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.document_page delete own" ON "deal_intel"."document_page" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."document" "d"
  WHERE (("d"."id" = "document_page"."document_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.document_page insert own" ON "deal_intel"."document_page" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "deal_intel"."document" "d"
  WHERE (("d"."id" = "document_page"."document_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.document_page select own" ON "deal_intel"."document_page" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."document" "d"
  WHERE (("d"."id" = "document_page"."document_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.document_page update own" ON "deal_intel"."document_page" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."document" "d"
  WHERE (("d"."id" = "document_page"."document_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.document_sentence delete own" ON "deal_intel"."document_sentence" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."document" "d"
  WHERE (("d"."id" = "document_sentence"."document_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.document_sentence insert own" ON "deal_intel"."document_sentence" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "deal_intel"."document" "d"
  WHERE (("d"."id" = "document_sentence"."document_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.document_sentence select own" ON "deal_intel"."document_sentence" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."document" "d"
  WHERE (("d"."id" = "document_sentence"."document_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.document_sentence update own" ON "deal_intel"."document_sentence" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."document" "d"
  WHERE (("d"."id" = "document_sentence"."document_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.keyword_cluster read" ON "deal_intel"."keyword_cluster" FOR SELECT USING (("auth"."role"() = ANY (ARRAY['authenticated'::"text", 'service_role'::"text"])));



CREATE POLICY "deal_intel.keyword_cluster write service" ON "deal_intel"."keyword_cluster" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "deal_intel.keyword_membership read" ON "deal_intel"."keyword_term_cluster_membership" FOR SELECT USING (("auth"."role"() = ANY (ARRAY['authenticated'::"text", 'service_role'::"text"])));



CREATE POLICY "deal_intel.keyword_membership write service" ON "deal_intel"."keyword_term_cluster_membership" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "deal_intel.keyword_term read" ON "deal_intel"."keyword_term" FOR SELECT USING (("auth"."role"() = ANY (ARRAY['authenticated'::"text", 'service_role'::"text"])));



CREATE POLICY "deal_intel.keyword_term write service" ON "deal_intel"."keyword_term" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "deal_intel.meeting_assistant_event read" ON "deal_intel"."meeting_assistant_event" FOR SELECT USING ("deal_intel"."user_can_access_meeting"("meeting_id"));



CREATE POLICY "deal_intel.meeting_assistant_event write" ON "deal_intel"."meeting_assistant_event" USING ("deal_intel"."user_can_access_meeting"("meeting_id")) WITH CHECK ("deal_intel"."user_can_access_meeting"("meeting_id"));



CREATE POLICY "deal_intel.meeting_participant read" ON "deal_intel"."meeting_participant" FOR SELECT USING ("deal_intel"."user_can_access_meeting"("meeting_id"));



CREATE POLICY "deal_intel.meeting_participant write" ON "deal_intel"."meeting_participant" USING ("deal_intel"."user_can_access_meeting"("meeting_id")) WITH CHECK ("deal_intel"."user_can_access_meeting"("meeting_id"));



CREATE POLICY "deal_intel.meeting_session delete own" ON "deal_intel"."meeting_session" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "meeting_session"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.meeting_session insert own" ON "deal_intel"."meeting_session" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "meeting_session"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.meeting_session select own" ON "deal_intel"."meeting_session" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "meeting_session"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.meeting_session update own" ON "deal_intel"."meeting_session" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "meeting_session"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.meeting_transcript_segment read" ON "deal_intel"."meeting_transcript_segment" FOR SELECT USING ("deal_intel"."user_can_access_meeting"("meeting_id"));



CREATE POLICY "deal_intel.meeting_transcript_segment write" ON "deal_intel"."meeting_transcript_segment" USING ("deal_intel"."user_can_access_meeting"("meeting_id")) WITH CHECK ("deal_intel"."user_can_access_meeting"("meeting_id"));



CREATE POLICY "deal_intel.research_feedback read" ON "deal_intel"."deal_research_feedback" FOR SELECT USING ("deal_intel"."user_can_access_research_workflow"("workflow_id"));



CREATE POLICY "deal_intel.research_feedback write" ON "deal_intel"."deal_research_feedback" USING (("deal_intel"."user_can_access_research_workflow"("workflow_id") AND ("user_id" = "auth"."uid"()))) WITH CHECK (("deal_intel"."user_can_access_research_workflow"("workflow_id") AND ("user_id" = "auth"."uid"())));



CREATE POLICY "deal_intel.research_step read" ON "deal_intel"."deal_research_step" FOR SELECT USING ("deal_intel"."user_can_access_research_workflow"("workflow_id"));



CREATE POLICY "deal_intel.research_step write" ON "deal_intel"."deal_research_step" USING ("deal_intel"."user_can_access_research_workflow"("workflow_id")) WITH CHECK ("deal_intel"."user_can_access_research_workflow"("workflow_id"));



CREATE POLICY "deal_intel.research_step_run read" ON "deal_intel"."deal_research_step_run" FOR SELECT USING ("deal_intel"."user_can_access_research_workflow"("workflow_id"));



CREATE POLICY "deal_intel.research_step_run write" ON "deal_intel"."deal_research_step_run" USING ("deal_intel"."user_can_access_research_workflow"("workflow_id")) WITH CHECK ("deal_intel"."user_can_access_research_workflow"("workflow_id"));



CREATE POLICY "deal_intel.research_workflow read" ON "deal_intel"."deal_research_workflow" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "deal_research_workflow"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.research_workflow write" ON "deal_intel"."deal_research_workflow" USING ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "deal_research_workflow"."deal_id") AND ("d"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "deal_intel"."deal" "d"
  WHERE (("d"."id" = "deal_research_workflow"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deal_intel.user_agent_preference select own" ON "deal_intel"."user_agent_preference" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "deal_intel.user_agent_preference upsert own" ON "deal_intel"."user_agent_preference" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "deal_intel.user_investment_preference select own" ON "deal_intel"."user_investment_preference" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "deal_intel.user_investment_preference upsert own" ON "deal_intel"."user_investment_preference" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "deal_intel.user_research_site_preference read" ON "deal_intel"."user_research_site_preference" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "deal_intel.user_research_site_preference write" ON "deal_intel"."user_research_site_preference" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "deal_intel.user_website_preference select own" ON "deal_intel"."user_website_preference" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "deal_intel.user_website_preference upsert own" ON "deal_intel"."user_website_preference" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "deal_intel.user_website_preference_embedding select own" ON "deal_intel"."user_website_preference_embedding" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "deal_intel.user_website_preference_embedding upsert own" ON "deal_intel"."user_website_preference_embedding" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "deal_intel"."deal_research_feedback" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "deal_intel"."deal_research_step" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "deal_intel"."deal_research_step_run" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "deal_intel"."deal_research_workflow" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "deal_intel"."deal_revision" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "deal_intel"."deal_tree_edge" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "deal_intel"."deal_tree_node" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "deal_intel"."document" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "deal_intel"."document_chunk" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "deal_intel"."document_page" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "deal_intel"."document_sentence" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "deal_intel"."keyword_cluster" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "deal_intel"."keyword_term" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "deal_intel"."keyword_term_cluster_membership" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "deal_intel"."meeting_assistant_event" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "deal_intel"."meeting_participant" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "deal_intel"."meeting_session" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "deal_intel"."meeting_transcript_segment" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "deal_intel"."user_agent_preference" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "deal_intel"."user_investment_preference" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "deal_intel"."user_research_site_preference" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "deal_intel"."user_website_preference" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "deal_intel"."user_website_preference_embedding" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "Users can access messages in own threads" ON "public"."chat_messages" USING ((EXISTS ( SELECT 1
   FROM "public"."chat_threads" "t"
  WHERE (("t"."id" = "chat_messages"."thread_id") AND ("t"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."chat_threads" "t"
  WHERE (("t"."id" = "chat_messages"."thread_id") AND ("t"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can delete own deal_context_nodes" ON "public"."deal_context_nodes" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_context_nodes"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can delete own deal_feature_definitions" ON "public"."deal_feature_definitions" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can delete own deal_feature_values" ON "public"."deal_feature_values" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_feature_values"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can delete own deal_keywords" ON "public"."deal_keywords" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_keywords"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can delete own deal_pipeline_json_core_assumptions" ON "public"."deal_pipeline_json_core_assumptions" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_core_assumptions"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can delete own deal_pipeline_json_founder_signals" ON "public"."deal_pipeline_json_founder_signals" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_founder_signals"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can delete own deal_pipeline_json_market_power" ON "public"."deal_pipeline_json_market_power" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_market_power"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can delete own deal_pipeline_json_parsing" ON "public"."deal_pipeline_json_parsing" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_parsing"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can delete own deal_pipeline_json_problem_3c" ON "public"."deal_pipeline_json_problem_3c" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_problem_3c"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can delete own deal_pipeline_json_questions_combined" ON "public"."deal_pipeline_json_questions_combined" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_questions_combined"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can delete own deal_pipeline_json_solution_3d" ON "public"."deal_pipeline_json_solution_3d" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_solution_3d"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can delete own deal_pipeline_json_summaries" ON "public"."deal_pipeline_json_summaries" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_summaries"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can delete own deal_pipeline_json_thesis_fit" ON "public"."deal_pipeline_json_thesis_fit" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_thesis_fit"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can delete own deal_pipeline_json_traction_signals" ON "public"."deal_pipeline_json_traction_signals" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_traction_signals"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can delete own deal_retrieval_index" ON "public"."deal_retrieval_index" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_retrieval_index"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can delete own deal_tree_nodes" ON "public"."deal_tree_nodes" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_tree_nodes"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can delete own deals" ON "public"."deals" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can delete own emails" ON "public"."emails" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."gmail_connections" "gc"
  WHERE (("gc"."id" = "emails"."gmail_connection_id") AND ("gc"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can delete own gmail_connections" ON "public"."gmail_connections" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can delete own pitch_deck_results" ON "public"."pitch_deck_results" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM ("public"."emails" "e"
     JOIN "public"."gmail_connections" "gc" ON (("gc"."id" = "e"."gmail_connection_id")))
  WHERE (("e"."id" = "pitch_deck_results"."email_id") AND ("gc"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert fund_contacts" ON "public"."fund_contacts" FOR INSERT WITH CHECK (true);



CREATE POLICY "Users can insert investors" ON "public"."investors" FOR INSERT WITH CHECK (true);



CREATE POLICY "Users can insert own analysis_status" ON "public"."analysis_status" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."deal_analyses" "da"
     JOIN "public"."deals" "d" ON (("d"."id" = "da"."deal_id")))
  WHERE (("da"."id" = "analysis_status"."analysis_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own contact_edges" ON "public"."contact_edges" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "contact_edges"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own contact_employment" ON "public"."contact_employment" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."fund_contacts" "c"
  WHERE ("c"."id" = "contact_employment"."contact_id"))));



CREATE POLICY "Users can insert own contradictions" ON "public"."contradictions" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "contradictions"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own deal_analyses" ON "public"."deal_analyses" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_analyses"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own deal_assumptions" ON "public"."deal_assumptions" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_assumptions"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own deal_claims" ON "public"."deal_claims" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_claims"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own deal_competitors" ON "public"."deal_competitors" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_competitors"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own deal_context_nodes" ON "public"."deal_context_nodes" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_context_nodes"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own deal_differentiation" ON "public"."deal_differentiation" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_differentiation"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own deal_entities" ON "public"."deal_entities" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_entities"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own deal_feature_definitions" ON "public"."deal_feature_definitions" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can insert own deal_feature_provenance" ON "public"."deal_feature_provenance" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_feature_provenance"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own deal_feature_values" ON "public"."deal_feature_values" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_feature_values"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own deal_flags" ON "public"."deal_flags" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_flags"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own deal_investors" ON "public"."deal_investors" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_investors"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own deal_keywords" ON "public"."deal_keywords" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_keywords"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own deal_metrics" ON "public"."deal_metrics" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_metrics"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own deal_pipeline_json_core_assumptions" ON "public"."deal_pipeline_json_core_assumptions" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_core_assumptions"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own deal_pipeline_json_founder_signals" ON "public"."deal_pipeline_json_founder_signals" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_founder_signals"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own deal_pipeline_json_market_power" ON "public"."deal_pipeline_json_market_power" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_market_power"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own deal_pipeline_json_parsing" ON "public"."deal_pipeline_json_parsing" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_parsing"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own deal_pipeline_json_problem_3c" ON "public"."deal_pipeline_json_problem_3c" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_problem_3c"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own deal_pipeline_json_questions_combined" ON "public"."deal_pipeline_json_questions_combined" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_questions_combined"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own deal_pipeline_json_solution_3d" ON "public"."deal_pipeline_json_solution_3d" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_solution_3d"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own deal_pipeline_json_summaries" ON "public"."deal_pipeline_json_summaries" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_summaries"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own deal_pipeline_json_thesis_fit" ON "public"."deal_pipeline_json_thesis_fit" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_thesis_fit"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own deal_pipeline_json_traction_signals" ON "public"."deal_pipeline_json_traction_signals" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_traction_signals"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own deal_problem" ON "public"."deal_problem" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_problem"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own deal_prompt_runs" ON "public"."deal_prompt_runs" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_prompt_runs"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own deal_questions" ON "public"."deal_questions" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_questions"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own deal_retrieval_index" ON "public"."deal_retrieval_index" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_retrieval_index"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own deal_scores" ON "public"."deal_scores" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_scores"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own deal_solution" ON "public"."deal_solution" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_solution"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own deal_traction" ON "public"."deal_traction" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_traction"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own deal_tree_nodes" ON "public"."deal_tree_nodes" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_tree_nodes"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own deals" ON "public"."deals" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can insert own emails" ON "public"."emails" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."gmail_connections" "gc"
  WHERE (("gc"."id" = "emails"."gmail_connection_id") AND ("gc"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own founder_employment" ON "public"."founder_employment" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."founders" "f"
     JOIN "public"."deals" "d" ON (("d"."id" = "f"."deal_id")))
  WHERE (("f"."id" = "founder_employment"."founder_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own founders" ON "public"."founders" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "founders"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own fund_thesis" ON "public"."fund_thesis" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert own fund_thesis_v2" ON "public"."fund_thesis_v2" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can insert own gmail_connections" ON "public"."gmail_connections" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert own investment_memos" ON "public"."investment_memos" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "investment_memos"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own investor_patterns" ON "public"."investor_patterns" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM (("public"."investors" "i"
     JOIN "public"."deal_investors" "di" ON (("di"."investor_id" = "i"."id")))
     JOIN "public"."deals" "d" ON (("d"."id" = "di"."deal_id")))
  WHERE (("i"."id" = "investor_patterns"."investor_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own meetings" ON "public"."meetings" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "meetings"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own pitch_deck_results" ON "public"."pitch_deck_results" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."emails" "e"
     JOIN "public"."gmail_connections" "gc" ON (("gc"."id" = "e"."gmail_connection_id")))
  WHERE (("e"."id" = "pitch_deck_results"."email_id") AND ("gc"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own question_outcomes" ON "public"."question_outcomes" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."deal_questions" "q"
     JOIN "public"."deals" "d" ON (("d"."id" = "q"."deal_id")))
  WHERE (("q"."id" = "question_outcomes"."question_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own scoring_rubrics" ON "public"."scoring_rubrics" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."fund_thesis_v2" "t"
  WHERE (("t"."id" = "scoring_rubrics"."thesis_id") AND ("t"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own thesis_rules" ON "public"."thesis_rules" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."fund_thesis_v2" "t"
  WHERE (("t"."id" = "thesis_rules"."thesis_id") AND ("t"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert question_templates" ON "public"."question_templates" FOR INSERT WITH CHECK (true);



CREATE POLICY "Users can manage own chat_threads" ON "public"."chat_threads" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can select investors" ON "public"."investors" FOR SELECT USING (true);



CREATE POLICY "Users can select own analysis_status" ON "public"."analysis_status" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."deal_analyses" "da"
     JOIN "public"."deals" "d" ON (("d"."id" = "da"."deal_id")))
  WHERE (("da"."id" = "analysis_status"."analysis_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own contact_edges" ON "public"."contact_edges" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "contact_edges"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own contact_employment" ON "public"."contact_employment" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."fund_contacts" "c"
  WHERE ("c"."id" = "contact_employment"."contact_id"))));



CREATE POLICY "Users can select own contradictions" ON "public"."contradictions" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "contradictions"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own deal_analyses" ON "public"."deal_analyses" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_analyses"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own deal_assumptions" ON "public"."deal_assumptions" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_assumptions"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own deal_claims" ON "public"."deal_claims" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_claims"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own deal_competitors" ON "public"."deal_competitors" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_competitors"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own deal_context_nodes" ON "public"."deal_context_nodes" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_context_nodes"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own deal_differentiation" ON "public"."deal_differentiation" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_differentiation"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own deal_entities" ON "public"."deal_entities" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_entities"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own deal_feature_definitions" ON "public"."deal_feature_definitions" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can select own deal_feature_provenance" ON "public"."deal_feature_provenance" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_feature_provenance"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own deal_feature_values" ON "public"."deal_feature_values" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_feature_values"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own deal_flags" ON "public"."deal_flags" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_flags"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own deal_investors" ON "public"."deal_investors" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_investors"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own deal_keywords" ON "public"."deal_keywords" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_keywords"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own deal_metrics" ON "public"."deal_metrics" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_metrics"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own deal_pipeline_json_core_assumptions" ON "public"."deal_pipeline_json_core_assumptions" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_core_assumptions"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own deal_pipeline_json_founder_signals" ON "public"."deal_pipeline_json_founder_signals" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_founder_signals"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own deal_pipeline_json_market_power" ON "public"."deal_pipeline_json_market_power" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_market_power"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own deal_pipeline_json_parsing" ON "public"."deal_pipeline_json_parsing" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_parsing"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own deal_pipeline_json_problem_3c" ON "public"."deal_pipeline_json_problem_3c" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_problem_3c"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own deal_pipeline_json_questions_combined" ON "public"."deal_pipeline_json_questions_combined" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_questions_combined"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own deal_pipeline_json_solution_3d" ON "public"."deal_pipeline_json_solution_3d" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_solution_3d"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own deal_pipeline_json_summaries" ON "public"."deal_pipeline_json_summaries" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_summaries"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own deal_pipeline_json_thesis_fit" ON "public"."deal_pipeline_json_thesis_fit" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_thesis_fit"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own deal_pipeline_json_traction_signals" ON "public"."deal_pipeline_json_traction_signals" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_traction_signals"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own deal_problem" ON "public"."deal_problem" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_problem"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own deal_prompt_runs" ON "public"."deal_prompt_runs" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_prompt_runs"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own deal_questions" ON "public"."deal_questions" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_questions"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own deal_retrieval_index" ON "public"."deal_retrieval_index" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_retrieval_index"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own deal_scores" ON "public"."deal_scores" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_scores"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own deal_solution" ON "public"."deal_solution" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_solution"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own deal_traction" ON "public"."deal_traction" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_traction"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own deal_tree_nodes" ON "public"."deal_tree_nodes" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_tree_nodes"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own deals" ON "public"."deals" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can select own founder_employment" ON "public"."founder_employment" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."founders" "f"
     JOIN "public"."deals" "d" ON (("d"."id" = "f"."deal_id")))
  WHERE (("f"."id" = "founder_employment"."founder_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own founders" ON "public"."founders" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "founders"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own fund_contacts" ON "public"."fund_contacts" FOR SELECT USING (true);



CREATE POLICY "Users can select own fund_thesis_v2" ON "public"."fund_thesis_v2" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can select own investment_memos" ON "public"."investment_memos" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "investment_memos"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own investor_patterns" ON "public"."investor_patterns" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM (("public"."investors" "i"
     JOIN "public"."deal_investors" "di" ON (("di"."investor_id" = "i"."id")))
     JOIN "public"."deals" "d" ON (("d"."id" = "di"."deal_id")))
  WHERE (("i"."id" = "investor_patterns"."investor_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own meetings" ON "public"."meetings" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "meetings"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own question_outcomes" ON "public"."question_outcomes" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."deal_questions" "q"
     JOIN "public"."deals" "d" ON (("d"."id" = "q"."deal_id")))
  WHERE (("q"."id" = "question_outcomes"."question_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own question_templates" ON "public"."question_templates" FOR SELECT USING (true);



CREATE POLICY "Users can select own scoring_rubrics" ON "public"."scoring_rubrics" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."fund_thesis_v2" "t"
  WHERE (("t"."id" = "scoring_rubrics"."thesis_id") AND ("t"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can select own thesis_rules" ON "public"."thesis_rules" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."fund_thesis_v2" "t"
  WHERE (("t"."id" = "thesis_rules"."thesis_id") AND ("t"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can update own analysis_status" ON "public"."analysis_status" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM ("public"."deal_analyses" "da"
     JOIN "public"."deals" "d" ON (("d"."id" = "da"."deal_id")))
  WHERE (("da"."id" = "analysis_status"."analysis_id") AND ("d"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."deal_analyses" "da"
     JOIN "public"."deals" "d" ON (("d"."id" = "da"."deal_id")))
  WHERE (("da"."id" = "analysis_status"."analysis_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can update own deal_context_nodes" ON "public"."deal_context_nodes" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_context_nodes"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can update own deal_feature_definitions" ON "public"."deal_feature_definitions" FOR UPDATE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can update own deal_feature_values" ON "public"."deal_feature_values" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_feature_values"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can update own deal_keywords" ON "public"."deal_keywords" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_keywords"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can update own deal_pipeline_json_core_assumptions" ON "public"."deal_pipeline_json_core_assumptions" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_core_assumptions"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can update own deal_pipeline_json_founder_signals" ON "public"."deal_pipeline_json_founder_signals" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_founder_signals"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can update own deal_pipeline_json_market_power" ON "public"."deal_pipeline_json_market_power" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_market_power"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can update own deal_pipeline_json_parsing" ON "public"."deal_pipeline_json_parsing" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_parsing"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can update own deal_pipeline_json_problem_3c" ON "public"."deal_pipeline_json_problem_3c" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_problem_3c"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can update own deal_pipeline_json_questions_combined" ON "public"."deal_pipeline_json_questions_combined" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_questions_combined"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can update own deal_pipeline_json_solution_3d" ON "public"."deal_pipeline_json_solution_3d" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_solution_3d"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can update own deal_pipeline_json_summaries" ON "public"."deal_pipeline_json_summaries" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_summaries"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can update own deal_pipeline_json_thesis_fit" ON "public"."deal_pipeline_json_thesis_fit" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_thesis_fit"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can update own deal_pipeline_json_traction_signals" ON "public"."deal_pipeline_json_traction_signals" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_pipeline_json_traction_signals"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can update own deal_retrieval_index" ON "public"."deal_retrieval_index" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_retrieval_index"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can update own deal_tree_nodes" ON "public"."deal_tree_nodes" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."deals" "d"
  WHERE (("d"."id" = "deal_tree_nodes"."deal_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can update own deals" ON "public"."deals" FOR UPDATE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can update own fund_thesis" ON "public"."fund_thesis" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update own gmail_connections" ON "public"."gmail_connections" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update own pitch_deck_results" ON "public"."pitch_deck_results" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM ("public"."emails" "e"
     JOIN "public"."gmail_connections" "gc" ON (("gc"."id" = "e"."gmail_connection_id")))
  WHERE (("e"."id" = "pitch_deck_results"."email_id") AND ("gc"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can view own emails" ON "public"."emails" FOR SELECT USING ((("deleted_at" IS NULL) AND (EXISTS ( SELECT 1
   FROM "public"."gmail_connections" "gc"
  WHERE (("gc"."id" = "emails"."gmail_connection_id") AND ("gc"."user_id" = "auth"."uid"()))))));



CREATE POLICY "Users can view own fund_thesis" ON "public"."fund_thesis" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own gmail_connections" ON "public"."gmail_connections" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own pitch_deck_results" ON "public"."pitch_deck_results" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."emails" "e"
     JOIN "public"."gmail_connections" "gc" ON (("gc"."id" = "e"."gmail_connection_id")))
  WHERE (("e"."id" = "pitch_deck_results"."email_id") AND ("gc"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users delete own spreadsheets" ON "public"."user_spreadsheets" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users insert own spreadsheets" ON "public"."user_spreadsheets" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users manage own investment_rule_documents" ON "public"."investment_rule_documents" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users manage own investment_rules" ON "public"."investment_rules" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users manage own user_investment_rules_context" ON "public"."user_investment_rules_context" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users select own spreadsheets" ON "public"."user_spreadsheets" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users update own spreadsheets" ON "public"."user_spreadsheets" FOR UPDATE USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."_deal_tree_legacy_map" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."analysis_status" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."chat_messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."chat_threads" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."contact_edges" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."contact_employment" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."contradictions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deal_analyses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deal_assumptions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deal_claims" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deal_competitors" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deal_context_nodes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deal_differentiation" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deal_entities" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deal_feature_definitions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deal_feature_provenance" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deal_feature_values" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deal_flags" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deal_investors" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deal_keywords" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deal_metrics" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deal_pipeline_json_core_assumptions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deal_pipeline_json_founder_signals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deal_pipeline_json_market_power" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deal_pipeline_json_parsing" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deal_pipeline_json_problem_3c" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deal_pipeline_json_questions_combined" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deal_pipeline_json_solution_3d" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deal_pipeline_json_summaries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deal_pipeline_json_thesis_fit" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deal_pipeline_json_traction_signals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deal_problem" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deal_prompt_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deal_questions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deal_retrieval_index" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deal_scores" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deal_solution" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deal_traction" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deal_tree_nodes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."emails" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."founder_employment" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."founders" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."fund_contacts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."fund_thesis" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."fund_thesis_v2" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."gmail_connections" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."investment_memos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."investment_rule_documents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."investment_rules" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."investor_patterns" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."investors" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."meetings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pitch_deck_results" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."question_outcomes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."question_templates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."scoring_rubrics" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."thesis_rules" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_investment_rules_context" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_spreadsheets" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "deal_intel" TO "authenticated";
GRANT USAGE ON SCHEMA "deal_intel" TO "service_role";
GRANT USAGE ON SCHEMA "deal_intel" TO "anon";



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "deal_intel"."build_fts_document"("p_value_text" "text", "p_value_jsonb" "jsonb", "p_embedding_input" "text", "p_keywords" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "deal_intel"."build_fts_document"("p_value_text" "text", "p_value_jsonb" "jsonb", "p_embedding_input" "text", "p_keywords" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "deal_intel"."build_fts_document"("p_value_text" "text", "p_value_jsonb" "jsonb", "p_embedding_input" "text", "p_keywords" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "deal_intel"."match_deal_tree_subnodes_vector"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_deal_ids" "uuid"[], "p_include_personas" boolean, "p_match_count" integer) TO "anon";
GRANT ALL ON FUNCTION "deal_intel"."match_deal_tree_subnodes_vector"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_deal_ids" "uuid"[], "p_include_personas" boolean, "p_match_count" integer) TO "authenticated";
GRANT ALL ON FUNCTION "deal_intel"."match_deal_tree_subnodes_vector"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_deal_ids" "uuid"[], "p_include_personas" boolean, "p_match_count" integer) TO "service_role";



GRANT ALL ON FUNCTION "deal_intel"."match_similar_deals_hybrid"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_query_text" "text", "p_candidate_deal_ids" "uuid"[], "p_exclude_deal_id" "uuid", "p_vector_limit" integer, "p_fts_limit" integer, "p_final_limit" integer, "p_rrf_k" integer) TO "anon";
GRANT ALL ON FUNCTION "deal_intel"."match_similar_deals_hybrid"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_query_text" "text", "p_candidate_deal_ids" "uuid"[], "p_exclude_deal_id" "uuid", "p_vector_limit" integer, "p_fts_limit" integer, "p_final_limit" integer, "p_rrf_k" integer) TO "authenticated";
GRANT ALL ON FUNCTION "deal_intel"."match_similar_deals_hybrid"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_query_text" "text", "p_candidate_deal_ids" "uuid"[], "p_exclude_deal_id" "uuid", "p_vector_limit" integer, "p_fts_limit" integer, "p_final_limit" integer, "p_rrf_k" integer) TO "service_role";



GRANT ALL ON FUNCTION "deal_intel"."set_claim_search_document"() TO "anon";
GRANT ALL ON FUNCTION "deal_intel"."set_claim_search_document"() TO "authenticated";
GRANT ALL ON FUNCTION "deal_intel"."set_claim_search_document"() TO "service_role";



GRANT ALL ON FUNCTION "deal_intel"."set_deal_fact_node_search_document"() TO "anon";
GRANT ALL ON FUNCTION "deal_intel"."set_deal_fact_node_search_document"() TO "authenticated";
GRANT ALL ON FUNCTION "deal_intel"."set_deal_fact_node_search_document"() TO "service_role";



GRANT ALL ON FUNCTION "deal_intel"."set_deal_tree_node_search_document"() TO "anon";
GRANT ALL ON FUNCTION "deal_intel"."set_deal_tree_node_search_document"() TO "authenticated";
GRANT ALL ON FUNCTION "deal_intel"."set_deal_tree_node_search_document"() TO "service_role";



GRANT ALL ON FUNCTION "deal_intel"."set_document_chunk_search_document"() TO "anon";
GRANT ALL ON FUNCTION "deal_intel"."set_document_chunk_search_document"() TO "authenticated";
GRANT ALL ON FUNCTION "deal_intel"."set_document_chunk_search_document"() TO "service_role";



GRANT ALL ON FUNCTION "deal_intel"."set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "deal_intel"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "deal_intel"."set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "deal_intel"."user_can_access_meeting"("p_meeting_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "deal_intel"."user_can_access_meeting"("p_meeting_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "deal_intel"."user_can_access_meeting"("p_meeting_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "deal_intel"."user_can_access_research_workflow"("p_workflow_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "deal_intel"."user_can_access_research_workflow"("p_workflow_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "deal_intel"."user_can_access_research_workflow"("p_workflow_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_create_deal_with_revision"("p_user_id" "uuid", "p_deal_metadata" "jsonb", "p_revision_label" "text", "p_revision_metadata" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_create_deal_with_revision"("p_user_id" "uuid", "p_deal_metadata" "jsonb", "p_revision_label" "text", "p_revision_metadata" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_create_deal_with_revision"("p_user_id" "uuid", "p_deal_metadata" "jsonb", "p_revision_label" "text", "p_revision_metadata" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_delete_deal"("p_deal_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_delete_deal"("p_deal_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_delete_deal"("p_deal_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_delete_keyword_cluster"("p_cluster_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_delete_keyword_cluster"("p_cluster_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_delete_keyword_cluster"("p_cluster_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_get_deal_metadata"("p_deal_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_get_deal_metadata"("p_deal_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_get_deal_metadata"("p_deal_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_get_deals_by_ids"("p_deal_ids" "uuid"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_get_deals_by_ids"("p_deal_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_get_deals_by_ids"("p_deal_ids" "uuid"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_get_fact_nodes"("p_deal_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_get_fact_nodes"("p_deal_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_get_fact_nodes"("p_deal_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_get_fact_nodes_for_view"("p_deal_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_get_fact_nodes_for_view"("p_deal_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_get_fact_nodes_for_view"("p_deal_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_get_keyword_memberships"("p_term_ids" "uuid"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_get_keyword_memberships"("p_term_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_get_keyword_memberships"("p_term_ids" "uuid"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_get_keyword_terms"("p_normalized_texts" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_get_keyword_terms"("p_normalized_texts" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_get_keyword_terms"("p_normalized_texts" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_get_latest_root"("p_deal_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_get_latest_root"("p_deal_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_get_latest_root"("p_deal_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_get_tree_children"("p_deal_id" "uuid", "p_parent_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_get_tree_children"("p_deal_id" "uuid", "p_parent_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_get_tree_children"("p_deal_id" "uuid", "p_parent_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_get_tree_children_by_parent_ids"("p_parent_ids" "uuid"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_get_tree_children_by_parent_ids"("p_parent_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_get_tree_children_by_parent_ids"("p_parent_ids" "uuid"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_get_tree_nodes"("p_deal_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_get_tree_nodes"("p_deal_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_get_tree_nodes"("p_deal_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_get_tree_nodes_by_ids"("p_node_ids" "uuid"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_get_tree_nodes_by_ids"("p_node_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_get_tree_nodes_by_ids"("p_node_ids" "uuid"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_get_tree_nodes_for_similarity"("p_deal_ids" "uuid"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_get_tree_nodes_for_similarity"("p_deal_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_get_tree_nodes_for_similarity"("p_deal_ids" "uuid"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_insert_fact_edges"("p_rows" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_insert_fact_edges"("p_rows" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_insert_fact_edges"("p_rows" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_insert_fact_nodes"("p_rows" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_insert_fact_nodes"("p_rows" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_insert_fact_nodes"("p_rows" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_insert_keyword_cluster"("p_representative_term_id" "uuid", "p_cluster_embedding" "extensions"."vector", "p_produced_by" "text", "p_metadata" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_insert_keyword_cluster"("p_representative_term_id" "uuid", "p_cluster_embedding" "extensions"."vector", "p_produced_by" "text", "p_metadata" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_insert_keyword_cluster"("p_representative_term_id" "uuid", "p_cluster_embedding" "extensions"."vector", "p_produced_by" "text", "p_metadata" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_insert_tree_edge"("p_edge" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_insert_tree_edge"("p_edge" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_insert_tree_edge"("p_edge" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_insert_tree_node"("p_node" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_insert_tree_node"("p_node" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_insert_tree_node"("p_node" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_list_deal_ids"("p_deal_id" "uuid", "p_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_list_deal_ids"("p_deal_id" "uuid", "p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_list_deal_ids"("p_deal_id" "uuid", "p_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_list_deals_for_user"("p_user_id" "uuid", "p_exclude_deal_id" "uuid", "p_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_list_deals_for_user"("p_user_id" "uuid", "p_exclude_deal_id" "uuid", "p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_list_deals_for_user"("p_user_id" "uuid", "p_exclude_deal_id" "uuid", "p_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_list_keyword_clusters"() TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_list_keyword_clusters"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_list_keyword_clusters"() TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_match_claims_fts"("p_user_id" "uuid", "p_query" "text", "p_match_count" integer, "p_deal_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_match_claims_fts"("p_user_id" "uuid", "p_query" "text", "p_match_count" integer, "p_deal_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_match_claims_fts"("p_user_id" "uuid", "p_query" "text", "p_match_count" integer, "p_deal_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_match_claims_vector"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_match_count" integer, "p_deal_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_match_claims_vector"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_match_count" integer, "p_deal_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_match_claims_vector"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_match_count" integer, "p_deal_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_match_deal_tree_nodes_fts"("p_user_id" "uuid", "p_query" "text", "p_match_count" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_match_deal_tree_nodes_fts"("p_user_id" "uuid", "p_query" "text", "p_match_count" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_match_deal_tree_nodes_fts"("p_user_id" "uuid", "p_query" "text", "p_match_count" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_match_deal_tree_nodes_vector"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_deal_ids" "uuid"[], "p_match_count" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_match_deal_tree_nodes_vector"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_deal_ids" "uuid"[], "p_match_count" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_match_deal_tree_nodes_vector"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_deal_ids" "uuid"[], "p_match_count" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_match_deal_tree_subnodes_vector"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_deal_ids" "uuid"[], "p_include_personas" boolean, "p_match_count" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_match_deal_tree_subnodes_vector"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_deal_ids" "uuid"[], "p_include_personas" boolean, "p_match_count" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_match_deal_tree_subnodes_vector"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_deal_ids" "uuid"[], "p_include_personas" boolean, "p_match_count" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_match_document_chunks_fts"("p_user_id" "uuid", "p_query" "text", "p_match_count" integer, "p_deal_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_match_document_chunks_fts"("p_user_id" "uuid", "p_query" "text", "p_match_count" integer, "p_deal_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_match_document_chunks_fts"("p_user_id" "uuid", "p_query" "text", "p_match_count" integer, "p_deal_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_match_document_chunks_vector"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_match_count" integer, "p_deal_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_match_document_chunks_vector"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_match_count" integer, "p_deal_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_match_document_chunks_vector"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_match_count" integer, "p_deal_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_match_similar_deals_hybrid"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_query_text" "text", "p_candidate_deal_ids" "uuid"[], "p_exclude_deal_id" "uuid", "p_vector_limit" integer, "p_fts_limit" integer, "p_final_limit" integer, "p_rrf_k" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_match_similar_deals_hybrid"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_query_text" "text", "p_candidate_deal_ids" "uuid"[], "p_exclude_deal_id" "uuid", "p_vector_limit" integer, "p_fts_limit" integer, "p_final_limit" integer, "p_rrf_k" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_match_similar_deals_hybrid"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_query_text" "text", "p_candidate_deal_ids" "uuid"[], "p_exclude_deal_id" "uuid", "p_vector_limit" integer, "p_fts_limit" integer, "p_final_limit" integer, "p_rrf_k" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_match_similarity_2d"("p_user_id" "uuid", "p_source_deal_id" "uuid", "p_candidate_deal_ids" "uuid"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_match_similarity_2d"("p_user_id" "uuid", "p_source_deal_id" "uuid", "p_candidate_deal_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_match_similarity_2d"("p_user_id" "uuid", "p_source_deal_id" "uuid", "p_candidate_deal_ids" "uuid"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_parity_counts"("p_deal_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_parity_counts"("p_deal_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_parity_counts"("p_deal_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_reset_tree"("p_deal_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_reset_tree"("p_deal_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_reset_tree"("p_deal_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_update_fact_node_enrichment"("p_node_id" "uuid", "p_embedding_input" "text", "p_embedding_model" "text", "p_content_embedding" "extensions"."vector", "p_keywords" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_update_fact_node_enrichment"("p_node_id" "uuid", "p_embedding_input" "text", "p_embedding_model" "text", "p_content_embedding" "extensions"."vector", "p_keywords" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_update_fact_node_enrichment"("p_node_id" "uuid", "p_embedding_input" "text", "p_embedding_model" "text", "p_content_embedding" "extensions"."vector", "p_keywords" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_update_keyword_cluster_embedding"("p_cluster_id" "uuid", "p_cluster_embedding" "extensions"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_update_keyword_cluster_embedding"("p_cluster_id" "uuid", "p_cluster_embedding" "extensions"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_update_keyword_cluster_embedding"("p_cluster_id" "uuid", "p_cluster_embedding" "extensions"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_update_keyword_memberships_cluster"("p_from_cluster_id" "uuid", "p_to_cluster_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_update_keyword_memberships_cluster"("p_from_cluster_id" "uuid", "p_to_cluster_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_update_keyword_memberships_cluster"("p_from_cluster_id" "uuid", "p_to_cluster_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_update_tree_node_patch"("p_id" "uuid", "p_patch" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_update_tree_node_patch"("p_id" "uuid", "p_patch" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_update_tree_node_patch"("p_id" "uuid", "p_patch" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_upsert_keyword_membership"("p_term_id" "uuid", "p_cluster_id" "uuid", "p_weight" double precision) TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_upsert_keyword_membership"("p_term_id" "uuid", "p_cluster_id" "uuid", "p_weight" double precision) TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_upsert_keyword_membership"("p_term_id" "uuid", "p_cluster_id" "uuid", "p_weight" double precision) TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_intel_upsert_keyword_term"("p_normalized_text" "text", "p_raw_text" "text", "p_fixed_token_count" integer, "p_embedding" "extensions"."vector", "p_embedding_model" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."deal_intel_upsert_keyword_term"("p_normalized_text" "text", "p_raw_text" "text", "p_fixed_token_count" integer, "p_embedding" "extensions"."vector", "p_embedding_model" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_intel_upsert_keyword_term"("p_normalized_text" "text", "p_raw_text" "text", "p_fixed_token_count" integer, "p_embedding" "extensions"."vector", "p_embedding_model" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."match_deal_context_nodes"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_match_count" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."match_deal_context_nodes"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_match_count" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."match_deal_context_nodes"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_match_count" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."match_deal_context_nodes_fts"("p_user_id" "uuid", "p_query" "text", "p_match_count" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."match_deal_context_nodes_fts"("p_user_id" "uuid", "p_query" "text", "p_match_count" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."match_deal_context_nodes_fts"("p_user_id" "uuid", "p_query" "text", "p_match_count" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."match_deal_context_nodes_in_deals"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_deal_ids" "uuid"[], "p_match_count" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."match_deal_context_nodes_in_deals"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_deal_ids" "uuid"[], "p_match_count" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."match_deal_context_nodes_in_deals"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_deal_ids" "uuid"[], "p_match_count" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."match_deal_tree_nodes_fts"("p_user_id" "uuid", "p_query" "text", "p_match_count" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."match_deal_tree_nodes_fts"("p_user_id" "uuid", "p_query" "text", "p_match_count" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."match_deal_tree_nodes_fts"("p_user_id" "uuid", "p_query" "text", "p_match_count" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."match_deal_tree_nodes_vector"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_deal_ids" "uuid"[], "p_match_count" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."match_deal_tree_nodes_vector"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_deal_ids" "uuid"[], "p_match_count" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."match_deal_tree_nodes_vector"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_deal_ids" "uuid"[], "p_match_count" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."match_similar_deals_deal_tree_hybrid"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_query_text" "text", "p_exclude_deal_id" "uuid", "p_vector_limit" integer, "p_fts_limit" integer, "p_final_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."match_similar_deals_deal_tree_hybrid"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_query_text" "text", "p_exclude_deal_id" "uuid", "p_vector_limit" integer, "p_fts_limit" integer, "p_final_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."match_similar_deals_deal_tree_hybrid"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_query_text" "text", "p_exclude_deal_id" "uuid", "p_vector_limit" integer, "p_fts_limit" integer, "p_final_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."match_similar_deals_from_deal"("p_source_deal_id" "uuid", "p_match_count" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."match_similar_deals_from_deal"("p_source_deal_id" "uuid", "p_match_count" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."match_similar_deals_from_deal"("p_source_deal_id" "uuid", "p_match_count" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."match_similar_deals_hybrid"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_query_text" "text", "p_exclude_deal_id" "uuid", "p_vector_limit" integer, "p_fts_limit" integer, "p_final_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."match_similar_deals_hybrid"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_query_text" "text", "p_exclude_deal_id" "uuid", "p_vector_limit" integer, "p_fts_limit" integer, "p_final_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."match_similar_deals_hybrid"("p_user_id" "uuid", "p_query_embedding" "extensions"."vector", "p_query_text" "text", "p_exclude_deal_id" "uuid", "p_vector_limit" integer, "p_fts_limit" integer, "p_final_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."set_deal_keywords_tsv"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_deal_keywords_tsv"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_deal_keywords_tsv"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_deal_tree_nodes_search_document"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_deal_tree_nodes_search_document"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_deal_tree_nodes_search_document"() TO "service_role";



GRANT ALL ON TABLE "deal_intel"."claim" TO "anon";
GRANT ALL ON TABLE "deal_intel"."claim" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."claim" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."company_fact" TO "anon";
GRANT ALL ON TABLE "deal_intel"."company_fact" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."company_fact" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."company_makeup" TO "anon";
GRANT ALL ON TABLE "deal_intel"."company_makeup" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."company_makeup" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."company_negative" TO "anon";
GRANT ALL ON TABLE "deal_intel"."company_negative" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."company_negative" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."company_origin_story" TO "anon";
GRANT ALL ON TABLE "deal_intel"."company_origin_story" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."company_origin_story" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."company_person" TO "anon";
GRANT ALL ON TABLE "deal_intel"."company_person" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."company_person" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."company_problem" TO "anon";
GRANT ALL ON TABLE "deal_intel"."company_problem" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."company_problem" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."company_solution" TO "anon";
GRANT ALL ON TABLE "deal_intel"."company_solution" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."company_solution" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."company_traction" TO "anon";
GRANT ALL ON TABLE "deal_intel"."company_traction" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."company_traction" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."deal" TO "anon";
GRANT ALL ON TABLE "deal_intel"."deal" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."deal" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."deal_fact_edge" TO "anon";
GRANT ALL ON TABLE "deal_intel"."deal_fact_edge" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."deal_fact_edge" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."deal_fact_node" TO "anon";
GRANT ALL ON TABLE "deal_intel"."deal_fact_node" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."deal_fact_node" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."deal_research_feedback" TO "anon";
GRANT ALL ON TABLE "deal_intel"."deal_research_feedback" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."deal_research_feedback" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."deal_research_step" TO "anon";
GRANT ALL ON TABLE "deal_intel"."deal_research_step" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."deal_research_step" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."deal_research_step_run" TO "anon";
GRANT ALL ON TABLE "deal_intel"."deal_research_step_run" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."deal_research_step_run" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."deal_research_workflow" TO "anon";
GRANT ALL ON TABLE "deal_intel"."deal_research_workflow" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."deal_research_workflow" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."deal_revision" TO "anon";
GRANT ALL ON TABLE "deal_intel"."deal_revision" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."deal_revision" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."deal_tree_edge" TO "anon";
GRANT ALL ON TABLE "deal_intel"."deal_tree_edge" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."deal_tree_edge" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."deal_tree_node" TO "anon";
GRANT ALL ON TABLE "deal_intel"."deal_tree_node" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."deal_tree_node" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."document" TO "anon";
GRANT ALL ON TABLE "deal_intel"."document" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."document" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."document_chunk" TO "anon";
GRANT ALL ON TABLE "deal_intel"."document_chunk" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."document_chunk" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."document_page" TO "anon";
GRANT ALL ON TABLE "deal_intel"."document_page" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."document_page" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."document_sentence" TO "anon";
GRANT ALL ON TABLE "deal_intel"."document_sentence" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."document_sentence" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."keyword_cluster" TO "anon";
GRANT ALL ON TABLE "deal_intel"."keyword_cluster" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."keyword_cluster" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."keyword_term" TO "anon";
GRANT ALL ON TABLE "deal_intel"."keyword_term" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."keyword_term" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."keyword_term_cluster_membership" TO "anon";
GRANT ALL ON TABLE "deal_intel"."keyword_term_cluster_membership" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."keyword_term_cluster_membership" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."meeting_assistant_event" TO "anon";
GRANT ALL ON TABLE "deal_intel"."meeting_assistant_event" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."meeting_assistant_event" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."meeting_participant" TO "anon";
GRANT ALL ON TABLE "deal_intel"."meeting_participant" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."meeting_participant" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."meeting_session" TO "anon";
GRANT ALL ON TABLE "deal_intel"."meeting_session" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."meeting_session" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."meeting_transcript_segment" TO "anon";
GRANT ALL ON TABLE "deal_intel"."meeting_transcript_segment" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."meeting_transcript_segment" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."user_agent_preference" TO "anon";
GRANT ALL ON TABLE "deal_intel"."user_agent_preference" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."user_agent_preference" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."user_investment_preference" TO "anon";
GRANT ALL ON TABLE "deal_intel"."user_investment_preference" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."user_investment_preference" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."user_research_site_preference" TO "anon";
GRANT ALL ON TABLE "deal_intel"."user_research_site_preference" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."user_research_site_preference" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."user_website_preference" TO "anon";
GRANT ALL ON TABLE "deal_intel"."user_website_preference" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."user_website_preference" TO "service_role";



GRANT ALL ON TABLE "deal_intel"."user_website_preference_embedding" TO "anon";
GRANT ALL ON TABLE "deal_intel"."user_website_preference_embedding" TO "authenticated";
GRANT ALL ON TABLE "deal_intel"."user_website_preference_embedding" TO "service_role";



GRANT ALL ON TABLE "public"."_deal_tree_legacy_map" TO "service_role";



GRANT ALL ON TABLE "public"."analysis_status" TO "anon";
GRANT ALL ON TABLE "public"."analysis_status" TO "authenticated";
GRANT ALL ON TABLE "public"."analysis_status" TO "service_role";



GRANT ALL ON TABLE "public"."chat_messages" TO "anon";
GRANT ALL ON TABLE "public"."chat_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."chat_messages" TO "service_role";



GRANT ALL ON TABLE "public"."chat_threads" TO "anon";
GRANT ALL ON TABLE "public"."chat_threads" TO "authenticated";
GRANT ALL ON TABLE "public"."chat_threads" TO "service_role";



GRANT ALL ON TABLE "public"."contact_edges" TO "anon";
GRANT ALL ON TABLE "public"."contact_edges" TO "authenticated";
GRANT ALL ON TABLE "public"."contact_edges" TO "service_role";



GRANT ALL ON TABLE "public"."contact_employment" TO "anon";
GRANT ALL ON TABLE "public"."contact_employment" TO "authenticated";
GRANT ALL ON TABLE "public"."contact_employment" TO "service_role";



GRANT ALL ON TABLE "public"."contradictions" TO "anon";
GRANT ALL ON TABLE "public"."contradictions" TO "authenticated";
GRANT ALL ON TABLE "public"."contradictions" TO "service_role";



GRANT ALL ON TABLE "public"."deal_analyses" TO "anon";
GRANT ALL ON TABLE "public"."deal_analyses" TO "authenticated";
GRANT ALL ON TABLE "public"."deal_analyses" TO "service_role";



GRANT ALL ON TABLE "public"."deal_assumptions" TO "anon";
GRANT ALL ON TABLE "public"."deal_assumptions" TO "authenticated";
GRANT ALL ON TABLE "public"."deal_assumptions" TO "service_role";



GRANT ALL ON TABLE "public"."deal_claims" TO "anon";
GRANT ALL ON TABLE "public"."deal_claims" TO "authenticated";
GRANT ALL ON TABLE "public"."deal_claims" TO "service_role";



GRANT ALL ON TABLE "public"."deal_competitors" TO "anon";
GRANT ALL ON TABLE "public"."deal_competitors" TO "authenticated";
GRANT ALL ON TABLE "public"."deal_competitors" TO "service_role";



GRANT ALL ON TABLE "public"."deal_context_nodes" TO "anon";
GRANT ALL ON TABLE "public"."deal_context_nodes" TO "authenticated";
GRANT ALL ON TABLE "public"."deal_context_nodes" TO "service_role";



GRANT ALL ON TABLE "public"."deal_differentiation" TO "anon";
GRANT ALL ON TABLE "public"."deal_differentiation" TO "authenticated";
GRANT ALL ON TABLE "public"."deal_differentiation" TO "service_role";



GRANT ALL ON TABLE "public"."deal_entities" TO "anon";
GRANT ALL ON TABLE "public"."deal_entities" TO "authenticated";
GRANT ALL ON TABLE "public"."deal_entities" TO "service_role";



GRANT ALL ON TABLE "public"."deal_feature_definitions" TO "anon";
GRANT ALL ON TABLE "public"."deal_feature_definitions" TO "authenticated";
GRANT ALL ON TABLE "public"."deal_feature_definitions" TO "service_role";



GRANT ALL ON TABLE "public"."deal_feature_provenance" TO "anon";
GRANT ALL ON TABLE "public"."deal_feature_provenance" TO "authenticated";
GRANT ALL ON TABLE "public"."deal_feature_provenance" TO "service_role";



GRANT ALL ON TABLE "public"."deal_feature_values" TO "anon";
GRANT ALL ON TABLE "public"."deal_feature_values" TO "authenticated";
GRANT ALL ON TABLE "public"."deal_feature_values" TO "service_role";



GRANT ALL ON TABLE "public"."deal_flags" TO "anon";
GRANT ALL ON TABLE "public"."deal_flags" TO "authenticated";
GRANT ALL ON TABLE "public"."deal_flags" TO "service_role";



GRANT ALL ON TABLE "public"."deal_investors" TO "anon";
GRANT ALL ON TABLE "public"."deal_investors" TO "authenticated";
GRANT ALL ON TABLE "public"."deal_investors" TO "service_role";



GRANT ALL ON TABLE "public"."deal_keywords" TO "anon";
GRANT ALL ON TABLE "public"."deal_keywords" TO "authenticated";
GRANT ALL ON TABLE "public"."deal_keywords" TO "service_role";



GRANT ALL ON TABLE "public"."deal_metrics" TO "anon";
GRANT ALL ON TABLE "public"."deal_metrics" TO "authenticated";
GRANT ALL ON TABLE "public"."deal_metrics" TO "service_role";



GRANT ALL ON TABLE "public"."deal_pipeline_json_core_assumptions" TO "anon";
GRANT ALL ON TABLE "public"."deal_pipeline_json_core_assumptions" TO "authenticated";
GRANT ALL ON TABLE "public"."deal_pipeline_json_core_assumptions" TO "service_role";



GRANT ALL ON TABLE "public"."deal_pipeline_json_founder_signals" TO "anon";
GRANT ALL ON TABLE "public"."deal_pipeline_json_founder_signals" TO "authenticated";
GRANT ALL ON TABLE "public"."deal_pipeline_json_founder_signals" TO "service_role";



GRANT ALL ON TABLE "public"."deal_pipeline_json_market_power" TO "anon";
GRANT ALL ON TABLE "public"."deal_pipeline_json_market_power" TO "authenticated";
GRANT ALL ON TABLE "public"."deal_pipeline_json_market_power" TO "service_role";



GRANT ALL ON TABLE "public"."deal_pipeline_json_parsing" TO "anon";
GRANT ALL ON TABLE "public"."deal_pipeline_json_parsing" TO "authenticated";
GRANT ALL ON TABLE "public"."deal_pipeline_json_parsing" TO "service_role";



GRANT ALL ON TABLE "public"."deal_pipeline_json_problem_3c" TO "anon";
GRANT ALL ON TABLE "public"."deal_pipeline_json_problem_3c" TO "authenticated";
GRANT ALL ON TABLE "public"."deal_pipeline_json_problem_3c" TO "service_role";



GRANT ALL ON TABLE "public"."deal_pipeline_json_questions_combined" TO "anon";
GRANT ALL ON TABLE "public"."deal_pipeline_json_questions_combined" TO "authenticated";
GRANT ALL ON TABLE "public"."deal_pipeline_json_questions_combined" TO "service_role";



GRANT ALL ON TABLE "public"."deal_pipeline_json_solution_3d" TO "anon";
GRANT ALL ON TABLE "public"."deal_pipeline_json_solution_3d" TO "authenticated";
GRANT ALL ON TABLE "public"."deal_pipeline_json_solution_3d" TO "service_role";



GRANT ALL ON TABLE "public"."deal_pipeline_json_summaries" TO "anon";
GRANT ALL ON TABLE "public"."deal_pipeline_json_summaries" TO "authenticated";
GRANT ALL ON TABLE "public"."deal_pipeline_json_summaries" TO "service_role";



GRANT ALL ON TABLE "public"."deal_pipeline_json_thesis_fit" TO "anon";
GRANT ALL ON TABLE "public"."deal_pipeline_json_thesis_fit" TO "authenticated";
GRANT ALL ON TABLE "public"."deal_pipeline_json_thesis_fit" TO "service_role";



GRANT ALL ON TABLE "public"."deal_pipeline_json_traction_signals" TO "anon";
GRANT ALL ON TABLE "public"."deal_pipeline_json_traction_signals" TO "authenticated";
GRANT ALL ON TABLE "public"."deal_pipeline_json_traction_signals" TO "service_role";



GRANT ALL ON TABLE "public"."deal_problem" TO "anon";
GRANT ALL ON TABLE "public"."deal_problem" TO "authenticated";
GRANT ALL ON TABLE "public"."deal_problem" TO "service_role";



GRANT ALL ON TABLE "public"."deal_prompt_runs" TO "anon";
GRANT ALL ON TABLE "public"."deal_prompt_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."deal_prompt_runs" TO "service_role";



GRANT ALL ON TABLE "public"."deal_questions" TO "anon";
GRANT ALL ON TABLE "public"."deal_questions" TO "authenticated";
GRANT ALL ON TABLE "public"."deal_questions" TO "service_role";



GRANT ALL ON TABLE "public"."deal_retrieval_index" TO "anon";
GRANT ALL ON TABLE "public"."deal_retrieval_index" TO "authenticated";
GRANT ALL ON TABLE "public"."deal_retrieval_index" TO "service_role";



GRANT ALL ON TABLE "public"."deal_scores" TO "anon";
GRANT ALL ON TABLE "public"."deal_scores" TO "authenticated";
GRANT ALL ON TABLE "public"."deal_scores" TO "service_role";



GRANT ALL ON TABLE "public"."deal_solution" TO "anon";
GRANT ALL ON TABLE "public"."deal_solution" TO "authenticated";
GRANT ALL ON TABLE "public"."deal_solution" TO "service_role";



GRANT ALL ON TABLE "public"."deal_traction" TO "anon";
GRANT ALL ON TABLE "public"."deal_traction" TO "authenticated";
GRANT ALL ON TABLE "public"."deal_traction" TO "service_role";



GRANT ALL ON TABLE "public"."deal_tree_nodes" TO "anon";
GRANT ALL ON TABLE "public"."deal_tree_nodes" TO "authenticated";
GRANT ALL ON TABLE "public"."deal_tree_nodes" TO "service_role";



GRANT ALL ON TABLE "public"."deals" TO "anon";
GRANT ALL ON TABLE "public"."deals" TO "authenticated";
GRANT ALL ON TABLE "public"."deals" TO "service_role";



GRANT ALL ON TABLE "public"."emails" TO "anon";
GRANT ALL ON TABLE "public"."emails" TO "authenticated";
GRANT ALL ON TABLE "public"."emails" TO "service_role";



GRANT ALL ON TABLE "public"."founder_employment" TO "anon";
GRANT ALL ON TABLE "public"."founder_employment" TO "authenticated";
GRANT ALL ON TABLE "public"."founder_employment" TO "service_role";



GRANT ALL ON TABLE "public"."founders" TO "anon";
GRANT ALL ON TABLE "public"."founders" TO "authenticated";
GRANT ALL ON TABLE "public"."founders" TO "service_role";



GRANT ALL ON TABLE "public"."fund_contacts" TO "anon";
GRANT ALL ON TABLE "public"."fund_contacts" TO "authenticated";
GRANT ALL ON TABLE "public"."fund_contacts" TO "service_role";



GRANT ALL ON TABLE "public"."fund_thesis" TO "anon";
GRANT ALL ON TABLE "public"."fund_thesis" TO "authenticated";
GRANT ALL ON TABLE "public"."fund_thesis" TO "service_role";



GRANT ALL ON TABLE "public"."fund_thesis_v2" TO "anon";
GRANT ALL ON TABLE "public"."fund_thesis_v2" TO "authenticated";
GRANT ALL ON TABLE "public"."fund_thesis_v2" TO "service_role";



GRANT ALL ON TABLE "public"."gmail_connections" TO "anon";
GRANT ALL ON TABLE "public"."gmail_connections" TO "authenticated";
GRANT ALL ON TABLE "public"."gmail_connections" TO "service_role";



GRANT ALL ON TABLE "public"."investment_memos" TO "anon";
GRANT ALL ON TABLE "public"."investment_memos" TO "authenticated";
GRANT ALL ON TABLE "public"."investment_memos" TO "service_role";



GRANT ALL ON TABLE "public"."investment_rule_documents" TO "anon";
GRANT ALL ON TABLE "public"."investment_rule_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."investment_rule_documents" TO "service_role";



GRANT ALL ON TABLE "public"."investment_rules" TO "anon";
GRANT ALL ON TABLE "public"."investment_rules" TO "authenticated";
GRANT ALL ON TABLE "public"."investment_rules" TO "service_role";



GRANT ALL ON TABLE "public"."investor_patterns" TO "anon";
GRANT ALL ON TABLE "public"."investor_patterns" TO "authenticated";
GRANT ALL ON TABLE "public"."investor_patterns" TO "service_role";



GRANT ALL ON TABLE "public"."investors" TO "anon";
GRANT ALL ON TABLE "public"."investors" TO "authenticated";
GRANT ALL ON TABLE "public"."investors" TO "service_role";



GRANT ALL ON TABLE "public"."keyword_clusters" TO "anon";
GRANT ALL ON TABLE "public"."keyword_clusters" TO "authenticated";
GRANT ALL ON TABLE "public"."keyword_clusters" TO "service_role";



GRANT ALL ON TABLE "public"."meetings" TO "anon";
GRANT ALL ON TABLE "public"."meetings" TO "authenticated";
GRANT ALL ON TABLE "public"."meetings" TO "service_role";



GRANT ALL ON TABLE "public"."pitch_deck_results" TO "anon";
GRANT ALL ON TABLE "public"."pitch_deck_results" TO "authenticated";
GRANT ALL ON TABLE "public"."pitch_deck_results" TO "service_role";



GRANT ALL ON TABLE "public"."question_outcomes" TO "anon";
GRANT ALL ON TABLE "public"."question_outcomes" TO "authenticated";
GRANT ALL ON TABLE "public"."question_outcomes" TO "service_role";



GRANT ALL ON TABLE "public"."question_templates" TO "anon";
GRANT ALL ON TABLE "public"."question_templates" TO "authenticated";
GRANT ALL ON TABLE "public"."question_templates" TO "service_role";



GRANT ALL ON TABLE "public"."scoring_rubrics" TO "anon";
GRANT ALL ON TABLE "public"."scoring_rubrics" TO "authenticated";
GRANT ALL ON TABLE "public"."scoring_rubrics" TO "service_role";



GRANT ALL ON TABLE "public"."thesis_rules" TO "anon";
GRANT ALL ON TABLE "public"."thesis_rules" TO "authenticated";
GRANT ALL ON TABLE "public"."thesis_rules" TO "service_role";



GRANT ALL ON TABLE "public"."user_investment_rules_context" TO "anon";
GRANT ALL ON TABLE "public"."user_investment_rules_context" TO "authenticated";
GRANT ALL ON TABLE "public"."user_investment_rules_context" TO "service_role";



GRANT ALL ON TABLE "public"."user_spreadsheets" TO "anon";
GRANT ALL ON TABLE "public"."user_spreadsheets" TO "authenticated";
GRANT ALL ON TABLE "public"."user_spreadsheets" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "deal_intel" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "deal_intel" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "deal_intel" GRANT ALL ON SEQUENCES TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "deal_intel" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "deal_intel" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "deal_intel" GRANT ALL ON FUNCTIONS TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "deal_intel" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "deal_intel" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "deal_intel" GRANT ALL ON TABLES TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";







