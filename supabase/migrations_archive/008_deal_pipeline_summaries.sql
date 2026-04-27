-- Preview prose from V2-2 aggregation prompts (separate from agent JSON blobs in deal_pipeline_json_*).

CREATE TABLE IF NOT EXISTS deal_pipeline_json_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  analysis_id uuid NOT NULL REFERENCES deal_analyses(id) ON DELETE CASCADE,
  pipeline_summaries_json jsonb NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (analysis_id)
);

ALTER TABLE deal_pipeline_json_summaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can select own deal_pipeline_json_summaries"
  ON deal_pipeline_json_summaries FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_summaries.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own deal_pipeline_json_summaries"
  ON deal_pipeline_json_summaries FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_summaries.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can update own deal_pipeline_json_summaries"
  ON deal_pipeline_json_summaries FOR UPDATE
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_summaries.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can delete own deal_pipeline_json_summaries"
  ON deal_pipeline_json_summaries FOR DELETE
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_summaries.deal_id AND d.user_id = auth.uid()));
