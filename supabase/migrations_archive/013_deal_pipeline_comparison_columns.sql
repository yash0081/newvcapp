-- Structured comparison slices from LLM outputs
-- (past-deal delta reasoning + assumption-to-past-deal failure-mode mapping)

ALTER TABLE deal_pipeline_json_thesis_fit
  ADD COLUMN IF NOT EXISTS past_deal_comparisons_json jsonb;

ALTER TABLE deal_pipeline_json_traction_signals
  ADD COLUMN IF NOT EXISTS past_deal_comparisons_json jsonb;

ALTER TABLE deal_pipeline_json_problem_3c
  ADD COLUMN IF NOT EXISTS past_deal_comparisons_json jsonb;

ALTER TABLE deal_pipeline_json_solution_3d
  ADD COLUMN IF NOT EXISTS past_deal_comparisons_json jsonb;

ALTER TABLE deal_pipeline_json_core_assumptions
  ADD COLUMN IF NOT EXISTS past_deal_comparisons_json jsonb;

ALTER TABLE deal_pipeline_json_core_assumptions
  ADD COLUMN IF NOT EXISTS assumption_comparisons_json jsonb;

