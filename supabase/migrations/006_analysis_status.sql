CREATE TABLE IF NOT EXISTS analysis_status (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id uuid NOT NULL REFERENCES deal_analyses(id) ON DELETE CASCADE,
  current_step text,
  status text NOT NULL,
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE analysis_status ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can select own analysis_status"
  ON analysis_status FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM deal_analyses da
      JOIN deals d ON d.id = da.deal_id
      WHERE da.id = analysis_status.analysis_id
        AND d.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert own analysis_status"
  ON analysis_status FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM deal_analyses da
      JOIN deals d ON d.id = da.deal_id
      WHERE da.id = analysis_status.analysis_id
        AND d.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update own analysis_status"
  ON analysis_status FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM deal_analyses da
      JOIN deals d ON d.id = da.deal_id
      WHERE da.id = analysis_status.analysis_id
        AND d.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM deal_analyses da
      JOIN deals d ON d.id = da.deal_id
      WHERE da.id = analysis_status.analysis_id
        AND d.user_id = auth.uid()
    )
  );

