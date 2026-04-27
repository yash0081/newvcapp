-- Pitch deck analysis results: one row per email that was scored
CREATE TABLE pitch_deck_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id UUID NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  gmail_message_id TEXT NOT NULL,
  gmail_attachment_id TEXT,
  pdf_size_bytes INT,

  parsing_json JSONB,
  problem_extraction_json JSONB,
  solution_extraction_json JSONB,

  problem_quality_score NUMERIC,
  solution_quality_score NUMERIC,
  founder_team_quality_score NUMERIC,
  metrics_quality_score NUMERIC,
  composite_score NUMERIC,

  problem_web_json JSONB,
  solution_web_json JSONB,
  founder_web_json JSONB,
  metrics_web_json JSONB,

  processed_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(email_id)
);

ALTER TABLE pitch_deck_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own pitch_deck_results"
  ON pitch_deck_results FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM emails e
      JOIN gmail_connections gc ON gc.id = e.gmail_connection_id
      WHERE e.id = pitch_deck_results.email_id AND gc.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert own pitch_deck_results"
  ON pitch_deck_results FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM emails e
      JOIN gmail_connections gc ON gc.id = e.gmail_connection_id
      WHERE e.id = pitch_deck_results.email_id AND gc.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update own pitch_deck_results"
  ON pitch_deck_results FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM emails e
      JOIN gmail_connections gc ON gc.id = e.gmail_connection_id
      WHERE e.id = pitch_deck_results.email_id AND gc.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete own pitch_deck_results"
  ON pitch_deck_results FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM emails e
      JOIN gmail_connections gc ON gc.id = e.gmail_connection_id
      WHERE e.id = pitch_deck_results.email_id AND gc.user_id = auth.uid()
    )
  );

CREATE INDEX pitch_deck_results_email_id_idx ON pitch_deck_results(email_id);
CREATE INDEX pitch_deck_results_composite_score_idx ON pitch_deck_results(composite_score DESC);
