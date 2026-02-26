-- Fund thesis: one row per user (fund's thesis statement for thesis-fit scoring)
CREATE TABLE fund_thesis (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  thesis_text TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE fund_thesis ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own fund_thesis"
  ON fund_thesis FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own fund_thesis"
  ON fund_thesis FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own fund_thesis"
  ON fund_thesis FOR UPDATE
  USING (auth.uid() = user_id);

-- New deal-sourcing pipeline outputs (Phase 2–4)
ALTER TABLE pitch_deck_results
  ADD COLUMN IF NOT EXISTS thesis_fit_json JSONB,
  ADD COLUMN IF NOT EXISTS founder_signal_json JSONB,
  ADD COLUMN IF NOT EXISTS traction_signal_json JSONB,
  ADD COLUMN IF NOT EXISTS problem_quality_3c_json JSONB,
  ADD COLUMN IF NOT EXISTS solution_defensibility_json JSONB,
  ADD COLUMN IF NOT EXISTS market_power_json JSONB,
  ADD COLUMN IF NOT EXISTS core_assumption_json JSONB,
  ADD COLUMN IF NOT EXISTS thesis_fit_score NUMERIC,
  ADD COLUMN IF NOT EXISTS founder_signal_score NUMERIC,
  ADD COLUMN IF NOT EXISTS traction_signal_score NUMERIC,
  ADD COLUMN IF NOT EXISTS solution_defensibility_score NUMERIC,
  ADD COLUMN IF NOT EXISTS market_power_score NUMERIC;
