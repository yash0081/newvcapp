-- deal_intel: async background jobs + document components + preferences
-- This migration adds the minimum DB surface area needed for the “fast-first, async-enriched” model.

CREATE SCHEMA IF NOT EXISTS deal_intel;

-- 1) Background job queue (DB-native, simple + observable)
CREATE TABLE IF NOT EXISTS deal_intel.bg_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type text NOT NULL,
  subject_kind text NOT NULL,
  subject_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','deadletter')),
  priority int NOT NULL DEFAULT 100,
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 6,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_intel_bg_job_runnable_idx
  ON deal_intel.bg_job(status, next_run_at, priority, created_at);
CREATE INDEX IF NOT EXISTS deal_intel_bg_job_subject_idx
  ON deal_intel.bg_job(subject_kind, subject_id);

DROP TRIGGER IF EXISTS deal_intel_bg_job_updated_at ON deal_intel.bg_job;
CREATE TRIGGER deal_intel_bg_job_updated_at
BEFORE UPDATE ON deal_intel.bg_job
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_updated_at();

-- Enqueue job (idempotency is handled at app level for now).
CREATE OR REPLACE FUNCTION deal_intel.enqueue_job(
  p_job_type text,
  p_subject_kind text,
  p_subject_id uuid,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_priority int DEFAULT 100
) RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = deal_intel, public
AS $$
  INSERT INTO deal_intel.bg_job(job_type, subject_kind, subject_id, payload, priority)
  VALUES (p_job_type, p_subject_kind, p_subject_id, coalesce(p_payload, '{}'::jsonb), coalesce(p_priority, 100))
  RETURNING id;
$$;

-- Claim jobs (simple leasing). Worker provides an id string.
CREATE OR REPLACE FUNCTION deal_intel.claim_jobs(
  p_worker_id text,
  p_limit int DEFAULT 10
) RETURNS SETOF deal_intel.bg_job
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = deal_intel, public
AS $$
DECLARE
  v_limit int := greatest(1, least(coalesce(p_limit, 10), 50));
BEGIN
  RETURN QUERY
  WITH cte AS (
    SELECT id
    FROM deal_intel.bg_job
    WHERE status = 'queued'
      AND next_run_at <= now()
    ORDER BY priority ASC, created_at ASC
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE deal_intel.bg_job j
  SET status = 'running',
      locked_at = now(),
      locked_by = p_worker_id,
      attempts = attempts + 1,
      updated_at = now()
  FROM cte
  WHERE j.id = cte.id
  RETURNING j.*;
END;
$$;

-- Finish job.
CREATE OR REPLACE FUNCTION deal_intel.finish_job(
  p_job_id uuid,
  p_ok boolean,
  p_error text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = deal_intel, public
AS $$
DECLARE
  v_err text := left(coalesce(p_error, ''), 5000);
BEGIN
  IF p_ok THEN
    UPDATE deal_intel.bg_job
      SET status = 'done',
          error = NULL,
          locked_at = NULL,
          locked_by = NULL,
          updated_at = now()
    WHERE id = p_job_id;
  ELSE
    UPDATE deal_intel.bg_job
      SET status = CASE WHEN attempts >= max_attempts THEN 'deadletter' ELSE 'queued' END,
          error = v_err,
          locked_at = NULL,
          locked_by = NULL,
          next_run_at = CASE
            WHEN attempts >= max_attempts THEN now()
            ELSE now() + (interval '5 seconds' * greatest(1, attempts))
          END,
          updated_at = now()
    WHERE id = p_job_id;
  END IF;
END;
$$;

-- 2) Document components (structure-first units for semantic chunking)
CREATE TABLE IF NOT EXISTS deal_intel.document_component (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES deal_intel.document(id) ON DELETE CASCADE,
  component_kind text NOT NULL CHECK (component_kind IN ('heading','paragraph','bullet','table','slide','sentence_run','other')),
  page_number int NOT NULL CHECK (page_number >= 1),
  char_start int NOT NULL CHECK (char_start >= 0),
  char_end int NOT NULL CHECK (char_end >= 0),
  text text NOT NULL,
  tokens_est int NOT NULL DEFAULT 0 CHECK (tokens_est >= 0),
  structure_path text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding extensions.vector(768),
  embedding_model text,
  embedding_status text NOT NULL DEFAULT 'missing' CHECK (embedding_status IN ('missing','queued','computing','ready','error')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_intel_document_component_doc_idx
  ON deal_intel.document_component(document_id, page_number, char_start);
CREATE INDEX IF NOT EXISTS deal_intel_document_component_embedding_hnsw_idx
  ON deal_intel.document_component USING hnsw (embedding extensions.vector_cosine_ops)
  WITH (m='16', ef_construction='64')
  WHERE embedding IS NOT NULL;

-- 3) Add minimal “fast vs refined” markers to document/document_chunk (no UI job exposure required)
ALTER TABLE deal_intel.document
  ADD COLUMN IF NOT EXISTS doc_type text,
  ADD COLUMN IF NOT EXISTS routing_confidence double precision,
  ADD COLUMN IF NOT EXISTS routing_reason text;

ALTER TABLE deal_intel.document_chunk
  ADD COLUMN IF NOT EXISTS produced_by text DEFAULT 'fast' CHECK (produced_by IN ('fast','refined')),
  ADD COLUMN IF NOT EXISTS chunk_version int DEFAULT 1,
  ADD COLUMN IF NOT EXISTS merge_parent_ids uuid[] DEFAULT '{}'::uuid[];

-- 4) Preferences (Layer 1c/1d)
CREATE TABLE IF NOT EXISTS deal_intel.user_rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  rule_type text NOT NULL,
  value_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence double precision NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  recency_weight double precision NOT NULL DEFAULT 1.0 CHECK (recency_weight >= 0),
  is_explicit boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS deal_intel_user_rule_updated_at ON deal_intel.user_rule;
CREATE TRIGGER deal_intel_user_rule_updated_at
BEFORE UPDATE ON deal_intel.user_rule
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_updated_at();

CREATE TABLE IF NOT EXISTS deal_intel.website_preference (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  website_domain text NOT NULL,
  situation_description text,
  task_types text[] NOT NULL DEFAULT '{}'::text[],
  focus_guidance text,
  frequency_score double precision NOT NULL DEFAULT 0.5 CHECK (frequency_score >= 0 AND frequency_score <= 1),
  quality_score double precision NOT NULL DEFAULT 0.5 CHECK (quality_score >= 0 AND quality_score <= 1),
  preference_score double precision NOT NULL DEFAULT 0.5 CHECK (preference_score >= 0 AND preference_score <= 1),
  confidence double precision NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  recency_weight double precision NOT NULL DEFAULT 1.0 CHECK (recency_weight >= 0),
  is_explicit boolean NOT NULL DEFAULT false,
  context_embedding extensions.vector(768),
  purpose_embedding extensions.vector(768),
  company_embedding extensions.vector(768),
  embedding_model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS deal_intel_website_preference_updated_at ON deal_intel.website_preference;
CREATE TRIGGER deal_intel_website_preference_updated_at
BEFORE UPDATE ON deal_intel.website_preference
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_updated_at();

CREATE TABLE IF NOT EXISTS deal_intel.investment_preference (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  preference_text text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('like','dislike')),
  weight double precision NOT NULL DEFAULT 0.5 CHECK (weight >= 0 AND weight <= 1),
  confidence double precision NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  is_explicit boolean NOT NULL DEFAULT false,
  context_tags jsonb NOT NULL DEFAULT '{}'::jsonb,
  context_embedding extensions.vector(768),
  company_embedding extensions.vector(768),
  embedding_model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS deal_intel_investment_preference_updated_at ON deal_intel.investment_preference;
CREATE TRIGGER deal_intel_investment_preference_updated_at
BEFORE UPDATE ON deal_intel.investment_preference
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_updated_at();

-- 5) RLS (keep it simple: user owns their preference rows)
ALTER TABLE deal_intel.bg_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.document_component ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.user_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.website_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.investment_preference ENABLE ROW LEVEL SECURITY;

-- bg_job: service_role only (workers). No client access.
DROP POLICY IF EXISTS "deal_intel.bg_job service_role" ON deal_intel.bg_job;
CREATE POLICY "deal_intel.bg_job service_role"
  ON deal_intel.bg_job
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- document_component: authorize via parent document ownership (same pattern as document_chunk)
DROP POLICY IF EXISTS "deal_intel.document_component select own" ON deal_intel.document_component;
CREATE POLICY "deal_intel.document_component select own"
  ON deal_intel.document_component FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM deal_intel.document d
      WHERE d.id = document_component.document_id
        AND d.user_id = auth.uid()
    )
  );
DROP POLICY IF EXISTS "deal_intel.document_component insert own" ON deal_intel.document_component;
CREATE POLICY "deal_intel.document_component insert own"
  ON deal_intel.document_component FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM deal_intel.document d
      WHERE d.id = document_component.document_id
        AND d.user_id = auth.uid()
    )
  );
DROP POLICY IF EXISTS "deal_intel.document_component update own" ON deal_intel.document_component;
CREATE POLICY "deal_intel.document_component update own"
  ON deal_intel.document_component FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM deal_intel.document d
      WHERE d.id = document_component.document_id
        AND d.user_id = auth.uid()
    )
  );
DROP POLICY IF EXISTS "deal_intel.document_component delete own" ON deal_intel.document_component;
CREATE POLICY "deal_intel.document_component delete own"
  ON deal_intel.document_component FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM deal_intel.document d
      WHERE d.id = document_component.document_id
        AND d.user_id = auth.uid()
    )
  );

-- user_rule: user owns by user_id
DROP POLICY IF EXISTS "deal_intel.user_rule own" ON deal_intel.user_rule;
CREATE POLICY "deal_intel.user_rule own"
  ON deal_intel.user_rule
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "deal_intel.website_preference own" ON deal_intel.website_preference;
CREATE POLICY "deal_intel.website_preference own"
  ON deal_intel.website_preference
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "deal_intel.investment_preference own" ON deal_intel.investment_preference;
CREATE POLICY "deal_intel.investment_preference own"
  ON deal_intel.investment_preference
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

