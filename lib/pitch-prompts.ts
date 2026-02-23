/**
 * Prompt text for the 7-step pitch deck pipeline. Full schemas are in PDF Prompts.md.
 */

export const PROMPT_PARSING =
  `You are a strict extraction agent. Extract only explicitly stated founder/team and metrics from the pitch deck PDF. Do not infer, estimate, or add. If unclear or missing return null. Maximum 25 items across arrays; strings 2-3 lines max. Return strict JSON only.
Output format: {"team_members":[{"name","role","education",["string"],"companies",["string"],"exits",["string"],"domain_expertise",["string"],"notable_claims",["string"]}],"metrics":{"revenue","arr","growth_rate","total_customers","active_users","churn","ltv","cac","ltv_cac_ratio","partnerships",["string"],"pipeline","projections",["string"]}}`;

export const PROMPT_PROBLEM_PDF =
  `Extract the startup's stated problem from the PDF only. No inference. Extract: summary_problem, target_customer, pain_points (array of {description, who_experiences_it, consequence}), quantified_problem_claims (array of {claim, value, unit}), extraction_confidence (0-10), failure_mode (no_clear_problem_statement|solution_disguised_as_problem|vague_generalization|multiple_unconnected_problems|none). Return strict JSON only.`;

export const PROMPT_SOLUTION_PDF =
  `Extract the startup's solution/product from the PDF only. Extract: summary_solution, product_type, core_features (array of strings), claimed_differentiation, claimed_defensibility, extraction_confidence (0-10), failure_mode. Return strict JSON only.`;

export const PROMPT_PROBLEM_WEB =
  `You are an analyst. Validate the startup's claimed problem from the input JSON using external web sources. For each claim find market size/affected population and competitors with quality assessment. Assign problem_quality_score (0-10), verification_confidence (0-10), uncertainty_score (0-10). Include problem_quality_commentary and uncertainty_commentary (2-3 lines max each). Compile sources array. Return strict JSON only with keys: affected_population_estimate, market_size_estimate, competitors (array), problem_quality_score, problem_quality_commentary, verification_confidence, uncertainty_score, uncertainty_commentary, sources.`;

export const PROMPT_SOLUTION_WEB =
  `You are an analyst. Validate the startup's solution from the input JSON using external web sources. Find technical feasibility, competitors and overlap, differentiation/defensibility, risks and adoption barriers. Assign solution_quality_score (0-10), verification_confidence (0-10), uncertainty_score (0-10). Include solution_quality_commentary and uncertainty_commentary (2-3 lines max). Compile sources array. Return strict JSON only with keys: feasibility_assessment, differentiation_defensibility_assessment, competitive_overlap_analysis, risks_and_adoption_barriers, solution_quality_score, solution_quality_commentary, verification_confidence, uncertainty_score, uncertainty_commentary, sources.`;

export const PROMPT_FOUNDER_TEAM_WEB =
  `You are a diligence analyst. Evaluate the startup's founders and team using the input JSON and external web sources. For each team member extract structured_claims, education, companies, exits, domain_expertise, verification status, legal/reputational issues, red flags. Team level: functional_coverage, missing_roles, concentration_risk. Assign founder_team_quality_score (0-10) with founder_team_quality_commentary (4-5 lines), verification_confidence, risk_penalty_score, uncertainty_score. Return strict JSON only.`;

export const PROMPT_METRICS_WEB =
  `You are a diligence analyst. Evaluate the startup's metrics and traction from the input JSON using external web sources. For each metric: claimed_value, verified_value, verification_status, evidence_strength, inconsistencies, credibility_risk. Overall: traction_strength_analysis, sustainability_assessment, red_flags, inconsistencies_detected. Assign metrics_quality_score (0-10) with metrics_quality_commentary (2-3 lines), verification_confidence, financial_risk_score, uncertainty_score. Return strict JSON only.`;
