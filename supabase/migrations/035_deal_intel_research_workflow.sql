-- deal_intel: per-deal research workflow planner + execution

CREATE SCHEMA IF NOT EXISTS deal_intel;
GRANT USAGE ON SCHEMA deal_intel TO authenticated, service_role;

CREATE TABLE IF NOT EXISTS deal_intel.deal_research_workflow (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deal_intel.deal(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'Research workflow',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready','running','done','archived')),
  version int NOT NULL DEFAULT 1,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS deal_intel_research_workflow_deal_user_active_idx
  ON deal_intel.deal_research_workflow(deal_id, user_id)
  WHERE status <> 'archived';
CREATE INDEX IF NOT EXISTS deal_intel_research_workflow_deal_updated_idx
  ON deal_intel.deal_research_workflow(deal_id, updated_at DESC);

DROP TRIGGER IF EXISTS deal_intel_research_workflow_updated_at ON deal_intel.deal_research_workflow;
CREATE TRIGGER deal_intel_research_workflow_updated_at
BEFORE UPDATE ON deal_intel.deal_research_workflow
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_updated_at();

CREATE TABLE IF NOT EXISTS deal_intel.deal_research_step (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES deal_intel.deal_research_workflow(id) ON DELETE CASCADE,
  position int NOT NULL DEFAULT 0 CHECK (position >= 0),
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','blocked','queued','running','done','failed')),
  website text NOT NULL,
  task text NOT NULL,
  notes text,
  depends_on_step_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_intel_research_step_workflow_position_idx
  ON deal_intel.deal_research_step(workflow_id, position);
CREATE INDEX IF NOT EXISTS deal_intel_research_step_workflow_status_idx
  ON deal_intel.deal_research_step(workflow_id, status);

DROP TRIGGER IF EXISTS deal_intel_research_step_updated_at ON deal_intel.deal_research_step;
CREATE TRIGGER deal_intel_research_step_updated_at
BEFORE UPDATE ON deal_intel.deal_research_step
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_updated_at();

CREATE TABLE IF NOT EXISTS deal_intel.deal_research_step_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES deal_intel.deal_research_workflow(id) ON DELETE CASCADE,
  step_id uuid NOT NULL REFERENCES deal_intel.deal_research_step(id) ON DELETE CASCADE,
  run_status text NOT NULL DEFAULT 'done' CHECK (run_status IN ('running','done','failed')),
  output_notes text,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_intel_research_step_run_step_created_idx
  ON deal_intel.deal_research_step_run(step_id, created_at DESC);
CREATE INDEX IF NOT EXISTS deal_intel_research_step_run_workflow_created_idx
  ON deal_intel.deal_research_step_run(workflow_id, created_at DESC);

CREATE TABLE IF NOT EXISTS deal_intel.deal_research_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES deal_intel.deal_research_workflow(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('accept_update','reject_update','manual_edit')),
  rationale text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_intel_research_feedback_workflow_created_idx
  ON deal_intel.deal_research_feedback(workflow_id, created_at DESC);

CREATE TABLE IF NOT EXISTS deal_intel.user_research_site_preference (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  domain text NOT NULL,
  category text NOT NULL DEFAULT 'general',
  preference_score numeric NOT NULL DEFAULT 0 CHECK (preference_score >= -1 AND preference_score <= 1),
  success_rate numeric NOT NULL DEFAULT 0.5 CHECK (success_rate >= 0 AND success_rate <= 1),
  usage_count int NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, domain, category)
);

CREATE INDEX IF NOT EXISTS deal_intel_user_research_pref_user_category_idx
  ON deal_intel.user_research_site_preference(user_id, category);

DROP TRIGGER IF EXISTS deal_intel_user_research_pref_updated_at ON deal_intel.user_research_site_preference;
CREATE TRIGGER deal_intel_user_research_pref_updated_at
BEFORE UPDATE ON deal_intel.user_research_site_preference
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_updated_at();

CREATE OR REPLACE FUNCTION deal_intel.user_can_access_research_workflow(p_workflow_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = deal_intel, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM deal_intel.deal_research_workflow rw
    JOIN deal_intel.deal d ON d.id = rw.deal_id
    WHERE rw.id = p_workflow_id
      AND d.user_id = auth.uid()
  );
$$;

ALTER TABLE deal_intel.deal_research_workflow ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.deal_research_step ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.deal_research_step_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.deal_research_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.user_research_site_preference ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "deal_intel.research_workflow read" ON deal_intel.deal_research_workflow;
CREATE POLICY "deal_intel.research_workflow read"
  ON deal_intel.deal_research_workflow FOR SELECT
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = deal_research_workflow.deal_id AND d.user_id = auth.uid()));
DROP POLICY IF EXISTS "deal_intel.research_workflow write" ON deal_intel.deal_research_workflow;
CREATE POLICY "deal_intel.research_workflow write"
  ON deal_intel.deal_research_workflow FOR ALL
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = deal_research_workflow.deal_id AND d.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = deal_research_workflow.deal_id AND d.user_id = auth.uid()));

DROP POLICY IF EXISTS "deal_intel.research_step read" ON deal_intel.deal_research_step;
CREATE POLICY "deal_intel.research_step read"
  ON deal_intel.deal_research_step FOR SELECT
  USING (deal_intel.user_can_access_research_workflow(deal_research_step.workflow_id));
DROP POLICY IF EXISTS "deal_intel.research_step write" ON deal_intel.deal_research_step;
CREATE POLICY "deal_intel.research_step write"
  ON deal_intel.deal_research_step FOR ALL
  USING (deal_intel.user_can_access_research_workflow(deal_research_step.workflow_id))
  WITH CHECK (deal_intel.user_can_access_research_workflow(deal_research_step.workflow_id));

DROP POLICY IF EXISTS "deal_intel.research_step_run read" ON deal_intel.deal_research_step_run;
CREATE POLICY "deal_intel.research_step_run read"
  ON deal_intel.deal_research_step_run FOR SELECT
  USING (deal_intel.user_can_access_research_workflow(deal_research_step_run.workflow_id));
DROP POLICY IF EXISTS "deal_intel.research_step_run write" ON deal_intel.deal_research_step_run;
CREATE POLICY "deal_intel.research_step_run write"
  ON deal_intel.deal_research_step_run FOR ALL
  USING (deal_intel.user_can_access_research_workflow(deal_research_step_run.workflow_id))
  WITH CHECK (deal_intel.user_can_access_research_workflow(deal_research_step_run.workflow_id));

DROP POLICY IF EXISTS "deal_intel.research_feedback read" ON deal_intel.deal_research_feedback;
CREATE POLICY "deal_intel.research_feedback read"
  ON deal_intel.deal_research_feedback FOR SELECT
  USING (deal_intel.user_can_access_research_workflow(deal_research_feedback.workflow_id));
DROP POLICY IF EXISTS "deal_intel.research_feedback write" ON deal_intel.deal_research_feedback;
CREATE POLICY "deal_intel.research_feedback write"
  ON deal_intel.deal_research_feedback FOR ALL
  USING (
    deal_intel.user_can_access_research_workflow(deal_research_feedback.workflow_id)
    AND deal_research_feedback.user_id = auth.uid()
  )
  WITH CHECK (
    deal_intel.user_can_access_research_workflow(deal_research_feedback.workflow_id)
    AND deal_research_feedback.user_id = auth.uid()
  );

DROP POLICY IF EXISTS "deal_intel.user_research_site_preference read" ON deal_intel.user_research_site_preference;
CREATE POLICY "deal_intel.user_research_site_preference read"
  ON deal_intel.user_research_site_preference FOR SELECT
  USING (user_id = auth.uid());
DROP POLICY IF EXISTS "deal_intel.user_research_site_preference write" ON deal_intel.user_research_site_preference;
CREATE POLICY "deal_intel.user_research_site_preference write"
  ON deal_intel.user_research_site_preference FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

