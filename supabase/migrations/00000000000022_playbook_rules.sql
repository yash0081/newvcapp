-- Layer B: Numeric knobs (thresholds, priorities) extracted from telemetry
CREATE TABLE IF NOT EXISTS deal_intel.copilot_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  task_type text NOT NULL,
  domain text NOT NULL,
  policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, task_type, domain)
);

-- Layer C: Prose rules for LLM prompt injection
CREATE TABLE IF NOT EXISTS deal_intel.user_playbook_rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  task_type text NOT NULL,
  domain text,
  rule_text text NOT NULL,
  confidence numeric NOT NULL DEFAULT 0.5,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS deal_intel_copilot_policy_user_idx ON deal_intel.copilot_policy(user_id);
CREATE INDEX IF NOT EXISTS deal_intel_user_playbook_rule_user_idx ON deal_intel.user_playbook_rule(user_id, task_type);

-- Triggers for updated_at
DROP TRIGGER IF EXISTS deal_intel_copilot_policy_updated_at ON deal_intel.copilot_policy;
CREATE TRIGGER deal_intel_copilot_policy_updated_at
BEFORE UPDATE ON deal_intel.copilot_policy
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_updated_at();

DROP TRIGGER IF EXISTS deal_intel_user_playbook_rule_updated_at ON deal_intel.user_playbook_rule;
CREATE TRIGGER deal_intel_user_playbook_rule_updated_at
BEFORE UPDATE ON deal_intel.user_playbook_rule
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_updated_at();

-- RLS
ALTER TABLE deal_intel.copilot_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.user_playbook_rule ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "deal_intel.copilot_policy read" ON deal_intel.copilot_policy;
CREATE POLICY "deal_intel.copilot_policy read" ON deal_intel.copilot_policy FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "deal_intel.copilot_policy write" ON deal_intel.copilot_policy;
CREATE POLICY "deal_intel.copilot_policy write" ON deal_intel.copilot_policy FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "deal_intel.user_playbook_rule read" ON deal_intel.user_playbook_rule;
CREATE POLICY "deal_intel.user_playbook_rule read" ON deal_intel.user_playbook_rule FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "deal_intel.user_playbook_rule write" ON deal_intel.user_playbook_rule;
CREATE POLICY "deal_intel.user_playbook_rule write" ON deal_intel.user_playbook_rule FOR ALL USING (auth.uid() = user_id);

-- Grants
GRANT ALL ON TABLE deal_intel.copilot_policy TO anon, authenticated, service_role;
GRANT ALL ON TABLE deal_intel.user_playbook_rule TO anon, authenticated, service_role;
