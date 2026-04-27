-- Public wrappers for bg job queue RPCs (consistent with existing `public.deal_intel_*` pattern)

CREATE OR REPLACE FUNCTION public.deal_intel_enqueue_job(
  p_job_type text,
  p_subject_kind text,
  p_subject_id uuid,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_priority int DEFAULT 100
) RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT deal_intel.enqueue_job(p_job_type, p_subject_kind, p_subject_id, p_payload, p_priority);
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_claim_jobs(
  p_worker_id text,
  p_limit int DEFAULT 10
) RETURNS SETOF deal_intel.bg_job
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT * FROM deal_intel.claim_jobs(p_worker_id, p_limit);
$$;

CREATE OR REPLACE FUNCTION public.deal_intel_finish_job(
  p_job_id uuid,
  p_ok boolean,
  p_error text DEFAULT NULL
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT deal_intel.finish_job(p_job_id, p_ok, p_error);
$$;

GRANT ALL ON FUNCTION public.deal_intel_enqueue_job(text, text, uuid, jsonb, int) TO service_role;
GRANT ALL ON FUNCTION public.deal_intel_claim_jobs(text, int) TO service_role;
GRANT ALL ON FUNCTION public.deal_intel_finish_job(uuid, boolean, text) TO service_role;

