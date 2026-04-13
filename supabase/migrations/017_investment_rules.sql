-- Investment criteria documents: per-user rules extracted from uploaded docs, aggregated context for pipeline injection.

CREATE TABLE IF NOT EXISTS investment_rule_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  storage_path text NOT NULL,
  original_filename text,
  mime_type text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
  error_message text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS investment_rule_documents_user_id_idx ON investment_rule_documents(user_id);

CREATE TABLE IF NOT EXISTS investment_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES investment_rule_documents(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  rule_text text NOT NULL,
  condition_text text NOT NULL DEFAULT '',
  rule_section text NOT NULL CHECK (rule_section IN ('problem', 'solution', 'founder')),
  condition_section text NOT NULL CHECK (condition_section IN ('problem', 'solution', 'founder', 'market')),
  polarity text NOT NULL CHECK (polarity IN ('positive', 'negative')),
  target_score_key text NOT NULL,
  specific_score_change numeric,
  keywords jsonb NOT NULL DEFAULT '[]'::jsonb,
  rule_json jsonb NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS investment_rules_user_id_idx ON investment_rules(user_id);
CREATE INDEX IF NOT EXISTS investment_rules_document_id_idx ON investment_rules(document_id);

-- One row per user: deduplicated aggregated rules by section for fast pipeline load
CREATE TABLE IF NOT EXISTS user_investment_rules_context (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  aggregated_by_section jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE investment_rule_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE investment_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_investment_rules_context ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own investment_rule_documents"
  ON investment_rule_documents FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users manage own investment_rules"
  ON investment_rules FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users manage own user_investment_rules_context"
  ON user_investment_rules_context FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Storage bucket `investment-rules` should be created in Supabase Dashboard (private). Server uses service role for upload.
