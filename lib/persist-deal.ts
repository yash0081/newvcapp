import type { SupabaseClient } from "@supabase/supabase-js";
import type { DealSourcingResult } from "@/lib/deal-sourcing-pipeline";
import { normalizeScore0to10 } from "@/lib/model-scores";

function toRecord(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

function getNumber(obj: Record<string, unknown> | null | undefined, key: string): number | null {
  if (!obj) return null;
  const v = obj[key];
  if (typeof v === "number" && !Number.isNaN(v)) return normalizeScore0to10(v);
  if (typeof v === "string") {
    const num = parseFloat(v);
    return Number.isNaN(num) ? null : normalizeScore0to10(num);
  }
  return null;
}

/** One row per analysis in deal_pipeline_json_* tables (mirrors DealSourcingResult keys). */
async function persistPipelineJsonTables(
  admin: SupabaseClient,
  dealId: string,
  analysisId: string,
  result: DealSourcingResult
): Promise<void> {
  const upsert = async (table: string, row: Record<string, unknown>) => {
    const { error } = await admin.from(table).upsert(row, { onConflict: "analysis_id" });
    if (error) {
      console.error(`persistPipelineJsonTables: ${table}`, error);
    }
  };

  await upsert("deal_pipeline_json_parsing", {
    deal_id: dealId,
    analysis_id: analysisId,
    parsing_json: result.parsing_json ?? {},
  });
  await upsert("deal_pipeline_json_thesis_fit", {
    deal_id: dealId,
    analysis_id: analysisId,
    thesis_fit_json: result.thesis_fit_json ?? {},
  });
  await upsert("deal_pipeline_json_founder_signals", {
    deal_id: dealId,
    analysis_id: analysisId,
    founder_signal_json: result.founder_signal_json ?? {},
  });
  await upsert("deal_pipeline_json_traction_signals", {
    deal_id: dealId,
    analysis_id: analysisId,
    traction_signal_json: result.traction_signal_json ?? {},
  });
  await upsert("deal_pipeline_json_problem_3c", {
    deal_id: dealId,
    analysis_id: analysisId,
    problem_quality_3c_json: result.problem_quality_3c_json ?? {},
  });
  await upsert("deal_pipeline_json_solution_3d", {
    deal_id: dealId,
    analysis_id: analysisId,
    solution_defensibility_json: result.solution_defensibility_json ?? {},
  });
  await upsert("deal_pipeline_json_market_power", {
    deal_id: dealId,
    analysis_id: analysisId,
    market_power_json: result.market_power_json ?? null,
  });
  await upsert("deal_pipeline_json_core_assumptions", {
    deal_id: dealId,
    analysis_id: analysisId,
    core_assumption_json: result.core_assumption_json ?? {},
  });
  await upsert("deal_pipeline_json_summaries", {
    deal_id: dealId,
    analysis_id: analysisId,
    pipeline_summaries_json: result.pipeline_summaries ?? {},
  });
}

export async function persistDealAnalysis(opts: {
  admin: SupabaseClient;
  userId: string;
  pdfUrl?: string | null;
  result: DealSourcingResult;
  /** When provided, persist into this existing deal/analysis instead of creating new rows. */
  existingDealId?: string;
  existingAnalysisId?: string;
}): Promise<{ dealId: string; analysisId: string } | null> {
  const { admin, userId, pdfUrl, result, existingDealId, existingAnalysisId } = opts;

  const parsing = toRecord(result.parsing_json);
  const companyOverview = toRecord(parsing.company_overview);

  const companyName = typeof companyOverview.company_name === "string" ? companyOverview.company_name : null;
  const website = typeof companyOverview.website === "string" ? companyOverview.website : null;
  const sector = typeof companyOverview.sector_category === "string" ? companyOverview.sector_category : null;
  const stage = typeof companyOverview.stage === "string" ? companyOverview.stage : null;
  const businessModel = typeof companyOverview.business_model === "string" ? companyOverview.business_model : null;
  const geography = typeof companyOverview.geography === "string" ? companyOverview.geography : null;

  let dealId: string;
  let analysisId: string;

  if (existingDealId && existingAnalysisId) {
    dealId = existingDealId;
    analysisId = existingAnalysisId;
    const { error: dealUpdateError } = await admin
      .from("deals")
      .update({
        company_name: companyName,
        website,
        sector,
        stage,
        business_model: businessModel,
        geography,
        deck_url: pdfUrl ?? null,
      })
      .eq("id", existingDealId);
    if (dealUpdateError) {
      console.error("persistDealAnalysis: failed to update deal", dealUpdateError);
      return null;
    }
    const { error: analysisUpdateError } = await admin
      .from("deal_analyses")
      .update({ raw_output: result as unknown })
      .eq("id", existingAnalysisId);
    if (analysisUpdateError) {
      console.error("persistDealAnalysis: failed to update deal_analyses", analysisUpdateError);
      return null;
    }
  } else {
    // 1) Create deal row
    const { data: dealRow, error: dealError } = await admin
      .from("deals")
      .insert({
        user_id: userId,
        company_name: companyName,
        website,
        sector,
        stage,
        business_model: businessModel,
        geography,
        deck_url: pdfUrl ?? null,
      })
      .select("id")
      .single();

    if (dealError || !dealRow) {
      console.error("persistDealAnalysis: failed to insert deal", dealError);
      return null;
    }

    dealId = dealRow.id as string;

    // 2) Store raw analysis run
    const { data: analysisRow, error: analysisError } = await admin
      .from("deal_analyses")
      .insert({
        deal_id: dealId,
        raw_output: result as unknown,
      })
      .select("id")
      .single();

    if (analysisError || !analysisRow) {
      console.error("persistDealAnalysis: failed to insert deal_analyses", analysisError);
      return null;
    }

    analysisId = analysisRow.id as string;
  }

  await persistPipelineJsonTables(admin, dealId, analysisId, result);

  // 3) Section-specific tables (decomposition of JSON blobs)
  const founderSignal = toRecord(result.founder_signal_json);
  const tractionSignal = toRecord(result.traction_signal_json);
  const problem3c = toRecord(result.problem_quality_3c_json);
  const solution3d = toRecord(result.solution_defensibility_json);
  const coreAssumption = toRecord(result.core_assumption_json);

  const problem = toRecord(parsing.problem);
  const solution = toRecord(parsing.solution);

  // ----- founders: Phase 1 team rows + Founder A JSON (index-aligned with pipeline) -----
  const teamList = Array.isArray(parsing.team) ? (parsing.team as unknown[]) : [];
  const perFounderEnrich = Array.isArray(founderSignal.per_founder)
    ? (founderSignal.per_founder as unknown[])
    : [];
  await admin
    .from("founders")
    .delete()
    .eq("deal_id", dealId)
    .eq("enrichment_source", "deal_sourcing_v2_founder_a");
  for (let i = 0; i < teamList.length; i++) {
    const t = toRecord(teamList[i]);
    const name = typeof t.name === "string" ? t.name.trim() : "";
    if (!name) continue;
    const enrichmentRaw = i < perFounderEnrich.length ? perFounderEnrich[i] : null;
    const { error: founderErr } = await admin.from("founders").insert({
      deal_id: dealId,
      name,
      role: typeof t.role === "string" ? t.role : null,
      enrichment_source: "deal_sourcing_v2_founder_a",
      enrichment_raw: enrichmentRaw,
    });
    if (founderErr) {
      console.error("persistDealAnalysis: founders insert", founderErr);
    }
  }

  // ----- deal_metrics: Phase 1 market claims (decomposed) -----
  const market = toRecord(parsing.market);
  const marketPairs: { metric_name: string; metric_value: string }[] = [];
  const addMarket = (key: string, val: unknown) => {
    if (val == null) return;
    const s = typeof val === "string" ? val.trim() : JSON.stringify(val);
    if (s) marketPairs.push({ metric_name: key, metric_value: s });
  };
  addMarket("tam_claim", market.tam_claim);
  addMarket("sam_claim", market.sam_claim);
  addMarket("som_claim", market.som_claim);
  if (Array.isArray(market.market_growth_claims)) {
    addMarket("market_growth_claims", market.market_growth_claims);
  }
  for (const row of marketPairs) {
    const { error: mErr } = await admin.from("deal_metrics").insert({
      deal_id: dealId,
      metric_name: row.metric_name,
      metric_value: row.metric_value,
      source_type: "phase1_parse",
      confidence: null,
      is_verified: false,
    });
    if (mErr) {
      console.error("persistDealAnalysis: deal_metrics insert", mErr);
    }
  }

  // ----- deal_problem (Phase 1 + Phase 3C nested JSON) -----
  const problemAnalysis = toRecord(problem3c.problem_analysis);
  const customerAnalysis = toRecord(problem3c.customer_analysis);
  const problemScores = toRecord(problem3c.scores as unknown);

  await admin.from("deal_problem").insert({
    deal_id: dealId,
    analysis_id: analysisId,
    problem_statement:
      typeof problem.problem_statement === "string" ? problem.problem_statement : null,
    root_cause_depth:
      typeof problemAnalysis.root_cause_depth === "string"
        ? problemAnalysis.root_cause_depth
        : null,
    economic_gravity:
      typeof problemAnalysis.economic_gravity === "string"
        ? problemAnalysis.economic_gravity
        : null,
    structural_urgency:
      typeof problemAnalysis.structural_urgency === "string"
        ? problemAnalysis.structural_urgency
        : null,
    persona_clarity:
      typeof customerAnalysis.persona_clarity === "string"
        ? customerAnalysis.persona_clarity
        : null,
    economic_buyer_persona:
      typeof customerAnalysis.economic_buyer_persona === "string"
        ? customerAnalysis.economic_buyer_persona
        : null,
    budget_priority_validation:
      typeof customerAnalysis.budget_priority_validation === "string"
        ? customerAnalysis.budget_priority_validation
        : null,
    pain_severity_score: getNumber(problemScores, "pain_severity_score"),
    buyer_authority_score: getNumber(problemScores, "buyer_authority_score"),
    structural_tailwinds_score: getNumber(problemScores, "structural_tailwinds_score"),
    venture_scale_plausibility: getNumber(problemScores, "venture_scale_plausibility"),
  });

  // ----- deal_solution (Phase 1 + Phase 3D nested JSON) -----
  const solutionAnalysis = toRecord(solution3d.solution_analysis);
  const defensibilitySignals = toRecord(solution3d.defensibility_signals);
  const solutionScores = toRecord(solution3d.scores as unknown);

  const previewSolution =
    typeof result.pipeline_summaries?.solution === "string" && result.pipeline_summaries.solution.trim()
      ? result.pipeline_summaries.solution
      : null;

  await admin.from("deal_solution").insert({
    deal_id: dealId,
    analysis_id: analysisId,
    solution_summary:
      previewSolution ??
      (typeof solution.solution_summary === "string" ? solution.solution_summary : null) ??
      (typeof solutionAnalysis.stated_solution_ref === "string"
        ? (solutionAnalysis.stated_solution_ref as string)
        : null),
    product_type: typeof solution.product_type === "string" ? solution.product_type : null,
    moat_type:
      typeof defensibilitySignals.moat_type === "string"
        ? defensibilitySignals.moat_type
        : null,
    replication_difficulty:
      typeof defensibilitySignals.replication_difficulty === "string"
        ? defensibilitySignals.replication_difficulty
        : null,
    compounding_potential:
      typeof defensibilitySignals.compounding_potential === "string"
        ? defensibilitySignals.compounding_potential
        : null,
    technical_moat_evidence:
      typeof solutionAnalysis.technical_moat_evidence === "string"
        ? solutionAnalysis.technical_moat_evidence
        : null,
    ten_x_improvement_score: getNumber(solutionScores, "10x_improvement_plausibility"),
    defensibility_potential: getNumber(solutionScores, "defensibility_potential"),
    competitive_edge_score: getNumber(solutionScores, "competitive_edge_score"),
  });

  // ----- deal_traction (Traction schema nested JSON) -----
  const inferredContext = toRecord(tractionSignal.inferred_context);

  await admin.from("deal_traction").insert({
    deal_id: dealId,
    analysis_id: analysisId,
    inferred_stage:
      typeof inferredContext.inferred_stage === "string"
        ? inferredContext.inferred_stage
        : null,
    benchmark_context:
      typeof inferredContext.benchmark_context === "string"
        ? inferredContext.benchmark_context
        : null,
    traction_strength_score: getNumber(tractionSignal, "traction_strength_score"),
    growth_acceleration_score: getNumber(tractionSignal, "growth_acceleration_score"),
    stage_adjusted_signal_score: getNumber(tractionSignal, "stage_adjusted_signal_score"),
    signal_completeness:
      typeof tractionSignal.signal_completeness === "string"
        ? tractionSignal.signal_completeness
        : null,
  });

  // ----- deal_assumptions (Phase 4 strategic assumption JSON) -----
  const criticalAssumptions = Array.isArray(coreAssumption.critical_assumptions)
    ? (coreAssumption.critical_assumptions as unknown[])
    : [];
  const linchpin = toRecord(coreAssumption.the_linchpin_assumption);

  const assumptionRows = criticalAssumptions.map((item, index) => {
    const text =
      typeof item === "string"
        ? (item as string)
        : (toRecord(item).assumption as string | null);
    return {
      deal_id: dealId,
      analysis_id: analysisId,
      assumption_text: text ?? null,
      assumption_type: null,
      inversion: null,
      must_be_true: null,
      is_linchpin: index === 0 ? true : null,
      fragility_score:
        index === 0 ? getNumber(linchpin, "fragility_score") : null,
      why_fragile:
        index === 0 && typeof linchpin.why_it_is_fragile === "string"
          ? (linchpin.why_it_is_fragile as string)
          : null,
      failure_mode: null,
    };
  });

  if (assumptionRows.length) {
    await admin.from("deal_assumptions").insert(assumptionRows);
  }

  // deal_questions from question prompts (stored top-level on result, not inside core_assumption_json).
  const firstOrder = toRecord(
    result.questions_first_order_json ?? coreAssumption.first_order_questions
  );
  const structural = toRecord(
    result.questions_structural_json ?? coreAssumption.structural_auditor_questions
  );
  const questionTexts: string[] = [];
  const addIfText = (v: unknown) => {
    if (typeof v === "string" && v.trim()) questionTexts.push(v.trim());
  };
  const interrogations = Array.isArray(firstOrder.critical_assumption_interrogation)
    ? (firstOrder.critical_assumption_interrogation as unknown[])
    : [];
  for (const item of interrogations) {
    const q = toRecord(item);
    const killers = toRecord(q.killer_questions);
    addIfText(killers.evidence);
    addIfText(killers.behavioral_proof);
    addIfText(killers.failure_boundary);
    addIfText(killers.contradictory_signal);
  }
  const linchpinQuestions = toRecord(firstOrder.linchpin_questions);
  addIfText(linchpinQuestions.real_world_evidence);
  addIfText(linchpinQuestions.structural_dependency_test);
  addIfText(linchpinQuestions.market_contradiction);

  const dependencyQuestions = toRecord(structural.dependency_chain_questions);
  addIfText(dependencyQuestions.weakest_link_verification);
  addIfText(dependencyQuestions.unvalidated_step_check);
  addIfText(dependencyQuestions.cascade_failure_test);
  const failureModeQuestions = Array.isArray(structural.failure_mode_questions)
    ? (structural.failure_mode_questions as unknown[])
    : [];
  const deltaQuestions = Array.isArray(structural.conviction_delta_credibility_questions)
    ? (structural.conviction_delta_credibility_questions as unknown[])
    : [];
  for (const q of [...failureModeQuestions, ...deltaQuestions]) addIfText(q);

  if (questionTexts.length) {
    await admin.from("deal_questions").insert(
      questionTexts.slice(0, 20).map((text) => ({
        deal_id: dealId,
        analysis_id: analysisId,
        question_text: text,
        source_signal: "assumptions_questions",
        question_type: "generated",
      }))
    );
  }

  // deal_scores (high-level)
  const scoreRows = [
    { dimension: "thesis_fit", raw_score: result.thesis_fit_score },
    { dimension: "founder", raw_score: result.founder_signal_score },
    { dimension: "traction", raw_score: result.traction_signal_score },
    { dimension: "problem", raw_score: result.problem_quality_score },
    { dimension: "solution", raw_score: result.solution_defensibility_score },
  ].map((row) => ({
    deal_id: dealId,
    analysis_id: analysisId,
    dimension: row.dimension,
    raw_score: row.raw_score,
  }));
  await admin.from("deal_scores").insert(scoreRows);

  // deal_flags (auto-reject from thesis if present)
  if (typeof result.thesis_auto_reject === "boolean" && result.thesis_auto_reject) {
    await admin.from("deal_flags").insert({
      deal_id: dealId,
      analysis_id: analysisId,
      flag_type: "thesis_auto_reject",
      flag_message: "Thesis fit scores below threshold",
      auto_reject: true,
      triggered_by: "thesis_agent",
    });
  }

  return { dealId, analysisId };
}

