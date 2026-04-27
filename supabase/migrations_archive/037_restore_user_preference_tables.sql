-- Restore user preference tables dropped by cleanup migration.
-- This recreates schema objects from 025_deal_intel_schema.sql.

CREATE SCHEMA IF NOT EXISTS deal_intel;
GRANT USAGE ON SCHEMA deal_intel TO authenticated, service_role;

CREATE TABLE IF NOT EXISTS deal_intel.user_agent_preference (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tone_language_rules text,
  forbidden_actions_behaviors jsonb NOT NULL DEFAULT '[]'::jsonb,
  general_agent_behavior_preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS deal_intel_user_agent_preference_updated_at ON deal_intel.user_agent_preference;
CREATE TRIGGER deal_intel_user_agent_preference_updated_at
BEFORE UPDATE ON deal_intel.user_agent_preference
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_updated_at();

CREATE TABLE IF NOT EXISTS deal_intel.user_website_preference (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  website text NOT NULL,
  situations_good_for text,
  focus_info_by_situation jsonb NOT NULL DEFAULT '{}'::jsonb,
  how_often_user_prefers_website text,
  how_often_user_likes_data_returned text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, website)
);

DROP TRIGGER IF EXISTS deal_intel_user_website_preference_updated_at ON deal_intel.user_website_preference;
CREATE TRIGGER deal_intel_user_website_preference_updated_at
BEFORE UPDATE ON deal_intel.user_website_preference
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_updated_at();

CREATE INDEX IF NOT EXISTS deal_intel_user_website_preference_user_idx
  ON deal_intel.user_website_preference(user_id);

CREATE TABLE IF NOT EXISTS deal_intel.user_website_preference_embedding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  website text NOT NULL,
  profile_embedding vector(768),
  embedding_model text,
  embedding_input text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, website)
);

DROP TRIGGER IF EXISTS deal_intel_user_website_preference_embedding_updated_at ON deal_intel.user_website_preference_embedding;
CREATE TRIGGER deal_intel_user_website_preference_embedding_updated_at
BEFORE UPDATE ON deal_intel.user_website_preference_embedding
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_updated_at();

ALTER TABLE deal_intel.user_agent_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.user_website_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.user_website_preference_embedding ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "deal_intel.user_agent_preference select own" ON deal_intel.user_agent_preference;
CREATE POLICY "deal_intel.user_agent_preference select own"
  ON deal_intel.user_agent_preference FOR SELECT
  USING (user_id = auth.uid());
DROP POLICY IF EXISTS "deal_intel.user_agent_preference upsert own" ON deal_intel.user_agent_preference;
CREATE POLICY "deal_intel.user_agent_preference upsert own"
  ON deal_intel.user_agent_preference FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "deal_intel.user_website_preference select own" ON deal_intel.user_website_preference;
CREATE POLICY "deal_intel.user_website_preference select own"
  ON deal_intel.user_website_preference FOR SELECT
  USING (user_id = auth.uid());
DROP POLICY IF EXISTS "deal_intel.user_website_preference upsert own" ON deal_intel.user_website_preference;
CREATE POLICY "deal_intel.user_website_preference upsert own"
  ON deal_intel.user_website_preference FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "deal_intel.user_website_preference_embedding select own" ON deal_intel.user_website_preference_embedding;
CREATE POLICY "deal_intel.user_website_preference_embedding select own"
  ON deal_intel.user_website_preference_embedding FOR SELECT
  USING (user_id = auth.uid());
DROP POLICY IF EXISTS "deal_intel.user_website_preference_embedding upsert own" ON deal_intel.user_website_preference_embedding;
CREATE POLICY "deal_intel.user_website_preference_embedding upsert own"
  ON deal_intel.user_website_preference_embedding FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
