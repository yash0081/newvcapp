-- deal_intel: research copilot sessions + per-event log

CREATE SCHEMA IF NOT EXISTS deal_intel;

-- 1) Sessions: one per deal "research watch" run; finalize creates a document.
CREATE TABLE IF NOT EXISTS deal_intel.copilot_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deal_intel.deal(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','finalized','abandoned')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  finalized_document_id uuid REFERENCES deal_intel.document(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_intel_copilot_session_deal_status_idx
  ON deal_intel.copilot_session(deal_id, status);
CREATE INDEX IF NOT EXISTS deal_intel_copilot_session_user_started_idx
  ON deal_intel.copilot_session(user_id, started_at DESC);

DROP TRIGGER IF EXISTS deal_intel_copilot_session_updated_at ON deal_intel.copilot_session;
CREATE TRIGGER deal_intel_copilot_session_updated_at
BEFORE UPDATE ON deal_intel.copilot_session
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_updated_at();

-- 2) Event log per session (observations, suggestions, decisions, prompts, errors).
CREATE TABLE IF NOT EXISTS deal_intel.copilot_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES deal_intel.copilot_session(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('observation','suggestion','accepted','rejected','prompt','reply','error')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  hostname text,
  parent_event_id uuid REFERENCES deal_intel.copilot_event(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_intel_copilot_event_session_created_idx
  ON deal_intel.copilot_event(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS deal_intel_copilot_event_session_kind_idx
  ON deal_intel.copilot_event(session_id, kind, created_at DESC);

-- 3) RLS access helper, mirroring user_can_access_research_workflow.
CREATE OR REPLACE FUNCTION deal_intel.user_can_access_copilot_session(p_session_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = deal_intel, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM deal_intel.copilot_session s
    JOIN deal_intel.deal d ON d.id = s.deal_id
    WHERE s.id = p_session_id
      AND d.user_id = auth.uid()
  );
$$;

GRANT ALL ON FUNCTION deal_intel.user_can_access_copilot_session(uuid) TO anon, authenticated, service_role;

-- 4) RLS
ALTER TABLE deal_intel.copilot_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.copilot_event ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "deal_intel.copilot_session read" ON deal_intel.copilot_session;
CREATE POLICY "deal_intel.copilot_session read"
ON deal_intel.copilot_session
FOR SELECT
USING (EXISTS (
  SELECT 1 FROM deal_intel.deal d
  WHERE d.id = copilot_session.deal_id AND d.user_id = auth.uid()
));

DROP POLICY IF EXISTS "deal_intel.copilot_session write" ON deal_intel.copilot_session;
CREATE POLICY "deal_intel.copilot_session write"
ON deal_intel.copilot_session
USING (EXISTS (
  SELECT 1 FROM deal_intel.deal d
  WHERE d.id = copilot_session.deal_id AND d.user_id = auth.uid()
))
WITH CHECK (EXISTS (
  SELECT 1 FROM deal_intel.deal d
  WHERE d.id = copilot_session.deal_id AND d.user_id = auth.uid()
));

DROP POLICY IF EXISTS "deal_intel.copilot_event read" ON deal_intel.copilot_event;
CREATE POLICY "deal_intel.copilot_event read"
ON deal_intel.copilot_event
FOR SELECT
USING (deal_intel.user_can_access_copilot_session(session_id));

DROP POLICY IF EXISTS "deal_intel.copilot_event write" ON deal_intel.copilot_event;
CREATE POLICY "deal_intel.copilot_event write"
ON deal_intel.copilot_event
USING (deal_intel.user_can_access_copilot_session(session_id))
WITH CHECK (deal_intel.user_can_access_copilot_session(session_id));

-- 5) Grants
GRANT ALL ON TABLE deal_intel.copilot_session TO anon, authenticated, service_role;
GRANT ALL ON TABLE deal_intel.copilot_event   TO anon, authenticated, service_role;
