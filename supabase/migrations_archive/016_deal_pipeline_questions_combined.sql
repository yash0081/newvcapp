-- Combined question artifact (4 types) per analysis.

CREATE TABLE IF NOT EXISTS deal_pipeline_json_questions_combined (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  analysis_id uuid NOT NULL REFERENCES deal_analyses(id) ON DELETE CASCADE,
  questions_combined_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  UNIQUE (analysis_id)
);

ALTER TABLE deal_pipeline_json_questions_combined ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can select own deal_pipeline_json_questions_combined"
  ON deal_pipeline_json_questions_combined FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_questions_combined.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own deal_pipeline_json_questions_combined"
  ON deal_pipeline_json_questions_combined FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_questions_combined.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can update own deal_pipeline_json_questions_combined"
  ON deal_pipeline_json_questions_combined FOR UPDATE
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_questions_combined.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can delete own deal_pipeline_json_questions_combined"
  ON deal_pipeline_json_questions_combined FOR DELETE
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_questions_combined.deal_id AND d.user_id = auth.uid()));

