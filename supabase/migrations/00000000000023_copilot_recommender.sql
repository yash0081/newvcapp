-- Copilot recommender: per-user learned weights + per-decision feature log.
-- Powers online logistic regression on accept/reject + implicit dwell signals.

CREATE SCHEMA IF NOT EXISTS deal_intel;

-- 1) Per-user recommender weights. One row per user. Updated by SGD after each labeled event.
CREATE TABLE IF NOT EXISTS deal_intel.copilot_recommender_weights (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  weights jsonb NOT NULL DEFAULT '{}'::jsonb,
  updates_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- New hybrid exploration weights (can be overridden via upsert for existing users)
  w_same_host numeric DEFAULT 1.5,
  w_trusted_seed numeric DEFAULT -0.3,
  w_task_alignment numeric DEFAULT 0.8,
  w_novelty numeric DEFAULT 0.7,
  w_dead_end numeric DEFAULT -1.0
);

DROP TRIGGER IF EXISTS deal_intel_copilot_recommender_weights_updated_at
  ON deal_intel.copilot_recommender_weights;
CREATE TRIGGER deal_intel_copilot_recommender_weights_updated_at
BEFORE UPDATE ON deal_intel.copilot_recommender_weights
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_updated_at();

-- 2) Per-decision ranking event log. One row per top-K candidate considered.
-- `chosen=true` means the candidate was actually returned by plan-next this tick.
-- `label` is filled later by attribution (accept/reject/skip/paywall/dwell).
CREATE TABLE IF NOT EXISTS deal_intel.copilot_ranking_event (
  id bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES deal_intel.copilot_session(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  candidate_url text NOT NULL,
  candidate_host text NOT NULL,
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  chosen boolean NOT NULL DEFAULT false,
  label smallint, -- 1=positive, 0=negative, NULL=unresolved
  label_kind text, -- e.g. accept_suggestion, accept_draft, reject_suggestion, skip_host, paywall, implicit_engaged, implicit_bounce
  sample_weight numeric NOT NULL DEFAULT 1.0,
  created_at timestamptz NOT NULL DEFAULT now(),
  labeled_at timestamptz
);

CREATE INDEX IF NOT EXISTS deal_intel_copilot_ranking_event_session_idx
  ON deal_intel.copilot_ranking_event(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS deal_intel_copilot_ranking_event_user_host_idx
  ON deal_intel.copilot_ranking_event(user_id, candidate_host, created_at DESC);
-- Partial index for unresolved attribution lookups (most common query).
CREATE INDEX IF NOT EXISTS deal_intel_copilot_ranking_event_unlabeled_idx
  ON deal_intel.copilot_ranking_event(session_id, candidate_host, created_at DESC)
  WHERE label IS NULL;

-- RLS
ALTER TABLE deal_intel.copilot_recommender_weights ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.copilot_ranking_event ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "deal_intel.copilot_recommender_weights read"
  ON deal_intel.copilot_recommender_weights;
CREATE POLICY "deal_intel.copilot_recommender_weights read"
ON deal_intel.copilot_recommender_weights FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "deal_intel.copilot_recommender_weights write"
  ON deal_intel.copilot_recommender_weights;
CREATE POLICY "deal_intel.copilot_recommender_weights write"
ON deal_intel.copilot_recommender_weights FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "deal_intel.copilot_ranking_event read"
  ON deal_intel.copilot_ranking_event;
CREATE POLICY "deal_intel.copilot_ranking_event read"
ON deal_intel.copilot_ranking_event FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "deal_intel.copilot_ranking_event write"
  ON deal_intel.copilot_ranking_event;
CREATE POLICY "deal_intel.copilot_ranking_event write"
ON deal_intel.copilot_ranking_event FOR ALL USING (auth.uid() = user_id);

-- Grants
GRANT ALL ON TABLE deal_intel.copilot_recommender_weights TO anon, authenticated, service_role;
GRANT ALL ON TABLE deal_intel.copilot_ranking_event TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE deal_intel.copilot_ranking_event_id_seq TO anon, authenticated, service_role;
