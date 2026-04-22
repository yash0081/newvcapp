-- deal_intel: greenfield deal schema (Layer 1a facts + Layer 1b vectors/edges + retrieval tree).
-- This migration creates ONLY new objects under schema `deal_intel` and does not touch legacy `public.deals` / `public.deal_*`.

-- pgvector is installed under schema `extensions` in Supabase.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

-- 0) Schema + grants
CREATE SCHEMA IF NOT EXISTS deal_intel;
GRANT USAGE ON SCHEMA deal_intel TO authenticated, service_role;

-- Helpers
CREATE OR REPLACE FUNCTION deal_intel.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION deal_intel.build_fts_document(
  p_value_text text,
  p_value_jsonb jsonb,
  p_embedding_input text,
  p_keywords text[]
)
RETURNS tsvector
LANGUAGE sql
STABLE
AS $$
  SELECT to_tsvector(
    'english',
    coalesce(p_value_text, '') || ' ' ||
    coalesce(p_embedding_input, '') || ' ' ||
    coalesce(array_to_string(coalesce(p_keywords, '{}'::text[]), ' '), '') || ' ' ||
    coalesce(left(p_value_jsonb::text, 8000), '')
  );
$$;

-- 1) Core deal tables
CREATE TABLE IF NOT EXISTS deal_intel.deal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

DROP TRIGGER IF EXISTS deal_intel_deal_updated_at ON deal_intel.deal;
CREATE TRIGGER deal_intel_deal_updated_at
BEFORE UPDATE ON deal_intel.deal
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_updated_at();

CREATE INDEX IF NOT EXISTS deal_intel_deal_user_idx ON deal_intel.deal(user_id);

CREATE TABLE IF NOT EXISTS deal_intel.deal_revision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deal_intel.deal(id) ON DELETE CASCADE,
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS deal_intel_deal_revision_deal_idx ON deal_intel.deal_revision(deal_id);

-- 2) Layer 1a+1b: fact nodes (with optional vectors) + weighted edges
CREATE TABLE IF NOT EXISTS deal_intel.deal_fact_node (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deal_intel.deal(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES deal_intel.deal_fact_node(id) ON DELETE CASCADE,

  path text NOT NULL,
  depth int NOT NULL DEFAULT 0,
  sort_key int NOT NULL DEFAULT 0,

  value_text text,
  value_jsonb jsonb,

  -- Layer 1b (same row)
  content_embedding vector(768),
  embedding_model text,
  embedding_input text,

  edge_weight_to_parent double precision NOT NULL DEFAULT 1.0,
  source_map jsonb NOT NULL DEFAULT '{}'::jsonb,

  keywords text[] NOT NULL DEFAULT '{}'::text[],
  search_document tsvector,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (deal_id, path)
);

DROP TRIGGER IF EXISTS deal_intel_deal_fact_node_updated_at ON deal_intel.deal_fact_node;
CREATE TRIGGER deal_intel_deal_fact_node_updated_at
BEFORE UPDATE ON deal_intel.deal_fact_node
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_updated_at();

CREATE OR REPLACE FUNCTION deal_intel.set_deal_fact_node_search_document()
RETURNS trigger
LANGUAGE plpgsql
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

DROP TRIGGER IF EXISTS deal_intel_deal_fact_node_fts ON deal_intel.deal_fact_node;
CREATE TRIGGER deal_intel_deal_fact_node_fts
BEFORE INSERT OR UPDATE OF value_text, value_jsonb, embedding_input, keywords
ON deal_intel.deal_fact_node
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_deal_fact_node_search_document();

CREATE INDEX IF NOT EXISTS deal_intel_deal_fact_node_deal_idx ON deal_intel.deal_fact_node(deal_id);
CREATE INDEX IF NOT EXISTS deal_intel_deal_fact_node_parent_idx ON deal_intel.deal_fact_node(parent_id);
CREATE INDEX IF NOT EXISTS deal_intel_deal_fact_node_path_idx ON deal_intel.deal_fact_node(deal_id, path);
CREATE INDEX IF NOT EXISTS deal_intel_deal_fact_node_search_gin_idx ON deal_intel.deal_fact_node USING gin (search_document);
CREATE INDEX IF NOT EXISTS deal_intel_deal_fact_node_keywords_gin_idx ON deal_intel.deal_fact_node USING gin (keywords);
CREATE INDEX IF NOT EXISTS deal_intel_deal_fact_node_embedding_hnsw_idx
  ON deal_intel.deal_fact_node
  USING hnsw (content_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE content_embedding IS NOT NULL;

CREATE TABLE IF NOT EXISTS deal_intel.deal_fact_edge (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deal_intel.deal(id) ON DELETE CASCADE,
  src_node_id uuid NOT NULL REFERENCES deal_intel.deal_fact_node(id) ON DELETE CASCADE,
  dst_node_id uuid NOT NULL REFERENCES deal_intel.deal_fact_node(id) ON DELETE CASCADE,
  edge_kind text NOT NULL,
  weight double precision NOT NULL DEFAULT 1.0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_intel_deal_fact_edge_deal_idx ON deal_intel.deal_fact_edge(deal_id);
CREATE INDEX IF NOT EXISTS deal_intel_deal_fact_edge_src_idx ON deal_intel.deal_fact_edge(src_node_id);
CREATE INDEX IF NOT EXISTS deal_intel_deal_fact_edge_dst_idx ON deal_intel.deal_fact_edge(dst_node_id);

-- 3) Retrieval tree: root / child / sub_child / persona nodes + weighted edges
CREATE TABLE IF NOT EXISTS deal_intel.deal_tree_node (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deal_intel.deal(id) ON DELETE CASCADE,
  revision_id uuid REFERENCES deal_intel.deal_revision(id) ON DELETE SET NULL,
  parent_id uuid REFERENCES deal_intel.deal_tree_node(id) ON DELETE CASCADE,

  kind text NOT NULL CHECK (kind IN ('root','child','sub_child','persona_subchild')),
  node_type text NOT NULL,

  -- Link child bucket back to the fact tree
  fact_section_root_id uuid REFERENCES deal_intel.deal_fact_node(id) ON DELETE SET NULL,

  node_path text,
  node_key text,
  node_value_text text,
  narrative_text text,

  -- Embeddings
  centroid_embedding vector(768),
  narrative_embedding vector(768),
  signal_embedding vector(768),
  anchor_embedding vector(768),
  drift_embedding vector(768),
  atomic_embedding vector(768),

  -- Weights (per plan)
  edge_weight_to_parent double precision NOT NULL DEFAULT 1.0,
  node_weight double precision NOT NULL DEFAULT 1.0,

  -- Persona gating (exclude from global rollups)
  use_for_global_similarity boolean NOT NULL DEFAULT true,

  keywords text[] NOT NULL DEFAULT '{}'::text[],
  search_document tsvector,
  source_map jsonb NOT NULL DEFAULT '{}'::jsonb,
  value_jsonb jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS deal_intel_deal_tree_node_updated_at ON deal_intel.deal_tree_node;
CREATE TRIGGER deal_intel_deal_tree_node_updated_at
BEFORE UPDATE ON deal_intel.deal_tree_node
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_updated_at();

CREATE OR REPLACE FUNCTION deal_intel.set_deal_tree_node_search_document()
RETURNS trigger
LANGUAGE plpgsql
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

DROP TRIGGER IF EXISTS deal_intel_deal_tree_node_fts ON deal_intel.deal_tree_node;
CREATE TRIGGER deal_intel_deal_tree_node_fts
BEFORE INSERT OR UPDATE OF narrative_text, value_jsonb, node_path, keywords
ON deal_intel.deal_tree_node
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_deal_tree_node_search_document();

CREATE INDEX IF NOT EXISTS deal_intel_deal_tree_node_deal_idx ON deal_intel.deal_tree_node(deal_id);
CREATE INDEX IF NOT EXISTS deal_intel_deal_tree_node_parent_idx ON deal_intel.deal_tree_node(parent_id);
CREATE INDEX IF NOT EXISTS deal_intel_deal_tree_node_kind_type_idx ON deal_intel.deal_tree_node(deal_id, kind, node_type);
CREATE INDEX IF NOT EXISTS deal_intel_deal_tree_node_search_gin_idx ON deal_intel.deal_tree_node USING gin (search_document);
CREATE INDEX IF NOT EXISTS deal_intel_deal_tree_node_centroid_hnsw_idx
  ON deal_intel.deal_tree_node
  USING hnsw (centroid_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE centroid_embedding IS NOT NULL;
CREATE INDEX IF NOT EXISTS deal_intel_deal_tree_node_signal_hnsw_idx
  ON deal_intel.deal_tree_node
  USING hnsw (signal_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE signal_embedding IS NOT NULL;
CREATE INDEX IF NOT EXISTS deal_intel_deal_tree_node_atomic_hnsw_idx
  ON deal_intel.deal_tree_node
  USING hnsw (atomic_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE atomic_embedding IS NOT NULL;
CREATE INDEX IF NOT EXISTS deal_intel_deal_tree_node_anchor_hnsw_idx
  ON deal_intel.deal_tree_node
  USING hnsw (anchor_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE anchor_embedding IS NOT NULL;

CREATE TABLE IF NOT EXISTS deal_intel.deal_tree_edge (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deal_intel.deal(id) ON DELETE CASCADE,
  src_node_id uuid NOT NULL REFERENCES deal_intel.deal_tree_node(id) ON DELETE CASCADE,
  dst_node_id uuid NOT NULL REFERENCES deal_intel.deal_tree_node(id) ON DELETE CASCADE,
  edge_kind text NOT NULL,
  weight double precision NOT NULL DEFAULT 1.0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_intel_deal_tree_edge_deal_idx ON deal_intel.deal_tree_edge(deal_id);
CREATE INDEX IF NOT EXISTS deal_intel_deal_tree_edge_src_idx ON deal_intel.deal_tree_edge(src_node_id);
CREATE INDEX IF NOT EXISTS deal_intel_deal_tree_edge_dst_idx ON deal_intel.deal_tree_edge(dst_node_id);

-- 4) User preferences (1c/1d)
CREATE TABLE IF NOT EXISTS deal_intel.user_agent_preference (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tone_language_rules text,
  forbidden_actions_behaviors jsonb NOT NULL DEFAULT '[]'::jsonb,
  general_agent_behavior_preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS deal_intel_user_agent_preference_updated_at ON deal_intel.user_agent_preference;
CREATE TRIGGER deal_intel_user_agent_preference_updated_at
BEFORE UPDATE ON deal_intel.user_agent_preference
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_updated_at();

CREATE TABLE IF NOT EXISTS deal_intel.user_website_preference (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  website text NOT NULL,
  situations_good_for text,
  focus_info_by_situation jsonb NOT NULL DEFAULT '{}'::jsonb,
  how_often_user_prefers_website text,
  how_often_user_likes_data_returned text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, website)
);

DROP TRIGGER IF EXISTS deal_intel_user_website_preference_updated_at ON deal_intel.user_website_preference;
CREATE TRIGGER deal_intel_user_website_preference_updated_at
BEFORE UPDATE ON deal_intel.user_website_preference
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_updated_at();

CREATE INDEX IF NOT EXISTS deal_intel_user_website_preference_user_idx ON deal_intel.user_website_preference(user_id);

CREATE TABLE IF NOT EXISTS deal_intel.user_website_preference_embedding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  website text NOT NULL,
  profile_embedding vector(768),
  embedding_model text,
  embedding_input text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, website)
);

DROP TRIGGER IF EXISTS deal_intel_user_website_preference_embedding_updated_at ON deal_intel.user_website_preference_embedding;
CREATE TRIGGER deal_intel_user_website_preference_embedding_updated_at
BEFORE UPDATE ON deal_intel.user_website_preference_embedding
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_updated_at();

CREATE TABLE IF NOT EXISTS deal_intel.user_investment_preference (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  preference text NOT NULL,
  care_like_dislike text NOT NULL,
  how_much_they_care numeric NOT NULL,
  confidence_score numeric NOT NULL,
  stated_or_inferred text NOT NULL CHECK (stated_or_inferred IN ('stated','inferred')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS deal_intel_user_investment_preference_updated_at ON deal_intel.user_investment_preference;
CREATE TRIGGER deal_intel_user_investment_preference_updated_at
BEFORE UPDATE ON deal_intel.user_investment_preference
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_updated_at();

CREATE INDEX IF NOT EXISTS deal_intel_user_investment_preference_user_idx ON deal_intel.user_investment_preference(user_id);

-- 5) Keyword normalization + clustering storage
CREATE TABLE IF NOT EXISTS deal_intel.keyword_term (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_text text NOT NULL,
  raw_text text,
  fixed_token_count int NOT NULL,
  embedding vector(768) NOT NULL,
  embedding_model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (normalized_text)
);

CREATE INDEX IF NOT EXISTS deal_intel_keyword_term_embedding_hnsw_idx
  ON deal_intel.keyword_term
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE TABLE IF NOT EXISTS deal_intel.keyword_cluster (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vocab_version int NOT NULL DEFAULT 1,
  representative_term_id uuid REFERENCES deal_intel.keyword_term(id) ON DELETE SET NULL,
  cluster_embedding vector(768),
  produced_by text NOT NULL CHECK (produced_by IN ('online_dsu','offline_hdbscan','offline_hierarchical')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_intel_keyword_cluster_version_idx ON deal_intel.keyword_cluster(vocab_version);
CREATE INDEX IF NOT EXISTS deal_intel_keyword_cluster_embedding_hnsw_idx
  ON deal_intel.keyword_cluster
  USING hnsw (cluster_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE cluster_embedding IS NOT NULL;

CREATE TABLE IF NOT EXISTS deal_intel.keyword_term_cluster_membership (
  term_id uuid PRIMARY KEY REFERENCES deal_intel.keyword_term(id) ON DELETE CASCADE,
  cluster_id uuid NOT NULL REFERENCES deal_intel.keyword_cluster(id) ON DELETE CASCADE,
  weight double precision NOT NULL DEFAULT 1.0
);

CREATE INDEX IF NOT EXISTS deal_intel_keyword_membership_cluster_idx ON deal_intel.keyword_term_cluster_membership(cluster_id);

-- 6) RLS policies
ALTER TABLE deal_intel.deal ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.deal_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.deal_fact_node ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.deal_fact_edge ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.deal_tree_node ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.deal_tree_edge ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.user_agent_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.user_website_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.user_website_preference_embedding ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.user_investment_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.keyword_term ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.keyword_cluster ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.keyword_term_cluster_membership ENABLE ROW LEVEL SECURITY;

-- Deals: per-user
CREATE POLICY "deal_intel.deal select own"
  ON deal_intel.deal FOR SELECT
  USING (user_id = auth.uid());
CREATE POLICY "deal_intel.deal insert own"
  ON deal_intel.deal FOR INSERT
  WITH CHECK (user_id = auth.uid());
CREATE POLICY "deal_intel.deal update own"
  ON deal_intel.deal FOR UPDATE
  USING (user_id = auth.uid());
CREATE POLICY "deal_intel.deal delete own"
  ON deal_intel.deal FOR DELETE
  USING (user_id = auth.uid());

-- Deal children: authorize via deal ownership
CREATE POLICY "deal_intel.deal_revision select own"
  ON deal_intel.deal_revision FOR SELECT
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = deal_revision.deal_id AND d.user_id = auth.uid()));
CREATE POLICY "deal_intel.deal_revision insert own"
  ON deal_intel.deal_revision FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = deal_revision.deal_id AND d.user_id = auth.uid()));
CREATE POLICY "deal_intel.deal_revision update own"
  ON deal_intel.deal_revision FOR UPDATE
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = deal_revision.deal_id AND d.user_id = auth.uid()));
CREATE POLICY "deal_intel.deal_revision delete own"
  ON deal_intel.deal_revision FOR DELETE
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = deal_revision.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "deal_intel.deal_fact_node select own"
  ON deal_intel.deal_fact_node FOR SELECT
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = deal_fact_node.deal_id AND d.user_id = auth.uid()));
CREATE POLICY "deal_intel.deal_fact_node insert own"
  ON deal_intel.deal_fact_node FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = deal_fact_node.deal_id AND d.user_id = auth.uid()));
CREATE POLICY "deal_intel.deal_fact_node update own"
  ON deal_intel.deal_fact_node FOR UPDATE
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = deal_fact_node.deal_id AND d.user_id = auth.uid()));
CREATE POLICY "deal_intel.deal_fact_node delete own"
  ON deal_intel.deal_fact_node FOR DELETE
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = deal_fact_node.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "deal_intel.deal_fact_edge select own"
  ON deal_intel.deal_fact_edge FOR SELECT
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = deal_fact_edge.deal_id AND d.user_id = auth.uid()));
CREATE POLICY "deal_intel.deal_fact_edge insert own"
  ON deal_intel.deal_fact_edge FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = deal_fact_edge.deal_id AND d.user_id = auth.uid()));
CREATE POLICY "deal_intel.deal_fact_edge update own"
  ON deal_intel.deal_fact_edge FOR UPDATE
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = deal_fact_edge.deal_id AND d.user_id = auth.uid()));
CREATE POLICY "deal_intel.deal_fact_edge delete own"
  ON deal_intel.deal_fact_edge FOR DELETE
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = deal_fact_edge.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "deal_intel.deal_tree_node select own"
  ON deal_intel.deal_tree_node FOR SELECT
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = deal_tree_node.deal_id AND d.user_id = auth.uid()));
CREATE POLICY "deal_intel.deal_tree_node insert own"
  ON deal_intel.deal_tree_node FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = deal_tree_node.deal_id AND d.user_id = auth.uid()));
CREATE POLICY "deal_intel.deal_tree_node update own"
  ON deal_intel.deal_tree_node FOR UPDATE
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = deal_tree_node.deal_id AND d.user_id = auth.uid()));
CREATE POLICY "deal_intel.deal_tree_node delete own"
  ON deal_intel.deal_tree_node FOR DELETE
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = deal_tree_node.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "deal_intel.deal_tree_edge select own"
  ON deal_intel.deal_tree_edge FOR SELECT
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = deal_tree_edge.deal_id AND d.user_id = auth.uid()));
CREATE POLICY "deal_intel.deal_tree_edge insert own"
  ON deal_intel.deal_tree_edge FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = deal_tree_edge.deal_id AND d.user_id = auth.uid()));
CREATE POLICY "deal_intel.deal_tree_edge update own"
  ON deal_intel.deal_tree_edge FOR UPDATE
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = deal_tree_edge.deal_id AND d.user_id = auth.uid()));
CREATE POLICY "deal_intel.deal_tree_edge delete own"
  ON deal_intel.deal_tree_edge FOR DELETE
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = deal_tree_edge.deal_id AND d.user_id = auth.uid()));

-- User pref tables: user_id = auth.uid()
CREATE POLICY "deal_intel.user_agent_preference select own"
  ON deal_intel.user_agent_preference FOR SELECT
  USING (user_id = auth.uid());
CREATE POLICY "deal_intel.user_agent_preference upsert own"
  ON deal_intel.user_agent_preference FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "deal_intel.user_website_preference select own"
  ON deal_intel.user_website_preference FOR SELECT
  USING (user_id = auth.uid());
CREATE POLICY "deal_intel.user_website_preference upsert own"
  ON deal_intel.user_website_preference FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "deal_intel.user_website_preference_embedding select own"
  ON deal_intel.user_website_preference_embedding FOR SELECT
  USING (user_id = auth.uid());
CREATE POLICY "deal_intel.user_website_preference_embedding upsert own"
  ON deal_intel.user_website_preference_embedding FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "deal_intel.user_investment_preference select own"
  ON deal_intel.user_investment_preference FOR SELECT
  USING (user_id = auth.uid());
CREATE POLICY "deal_intel.user_investment_preference upsert own"
  ON deal_intel.user_investment_preference FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Keywords: default global vocab (authenticated read; service_role write)
CREATE POLICY "deal_intel.keyword_term read"
  ON deal_intel.keyword_term FOR SELECT
  USING (auth.role() IN ('authenticated','service_role'));
CREATE POLICY "deal_intel.keyword_term write service"
  ON deal_intel.keyword_term FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "deal_intel.keyword_cluster read"
  ON deal_intel.keyword_cluster FOR SELECT
  USING (auth.role() IN ('authenticated','service_role'));
CREATE POLICY "deal_intel.keyword_cluster write service"
  ON deal_intel.keyword_cluster FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "deal_intel.keyword_membership read"
  ON deal_intel.keyword_term_cluster_membership FOR SELECT
  USING (auth.role() IN ('authenticated','service_role'));
CREATE POLICY "deal_intel.keyword_membership write service"
  ON deal_intel.keyword_term_cluster_membership FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- 7) RPCs for hybrid retrieval (vector + FTS + RRF)
CREATE OR REPLACE FUNCTION deal_intel.match_similar_deals_hybrid(
  p_user_id uuid,
  p_query_embedding vector(768),
  p_query_text text,
  p_candidate_deal_ids uuid[] DEFAULT NULL,
  p_exclude_deal_id uuid DEFAULT NULL,
  p_vector_limit int DEFAULT 200,
  p_fts_limit int DEFAULT 200,
  p_final_limit int DEFAULT 50,
  p_rrf_k int DEFAULT 60
)
RETURNS TABLE (
  deal_id uuid,
  vector_rank bigint,
  fts_rank bigint,
  rrf_score double precision
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = deal_intel, public, extensions
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

-- Vector fetch for post-RRF context injection across sub-children (optionally including personas).
CREATE OR REPLACE FUNCTION deal_intel.match_deal_tree_subnodes_vector(
  p_user_id uuid,
  p_query_embedding vector(768),
  p_deal_ids uuid[],
  p_include_personas boolean DEFAULT false,
  p_match_count int DEFAULT 40
)
RETURNS TABLE (
  id uuid,
  deal_id uuid,
  node_type text,
  node_path text,
  narrative_text text,
  similarity float
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = deal_intel, public, extensions
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

-- Public wrappers (Supabase RPC exposure is usually public schema only)
CREATE OR REPLACE FUNCTION public.deal_intel_match_similar_deals_hybrid(
  p_user_id uuid,
  p_query_embedding vector(768),
  p_query_text text,
  p_candidate_deal_ids uuid[] DEFAULT NULL,
  p_exclude_deal_id uuid DEFAULT NULL,
  p_vector_limit int DEFAULT 200,
  p_fts_limit int DEFAULT 200,
  p_final_limit int DEFAULT 50,
  p_rrf_k int DEFAULT 60
)
RETURNS TABLE (
  deal_id uuid,
  vector_rank bigint,
  fts_rank bigint,
  rrf_score double precision
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = deal_intel, public, extensions
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

CREATE OR REPLACE FUNCTION public.deal_intel_match_deal_tree_subnodes_vector(
  p_user_id uuid,
  p_query_embedding vector(768),
  p_deal_ids uuid[],
  p_include_personas boolean DEFAULT false,
  p_match_count int DEFAULT 40
)
RETURNS TABLE (
  id uuid,
  deal_id uuid,
  node_type text,
  node_path text,
  narrative_text text,
  similarity float
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = deal_intel, public, extensions
AS $$
  SELECT * FROM deal_intel.match_deal_tree_subnodes_vector(
    p_user_id,
    p_query_embedding,
    p_deal_ids,
    p_include_personas,
    p_match_count
  );
$$;

GRANT EXECUTE ON FUNCTION public.deal_intel_match_similar_deals_hybrid(uuid, vector(768), text, uuid[], uuid, int, int, int, int)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_intel_match_deal_tree_subnodes_vector(uuid, vector(768), uuid[], boolean, int)
  TO authenticated, service_role;

