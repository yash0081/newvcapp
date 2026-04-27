-- deal_intel: simplify relational schema (collapse overly-normalized child tables)
-- Reason: We want ONE table per bucket (problem/solution/traction/team/etc) with columns/arrays
-- rather than separate tables per subpart (education/achievements/etc).
--
-- Assumption: data can be dropped (user confirmed they wiped deal_intel data).

CREATE SCHEMA IF NOT EXISTS deal_intel;

-- 1) Collapse company_person child tables into columns on company_person
ALTER TABLE deal_intel.company_person
  ADD COLUMN IF NOT EXISTS education_general_description text,
  ADD COLUMN IF NOT EXISTS education_institutions text[],
  ADD COLUMN IF NOT EXISTS education_majors text[],
  ADD COLUMN IF NOT EXISTS education_gpa text,
  ADD COLUMN IF NOT EXISTS experience_general_description text,
  ADD COLUMN IF NOT EXISTS past_companies_worked_at text[],
  ADD COLUMN IF NOT EXISTS past_companies_founded_or_previous_exits text[],
  ADD COLUMN IF NOT EXISTS relevant_achievements text[],
  ADD COLUMN IF NOT EXISTS research text[],
  ADD COLUMN IF NOT EXISTS patents text[],
  ADD COLUMN IF NOT EXISTS projects text[];

DROP TABLE IF EXISTS deal_intel.company_person_project CASCADE;
DROP TABLE IF EXISTS deal_intel.company_person_patent CASCADE;
DROP TABLE IF EXISTS deal_intel.company_person_research CASCADE;
DROP TABLE IF EXISTS deal_intel.company_person_achievement CASCADE;
DROP TABLE IF EXISTS deal_intel.company_person_experience CASCADE;
DROP TABLE IF EXISTS deal_intel.company_person_education CASCADE;

-- 2) Collapse problem customers into columns on company_problem
ALTER TABLE deal_intel.company_problem
  ADD COLUMN IF NOT EXISTS all_potential_customers text[],
  ADD COLUMN IF NOT EXISTS actual_intended_customers_for_solution text[];

DROP TABLE IF EXISTS deal_intel.problem_customer CASCADE;

-- 3) Collapse solution children into columns on company_solution
ALTER TABLE deal_intel.company_solution
  ADD COLUMN IF NOT EXISTS who_are_the_customers text[],
  ADD COLUMN IF NOT EXISTS cost_to_customer_to_buy_product text,
  ADD COLUMN IF NOT EXISTS customer_benefit text[],
  ADD COLUMN IF NOT EXISTS solution_price_for_company text,
  ADD COLUMN IF NOT EXISTS price_per_customer_build_and_serve text,
  ADD COLUMN IF NOT EXISTS distinguishing_factors text[],
  ADD COLUMN IF NOT EXISTS defensibility text,
  ADD COLUMN IF NOT EXISTS patent_ip text[],
  ADD COLUMN IF NOT EXISTS proprietary_tech_or_solution text[],
  ADD COLUMN IF NOT EXISTS competitors jsonb;

DROP TABLE IF EXISTS deal_intel.solution_competitor CASCADE;
DROP TABLE IF EXISTS deal_intel.solution_defensibility CASCADE;
DROP TABLE IF EXISTS deal_intel.solution_distinguishing_factor CASCADE;
DROP TABLE IF EXISTS deal_intel.solution_pricing CASCADE;
DROP TABLE IF EXISTS deal_intel.solution_customer CASCADE;

-- 4) Collapse traction children into columns on company_traction
ALTER TABLE deal_intel.company_traction
  ADD COLUMN IF NOT EXISTS money_raised_per_stage text[],
  ADD COLUMN IF NOT EXISTS investor_list text[],
  ADD COLUMN IF NOT EXISTS notable_partners_or_customors text[];

-- Typo safety: keep correct column too (preferred spelling)
ALTER TABLE deal_intel.company_traction
  ADD COLUMN IF NOT EXISTS notable_partners_or_customers text[];

DROP TABLE IF EXISTS deal_intel.traction_partner_or_customer CASCADE;
DROP TABLE IF EXISTS deal_intel.traction_investor CASCADE;
DROP TABLE IF EXISTS deal_intel.traction_funding_round CASCADE;

-- 5) Replace negative_aspect (many rows) with company_negative (single row per deal/revision)
DROP TABLE IF EXISTS deal_intel.negative_aspect CASCADE;

CREATE TABLE IF NOT EXISTS deal_intel.company_negative (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deal_intel.deal(id) ON DELETE CASCADE,
  revision_id uuid REFERENCES deal_intel.deal_revision(id) ON DELETE SET NULL,
  negative_aspects text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deal_id, revision_id)
);

DROP TRIGGER IF EXISTS deal_intel_company_negative_updated_at ON deal_intel.company_negative;
CREATE TRIGGER deal_intel_company_negative_updated_at
BEFORE UPDATE ON deal_intel.company_negative
FOR EACH ROW
EXECUTE FUNCTION deal_intel.set_updated_at();

CREATE INDEX IF NOT EXISTS deal_intel_company_negative_deal_idx ON deal_intel.company_negative(deal_id);

ALTER TABLE deal_intel.company_negative ENABLE ROW LEVEL SECURITY;

CREATE POLICY "deal_intel.company_negative select own"
  ON deal_intel.company_negative FOR SELECT
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = company_negative.deal_id AND d.user_id = auth.uid()));
CREATE POLICY "deal_intel.company_negative upsert own"
  ON deal_intel.company_negative FOR ALL
  USING (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = company_negative.deal_id AND d.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM deal_intel.deal d WHERE d.id = company_negative.deal_id AND d.user_id = auth.uid()));

