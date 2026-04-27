-- Hybrid retrieval v2: section-level vectors + keyword index.

CREATE TABLE IF NOT EXISTS deal_retrieval_index (
  deal_id uuid PRIMARY KEY REFERENCES deals(id) ON DELETE CASCADE,
  analysis_id uuid NOT NULL REFERENCES deal_analyses(id) ON DELETE CASCADE,
  problem_normalized text,
  solution_normalized text,
  market_normalized text,
  risk_normalized text,
  concepts_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  normalized_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  problem_embedding vector(768),
  solution_embedding vector(768),
  market_embedding vector(768),
  risk_embedding vector(768),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dri_analysis_idx ON deal_retrieval_index (analysis_id);

CREATE INDEX IF NOT EXISTS dri_problem_embedding_hnsw_idx
  ON deal_retrieval_index USING hnsw (problem_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS dri_solution_embedding_hnsw_idx
  ON deal_retrieval_index USING hnsw (solution_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS dri_market_embedding_hnsw_idx
  ON deal_retrieval_index USING hnsw (market_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS dri_risk_embedding_hnsw_idx
  ON deal_retrieval_index USING hnsw (risk_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE TABLE IF NOT EXISTS deal_keywords (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  analysis_id uuid NOT NULL REFERENCES deal_analyses(id) ON DELETE CASCADE,
  section_name text NOT NULL CHECK (section_name IN ('problem', 'solution', 'market', 'risk')),
  concepts text[] NOT NULL DEFAULT '{}',
  concepts_text text,
  concepts_tsv tsvector,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deal_id, section_name)
);

CREATE OR REPLACE FUNCTION public.set_deal_keywords_tsv()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.concepts_text := coalesce(array_to_string(NEW.concepts, ' '), '');
  NEW.concepts_tsv := to_tsvector('english', NEW.concepts_text);
  RETURN NEW;
END;
$$;

CREATE TRIGGER deal_keywords_tsv_trigger
BEFORE INSERT OR UPDATE OF concepts
ON deal_keywords
FOR EACH ROW
EXECUTE FUNCTION public.set_deal_keywords_tsv();

CREATE INDEX IF NOT EXISTS deal_keywords_concepts_tsv_idx ON deal_keywords USING gin (concepts_tsv);
CREATE INDEX IF NOT EXISTS deal_keywords_concepts_arr_idx ON deal_keywords USING gin (concepts);

ALTER TABLE deal_retrieval_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_keywords ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can select own deal_retrieval_index"
  ON deal_retrieval_index FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_retrieval_index.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own deal_retrieval_index"
  ON deal_retrieval_index FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_retrieval_index.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can update own deal_retrieval_index"
  ON deal_retrieval_index FOR UPDATE
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_retrieval_index.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can delete own deal_retrieval_index"
  ON deal_retrieval_index FOR DELETE
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_retrieval_index.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can select own deal_keywords"
  ON deal_keywords FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_keywords.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own deal_keywords"
  ON deal_keywords FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_keywords.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can update own deal_keywords"
  ON deal_keywords FOR UPDATE
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_keywords.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can delete own deal_keywords"
  ON deal_keywords FOR DELETE
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_keywords.deal_id AND d.user_id = auth.uid()));
