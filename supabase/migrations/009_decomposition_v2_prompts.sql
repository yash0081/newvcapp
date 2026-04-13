-- Align relational decomposition with Prompts V2-2 JSON shapes (Phase 1 team, 3C/3D, traction, founders).

-- Phase 1 team member fields (deck parse) — were only implicit via enrichment_raw
ALTER TABLE founders
  ADD COLUMN IF NOT EXISTS background_summary text,
  ADD COLUMN IF NOT EXISTS previous_companies jsonb,
  ADD COLUMN IF NOT EXISTS institutions jsonb,
  ADD COLUMN IF NOT EXISTS awards_and_honors jsonb,
  ADD COLUMN IF NOT EXISTS past_exits jsonb;

-- Traction agent: full traction_evidence blob + Phase 1 traction snapshot
ALTER TABLE deal_traction
  ADD COLUMN IF NOT EXISTS traction_evidence_json jsonb,
  ADD COLUMN IF NOT EXISTS phase1_traction_json jsonb,
  ADD COLUMN IF NOT EXISTS revenue_data text,
  ADD COLUMN IF NOT EXISTS growth_signals text,
  ADD COLUMN IF NOT EXISTS customer_depth text,
  ADD COLUMN IF NOT EXISTS user_traction text,
  ADD COLUMN IF NOT EXISTS notable_partners_and_validation jsonb,
  ADD COLUMN IF NOT EXISTS investor_list jsonb,
  ADD COLUMN IF NOT EXISTS milestones_detected jsonb;

-- Phase 3C: stated_problem_ref + signal completeness (prompt schema)
ALTER TABLE deal_problem
  ADD COLUMN IF NOT EXISTS stated_problem_ref text,
  ADD COLUMN IF NOT EXISTS signal_completeness text;

-- Phase 3D: signal_interpretation + proof points array
ALTER TABLE deal_solution
  ADD COLUMN IF NOT EXISTS signal_completeness text,
  ADD COLUMN IF NOT EXISTS differentiation_proof_points jsonb,
  ADD COLUMN IF NOT EXISTS competitor_landscape_json jsonb;

-- Tie competitor / differentiation rows to a specific analysis run
ALTER TABLE deal_competitors
  ADD COLUMN IF NOT EXISTS analysis_id uuid REFERENCES deal_analyses(id) ON DELETE CASCADE;

ALTER TABLE deal_differentiation
  ADD COLUMN IF NOT EXISTS analysis_id uuid REFERENCES deal_analyses(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS deal_competitors_deal_analysis_idx
  ON deal_competitors (deal_id, analysis_id);

CREATE INDEX IF NOT EXISTS deal_differentiation_deal_analysis_idx
  ON deal_differentiation (deal_id, analysis_id);
