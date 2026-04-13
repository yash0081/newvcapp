-- One row per analysis: full JSON blob per pipeline stage (in addition to deal_analyses.raw_output).

CREATE TABLE IF NOT EXISTS deal_pipeline_json_parsing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  analysis_id uuid NOT NULL REFERENCES deal_analyses(id) ON DELETE CASCADE,
  parsing_json jsonb NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (analysis_id)
);

CREATE TABLE IF NOT EXISTS deal_pipeline_json_thesis_fit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  analysis_id uuid NOT NULL REFERENCES deal_analyses(id) ON DELETE CASCADE,
  thesis_fit_json jsonb NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (analysis_id)
);

CREATE TABLE IF NOT EXISTS deal_pipeline_json_founder_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  analysis_id uuid NOT NULL REFERENCES deal_analyses(id) ON DELETE CASCADE,
  founder_signal_json jsonb NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (analysis_id)
);

CREATE TABLE IF NOT EXISTS deal_pipeline_json_traction_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  analysis_id uuid NOT NULL REFERENCES deal_analyses(id) ON DELETE CASCADE,
  traction_signal_json jsonb NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (analysis_id)
);

CREATE TABLE IF NOT EXISTS deal_pipeline_json_problem_3c (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  analysis_id uuid NOT NULL REFERENCES deal_analyses(id) ON DELETE CASCADE,
  problem_quality_3c_json jsonb NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (analysis_id)
);

CREATE TABLE IF NOT EXISTS deal_pipeline_json_solution_3d (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  analysis_id uuid NOT NULL REFERENCES deal_analyses(id) ON DELETE CASCADE,
  solution_defensibility_json jsonb NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (analysis_id)
);

CREATE TABLE IF NOT EXISTS deal_pipeline_json_market_power (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  analysis_id uuid NOT NULL REFERENCES deal_analyses(id) ON DELETE CASCADE,
  market_power_json jsonb,
  created_at timestamptz DEFAULT now(),
  UNIQUE (analysis_id)
);

CREATE TABLE IF NOT EXISTS deal_pipeline_json_core_assumptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  analysis_id uuid NOT NULL REFERENCES deal_analyses(id) ON DELETE CASCADE,
  core_assumption_json jsonb NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (analysis_id)
);

ALTER TABLE deal_pipeline_json_parsing ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_pipeline_json_thesis_fit ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_pipeline_json_founder_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_pipeline_json_traction_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_pipeline_json_problem_3c ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_pipeline_json_solution_3d ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_pipeline_json_market_power ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_pipeline_json_core_assumptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can select own deal_pipeline_json_parsing"
  ON deal_pipeline_json_parsing FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_parsing.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own deal_pipeline_json_parsing"
  ON deal_pipeline_json_parsing FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_parsing.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can update own deal_pipeline_json_parsing"
  ON deal_pipeline_json_parsing FOR UPDATE
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_parsing.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can delete own deal_pipeline_json_parsing"
  ON deal_pipeline_json_parsing FOR DELETE
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_parsing.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can select own deal_pipeline_json_thesis_fit"
  ON deal_pipeline_json_thesis_fit FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_thesis_fit.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own deal_pipeline_json_thesis_fit"
  ON deal_pipeline_json_thesis_fit FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_thesis_fit.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can update own deal_pipeline_json_thesis_fit"
  ON deal_pipeline_json_thesis_fit FOR UPDATE
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_thesis_fit.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can delete own deal_pipeline_json_thesis_fit"
  ON deal_pipeline_json_thesis_fit FOR DELETE
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_thesis_fit.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can select own deal_pipeline_json_founder_signals"
  ON deal_pipeline_json_founder_signals FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_founder_signals.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own deal_pipeline_json_founder_signals"
  ON deal_pipeline_json_founder_signals FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_founder_signals.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can update own deal_pipeline_json_founder_signals"
  ON deal_pipeline_json_founder_signals FOR UPDATE
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_founder_signals.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can delete own deal_pipeline_json_founder_signals"
  ON deal_pipeline_json_founder_signals FOR DELETE
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_founder_signals.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can select own deal_pipeline_json_traction_signals"
  ON deal_pipeline_json_traction_signals FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_traction_signals.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own deal_pipeline_json_traction_signals"
  ON deal_pipeline_json_traction_signals FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_traction_signals.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can update own deal_pipeline_json_traction_signals"
  ON deal_pipeline_json_traction_signals FOR UPDATE
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_traction_signals.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can delete own deal_pipeline_json_traction_signals"
  ON deal_pipeline_json_traction_signals FOR DELETE
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_traction_signals.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can select own deal_pipeline_json_problem_3c"
  ON deal_pipeline_json_problem_3c FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_problem_3c.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own deal_pipeline_json_problem_3c"
  ON deal_pipeline_json_problem_3c FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_problem_3c.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can update own deal_pipeline_json_problem_3c"
  ON deal_pipeline_json_problem_3c FOR UPDATE
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_problem_3c.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can delete own deal_pipeline_json_problem_3c"
  ON deal_pipeline_json_problem_3c FOR DELETE
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_problem_3c.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can select own deal_pipeline_json_solution_3d"
  ON deal_pipeline_json_solution_3d FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_solution_3d.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own deal_pipeline_json_solution_3d"
  ON deal_pipeline_json_solution_3d FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_solution_3d.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can update own deal_pipeline_json_solution_3d"
  ON deal_pipeline_json_solution_3d FOR UPDATE
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_solution_3d.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can delete own deal_pipeline_json_solution_3d"
  ON deal_pipeline_json_solution_3d FOR DELETE
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_solution_3d.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can select own deal_pipeline_json_market_power"
  ON deal_pipeline_json_market_power FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_market_power.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own deal_pipeline_json_market_power"
  ON deal_pipeline_json_market_power FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_market_power.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can update own deal_pipeline_json_market_power"
  ON deal_pipeline_json_market_power FOR UPDATE
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_market_power.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can delete own deal_pipeline_json_market_power"
  ON deal_pipeline_json_market_power FOR DELETE
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_market_power.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can select own deal_pipeline_json_core_assumptions"
  ON deal_pipeline_json_core_assumptions FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_core_assumptions.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own deal_pipeline_json_core_assumptions"
  ON deal_pipeline_json_core_assumptions FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_core_assumptions.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can update own deal_pipeline_json_core_assumptions"
  ON deal_pipeline_json_core_assumptions FOR UPDATE
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_core_assumptions.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can delete own deal_pipeline_json_core_assumptions"
  ON deal_pipeline_json_core_assumptions FOR DELETE
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_pipeline_json_core_assumptions.deal_id AND d.user_id = auth.uid()));
