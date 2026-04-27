-- Optional narrative + structured notes linking analysis to similar deals in the user's corpus.

ALTER TABLE deal_analyses
  ADD COLUMN IF NOT EXISTS user_corpus_thesis_context_json jsonb,
  ADD COLUMN IF NOT EXISTS user_corpus_risk_context_json jsonb;

ALTER TABLE deal_problem
  ADD COLUMN IF NOT EXISTS user_corpus_context_json jsonb;

ALTER TABLE deal_solution
  ADD COLUMN IF NOT EXISTS user_corpus_context_json jsonb;
