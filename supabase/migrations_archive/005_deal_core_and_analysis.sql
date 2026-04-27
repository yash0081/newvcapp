-- Deal core and decomposed analysis schema (Schemas 1–4)

CREATE TABLE IF NOT EXISTS deals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_name text,
  website text,
  sector text,
  subsector text,
  stage text,
  business_model text,
  geography text,
  check_size_requested int,
  source text,
  decision text,
  pass_reason text,
  pass_reason_detail text,
  sourced_by uuid,
  deck_url text,
  deal_embedding vector,
  decision_date timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deal_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  pipeline_version int NOT NULL DEFAULT 2,
  raw_output jsonb,
  run_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deal_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  analysis_id uuid NOT NULL REFERENCES deal_analyses(id) ON DELETE CASCADE,
  dimension text NOT NULL,
  raw_score float,
  weighted_score float,
  rubric_weight float,
  scoring_stage text
);

CREATE TABLE IF NOT EXISTS deal_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  metric_name text,
  metric_value text,
  confidence text,
  source_type text,
  is_verified boolean
);

CREATE TABLE IF NOT EXISTS deal_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  analysis_id uuid REFERENCES deal_analyses(id) ON DELETE CASCADE,
  flag_type text,
  flag_message text,
  auto_reject boolean,
  triggered_by text
);

-- Per-prompt JSON storage for model calls in the analysis pipeline
CREATE TABLE IF NOT EXISTS deal_prompt_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  analysis_id uuid NOT NULL REFERENCES deal_analyses(id) ON DELETE CASCADE,
  step_name text NOT NULL,
  model_name text,
  model_tier text,
  input_context jsonb,
  output_json jsonb,
  error_message text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS investment_memos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  analysis_id uuid REFERENCES deal_analyses(id) ON DELETE SET NULL,
  content text,
  memo_embedding vector,
  authored_by text,
  partner_notes text,
  created_at timestamptz DEFAULT now()
);

-- Schema 2 — pitch deck analysis

CREATE TABLE IF NOT EXISTS deal_problem (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  analysis_id uuid NOT NULL REFERENCES deal_analyses(id) ON DELETE CASCADE,
  problem_statement text,
  root_cause_depth text,
  economic_gravity text,
  structural_urgency text,
  persona_clarity text,
  economic_buyer_persona text,
  budget_priority_validation text,
  pain_severity_score int,
  buyer_authority_score int,
  structural_tailwinds_score int,
  venture_scale_plausibility int
);

CREATE TABLE IF NOT EXISTS deal_solution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  analysis_id uuid NOT NULL REFERENCES deal_analyses(id) ON DELETE CASCADE,
  solution_summary text,
  product_type text,
  moat_type text,
  replication_difficulty text,
  compounding_potential text,
  technical_moat_evidence text,
  ten_x_improvement_score int,
  defensibility_potential int,
  competitive_edge_score int
);

CREATE TABLE IF NOT EXISTS deal_competitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  competitor_name text,
  category text,
  threat_level text,
  threat_assessment text
);

CREATE TABLE IF NOT EXISTS deal_differentiation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  proof_point text,
  proof_type text
);

CREATE TABLE IF NOT EXISTS deal_traction (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  analysis_id uuid NOT NULL REFERENCES deal_analyses(id) ON DELETE CASCADE,
  inferred_stage text,
  benchmark_context text,
  traction_strength_score int,
  growth_acceleration_score int,
  stage_adjusted_signal_score int,
  signal_completeness text
);

CREATE TABLE IF NOT EXISTS deal_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  entity_type text,
  entity_name text,
  role text,
  source text
);

CREATE TABLE IF NOT EXISTS deal_assumptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  analysis_id uuid NOT NULL REFERENCES deal_analyses(id) ON DELETE CASCADE,
  assumption_text text,
  assumption_type text,
  inversion text,
  must_be_true text,
  is_linchpin boolean,
  fragility_score int,
  why_fragile text,
  failure_mode text
);

CREATE TABLE IF NOT EXISTS deal_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  analysis_id uuid NOT NULL REFERENCES deal_analyses(id) ON DELETE CASCADE,
  agent_source text,
  claim_type text,
  subject text,
  predicate text,
  object text,
  confidence float,
  source_type text,
  flagged boolean
);

CREATE TABLE IF NOT EXISTS contradictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  analysis_id uuid NOT NULL REFERENCES deal_analyses(id) ON DELETE CASCADE,
  claim_a_id uuid REFERENCES deal_claims(id) ON DELETE CASCADE,
  claim_b_id uuid REFERENCES deal_claims(id) ON DELETE CASCADE,
  conflict_description text,
  severity text
);

-- Schema 3 — questions, meetings, outcomes, thesis, rubrics

CREATE TABLE IF NOT EXISTS question_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_type text,
  trigger_condition text,
  template_text text,
  applicable_stages text[],
  applicable_sectors text[],
  signal_yield float,
  use_count int,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deal_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  analysis_id uuid NOT NULL REFERENCES deal_analyses(id) ON DELETE CASCADE,
  template_id uuid REFERENCES question_templates(id) ON DELETE SET NULL,
  contradiction_id uuid REFERENCES contradictions(id) ON DELETE SET NULL,
  assumption_id uuid REFERENCES deal_assumptions(id) ON DELETE SET NULL,
  question_text text,
  source_signal text,
  question_type text,
  asked_in_meeting boolean DEFAULT false,
  meeting_id uuid,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  meeting_date date,
  fund_attendees text[],
  founder_attendees text[],
  notes text,
  transcript text,
  meeting_type text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS question_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id uuid NOT NULL REFERENCES deal_questions(id) ON DELETE CASCADE,
  meeting_id uuid REFERENCES meetings(id) ON DELETE CASCADE,
  was_asked boolean,
  answer_summary text,
  conviction_delta text,
  led_to_pass boolean,
  led_to_invest boolean,
  analyst_rating int,
  follow_up_needed text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fund_thesis_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  fund_name text,
  version int,
  stage_focus text[],
  sector_focus text[],
  check_size_min int,
  check_size_max int,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS thesis_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thesis_id uuid NOT NULL REFERENCES fund_thesis_v2(id) ON DELETE CASCADE,
  rule_type text,
  dimension text,
  condition text,
  machine_condition jsonb,
  weight float,
  auto_reject boolean,
  flag_message text
);

CREATE TABLE IF NOT EXISTS scoring_rubrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thesis_id uuid NOT NULL REFERENCES fund_thesis_v2(id) ON DELETE CASCADE,
  stage text,
  dimension text,
  weight float,
  description text
);

-- Schema 4 — knowledge graph

CREATE TABLE IF NOT EXISTS founders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  name text,
  linkedin_url text,
  email text,
  role text,
  enrichment_source text,
  enrichment_raw jsonb,
  universities text[],
  yc_batch text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS founder_employment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  founder_id uuid NOT NULL REFERENCES founders(id) ON DELETE CASCADE,
  company_name text,
  title text,
  start_date date,
  end_date date,
  is_current boolean
);

CREATE TABLE IF NOT EXISTS fund_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text,
  role text,
  firm text,
  linkedin_url text,
  email text
);

CREATE TABLE IF NOT EXISTS contact_employment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES fund_contacts(id) ON DELETE CASCADE,
  company_name text,
  title text,
  start_date date,
  end_date date
);

CREATE TABLE IF NOT EXISTS contact_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  founder_id uuid REFERENCES founders(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES fund_contacts(id) ON DELETE CASCADE,
  connection_type text,
  shared_entity text,
  overlap_start date,
  overlap_end date,
  confidence text,
  warm_path_note text,
  deal_id uuid REFERENCES deals(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS investors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text,
  investor_type text,
  typical_stage text,
  typical_sectors text[],
  crunchbase_id text
);

CREATE TABLE IF NOT EXISTS deal_investors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  investor_id uuid NOT NULL REFERENCES investors(id) ON DELETE CASCADE,
  role text,
  round_name text,
  amount bigint
);

CREATE TABLE IF NOT EXISTS investor_patterns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investor_id uuid NOT NULL REFERENCES investors(id) ON DELETE CASCADE,
  pattern_type text,
  evidence_deal_ids uuid[],
  confidence_score float,
  updated_at timestamptz DEFAULT now()
);

-- Enable RLS on core and analysis tables

ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_prompt_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE investment_memos ENABLE ROW LEVEL SECURITY;

ALTER TABLE deal_problem ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_solution ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_competitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_differentiation ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_traction ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_assumptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE contradictions ENABLE ROW LEVEL SECURITY;

ALTER TABLE question_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE question_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE fund_thesis_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE thesis_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE scoring_rubrics ENABLE ROW LEVEL SECURITY;

ALTER TABLE founders ENABLE ROW LEVEL SECURITY;
ALTER TABLE founder_employment ENABLE ROW LEVEL SECURITY;
ALTER TABLE fund_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_employment ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE investors ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_investors ENABLE ROW LEVEL SECURITY;
ALTER TABLE investor_patterns ENABLE ROW LEVEL SECURITY;

-- RLS policies: scope everything by deals.user_id

CREATE POLICY "Users can select own deals"
  ON deals FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Users can insert own deals"
  ON deals FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update own deals"
  ON deals FOR UPDATE
  USING (user_id = auth.uid());

CREATE POLICY "Users can delete own deals"
  ON deals FOR DELETE
  USING (user_id = auth.uid());

-- Helper macro-style policy for child tables: join back to deals via deal_id

CREATE POLICY "Users can select own deal_analyses"
  ON deal_analyses FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_analyses.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own deal_analyses"
  ON deal_analyses FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_analyses.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can select own deal_scores"
  ON deal_scores FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_scores.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own deal_scores"
  ON deal_scores FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_scores.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can select own deal_metrics"
  ON deal_metrics FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_metrics.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own deal_metrics"
  ON deal_metrics FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_metrics.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can select own deal_flags"
  ON deal_flags FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_flags.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own deal_flags"
  ON deal_flags FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_flags.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can select own deal_prompt_runs"
  ON deal_prompt_runs FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_prompt_runs.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own deal_prompt_runs"
  ON deal_prompt_runs FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_prompt_runs.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can select own investment_memos"
  ON investment_memos FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = investment_memos.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own investment_memos"
  ON investment_memos FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = investment_memos.deal_id AND d.user_id = auth.uid()));

-- Pitch deck analysis children

CREATE POLICY "Users can select own deal_problem"
  ON deal_problem FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_problem.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own deal_problem"
  ON deal_problem FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_problem.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can select own deal_solution"
  ON deal_solution FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_solution.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own deal_solution"
  ON deal_solution FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_solution.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can select own deal_competitors"
  ON deal_competitors FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_competitors.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own deal_competitors"
  ON deal_competitors FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_competitors.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can select own deal_differentiation"
  ON deal_differentiation FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_differentiation.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own deal_differentiation"
  ON deal_differentiation FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_differentiation.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can select own deal_traction"
  ON deal_traction FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_traction.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own deal_traction"
  ON deal_traction FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_traction.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can select own deal_entities"
  ON deal_entities FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_entities.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own deal_entities"
  ON deal_entities FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_entities.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can select own deal_assumptions"
  ON deal_assumptions FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_assumptions.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own deal_assumptions"
  ON deal_assumptions FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_assumptions.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can select own deal_claims"
  ON deal_claims FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_claims.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own deal_claims"
  ON deal_claims FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_claims.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can select own contradictions"
  ON contradictions FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = contradictions.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own contradictions"
  ON contradictions FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = contradictions.deal_id AND d.user_id = auth.uid()));

-- Questions & meetings

CREATE POLICY "Users can select own question_templates"
  ON question_templates FOR SELECT
  USING (true);

CREATE POLICY "Users can insert question_templates"
  ON question_templates FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Users can select own deal_questions"
  ON deal_questions FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_questions.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own deal_questions"
  ON deal_questions FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_questions.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can select own meetings"
  ON meetings FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = meetings.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own meetings"
  ON meetings FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = meetings.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can select own question_outcomes"
  ON question_outcomes FOR SELECT
  USING (EXISTS (SELECT 1 FROM deal_questions q JOIN deals d ON d.id = q.deal_id WHERE q.id = question_outcomes.question_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own question_outcomes"
  ON question_outcomes FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deal_questions q JOIN deals d ON d.id = q.deal_id WHERE q.id = question_outcomes.question_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can select own fund_thesis_v2"
  ON fund_thesis_v2 FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Users can insert own fund_thesis_v2"
  ON fund_thesis_v2 FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can select own thesis_rules"
  ON thesis_rules FOR SELECT
  USING (EXISTS (SELECT 1 FROM fund_thesis_v2 t WHERE t.id = thesis_rules.thesis_id AND t.user_id = auth.uid()));

CREATE POLICY "Users can insert own thesis_rules"
  ON thesis_rules FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM fund_thesis_v2 t WHERE t.id = thesis_rules.thesis_id AND t.user_id = auth.uid()));

CREATE POLICY "Users can select own scoring_rubrics"
  ON scoring_rubrics FOR SELECT
  USING (EXISTS (SELECT 1 FROM fund_thesis_v2 t WHERE t.id = scoring_rubrics.thesis_id AND t.user_id = auth.uid()));

CREATE POLICY "Users can insert own scoring_rubrics"
  ON scoring_rubrics FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM fund_thesis_v2 t WHERE t.id = scoring_rubrics.thesis_id AND t.user_id = auth.uid()));

-- Knowledge graph

CREATE POLICY "Users can select own founders"
  ON founders FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = founders.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own founders"
  ON founders FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = founders.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can select own founder_employment"
  ON founder_employment FOR SELECT
  USING (EXISTS (SELECT 1 FROM founders f JOIN deals d ON d.id = f.deal_id WHERE f.id = founder_employment.founder_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own founder_employment"
  ON founder_employment FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM founders f JOIN deals d ON d.id = f.deal_id WHERE f.id = founder_employment.founder_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can select own fund_contacts"
  ON fund_contacts FOR SELECT
  USING (true);

CREATE POLICY "Users can insert fund_contacts"
  ON fund_contacts FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Users can select own contact_employment"
  ON contact_employment FOR SELECT
  USING (EXISTS (SELECT 1 FROM fund_contacts c WHERE c.id = contact_employment.contact_id));

CREATE POLICY "Users can insert own contact_employment"
  ON contact_employment FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM fund_contacts c WHERE c.id = contact_employment.contact_id));

CREATE POLICY "Users can select own contact_edges"
  ON contact_edges FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = contact_edges.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own contact_edges"
  ON contact_edges FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = contact_edges.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can select investors"
  ON investors FOR SELECT
  USING (true);

CREATE POLICY "Users can insert investors"
  ON investors FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Users can select own deal_investors"
  ON deal_investors FOR SELECT
  USING (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_investors.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own deal_investors"
  ON deal_investors FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM deals d WHERE d.id = deal_investors.deal_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can select own investor_patterns"
  ON investor_patterns FOR SELECT
  USING (EXISTS (SELECT 1 FROM investors i JOIN deal_investors di ON di.investor_id = i.id JOIN deals d ON d.id = di.deal_id WHERE i.id = investor_patterns.investor_id AND d.user_id = auth.uid()));

CREATE POLICY "Users can insert own investor_patterns"
  ON investor_patterns FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM investors i JOIN deal_investors di ON di.investor_id = i.id JOIN deals d ON d.id = di.deal_id WHERE i.id = investor_patterns.investor_id AND d.user_id = auth.uid()));

