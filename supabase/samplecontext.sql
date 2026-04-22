-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.analysis_status (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  analysis_id uuid NOT NULL,
  current_step text,
  status text NOT NULL,
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT analysis_status_pkey PRIMARY KEY (id),
  CONSTRAINT analysis_status_analysis_id_fkey FOREIGN KEY (analysis_id) REFERENCES public.deal_analyses(id)
);
CREATE TABLE public.chat_messages (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL,
  role text NOT NULL CHECK (role = ANY (ARRAY['user'::text, 'assistant'::text, 'system'::text, 'tool'::text])),
  content text NOT NULL,
  metadata jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT chat_messages_pkey PRIMARY KEY (id),
  CONSTRAINT chat_messages_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.chat_threads(id)
);
CREATE TABLE public.chat_threads (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  deal_id uuid,
  title text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT chat_threads_pkey PRIMARY KEY (id),
  CONSTRAINT chat_threads_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id),
  CONSTRAINT chat_threads_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id)
);
CREATE TABLE public.contact_edges (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  founder_id uuid,
  contact_id uuid,
  connection_type text,
  shared_entity text,
  overlap_start date,
  overlap_end date,
  confidence text,
  warm_path_note text,
  deal_id uuid,
  CONSTRAINT contact_edges_pkey PRIMARY KEY (id),
  CONSTRAINT contact_edges_founder_id_fkey FOREIGN KEY (founder_id) REFERENCES public.founders(id),
  CONSTRAINT contact_edges_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.fund_contacts(id),
  CONSTRAINT contact_edges_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id)
);
CREATE TABLE public.contact_employment (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL,
  company_name text,
  title text,
  start_date date,
  end_date date,
  CONSTRAINT contact_employment_pkey PRIMARY KEY (id),
  CONSTRAINT contact_employment_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.fund_contacts(id)
);
CREATE TABLE public.contradictions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  analysis_id uuid NOT NULL,
  claim_a_id uuid,
  claim_b_id uuid,
  conflict_description text,
  severity text,
  CONSTRAINT contradictions_pkey PRIMARY KEY (id),
  CONSTRAINT contradictions_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id),
  CONSTRAINT contradictions_analysis_id_fkey FOREIGN KEY (analysis_id) REFERENCES public.deal_analyses(id),
  CONSTRAINT contradictions_claim_a_id_fkey FOREIGN KEY (claim_a_id) REFERENCES public.deal_claims(id),
  CONSTRAINT contradictions_claim_b_id_fkey FOREIGN KEY (claim_b_id) REFERENCES public.deal_claims(id)
);
CREATE TABLE public.deal_analyses (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  pipeline_version integer NOT NULL DEFAULT 2,
  raw_output jsonb,
  run_at timestamp with time zone DEFAULT now(),
  similar_peers_json jsonb,
  user_corpus_thesis_context_json jsonb,
  user_corpus_risk_context_json jsonb,
  CONSTRAINT deal_analyses_pkey PRIMARY KEY (id),
  CONSTRAINT deal_analyses_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id)
);
CREATE TABLE public.deal_assumptions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  analysis_id uuid NOT NULL,
  assumption_text text,
  assumption_type text,
  inversion text,
  must_be_true text,
  is_linchpin boolean,
  fragility_score integer,
  why_fragile text,
  failure_mode text,
  CONSTRAINT deal_assumptions_pkey PRIMARY KEY (id),
  CONSTRAINT deal_assumptions_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id),
  CONSTRAINT deal_assumptions_analysis_id_fkey FOREIGN KEY (analysis_id) REFERENCES public.deal_analyses(id)
);
CREATE TABLE public.deal_claims (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  analysis_id uuid NOT NULL,
  agent_source text,
  claim_type text,
  subject text,
  predicate text,
  object text,
  confidence double precision,
  source_type text,
  flagged boolean,
  CONSTRAINT deal_claims_pkey PRIMARY KEY (id),
  CONSTRAINT deal_claims_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id),
  CONSTRAINT deal_claims_analysis_id_fkey FOREIGN KEY (analysis_id) REFERENCES public.deal_analyses(id)
);
CREATE TABLE public.deal_competitors (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  competitor_name text,
  category text,
  threat_level text,
  threat_assessment text,
  analysis_id uuid,
  CONSTRAINT deal_competitors_pkey PRIMARY KEY (id),
  CONSTRAINT deal_competitors_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id),
  CONSTRAINT deal_competitors_analysis_id_fkey FOREIGN KEY (analysis_id) REFERENCES public.deal_analyses(id)
);
CREATE TABLE public.deal_context_nodes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  analysis_id uuid NOT NULL,
  parent_id uuid,
  node_type text NOT NULL,
  depth integer NOT NULL DEFAULT 0,
  raw_text text,
  structured_text text,
  keywords ARRAY NOT NULL DEFAULT '{}'::text[],
  embedding USER-DEFINED,
  node_weight double precision NOT NULL DEFAULT 1.0,
  subnode_weights_json jsonb,
  polarity text NOT NULL DEFAULT 'neutral'::text CHECK (polarity = ANY (ARRAY['positive'::text, 'negative'::text, 'neutral'::text])),
  version integer NOT NULL DEFAULT 1,
  search_document tsvector DEFAULT to_tsvector('english'::regconfig, ((COALESCE(raw_text, ''::text) || ' '::text) || COALESCE(structured_text, ''::text))),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT deal_context_nodes_pkey PRIMARY KEY (id),
  CONSTRAINT deal_context_nodes_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id),
  CONSTRAINT deal_context_nodes_analysis_id_fkey FOREIGN KEY (analysis_id) REFERENCES public.deal_analyses(id),
  CONSTRAINT deal_context_nodes_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.deal_context_nodes(id)
);
CREATE TABLE public.deal_differentiation (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  proof_point text,
  proof_type text,
  analysis_id uuid,
  CONSTRAINT deal_differentiation_pkey PRIMARY KEY (id),
  CONSTRAINT deal_differentiation_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id),
  CONSTRAINT deal_differentiation_analysis_id_fkey FOREIGN KEY (analysis_id) REFERENCES public.deal_analyses(id)
);
CREATE TABLE public.deal_entities (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  entity_type text,
  entity_name text,
  role text,
  source text,
  CONSTRAINT deal_entities_pkey PRIMARY KEY (id),
  CONSTRAINT deal_entities_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id)
);
CREATE TABLE public.deal_feature_definitions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  key text NOT NULL,
  label text NOT NULL,
  data_type text NOT NULL CHECK (data_type = ANY (ARRAY['number'::text, 'text'::text, 'bool'::text, 'json'::text])),
  origin text NOT NULL DEFAULT 'explicit_user'::text CHECK (origin = ANY (ARRAY['explicit_user'::text, 'pipeline'::text, 'inferred_llm'::text])),
  compute_tier text NOT NULL DEFAULT 'cheap'::text CHECK (compute_tier = ANY (ARRAY['cheap'::text, 'expensive'::text])),
  formula_or_prompt_ref text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT deal_feature_definitions_pkey PRIMARY KEY (id),
  CONSTRAINT deal_feature_definitions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id)
);
CREATE TABLE public.deal_feature_provenance (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  feature_id uuid NOT NULL,
  deal_id uuid NOT NULL,
  node_id uuid,
  prompt_run_id uuid,
  note text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT deal_feature_provenance_pkey PRIMARY KEY (id),
  CONSTRAINT deal_feature_provenance_feature_id_fkey FOREIGN KEY (feature_id) REFERENCES public.deal_feature_definitions(id),
  CONSTRAINT deal_feature_provenance_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id),
  CONSTRAINT deal_feature_provenance_node_id_fkey FOREIGN KEY (node_id) REFERENCES public.deal_context_nodes(id),
  CONSTRAINT deal_feature_provenance_prompt_run_id_fkey FOREIGN KEY (prompt_run_id) REFERENCES public.deal_prompt_runs(id)
);
CREATE TABLE public.deal_feature_values (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  feature_id uuid NOT NULL,
  value_jsonb jsonb,
  status text NOT NULL DEFAULT 'done'::text CHECK (status = ANY (ARRAY['pending'::text, 'done'::text, 'error'::text])),
  cache_key text,
  error_message text,
  computed_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT deal_feature_values_pkey PRIMARY KEY (id),
  CONSTRAINT deal_feature_values_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id),
  CONSTRAINT deal_feature_values_feature_id_fkey FOREIGN KEY (feature_id) REFERENCES public.deal_feature_definitions(id)
);
CREATE TABLE public.deal_flags (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  analysis_id uuid,
  flag_type text,
  flag_message text,
  auto_reject boolean,
  triggered_by text,
  CONSTRAINT deal_flags_pkey PRIMARY KEY (id),
  CONSTRAINT deal_flags_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id),
  CONSTRAINT deal_flags_analysis_id_fkey FOREIGN KEY (analysis_id) REFERENCES public.deal_analyses(id)
);
CREATE TABLE public.deal_investors (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  investor_id uuid NOT NULL,
  role text,
  round_name text,
  amount bigint,
  CONSTRAINT deal_investors_pkey PRIMARY KEY (id),
  CONSTRAINT deal_investors_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id),
  CONSTRAINT deal_investors_investor_id_fkey FOREIGN KEY (investor_id) REFERENCES public.investors(id)
);
CREATE TABLE public.deal_keywords (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  analysis_id uuid NOT NULL,
  section_name text NOT NULL CHECK (section_name = ANY (ARRAY['problem'::text, 'solution'::text, 'market'::text, 'risk'::text])),
  concepts ARRAY NOT NULL DEFAULT '{}'::text[],
  concepts_text text,
  concepts_tsv tsvector,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT deal_keywords_pkey PRIMARY KEY (id),
  CONSTRAINT deal_keywords_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id),
  CONSTRAINT deal_keywords_analysis_id_fkey FOREIGN KEY (analysis_id) REFERENCES public.deal_analyses(id)
);
CREATE TABLE public.deal_metrics (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  metric_name text,
  metric_value text,
  confidence text,
  source_type text,
  is_verified boolean,
  CONSTRAINT deal_metrics_pkey PRIMARY KEY (id),
  CONSTRAINT deal_metrics_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id)
);
CREATE TABLE public.deal_pipeline_json_core_assumptions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  analysis_id uuid NOT NULL UNIQUE,
  core_assumption_json jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  past_deal_comparisons_json jsonb,
  assumption_comparisons_json jsonb,
  CONSTRAINT deal_pipeline_json_core_assumptions_pkey PRIMARY KEY (id),
  CONSTRAINT deal_pipeline_json_core_assumptions_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id),
  CONSTRAINT deal_pipeline_json_core_assumptions_analysis_id_fkey FOREIGN KEY (analysis_id) REFERENCES public.deal_analyses(id)
);
CREATE TABLE public.deal_pipeline_json_founder_signals (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  analysis_id uuid NOT NULL UNIQUE,
  founder_signal_json jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT deal_pipeline_json_founder_signals_pkey PRIMARY KEY (id),
  CONSTRAINT deal_pipeline_json_founder_signals_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id),
  CONSTRAINT deal_pipeline_json_founder_signals_analysis_id_fkey FOREIGN KEY (analysis_id) REFERENCES public.deal_analyses(id)
);
CREATE TABLE public.deal_pipeline_json_market_power (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  analysis_id uuid NOT NULL UNIQUE,
  market_power_json jsonb,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT deal_pipeline_json_market_power_pkey PRIMARY KEY (id),
  CONSTRAINT deal_pipeline_json_market_power_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id),
  CONSTRAINT deal_pipeline_json_market_power_analysis_id_fkey FOREIGN KEY (analysis_id) REFERENCES public.deal_analyses(id)
);
CREATE TABLE public.deal_pipeline_json_parsing (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  analysis_id uuid NOT NULL UNIQUE,
  parsing_json jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT deal_pipeline_json_parsing_pkey PRIMARY KEY (id),
  CONSTRAINT deal_pipeline_json_parsing_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id),
  CONSTRAINT deal_pipeline_json_parsing_analysis_id_fkey FOREIGN KEY (analysis_id) REFERENCES public.deal_analyses(id)
);
CREATE TABLE public.deal_pipeline_json_problem_3c (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  analysis_id uuid NOT NULL UNIQUE,
  problem_quality_3c_json jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  past_deal_comparisons_json jsonb,
  CONSTRAINT deal_pipeline_json_problem_3c_pkey PRIMARY KEY (id),
  CONSTRAINT deal_pipeline_json_problem_3c_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id),
  CONSTRAINT deal_pipeline_json_problem_3c_analysis_id_fkey FOREIGN KEY (analysis_id) REFERENCES public.deal_analyses(id)
);
CREATE TABLE public.deal_pipeline_json_questions_combined (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  analysis_id uuid NOT NULL UNIQUE,
  questions_combined_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT deal_pipeline_json_questions_combined_pkey PRIMARY KEY (id),
  CONSTRAINT deal_pipeline_json_questions_combined_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id),
  CONSTRAINT deal_pipeline_json_questions_combined_analysis_id_fkey FOREIGN KEY (analysis_id) REFERENCES public.deal_analyses(id)
);
CREATE TABLE public.deal_pipeline_json_solution_3d (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  analysis_id uuid NOT NULL UNIQUE,
  solution_defensibility_json jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  past_deal_comparisons_json jsonb,
  CONSTRAINT deal_pipeline_json_solution_3d_pkey PRIMARY KEY (id),
  CONSTRAINT deal_pipeline_json_solution_3d_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id),
  CONSTRAINT deal_pipeline_json_solution_3d_analysis_id_fkey FOREIGN KEY (analysis_id) REFERENCES public.deal_analyses(id)
);
CREATE TABLE public.deal_pipeline_json_summaries (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  analysis_id uuid NOT NULL UNIQUE,
  pipeline_summaries_json jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT deal_pipeline_json_summaries_pkey PRIMARY KEY (id),
  CONSTRAINT deal_pipeline_json_summaries_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id),
  CONSTRAINT deal_pipeline_json_summaries_analysis_id_fkey FOREIGN KEY (analysis_id) REFERENCES public.deal_analyses(id)
);
CREATE TABLE public.deal_pipeline_json_thesis_fit (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  analysis_id uuid NOT NULL UNIQUE,
  thesis_fit_json jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  past_deal_comparisons_json jsonb,
  CONSTRAINT deal_pipeline_json_thesis_fit_pkey PRIMARY KEY (id),
  CONSTRAINT deal_pipeline_json_thesis_fit_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id),
  CONSTRAINT deal_pipeline_json_thesis_fit_analysis_id_fkey FOREIGN KEY (analysis_id) REFERENCES public.deal_analyses(id)
);
CREATE TABLE public.deal_pipeline_json_traction_signals (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  analysis_id uuid NOT NULL UNIQUE,
  traction_signal_json jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  past_deal_comparisons_json jsonb,
  CONSTRAINT deal_pipeline_json_traction_signals_pkey PRIMARY KEY (id),
  CONSTRAINT deal_pipeline_json_traction_signals_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id),
  CONSTRAINT deal_pipeline_json_traction_signals_analysis_id_fkey FOREIGN KEY (analysis_id) REFERENCES public.deal_analyses(id)
);
CREATE TABLE public.deal_problem (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  analysis_id uuid NOT NULL,
  problem_statement text,
  root_cause_depth text,
  economic_gravity text,
  structural_urgency text,
  persona_clarity text,
  economic_buyer_persona text,
  budget_priority_validation text,
  pain_severity_score integer,
  buyer_authority_score integer,
  structural_tailwinds_score integer,
  venture_scale_plausibility integer,
  stated_problem_ref text,
  signal_completeness text,
  user_corpus_context_json jsonb,
  CONSTRAINT deal_problem_pkey PRIMARY KEY (id),
  CONSTRAINT deal_problem_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id),
  CONSTRAINT deal_problem_analysis_id_fkey FOREIGN KEY (analysis_id) REFERENCES public.deal_analyses(id)
);
CREATE TABLE public.deal_prompt_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  analysis_id uuid NOT NULL,
  step_name text NOT NULL,
  model_name text,
  model_tier text,
  input_context jsonb,
  output_json jsonb,
  error_message text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT deal_prompt_runs_pkey PRIMARY KEY (id),
  CONSTRAINT deal_prompt_runs_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id),
  CONSTRAINT deal_prompt_runs_analysis_id_fkey FOREIGN KEY (analysis_id) REFERENCES public.deal_analyses(id)
);
CREATE TABLE public.deal_questions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  analysis_id uuid NOT NULL,
  template_id uuid,
  contradiction_id uuid,
  assumption_id uuid,
  question_text text,
  source_signal text,
  question_type text,
  asked_in_meeting boolean DEFAULT false,
  meeting_id uuid,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT deal_questions_pkey PRIMARY KEY (id),
  CONSTRAINT deal_questions_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id),
  CONSTRAINT deal_questions_analysis_id_fkey FOREIGN KEY (analysis_id) REFERENCES public.deal_analyses(id),
  CONSTRAINT deal_questions_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.question_templates(id),
  CONSTRAINT deal_questions_contradiction_id_fkey FOREIGN KEY (contradiction_id) REFERENCES public.contradictions(id),
  CONSTRAINT deal_questions_assumption_id_fkey FOREIGN KEY (assumption_id) REFERENCES public.deal_assumptions(id)
);
CREATE TABLE public.deal_retrieval_index (
  deal_id uuid NOT NULL,
  analysis_id uuid NOT NULL,
  problem_normalized text,
  solution_normalized text,
  market_normalized text,
  risk_normalized text,
  concepts_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  normalized_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  problem_embedding USER-DEFINED,
  solution_embedding USER-DEFINED,
  market_embedding USER-DEFINED,
  risk_embedding USER-DEFINED,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT deal_retrieval_index_pkey PRIMARY KEY (deal_id),
  CONSTRAINT deal_retrieval_index_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id),
  CONSTRAINT deal_retrieval_index_analysis_id_fkey FOREIGN KEY (analysis_id) REFERENCES public.deal_analyses(id)
);
CREATE TABLE public.deal_scores (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  analysis_id uuid NOT NULL,
  dimension text NOT NULL,
  raw_score double precision,
  weighted_score double precision,
  rubric_weight double precision,
  scoring_stage text,
  CONSTRAINT deal_scores_pkey PRIMARY KEY (id),
  CONSTRAINT deal_scores_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id),
  CONSTRAINT deal_scores_analysis_id_fkey FOREIGN KEY (analysis_id) REFERENCES public.deal_analyses(id)
);
CREATE TABLE public.deal_solution (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  analysis_id uuid NOT NULL,
  solution_summary text,
  product_type text,
  moat_type text,
  replication_difficulty text,
  compounding_potential text,
  technical_moat_evidence text,
  ten_x_improvement_score integer,
  defensibility_potential integer,
  competitive_edge_score integer,
  signal_completeness text,
  differentiation_proof_points jsonb,
  competitor_landscape_json jsonb,
  user_corpus_context_json jsonb,
  CONSTRAINT deal_solution_pkey PRIMARY KEY (id),
  CONSTRAINT deal_solution_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id),
  CONSTRAINT deal_solution_analysis_id_fkey FOREIGN KEY (analysis_id) REFERENCES public.deal_analyses(id)
);
CREATE TABLE public.deal_traction (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  analysis_id uuid NOT NULL,
  inferred_stage text,
  benchmark_context text,
  traction_strength_score integer,
  growth_acceleration_score integer,
  stage_adjusted_signal_score integer,
  signal_completeness text,
  traction_evidence_json jsonb,
  phase1_traction_json jsonb,
  revenue_data text,
  growth_signals text,
  customer_depth text,
  user_traction text,
  notable_partners_and_validation jsonb,
  investor_list jsonb,
  milestones_detected jsonb,
  CONSTRAINT deal_traction_pkey PRIMARY KEY (id),
  CONSTRAINT deal_traction_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id),
  CONSTRAINT deal_traction_analysis_id_fkey FOREIGN KEY (analysis_id) REFERENCES public.deal_analyses(id)
);
CREATE TABLE public.deals (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  company_name text,
  website text,
  sector text,
  subsector text,
  stage text,
  business_model text,
  geography text,
  check_size_requested integer,
  source text,
  decision text,
  pass_reason text,
  pass_reason_detail text,
  sourced_by uuid,
  deck_url text,
  deal_embedding USER-DEFINED,
  decision_date timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  search_document text,
  search_tsv tsvector DEFAULT to_tsvector('english'::regconfig, COALESCE(search_document, ''::text)),
  pass_reason_enum text,
  key_risks ARRAY,
  moat_type text,
  replication_difficulty text,
  product_type text,
  crm_notes text,
  crm_stage text,
  crm_next_step text,
  CONSTRAINT deals_pkey PRIMARY KEY (id),
  CONSTRAINT deals_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id)
);
CREATE TABLE public.emails (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  gmail_connection_id uuid NOT NULL,
  gmail_message_id text NOT NULL,
  subject text,
  from_address text,
  date timestamp with time zone,
  snippet text,
  created_at timestamp with time zone DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT emails_pkey PRIMARY KEY (id),
  CONSTRAINT emails_gmail_connection_id_fkey FOREIGN KEY (gmail_connection_id) REFERENCES public.gmail_connections(id)
);
CREATE TABLE public.founder_employment (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  founder_id uuid NOT NULL,
  company_name text,
  title text,
  start_date date,
  end_date date,
  is_current boolean,
  CONSTRAINT founder_employment_pkey PRIMARY KEY (id),
  CONSTRAINT founder_employment_founder_id_fkey FOREIGN KEY (founder_id) REFERENCES public.founders(id)
);
CREATE TABLE public.founders (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  name text,
  linkedin_url text,
  email text,
  role text,
  enrichment_source text,
  enrichment_raw jsonb,
  universities ARRAY,
  yc_batch text,
  created_at timestamp with time zone DEFAULT now(),
  background_summary text,
  previous_companies jsonb,
  institutions jsonb,
  awards_and_honors jsonb,
  past_exits jsonb,
  CONSTRAINT founders_pkey PRIMARY KEY (id),
  CONSTRAINT founders_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id)
);
CREATE TABLE public.fund_contacts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text,
  role text,
  firm text,
  linkedin_url text,
  email text,
  CONSTRAINT fund_contacts_pkey PRIMARY KEY (id)
);
CREATE TABLE public.fund_thesis (
  user_id uuid NOT NULL,
  thesis_text text NOT NULL DEFAULT ''::text,
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT fund_thesis_pkey PRIMARY KEY (user_id),
  CONSTRAINT fund_thesis_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id)
);
CREATE TABLE public.fund_thesis_v2 (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid,
  fund_name text,
  version integer,
  stage_focus ARRAY,
  sector_focus ARRAY,
  check_size_min integer,
  check_size_max integer,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT fund_thesis_v2_pkey PRIMARY KEY (id),
  CONSTRAINT fund_thesis_v2_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id)
);
CREATE TABLE public.gmail_connections (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  email text NOT NULL,
  access_token text NOT NULL,
  refresh_token text,
  watch_expiration timestamp with time zone,
  history_id text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT gmail_connections_pkey PRIMARY KEY (id),
  CONSTRAINT gmail_connections_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id)
);
CREATE TABLE public.investment_memos (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  analysis_id uuid,
  content text,
  memo_embedding USER-DEFINED,
  authored_by text,
  partner_notes text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT investment_memos_pkey PRIMARY KEY (id),
  CONSTRAINT investment_memos_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id),
  CONSTRAINT investment_memos_analysis_id_fkey FOREIGN KEY (analysis_id) REFERENCES public.deal_analyses(id)
);
CREATE TABLE public.investment_rule_documents (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  storage_path text NOT NULL,
  original_filename text,
  mime_type text,
  status text NOT NULL DEFAULT 'pending'::text CHECK (status = ANY (ARRAY['pending'::text, 'processing'::text, 'processed'::text, 'failed'::text])),
  error_message text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT investment_rule_documents_pkey PRIMARY KEY (id),
  CONSTRAINT investment_rule_documents_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id)
);
CREATE TABLE public.investment_rules (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL,
  user_id uuid NOT NULL,
  rule_text text NOT NULL,
  condition_text text NOT NULL DEFAULT ''::text,
  rule_section text NOT NULL CHECK (rule_section = ANY (ARRAY['problem'::text, 'solution'::text, 'founder'::text])),
  condition_section text NOT NULL CHECK (condition_section = ANY (ARRAY['problem'::text, 'solution'::text, 'founder'::text, 'market'::text])),
  polarity text NOT NULL CHECK (polarity = ANY (ARRAY['positive'::text, 'negative'::text])),
  target_score_key text NOT NULL,
  specific_score_change numeric,
  keywords jsonb NOT NULL DEFAULT '[]'::jsonb,
  rule_json jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT investment_rules_pkey PRIMARY KEY (id),
  CONSTRAINT investment_rules_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.investment_rule_documents(id),
  CONSTRAINT investment_rules_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id)
);
CREATE TABLE public.investor_patterns (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  investor_id uuid NOT NULL,
  pattern_type text,
  evidence_deal_ids ARRAY,
  confidence_score double precision,
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT investor_patterns_pkey PRIMARY KEY (id),
  CONSTRAINT investor_patterns_investor_id_fkey FOREIGN KEY (investor_id) REFERENCES public.investors(id)
);
CREATE TABLE public.investors (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text,
  investor_type text,
  typical_stage text,
  typical_sectors ARRAY,
  crunchbase_id text,
  CONSTRAINT investors_pkey PRIMARY KEY (id)
);
CREATE TABLE public.keyword_clusters (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  vocab_version integer NOT NULL DEFAULT 1,
  medoid_phrase text NOT NULL UNIQUE,
  medoid_embedding USER-DEFINED NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT keyword_clusters_pkey PRIMARY KEY (id)
);
CREATE TABLE public.meetings (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  meeting_date date,
  fund_attendees ARRAY,
  founder_attendees ARRAY,
  notes text,
  transcript text,
  meeting_type text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT meetings_pkey PRIMARY KEY (id),
  CONSTRAINT meetings_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id)
);
CREATE TABLE public.pitch_deck_results (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  email_id uuid NOT NULL UNIQUE,
  gmail_message_id text NOT NULL,
  gmail_attachment_id text,
  pdf_size_bytes integer,
  parsing_json jsonb,
  problem_extraction_json jsonb,
  solution_extraction_json jsonb,
  problem_quality_score numeric,
  solution_quality_score numeric,
  founder_team_quality_score numeric,
  metrics_quality_score numeric,
  composite_score numeric,
  problem_web_json jsonb,
  solution_web_json jsonb,
  founder_web_json jsonb,
  metrics_web_json jsonb,
  processed_at timestamp with time zone DEFAULT now(),
  thesis_fit_json jsonb,
  founder_signal_json jsonb,
  traction_signal_json jsonb,
  problem_quality_3c_json jsonb,
  solution_defensibility_json jsonb,
  market_power_json jsonb,
  core_assumption_json jsonb,
  thesis_fit_score numeric,
  founder_signal_score numeric,
  traction_signal_score numeric,
  solution_defensibility_score numeric,
  market_power_score numeric,
  CONSTRAINT pitch_deck_results_pkey PRIMARY KEY (id),
  CONSTRAINT pitch_deck_results_email_id_fkey FOREIGN KEY (email_id) REFERENCES public.emails(id)
);
CREATE TABLE public.question_outcomes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  question_id uuid NOT NULL,
  meeting_id uuid,
  was_asked boolean,
  answer_summary text,
  conviction_delta text,
  led_to_pass boolean,
  led_to_invest boolean,
  analyst_rating integer,
  follow_up_needed text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT question_outcomes_pkey PRIMARY KEY (id),
  CONSTRAINT question_outcomes_question_id_fkey FOREIGN KEY (question_id) REFERENCES public.deal_questions(id),
  CONSTRAINT question_outcomes_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id)
);
CREATE TABLE public.question_templates (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  question_type text,
  trigger_condition text,
  template_text text,
  applicable_stages ARRAY,
  applicable_sectors ARRAY,
  signal_yield double precision,
  use_count integer,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT question_templates_pkey PRIMARY KEY (id)
);
CREATE TABLE public.scoring_rubrics (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  thesis_id uuid NOT NULL,
  stage text,
  dimension text,
  weight double precision,
  description text,
  CONSTRAINT scoring_rubrics_pkey PRIMARY KEY (id),
  CONSTRAINT scoring_rubrics_thesis_id_fkey FOREIGN KEY (thesis_id) REFERENCES public.fund_thesis_v2(id)
);
CREATE TABLE public.thesis_rules (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  thesis_id uuid NOT NULL,
  rule_type text,
  dimension text,
  condition text,
  machine_condition jsonb,
  weight double precision,
  auto_reject boolean,
  flag_message text,
  CONSTRAINT thesis_rules_pkey PRIMARY KEY (id),
  CONSTRAINT thesis_rules_thesis_id_fkey FOREIGN KEY (thesis_id) REFERENCES public.fund_thesis_v2(id)
);
CREATE TABLE public.user_investment_rules_context (
  user_id uuid NOT NULL,
  aggregated_by_section jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT user_investment_rules_context_pkey PRIMARY KEY (user_id),
  CONSTRAINT user_investment_rules_context_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id)
);
CREATE TABLE public.user_spreadsheets (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL DEFAULT 'Untitled'::text,
  deal_ids ARRAY NOT NULL DEFAULT '{}'::uuid[],
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT user_spreadsheets_pkey PRIMARY KEY (id),
  CONSTRAINT user_spreadsheets_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id)
);