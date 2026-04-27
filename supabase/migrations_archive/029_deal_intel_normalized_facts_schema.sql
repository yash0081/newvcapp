-- deal_intel: normalized relational “facts” tables to mirror Schema.pdf buckets.
-- These tables are additive and coexist with:
-- - deal_intel.deal_fact_node / deal_fact_edge (flattened facts + embeddings + FTS)
-- - deal_intel.deal_tree_node / deal_tree_edge (retrieval tree + embeddings)
--
-- Design goals:
-- - Fully normalized tables (per user request)
-- - All rows authorized via ownership of deal_intel.deal.user_id
-- - Optional revision_id on tables where versioning is meaningful

CREATE SCHEMA IF NOT EXISTS deal_intel;
GRANT USAGE ON SCHEMA deal_intel TO authenticated, service_role;

-- ==============
-- 1) People / team
-- ==============

CREATE TABLE IF NOT EXISTS deal_intel.company_person (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deal_intel.deal(id) ON DELETE CASCADE,
  revision_id uuid REFERENCES deal_intel.deal_revision(id) ON DELETE SET NULL,
  person_kind text NOT NULL DEFAULT 'notable_company_person'
    CHECK (person_kind IN ('founder','team_member','notable_company_person')),
  name text NOT NULL,
  company_role text,
  general_description text,
  age int,
  location text,
  misc text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS deal_intel_company_person_updated_at ON deal_intel.company_person;
CREATE TRIGGER deal_intel_company_person_updated_at
BEFORE UPDATE ON deal_intel.company_person
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_updated_at();

CREATE INDEX IF NOT EXISTS deal_intel_company_person_deal_idx ON deal_intel.company_person(deal_id);
CREATE INDEX IF NOT EXISTS deal_intel_company_person_revision_idx ON deal_intel.company_person(revision_id);
CREATE INDEX IF NOT EXISTS deal_intel_company_person_name_idx ON deal_intel.company_person(deal_id, name);

CREATE TABLE IF NOT EXISTS deal_intel.company_person_education (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES deal_intel.company_person(id) ON DELETE CASCADE,
  general_description text,
  institution text,
  majors text[],
  gpa text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_intel_company_person_education_person_idx
  ON deal_intel.company_person_education(person_id);

CREATE TABLE IF NOT EXISTS deal_intel.company_person_experience (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES deal_intel.company_person(id) ON DELETE CASCADE,
  general_description text,
  past_companies_worked_at text[],
  past_companies_founded_or_exits text[],
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_intel_company_person_experience_person_idx
  ON deal_intel.company_person_experience(person_id);

CREATE TABLE IF NOT EXISTS deal_intel.company_person_achievement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES deal_intel.company_person(id) ON DELETE CASCADE,
  achievement_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_intel_company_person_achievement_person_idx
  ON deal_intel.company_person_achievement(person_id);

CREATE TABLE IF NOT EXISTS deal_intel.company_person_research (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES deal_intel.company_person(id) ON DELETE CASCADE,
  research_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_intel_company_person_research_person_idx
  ON deal_intel.company_person_research(person_id);

CREATE TABLE IF NOT EXISTS deal_intel.company_person_patent (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES deal_intel.company_person(id) ON DELETE CASCADE,
  patent_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_intel_company_person_patent_person_idx
  ON deal_intel.company_person_patent(person_id);

CREATE TABLE IF NOT EXISTS deal_intel.company_person_project (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES deal_intel.company_person(id) ON DELETE CASCADE,
  project_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_intel_company_person_project_person_idx
  ON deal_intel.company_person_project(person_id);

-- =================
-- 2) Company makeup
-- =================

CREATE TABLE IF NOT EXISTS deal_intel.company_makeup (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deal_intel.deal(id) ON DELETE CASCADE,
  revision_id uuid REFERENCES deal_intel.deal_revision(id) ON DELETE SET NULL,
  general_description text,
  general_education_history text,
  general_work_background text,
  company_size int,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deal_id, revision_id)
);

DROP TRIGGER IF EXISTS deal_intel_company_makeup_updated_at ON deal_intel.company_makeup;
CREATE TRIGGER deal_intel_company_makeup_updated_at
BEFORE UPDATE ON deal_intel.company_makeup
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_updated_at();

CREATE INDEX IF NOT EXISTS deal_intel_company_makeup_deal_idx ON deal_intel.company_makeup(deal_id);

-- ==========================
-- 3) Company origin story
-- ==========================

CREATE TABLE IF NOT EXISTS deal_intel.company_origin_story (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deal_intel.deal(id) ON DELETE CASCADE,
  revision_id uuid REFERENCES deal_intel.deal_revision(id) ON DELETE SET NULL,
  general_description text,
  cohesion_signals text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deal_id, revision_id)
);

DROP TRIGGER IF EXISTS deal_intel_company_origin_story_updated_at ON deal_intel.company_origin_story;
CREATE TRIGGER deal_intel_company_origin_story_updated_at
BEFORE UPDATE ON deal_intel.company_origin_story
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_updated_at();

CREATE INDEX IF NOT EXISTS deal_intel_company_origin_story_deal_idx ON deal_intel.company_origin_story(deal_id);

-- ===============
-- 4) Company problem
-- ===============

CREATE TABLE IF NOT EXISTS deal_intel.company_problem (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deal_intel.deal(id) ON DELETE CASCADE,
  revision_id uuid REFERENCES deal_intel.deal_revision(id) ON DELETE SET NULL,
  general_problem_description text,
  urgency text,
  current_cost_for_customers text,
  tam text,
  sam text,
  som text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deal_id, revision_id)
);

DROP TRIGGER IF EXISTS deal_intel_company_problem_updated_at ON deal_intel.company_problem;
CREATE TRIGGER deal_intel_company_problem_updated_at
BEFORE UPDATE ON deal_intel.company_problem
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_updated_at();

CREATE INDEX IF NOT EXISTS deal_intel_company_problem_deal_idx ON deal_intel.company_problem(deal_id);

CREATE TABLE IF NOT EXISTS deal_intel.problem_customer (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  problem_id uuid NOT NULL REFERENCES deal_intel.company_problem(id) ON DELETE CASCADE,
  customer_kind text NOT NULL CHECK (customer_kind IN ('potential','intended')),
  customer_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_intel_problem_customer_problem_idx ON deal_intel.problem_customer(problem_id);

-- =================
-- 5) Company solution
-- =================

CREATE TABLE IF NOT EXISTS deal_intel.company_solution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deal_intel.deal(id) ON DELETE CASCADE,
  revision_id uuid REFERENCES deal_intel.deal_revision(id) ON DELETE SET NULL,
  general_description text,
  novelty_or_uniqueness text,
  timeline_description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deal_id, revision_id)
);

DROP TRIGGER IF EXISTS deal_intel_company_solution_updated_at ON deal_intel.company_solution;
CREATE TRIGGER deal_intel_company_solution_updated_at
BEFORE UPDATE ON deal_intel.company_solution
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_updated_at();

CREATE INDEX IF NOT EXISTS deal_intel_company_solution_deal_idx ON deal_intel.company_solution(deal_id);

CREATE TABLE IF NOT EXISTS deal_intel.solution_customer (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  solution_id uuid NOT NULL REFERENCES deal_intel.company_solution(id) ON DELETE CASCADE,
  customer_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_intel_solution_customer_solution_idx ON deal_intel.solution_customer(solution_id);

CREATE TABLE IF NOT EXISTS deal_intel.solution_pricing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  solution_id uuid NOT NULL REFERENCES deal_intel.company_solution(id) ON DELETE CASCADE,
  customer_price text,
  company_cost_to_serve text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_intel_solution_pricing_solution_idx ON deal_intel.solution_pricing(solution_id);

CREATE TABLE IF NOT EXISTS deal_intel.solution_distinguishing_factor (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  solution_id uuid NOT NULL REFERENCES deal_intel.company_solution(id) ON DELETE CASCADE,
  factor_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_intel_solution_dist_factor_solution_idx
  ON deal_intel.solution_distinguishing_factor(solution_id);

CREATE TABLE IF NOT EXISTS deal_intel.solution_defensibility (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  solution_id uuid NOT NULL REFERENCES deal_intel.company_solution(id) ON DELETE CASCADE,
  patent_ip text,
  proprietary_tech text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_intel_solution_defensibility_solution_idx
  ON deal_intel.solution_defensibility(solution_id);

CREATE TABLE IF NOT EXISTS deal_intel.solution_competitor (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  solution_id uuid NOT NULL REFERENCES deal_intel.company_solution(id) ON DELETE CASCADE,
  name text NOT NULL,
  company_type text,
  similarity text,
  threat_posed text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_intel_solution_competitor_solution_idx
  ON deal_intel.solution_competitor(solution_id);
CREATE INDEX IF NOT EXISTS deal_intel_solution_competitor_name_idx
  ON deal_intel.solution_competitor(solution_id, name);

-- ===============
-- 6) Company traction
-- ===============

CREATE TABLE IF NOT EXISTS deal_intel.company_traction (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deal_intel.deal(id) ON DELETE CASCADE,
  revision_id uuid REFERENCES deal_intel.deal_revision(id) ON DELETE SET NULL,
  revenue_data text,
  company_stage text,
  product_stage text,
  customer_size_and_count text,
  growth_trends_description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deal_id, revision_id)
);

DROP TRIGGER IF EXISTS deal_intel_company_traction_updated_at ON deal_intel.company_traction;
CREATE TRIGGER deal_intel_company_traction_updated_at
BEFORE UPDATE ON deal_intel.company_traction
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_updated_at();

CREATE INDEX IF NOT EXISTS deal_intel_company_traction_deal_idx ON deal_intel.company_traction(deal_id);

CREATE TABLE IF NOT EXISTS deal_intel.traction_funding_round (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  traction_id uuid NOT NULL REFERENCES deal_intel.company_traction(id) ON DELETE CASCADE,
  stage_label text,
  amount_raised text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_intel_traction_round_traction_idx ON deal_intel.traction_funding_round(traction_id);

CREATE TABLE IF NOT EXISTS deal_intel.traction_investor (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  traction_id uuid NOT NULL REFERENCES deal_intel.company_traction(id) ON DELETE CASCADE,
  investor_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_intel_traction_investor_traction_idx ON deal_intel.traction_investor(traction_id);

CREATE TABLE IF NOT EXISTS deal_intel.traction_partner_or_customer (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  traction_id uuid NOT NULL REFERENCES deal_intel.company_traction(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'partner_or_customer'
    CHECK (kind IN ('partner','customer','partner_or_customer')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_intel_traction_partner_customer_traction_idx
  ON deal_intel.traction_partner_or_customer(traction_id);

-- ===============
-- 7) Negatives
-- ===============

CREATE TABLE IF NOT EXISTS deal_intel.negative_aspect (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deal_intel.deal(id) ON DELETE CASCADE,
  revision_id uuid REFERENCES deal_intel.deal_revision(id) ON DELETE SET NULL,
  negative_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_intel_negative_aspect_deal_idx ON deal_intel.negative_aspect(deal_id);

-- =================
-- RLS policies (authorize via deal ownership)
-- =================

ALTER TABLE deal_intel.company_person ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.company_person_education ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.company_person_experience ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.company_person_achievement ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.company_person_research ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.company_person_patent ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.company_person_project ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.company_makeup ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.company_origin_story ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.company_problem ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.problem_customer ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.company_solution ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.solution_customer ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.solution_pricing ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.solution_distinguishing_factor ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.solution_defensibility ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.solution_competitor ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.company_traction ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.traction_funding_round ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.traction_investor ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.traction_partner_or_customer ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_intel.negative_aspect ENABLE ROW LEVEL SECURITY;

-- Helper predicate: allow access if current user owns the deal.
-- Note: policies are repeated per table because Postgres RLS doesn't share macros.

-- company_person (direct deal_id)
CREATE POLICY "deal_intel.company_person select own"
  ON deal_intel.company_person FOR SELECT
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = company_person.deal_id AND d.user_id = auth.uid()));
CREATE POLICY "deal_intel.company_person insert own"
  ON deal_intel.company_person FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = company_person.deal_id AND d.user_id = auth.uid()));
CREATE POLICY "deal_intel.company_person update own"
  ON deal_intel.company_person FOR UPDATE
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = company_person.deal_id AND d.user_id = auth.uid()));
CREATE POLICY "deal_intel.company_person delete own"
  ON deal_intel.company_person FOR DELETE
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = company_person.deal_id AND d.user_id = auth.uid()));

-- Children of company_person: authorize via parent join
CREATE POLICY "deal_intel.company_person_education select own"
  ON deal_intel.company_person_education FOR SELECT
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_person p
    JOIN deal_intel.deal d ON d.id = p.deal_id
    WHERE p.id = company_person_education.person_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.company_person_education insert own"
  ON deal_intel.company_person_education FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1
    FROM deal_intel.company_person p
    JOIN deal_intel.deal d ON d.id = p.deal_id
    WHERE p.id = company_person_education.person_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.company_person_education update own"
  ON deal_intel.company_person_education FOR UPDATE
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_person p
    JOIN deal_intel.deal d ON d.id = p.deal_id
    WHERE p.id = company_person_education.person_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.company_person_education delete own"
  ON deal_intel.company_person_education FOR DELETE
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_person p
    JOIN deal_intel.deal d ON d.id = p.deal_id
    WHERE p.id = company_person_education.person_id AND d.user_id = auth.uid()
  ));

CREATE POLICY "deal_intel.company_person_experience select own"
  ON deal_intel.company_person_experience FOR SELECT
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_person p
    JOIN deal_intel.deal d ON d.id = p.deal_id
    WHERE p.id = company_person_experience.person_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.company_person_experience insert own"
  ON deal_intel.company_person_experience FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1
    FROM deal_intel.company_person p
    JOIN deal_intel.deal d ON d.id = p.deal_id
    WHERE p.id = company_person_experience.person_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.company_person_experience update own"
  ON deal_intel.company_person_experience FOR UPDATE
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_person p
    JOIN deal_intel.deal d ON d.id = p.deal_id
    WHERE p.id = company_person_experience.person_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.company_person_experience delete own"
  ON deal_intel.company_person_experience FOR DELETE
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_person p
    JOIN deal_intel.deal d ON d.id = p.deal_id
    WHERE p.id = company_person_experience.person_id AND d.user_id = auth.uid()
  ));

CREATE POLICY "deal_intel.company_person_achievement select own"
  ON deal_intel.company_person_achievement FOR SELECT
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_person p
    JOIN deal_intel.deal d ON d.id = p.deal_id
    WHERE p.id = company_person_achievement.person_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.company_person_achievement insert own"
  ON deal_intel.company_person_achievement FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1
    FROM deal_intel.company_person p
    JOIN deal_intel.deal d ON d.id = p.deal_id
    WHERE p.id = company_person_achievement.person_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.company_person_achievement update own"
  ON deal_intel.company_person_achievement FOR UPDATE
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_person p
    JOIN deal_intel.deal d ON d.id = p.deal_id
    WHERE p.id = company_person_achievement.person_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.company_person_achievement delete own"
  ON deal_intel.company_person_achievement FOR DELETE
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_person p
    JOIN deal_intel.deal d ON d.id = p.deal_id
    WHERE p.id = company_person_achievement.person_id AND d.user_id = auth.uid()
  ));

CREATE POLICY "deal_intel.company_person_research select own"
  ON deal_intel.company_person_research FOR SELECT
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_person p
    JOIN deal_intel.deal d ON d.id = p.deal_id
    WHERE p.id = company_person_research.person_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.company_person_research insert own"
  ON deal_intel.company_person_research FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1
    FROM deal_intel.company_person p
    JOIN deal_intel.deal d ON d.id = p.deal_id
    WHERE p.id = company_person_research.person_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.company_person_research update own"
  ON deal_intel.company_person_research FOR UPDATE
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_person p
    JOIN deal_intel.deal d ON d.id = p.deal_id
    WHERE p.id = company_person_research.person_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.company_person_research delete own"
  ON deal_intel.company_person_research FOR DELETE
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_person p
    JOIN deal_intel.deal d ON d.id = p.deal_id
    WHERE p.id = company_person_research.person_id AND d.user_id = auth.uid()
  ));

CREATE POLICY "deal_intel.company_person_patent select own"
  ON deal_intel.company_person_patent FOR SELECT
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_person p
    JOIN deal_intel.deal d ON d.id = p.deal_id
    WHERE p.id = company_person_patent.person_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.company_person_patent insert own"
  ON deal_intel.company_person_patent FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1
    FROM deal_intel.company_person p
    JOIN deal_intel.deal d ON d.id = p.deal_id
    WHERE p.id = company_person_patent.person_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.company_person_patent update own"
  ON deal_intel.company_person_patent FOR UPDATE
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_person p
    JOIN deal_intel.deal d ON d.id = p.deal_id
    WHERE p.id = company_person_patent.person_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.company_person_patent delete own"
  ON deal_intel.company_person_patent FOR DELETE
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_person p
    JOIN deal_intel.deal d ON d.id = p.deal_id
    WHERE p.id = company_person_patent.person_id AND d.user_id = auth.uid()
  ));

CREATE POLICY "deal_intel.company_person_project select own"
  ON deal_intel.company_person_project FOR SELECT
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_person p
    JOIN deal_intel.deal d ON d.id = p.deal_id
    WHERE p.id = company_person_project.person_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.company_person_project insert own"
  ON deal_intel.company_person_project FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1
    FROM deal_intel.company_person p
    JOIN deal_intel.deal d ON d.id = p.deal_id
    WHERE p.id = company_person_project.person_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.company_person_project update own"
  ON deal_intel.company_person_project FOR UPDATE
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_person p
    JOIN deal_intel.deal d ON d.id = p.deal_id
    WHERE p.id = company_person_project.person_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.company_person_project delete own"
  ON deal_intel.company_person_project FOR DELETE
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_person p
    JOIN deal_intel.deal d ON d.id = p.deal_id
    WHERE p.id = company_person_project.person_id AND d.user_id = auth.uid()
  ));

-- company_makeup / origin_story / problem / solution / traction / negative_aspect: direct deal_id
CREATE POLICY "deal_intel.company_makeup select own"
  ON deal_intel.company_makeup FOR SELECT
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = company_makeup.deal_id AND d.user_id = auth.uid()));
CREATE POLICY "deal_intel.company_makeup upsert own"
  ON deal_intel.company_makeup FOR ALL
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = company_makeup.deal_id AND d.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = company_makeup.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "deal_intel.company_origin_story select own"
  ON deal_intel.company_origin_story FOR SELECT
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = company_origin_story.deal_id AND d.user_id = auth.uid()));
CREATE POLICY "deal_intel.company_origin_story upsert own"
  ON deal_intel.company_origin_story FOR ALL
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = company_origin_story.deal_id AND d.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = company_origin_story.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "deal_intel.company_problem select own"
  ON deal_intel.company_problem FOR SELECT
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = company_problem.deal_id AND d.user_id = auth.uid()));
CREATE POLICY "deal_intel.company_problem upsert own"
  ON deal_intel.company_problem FOR ALL
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = company_problem.deal_id AND d.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = company_problem.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "deal_intel.company_solution select own"
  ON deal_intel.company_solution FOR SELECT
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = company_solution.deal_id AND d.user_id = auth.uid()));
CREATE POLICY "deal_intel.company_solution upsert own"
  ON deal_intel.company_solution FOR ALL
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = company_solution.deal_id AND d.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = company_solution.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "deal_intel.company_traction select own"
  ON deal_intel.company_traction FOR SELECT
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = company_traction.deal_id AND d.user_id = auth.uid()));
CREATE POLICY "deal_intel.company_traction upsert own"
  ON deal_intel.company_traction FOR ALL
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = company_traction.deal_id AND d.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = company_traction.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "deal_intel.negative_aspect select own"
  ON deal_intel.negative_aspect FOR SELECT
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = negative_aspect.deal_id AND d.user_id = auth.uid()));
CREATE POLICY "deal_intel.negative_aspect insert own"
  ON deal_intel.negative_aspect FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = negative_aspect.deal_id AND d.user_id = auth.uid()));
CREATE POLICY "deal_intel.negative_aspect update own"
  ON deal_intel.negative_aspect FOR UPDATE
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = negative_aspect.deal_id AND d.user_id = auth.uid()));
CREATE POLICY "deal_intel.negative_aspect delete own"
  ON deal_intel.negative_aspect FOR DELETE
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = negative_aspect.deal_id AND d.user_id = auth.uid()));

-- Customers / solution children / traction children: authorize via parent join
CREATE POLICY "deal_intel.problem_customer select own"
  ON deal_intel.problem_customer FOR SELECT
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_problem p
    JOIN deal_intel.deal d ON d.id = p.deal_id
    WHERE p.id = problem_customer.problem_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.problem_customer insert own"
  ON deal_intel.problem_customer FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1
    FROM deal_intel.company_problem p
    JOIN deal_intel.deal d ON d.id = p.deal_id
    WHERE p.id = problem_customer.problem_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.problem_customer update own"
  ON deal_intel.problem_customer FOR UPDATE
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_problem p
    JOIN deal_intel.deal d ON d.id = p.deal_id
    WHERE p.id = problem_customer.problem_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.problem_customer delete own"
  ON deal_intel.problem_customer FOR DELETE
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_problem p
    JOIN deal_intel.deal d ON d.id = p.deal_id
    WHERE p.id = problem_customer.problem_id AND d.user_id = auth.uid()
  ));

CREATE POLICY "deal_intel.solution_customer select own"
  ON deal_intel.solution_customer FOR SELECT
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_solution s
    JOIN deal_intel.deal d ON d.id = s.deal_id
    WHERE s.id = solution_customer.solution_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.solution_customer insert own"
  ON deal_intel.solution_customer FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1
    FROM deal_intel.company_solution s
    JOIN deal_intel.deal d ON d.id = s.deal_id
    WHERE s.id = solution_customer.solution_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.solution_customer update own"
  ON deal_intel.solution_customer FOR UPDATE
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_solution s
    JOIN deal_intel.deal d ON d.id = s.deal_id
    WHERE s.id = solution_customer.solution_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.solution_customer delete own"
  ON deal_intel.solution_customer FOR DELETE
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_solution s
    JOIN deal_intel.deal d ON d.id = s.deal_id
    WHERE s.id = solution_customer.solution_id AND d.user_id = auth.uid()
  ));

CREATE POLICY "deal_intel.solution_pricing select own"
  ON deal_intel.solution_pricing FOR SELECT
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_solution s
    JOIN deal_intel.deal d ON d.id = s.deal_id
    WHERE s.id = solution_pricing.solution_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.solution_pricing upsert own"
  ON deal_intel.solution_pricing FOR ALL
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_solution s
    JOIN deal_intel.deal d ON d.id = s.deal_id
    WHERE s.id = solution_pricing.solution_id AND d.user_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1
    FROM deal_intel.company_solution s
    JOIN deal_intel.deal d ON d.id = s.deal_id
    WHERE s.id = solution_pricing.solution_id AND d.user_id = auth.uid()
  ));

CREATE POLICY "deal_intel.solution_distinguishing_factor select own"
  ON deal_intel.solution_distinguishing_factor FOR SELECT
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_solution s
    JOIN deal_intel.deal d ON d.id = s.deal_id
    WHERE s.id = solution_distinguishing_factor.solution_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.solution_distinguishing_factor insert own"
  ON deal_intel.solution_distinguishing_factor FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1
    FROM deal_intel.company_solution s
    JOIN deal_intel.deal d ON d.id = s.deal_id
    WHERE s.id = solution_distinguishing_factor.solution_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.solution_distinguishing_factor update own"
  ON deal_intel.solution_distinguishing_factor FOR UPDATE
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_solution s
    JOIN deal_intel.deal d ON d.id = s.deal_id
    WHERE s.id = solution_distinguishing_factor.solution_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.solution_distinguishing_factor delete own"
  ON deal_intel.solution_distinguishing_factor FOR DELETE
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_solution s
    JOIN deal_intel.deal d ON d.id = s.deal_id
    WHERE s.id = solution_distinguishing_factor.solution_id AND d.user_id = auth.uid()
  ));

CREATE POLICY "deal_intel.solution_defensibility select own"
  ON deal_intel.solution_defensibility FOR SELECT
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_solution s
    JOIN deal_intel.deal d ON d.id = s.deal_id
    WHERE s.id = solution_defensibility.solution_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.solution_defensibility upsert own"
  ON deal_intel.solution_defensibility FOR ALL
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_solution s
    JOIN deal_intel.deal d ON d.id = s.deal_id
    WHERE s.id = solution_defensibility.solution_id AND d.user_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1
    FROM deal_intel.company_solution s
    JOIN deal_intel.deal d ON d.id = s.deal_id
    WHERE s.id = solution_defensibility.solution_id AND d.user_id = auth.uid()
  ));

CREATE POLICY "deal_intel.solution_competitor select own"
  ON deal_intel.solution_competitor FOR SELECT
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_solution s
    JOIN deal_intel.deal d ON d.id = s.deal_id
    WHERE s.id = solution_competitor.solution_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.solution_competitor insert own"
  ON deal_intel.solution_competitor FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1
    FROM deal_intel.company_solution s
    JOIN deal_intel.deal d ON d.id = s.deal_id
    WHERE s.id = solution_competitor.solution_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.solution_competitor update own"
  ON deal_intel.solution_competitor FOR UPDATE
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_solution s
    JOIN deal_intel.deal d ON d.id = s.deal_id
    WHERE s.id = solution_competitor.solution_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.solution_competitor delete own"
  ON deal_intel.solution_competitor FOR DELETE
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_solution s
    JOIN deal_intel.deal d ON d.id = s.deal_id
    WHERE s.id = solution_competitor.solution_id AND d.user_id = auth.uid()
  ));

CREATE POLICY "deal_intel.traction_funding_round select own"
  ON deal_intel.traction_funding_round FOR SELECT
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_traction t
    JOIN deal_intel.deal d ON d.id = t.deal_id
    WHERE t.id = traction_funding_round.traction_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.traction_funding_round insert own"
  ON deal_intel.traction_funding_round FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1
    FROM deal_intel.company_traction t
    JOIN deal_intel.deal d ON d.id = t.deal_id
    WHERE t.id = traction_funding_round.traction_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.traction_funding_round update own"
  ON deal_intel.traction_funding_round FOR UPDATE
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_traction t
    JOIN deal_intel.deal d ON d.id = t.deal_id
    WHERE t.id = traction_funding_round.traction_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.traction_funding_round delete own"
  ON deal_intel.traction_funding_round FOR DELETE
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_traction t
    JOIN deal_intel.deal d ON d.id = t.deal_id
    WHERE t.id = traction_funding_round.traction_id AND d.user_id = auth.uid()
  ));

CREATE POLICY "deal_intel.traction_investor select own"
  ON deal_intel.traction_investor FOR SELECT
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_traction t
    JOIN deal_intel.deal d ON d.id = t.deal_id
    WHERE t.id = traction_investor.traction_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.traction_investor insert own"
  ON deal_intel.traction_investor FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1
    FROM deal_intel.company_traction t
    JOIN deal_intel.deal d ON d.id = t.deal_id
    WHERE t.id = traction_investor.traction_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.traction_investor update own"
  ON deal_intel.traction_investor FOR UPDATE
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_traction t
    JOIN deal_intel.deal d ON d.id = t.deal_id
    WHERE t.id = traction_investor.traction_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.traction_investor delete own"
  ON deal_intel.traction_investor FOR DELETE
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_traction t
    JOIN deal_intel.deal d ON d.id = t.deal_id
    WHERE t.id = traction_investor.traction_id AND d.user_id = auth.uid()
  ));

CREATE POLICY "deal_intel.traction_partner_or_customer select own"
  ON deal_intel.traction_partner_or_customer FOR SELECT
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_traction t
    JOIN deal_intel.deal d ON d.id = t.deal_id
    WHERE t.id = traction_partner_or_customer.traction_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.traction_partner_or_customer insert own"
  ON deal_intel.traction_partner_or_customer FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1
    FROM deal_intel.company_traction t
    JOIN deal_intel.deal d ON d.id = t.deal_id
    WHERE t.id = traction_partner_or_customer.traction_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.traction_partner_or_customer update own"
  ON deal_intel.traction_partner_or_customer FOR UPDATE
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_traction t
    JOIN deal_intel.deal d ON d.id = t.deal_id
    WHERE t.id = traction_partner_or_customer.traction_id AND d.user_id = auth.uid()
  ));
CREATE POLICY "deal_intel.traction_partner_or_customer delete own"
  ON deal_intel.traction_partner_or_customer FOR DELETE
  USING (EXISTS (
    SELECT 1
    FROM deal_intel.company_traction t
    JOIN deal_intel.deal d ON d.id = t.deal_id
    WHERE t.id = traction_partner_or_customer.traction_id AND d.user_id = auth.uid()
  ));

