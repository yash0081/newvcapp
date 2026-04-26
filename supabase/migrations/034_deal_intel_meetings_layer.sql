-- deal_intel: live meeting assistant tables (sessions, transcript segments, memory, assistant events)
-- This is the MVP persistence layer for LiveKit-hosted meetings.

CREATE SCHEMA IF NOT EXISTS deal_intel;
GRANT USAGE ON SCHEMA deal_intel TO authenticated, service_role;

-- 1) Meeting session (host-owned, deal-scoped)
CREATE TABLE IF NOT EXISTS deal_intel.meeting_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deal_intel.deal(id) ON DELETE CASCADE,
  host_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  livekit_room_name text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created','live','ended','error')),
  started_at timestamptz,
  ended_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS deal_intel_meeting_session_updated_at ON deal_intel.meeting_session;
CREATE TRIGGER deal_intel_meeting_session_updated_at
BEFORE UPDATE ON deal_intel.meeting_session
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_updated_at();

CREATE INDEX IF NOT EXISTS deal_intel_meeting_session_deal_idx
  ON deal_intel.meeting_session(deal_id);
CREATE INDEX IF NOT EXISTS deal_intel_meeting_session_host_idx
  ON deal_intel.meeting_session(host_user_id);

-- 2) Participants (optional, for display/audit)
CREATE TABLE IF NOT EXISTS deal_intel.meeting_participant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id uuid NOT NULL REFERENCES deal_intel.meeting_session(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('host','guest')),
  display_name text,
  livekit_identity text,
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz
);

CREATE INDEX IF NOT EXISTS deal_intel_meeting_participant_meeting_idx
  ON deal_intel.meeting_participant(meeting_id);

-- 3) Transcript segments (append-only with revisions for corrections)
CREATE TABLE IF NOT EXISTS deal_intel.meeting_transcript_segment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id uuid NOT NULL REFERENCES deal_intel.meeting_session(id) ON DELETE CASCADE,
  segment_key text NOT NULL,
  revision int NOT NULL DEFAULT 0,
  speaker text,
  t_start_ms int NOT NULL CHECK (t_start_ms >= 0),
  t_end_ms int NOT NULL CHECK (t_end_ms >= 0),
  text text NOT NULL,
  is_final boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (meeting_id, segment_key, revision)
);

CREATE INDEX IF NOT EXISTS deal_intel_meeting_transcript_segment_meeting_time_idx
  ON deal_intel.meeting_transcript_segment(meeting_id, t_start_ms);
CREATE INDEX IF NOT EXISTS deal_intel_meeting_transcript_segment_meeting_key_idx
  ON deal_intel.meeting_transcript_segment(meeting_id, segment_key);

-- 4) Rolling memory (one row per meeting)
CREATE TABLE IF NOT EXISTS deal_intel.meeting_memory (
  meeting_id uuid PRIMARY KEY REFERENCES deal_intel.meeting_session(id) ON DELETE CASCADE,
  running_summary text NOT NULL DEFAULT '',
  last_summarized_t_ms int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 5) Assistant events (what client renders as cards)
CREATE TABLE IF NOT EXISTS deal_intel.meeting_assistant_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id uuid NOT NULL REFERENCES deal_intel.meeting_session(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('contradiction','crm_fact','key_point','suggested_question','action_prompt')),
  title text,
  body text NOT NULL,
  severity text NOT NULL DEFAULT 'low' CHECK (severity IN ('low','med','high')),
  source_map jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_intel_meeting_assistant_event_meeting_created_idx
  ON deal_intel.meeting_assistant_event(meeting_id, created_at);

-- 6) RLS policies (host-only MVP; guests should not have direct DB access)
ALTER TABLE deal_intel.meeting_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.meeting_participant ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.meeting_transcript_segment ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.meeting_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.meeting_assistant_event ENABLE ROW LEVEL SECURITY;

-- Helper: user owns meeting if they own the deal or are host_user_id (both should be true for normal flows).
CREATE OR REPLACE FUNCTION deal_intel.user_can_access_meeting(p_meeting_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = deal_intel, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM deal_intel.meeting_session ms
    JOIN deal_intel.deal d ON d.id = ms.deal_id
    WHERE ms.id = p_meeting_id
      AND d.user_id = auth.uid()
  );
$$;

-- meeting_session: authorize via deal ownership
DROP POLICY IF EXISTS "deal_intel.meeting_session select own" ON deal_intel.meeting_session;
CREATE POLICY "deal_intel.meeting_session select own"
  ON deal_intel.meeting_session FOR SELECT
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = meeting_session.deal_id AND d.user_id = auth.uid()));
DROP POLICY IF EXISTS "deal_intel.meeting_session insert own" ON deal_intel.meeting_session;
CREATE POLICY "deal_intel.meeting_session insert own"
  ON deal_intel.meeting_session FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = meeting_session.deal_id AND d.user_id = auth.uid()));
DROP POLICY IF EXISTS "deal_intel.meeting_session update own" ON deal_intel.meeting_session;
CREATE POLICY "deal_intel.meeting_session update own"
  ON deal_intel.meeting_session FOR UPDATE
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = meeting_session.deal_id AND d.user_id = auth.uid()));
DROP POLICY IF EXISTS "deal_intel.meeting_session delete own" ON deal_intel.meeting_session;
CREATE POLICY "deal_intel.meeting_session delete own"
  ON deal_intel.meeting_session FOR DELETE
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = meeting_session.deal_id AND d.user_id = auth.uid()));

-- meeting children: authorize via parent meeting + deal ownership
DROP POLICY IF EXISTS "deal_intel.meeting_participant read" ON deal_intel.meeting_participant;
CREATE POLICY "deal_intel.meeting_participant read"
  ON deal_intel.meeting_participant FOR SELECT
  USING (deal_intel.user_can_access_meeting(meeting_participant.meeting_id));
DROP POLICY IF EXISTS "deal_intel.meeting_participant write" ON deal_intel.meeting_participant;
CREATE POLICY "deal_intel.meeting_participant write"
  ON deal_intel.meeting_participant FOR ALL
  USING (deal_intel.user_can_access_meeting(meeting_participant.meeting_id))
  WITH CHECK (deal_intel.user_can_access_meeting(meeting_participant.meeting_id));

DROP POLICY IF EXISTS "deal_intel.meeting_transcript_segment read" ON deal_intel.meeting_transcript_segment;
CREATE POLICY "deal_intel.meeting_transcript_segment read"
  ON deal_intel.meeting_transcript_segment FOR SELECT
  USING (deal_intel.user_can_access_meeting(meeting_transcript_segment.meeting_id));
DROP POLICY IF EXISTS "deal_intel.meeting_transcript_segment write" ON deal_intel.meeting_transcript_segment;
CREATE POLICY "deal_intel.meeting_transcript_segment write"
  ON deal_intel.meeting_transcript_segment FOR ALL
  USING (deal_intel.user_can_access_meeting(meeting_transcript_segment.meeting_id))
  WITH CHECK (deal_intel.user_can_access_meeting(meeting_transcript_segment.meeting_id));

DROP POLICY IF EXISTS "deal_intel.meeting_memory read" ON deal_intel.meeting_memory;
CREATE POLICY "deal_intel.meeting_memory read"
  ON deal_intel.meeting_memory FOR SELECT
  USING (deal_intel.user_can_access_meeting(meeting_memory.meeting_id));
DROP POLICY IF EXISTS "deal_intel.meeting_memory write" ON deal_intel.meeting_memory;
CREATE POLICY "deal_intel.meeting_memory write"
  ON deal_intel.meeting_memory FOR ALL
  USING (deal_intel.user_can_access_meeting(meeting_memory.meeting_id))
  WITH CHECK (deal_intel.user_can_access_meeting(meeting_memory.meeting_id));

DROP POLICY IF EXISTS "deal_intel.meeting_assistant_event read" ON deal_intel.meeting_assistant_event;
CREATE POLICY "deal_intel.meeting_assistant_event read"
  ON deal_intel.meeting_assistant_event FOR SELECT
  USING (deal_intel.user_can_access_meeting(meeting_assistant_event.meeting_id));
DROP POLICY IF EXISTS "deal_intel.meeting_assistant_event write" ON deal_intel.meeting_assistant_event;
CREATE POLICY "deal_intel.meeting_assistant_event write"
  ON deal_intel.meeting_assistant_event FOR ALL
  USING (deal_intel.user_can_access_meeting(meeting_assistant_event.meeting_id))
  WITH CHECK (deal_intel.user_can_access_meeting(meeting_assistant_event.meeting_id));

