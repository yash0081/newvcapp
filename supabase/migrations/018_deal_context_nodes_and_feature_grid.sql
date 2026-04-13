-- Hierarchical context nodes + tabular feature grid (agentic platform plan).
-- Vector dim 768 matches text-embedding-004 / vertex-embeddings.

CREATE TABLE IF NOT EXISTS deal_context_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  analysis_id uuid NOT NULL REFERENCES deal_analyses(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES deal_context_nodes(id) ON DELETE CASCADE,
  node_type text NOT NULL,
  depth int NOT NULL DEFAULT 0,
  raw_text text,
  structured_text text,
  keywords text[] NOT NULL DEFAULT '{}',
  embedding vector(768),
  node_weight float NOT NULL DEFAULT 1.0,
  subnode_weights_json jsonb,
  polarity text NOT NULL DEFAULT 'neutral' CHECK (polarity IN ('positive', 'negative', 'neutral')),
  version int NOT NULL DEFAULT 1,
  search_document tsvector GENERATED ALWAYS AS (
    to_tsvector(
      'english',
      coalesce(raw_text, '') || ' ' || coalesce(structured_text, '')
    )
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_context_nodes_deal_analysis_idx
  ON deal_context_nodes (deal_id, analysis_id);
CREATE INDEX IF NOT EXISTS deal_context_nodes_parent_idx
  ON deal_context_nodes (parent_id);
CREATE INDEX IF NOT EXISTS deal_context_nodes_type_idx
  ON deal_context_nodes (deal_id, node_type);
CREATE INDEX IF NOT EXISTS deal_context_nodes_embedding_hnsw_idx
  ON deal_context_nodes
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS deal_context_nodes_search_gin_idx
  ON deal_context_nodes USING gin (search_document);

CREATE TABLE IF NOT EXISTS deal_feature_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key text NOT NULL,
  label text NOT NULL,
  data_type text NOT NULL CHECK (data_type IN ('number', 'text', 'bool', 'json')),
  origin text NOT NULL DEFAULT 'explicit_user' CHECK (origin IN ('explicit_user', 'pipeline', 'inferred_llm')),
  compute_tier text NOT NULL DEFAULT 'cheap' CHECK (compute_tier IN ('cheap', 'expensive')),
  formula_or_prompt_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, key)
);

CREATE TABLE IF NOT EXISTS deal_feature_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  feature_id uuid NOT NULL REFERENCES deal_feature_definitions(id) ON DELETE CASCADE,
  value_jsonb jsonb,
  status text NOT NULL DEFAULT 'done' CHECK (status IN ('pending', 'done', 'error')),
  cache_key text,
  error_message text,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deal_id, feature_id)
);

CREATE INDEX IF NOT EXISTS deal_feature_values_deal_idx ON deal_feature_values (deal_id);
CREATE INDEX IF NOT EXISTS deal_feature_values_feature_idx ON deal_feature_values (feature_id);

CREATE TABLE IF NOT EXISTS deal_feature_provenance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_id uuid NOT NULL REFERENCES deal_feature_definitions(id) ON DELETE CASCADE,
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  node_id uuid REFERENCES deal_context_nodes(id) ON DELETE SET NULL,
  prompt_run_id uuid REFERENCES deal_prompt_runs(id) ON DELETE SET NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_feature_provenance_feature_deal_idx
  ON deal_feature_provenance (feature_id, deal_id);

-- Minimal CRM fields on deals (plan A7)
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS crm_notes text,
  ADD COLUMN IF NOT EXISTS crm_stage text,
  ADD COLUMN IF NOT EXISTS crm_next_step text;

ALTER TABLE deal_context_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_feature_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_feature_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_feature_provenance ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can select own deal_context_nodes"
  ON deal_context_nodes FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_context_nodes.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own deal_context_nodes"
  ON deal_context_nodes FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_context_nodes.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can update own deal_context_nodes"
  ON deal_context_nodes FOR UPDATE
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_context_nodes.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can delete own deal_context_nodes"
  ON deal_context_nodes FOR DELETE
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_context_nodes.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can select own deal_feature_definitions"
  ON deal_feature_definitions FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Users can insert own deal_feature_definitions"
  ON deal_feature_definitions FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update own deal_feature_definitions"
  ON deal_feature_definitions FOR UPDATE
  USING (user_id = auth.uid());

CREATE POLICY "Users can delete own deal_feature_definitions"
  ON deal_feature_definitions FOR DELETE
  USING (user_id = auth.uid());

CREATE POLICY "Users can select own deal_feature_values"
  ON deal_feature_values FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_feature_values.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own deal_feature_values"
  ON deal_feature_values FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_feature_values.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can update own deal_feature_values"
  ON deal_feature_values FOR UPDATE
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_feature_values.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can delete own deal_feature_values"
  ON deal_feature_values FOR DELETE
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_feature_values.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can select own deal_feature_provenance"
  ON deal_feature_provenance FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_feature_provenance.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own deal_feature_provenance"
  ON deal_feature_provenance FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_feature_provenance.deal_id AND d.user_id = auth.uid()));
