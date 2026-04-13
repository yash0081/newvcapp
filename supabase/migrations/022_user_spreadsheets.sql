-- Saved spreadsheet views (deal subsets + history) for /home/deals/grid

CREATE TABLE IF NOT EXISTS user_spreadsheets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Untitled',
  deal_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_spreadsheets_user_updated
  ON user_spreadsheets (user_id, updated_at DESC);

ALTER TABLE user_spreadsheets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users select own spreadsheets"
  ON user_spreadsheets FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own spreadsheets"
  ON user_spreadsheets FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own spreadsheets"
  ON user_spreadsheets FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users delete own spreadsheets"
  ON user_spreadsheets FOR DELETE
  USING (auth.uid() = user_id);
