import type { SupabaseClient } from "@supabase/supabase-js";
import {
  embedRetrievalProfile,
  upsertDealRetrievalArtifacts,
  type DealRetrievalProfile,
} from "@/lib/deal-retrieval-profile";
import type { DealSourcingResult } from "@/lib/deal-sourcing-pipeline";
import { normalizeScore0to10 } from "@/lib/model-scores";
import { materializeDealContextFromPipeline } from "@/lib/materialize-deal-context";
import { syncPipelineScoresToFeatureGrid } from "@/lib/sync-deal-feature-values";

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

/** Round 0–10 scores for int columns in legacy schema. */
function scoreAsInt(obj: Record<string, unknown> | null | undefined, key: string): number | null {
  const n = getNumber(obj, key);
  if (n == null) return null;
  return Math.round(Math.min(10, Math.max(0, n)));
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

  const thesisFitJson =
    typeof result.thesis_fit_json === "object" && result.thesis_fit_json !== null
      ? (result.thesis_fit_json as Record<string, unknown>)
      : {};
  const tractionJson =
    typeof result.traction_signal_json === "object" && result.traction_signal_json !== null
      ? (result.traction_signal_json as Record<string, unknown>)
      : {};
  const problemJson =
    typeof result.problem_quality_3c_json === "object" && result.problem_quality_3c_json !== null
      ? (result.problem_quality_3c_json as Record<string, unknown>)
      : {};
  const solutionJson =
    typeof result.solution_defensibility_json === "object" && result.solution_defensibility_json !== null
      ? (result.solution_defensibility_json as Record<string, unknown>)
      : {};
  const coreAssumptionJson =
    typeof result.core_assumption_json === "object" && result.core_assumption_json !== null
      ? (result.core_assumption_json as Record<string, unknown>)
      : {};

  await upsert("deal_pipeline_json_parsing", {
    deal_id: dealId,
    analysis_id: analysisId,
    parsing_json: result.parsing_json ?? {},
  });
  await upsert("deal_pipeline_json_thesis_fit", {
    deal_id: dealId,
    analysis_id: analysisId,
    thesis_fit_json: result.thesis_fit_json ?? {},
    past_deal_comparisons_json: (thesisFitJson.past_deal_comparisons as unknown) ?? null,
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
    past_deal_comparisons_json: (tractionJson.past_deal_comparisons as unknown) ?? null,
  });
  await upsert("deal_pipeline_json_problem_3c", {
    deal_id: dealId,
    analysis_id: analysisId,
    problem_quality_3c_json: result.problem_quality_3c_json ?? {},
    past_deal_comparisons_json: (problemJson.past_deal_comparisons as unknown) ?? null,
  });
  await upsert("deal_pipeline_json_solution_3d", {
    deal_id: dealId,
    analysis_id: analysisId,
    solution_defensibility_json: result.solution_defensibility_json ?? {},
    past_deal_comparisons_json: (solutionJson.past_deal_comparisons as unknown) ?? null,
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
    past_deal_comparisons_json: (coreAssumptionJson.past_deal_comparisons as unknown) ?? null,
    assumption_comparisons_json: (coreAssumptionJson.assumption_comparisons as unknown) ?? null,
  });
  await upsert("deal_pipeline_json_summaries", {
    deal_id: dealId,
    analysis_id: analysisId,
    pipeline_summaries_json: result.pipeline_summaries ?? {},
  });

  if (result.questions_combined_json) {
    await upsert("deal_pipeline_json_questions_combined", {
      deal_id: dealId,
      analysis_id: analysisId,
      questions_combined_json: result.questions_combined_json ?? {},
    });
  }
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
  const userCorpusThesisContext = null;
  const userCorpusRiskContext = null;
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
      .update({
        raw_output: result as unknown,
        similar_peers_json: result.similar_peers_context ?? null,
        user_corpus_thesis_context_json: userCorpusThesisContext,
        user_corpus_risk_context_json: userCorpusRiskContext,
      })
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
        similar_peers_json: result.similar_peers_context ?? null,
        user_corpus_thesis_context_json: userCorpusThesisContext,
        user_corpus_risk_context_json: userCorpusRiskContext,
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

  const retrievalProfileRaw = result.retrieval_profile_json as DealRetrievalProfile | undefined;
  if (retrievalProfileRaw) {
    try {
      const embeddingsFromPipeline = result.retrieval_embeddings_json as
        | { problem: number[]; solution: number[]; market: number[] }
        | undefined;
      const embeddings = embeddingsFromPipeline ?? (await embedRetrievalProfile(retrievalProfileRaw));
      await upsertDealRetrievalArtifacts({
        admin,
        dealId,
        analysisId,
        profile: retrievalProfileRaw,
        embeddings,
      });
    } catch (e) {
      console.warn("persistDealAnalysis: retrieval profile persist skipped:", e);
    }
  }

  // 3) Section-specific tables (decomposition of JSON blobs)
  const founderSignal = toRecord(result.founder_signal_json);
  const tractionSignal = toRecord(result.traction_signal_json);
  const problem3c = toRecord(result.problem_quality_3c_json);
  const solution3d = toRecord(result.solution_defensibility_json);
  const coreAssumption = toRecord(result.core_assumption_json);

  const problem = toRecord(parsing.problem);
  const solution = toRecord(parsing.solution);

  // ----- founders: Phase 1 team + Founder A/B JSON (V2-2) -----
  const teamList = Array.isArray(parsing.team) ? (parsing.team as unknown[]) : [];
  const perFounderEnrich = Array.isArray(founderSignal.per_founder)
    ? (founderSignal.per_founder as unknown[])
    : [];
  const collective = founderSignal.collective;

  await admin
    .from("founders")
    .delete()
    .eq("deal_id", dealId)
    .in("enrichment_source", ["deal_sourcing_v2_founder_a", "deal_sourcing_v2_founder_b_collective"]);

  const insertFounderRow = async (row: Record<string, unknown>) => {
    const { error } = await admin.from("founders").insert(row);
    if (error) console.error("persistDealAnalysis: founders insert", error);
  };

  /** Phase 1 deck fields per Prompts V2-2 team[] schema */
  const mapTeamMemberToRow = (t: Record<string, unknown>, enrichmentRaw: unknown, source: string) => {
    const name = typeof t.name === "string" ? t.name.trim() : "";
    if (!name) return null;
    return {
      deal_id: dealId,
      name,
      role: typeof t.role === "string" ? t.role : null,
      background_summary: typeof t.background_summary === "string" ? t.background_summary : null,
      previous_companies: Array.isArray(t.previous_companies) ? t.previous_companies : null,
      institutions: Array.isArray(t.institutions) ? t.institutions : null,
      awards_and_honors: Array.isArray(t.awards_and_honors) ? t.awards_and_honors : null,
      past_exits: Array.isArray(t.past_exits) ? t.past_exits : null,
      enrichment_source: source,
      enrichment_raw: enrichmentRaw ?? null,
    };
  };

  if (teamList.length > 0) {
    for (let i = 0; i < teamList.length; i++) {
      const t = toRecord(teamList[i]);
      const enrichmentRaw = i < perFounderEnrich.length ? perFounderEnrich[i] : null;
      const row = mapTeamMemberToRow(t, enrichmentRaw, "deal_sourcing_v2_founder_a");
      if (row) await insertFounderRow(row);
    }
  } else if (perFounderEnrich.length > 0) {
    // Phase 1 had no team[] but Founder A still ran (edge case) — persist per founder_name
    for (const p of perFounderEnrich) {
      const r = toRecord(p);
      const name =
        typeof r.founder_name === "string" && r.founder_name.trim()
          ? r.founder_name.trim()
          : "Unknown founder";
      await insertFounderRow({
        deal_id: dealId,
        name,
        role: null,
        background_summary: null,
        previous_companies: null,
        institutions: null,
        awards_and_honors: null,
        past_exits: null,
        enrichment_source: "deal_sourcing_v2_founder_a",
        enrichment_raw: r,
      });
    }
  }

  // Founder B collective assessment (single row; full JSON in enrichment_raw)
  if (collective && typeof collective === "object") {
    await insertFounderRow({
      deal_id: dealId,
      name: companyName ? `${companyName} — collective team signal` : "Collective team signal",
      role: null,
      background_summary: null,
      previous_companies: null,
      institutions: null,
      awards_and_honors: null,
      past_exits: null,
      enrichment_source: "deal_sourcing_v2_founder_b_collective",
      enrichment_raw: collective,
    });
  }

  // ----- deal_metrics: Phase 1 market + traction claims -----
  const market = toRecord(parsing.market);
  const tractionPhase1 = toRecord(parsing.traction);
  const marketPairs: { metric_name: string; metric_value: string }[] = [];
  const addMetric = (key: string, val: unknown) => {
    if (val == null) return;
    const s = typeof val === "string" ? val.trim() : JSON.stringify(val);
    if (s) marketPairs.push({ metric_name: key, metric_value: s });
  };
  addMetric("tam_claim", market.tam_claim);
  addMetric("sam_claim", market.sam_claim);
  addMetric("som_claim", market.som_claim);
  if (Array.isArray(market.market_growth_claims)) {
    addMetric("market_growth_claims", market.market_growth_claims);
  }
  addMetric("traction_revenue", tractionPhase1.revenue);
  addMetric("traction_arr", tractionPhase1.arr);
  addMetric("traction_growth_rate", tractionPhase1.growth_rate);
  addMetric("traction_customers", tractionPhase1.customers);
  addMetric("traction_active_users", tractionPhase1.active_users);
  addMetric("traction_retention_or_churn", tractionPhase1.retention_or_churn);
  if (Array.isArray(tractionPhase1.notable_logos)) {
    addMetric("traction_notable_logos", tractionPhase1.notable_logos);
  }
  if (Array.isArray(tractionPhase1.partnerships)) {
    addMetric("traction_partnerships", tractionPhase1.partnerships);
  }
  const fundRaising = toRecord(parsing.fundraising);
  addMetric("fundraising_raising_amount", fundRaising.raising_amount);
  addMetric("fundraising_round", fundRaising.round_type_or_stage ?? fundRaising.round_type);
  addMetric("fundraising_valuation", fundRaising.valuation);
  if (Array.isArray(fundRaising.use_of_funds)) {
    addMetric("fundraising_use_of_funds", fundRaising.use_of_funds);
  }

  for (const row of marketPairs) {
    const { error: mErr } = await admin.from("deal_metrics").insert({
      deal_id: dealId,
      metric_name: row.metric_name,
      metric_value: row.metric_value,
      source_type: row.metric_name.startsWith("traction_") || row.metric_name.startsWith("fundraising_")
        ? "phase1_parse"
        : "phase1_parse",
      confidence: null,
      is_verified: false,
    });
    if (mErr) {
      console.error("persistDealAnalysis: deal_metrics insert", mErr);
    }
  }

  // ----- deal_problem (Phase 1 + Phase 3C — full V2-2 schema) -----
  const problemAnalysis = toRecord(problem3c.problem_analysis);
  const customerAnalysis = toRecord(problem3c.customer_analysis);
  const problemScores = toRecord(problem3c.scores as unknown);
  const problemSig = toRecord(problem3c.signal_interpretation);
  const { error: problemErr } = await admin.from("deal_problem").insert({
    deal_id: dealId,
    analysis_id: analysisId,
    problem_statement:
      typeof problem.problem_statement === "string" ? problem.problem_statement : null,
    stated_problem_ref:
      typeof problemAnalysis.stated_problem_ref === "string"
        ? problemAnalysis.stated_problem_ref
        : null,
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
    signal_completeness:
      typeof problemSig.signal_completeness === "string"
        ? problemSig.signal_completeness
        : null,
    pain_severity_score: scoreAsInt(problemScores, "pain_severity_score"),
    buyer_authority_score: scoreAsInt(problemScores, "buyer_authority_score"),
    structural_tailwinds_score: scoreAsInt(problemScores, "structural_tailwinds_score"),
    venture_scale_plausibility: scoreAsInt(problemScores, "venture_scale_plausibility"),
    user_corpus_context_json: null,
  });
  if (problemErr) console.error("persistDealAnalysis: deal_problem insert", problemErr);

  // ----- deal_solution (Phase 1 + Phase 3D + competitors / differentiation) -----
  const solutionAnalysis = toRecord(solution3d.solution_analysis);
  const defensibilitySignals = toRecord(solution3d.defensibility_signals);
  const solutionScores = toRecord(solution3d.scores as unknown);
  const solutionSig = toRecord(solution3d.signal_interpretation);
  const previewSolution =
    typeof result.pipeline_summaries?.solution === "string" && result.pipeline_summaries.solution.trim()
      ? result.pipeline_summaries.solution
      : null;

  const diffPoints = Array.isArray(solutionAnalysis.differentiation_proof_points)
    ? solutionAnalysis.differentiation_proof_points
    : [];

  const { error: solutionErr } = await admin.from("deal_solution").insert({
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
    signal_completeness:
      typeof solutionSig.signal_completeness === "string" ? solutionSig.signal_completeness : null,
    differentiation_proof_points: diffPoints.length ? diffPoints : null,
    competitor_landscape_json: Array.isArray(solutionAnalysis.competitor_landscape)
      ? solutionAnalysis.competitor_landscape
      : null,
    ten_x_improvement_score: scoreAsInt(solutionScores, "10x_improvement_plausibility"),
    defensibility_potential: scoreAsInt(solutionScores, "defensibility_potential"),
    competitive_edge_score: scoreAsInt(solutionScores, "competitive_edge_score"),
    user_corpus_context_json: null,
  });
  if (solutionErr) console.error("persistDealAnalysis: deal_solution insert", solutionErr);

  // One analysis per deal in typical flow; clear by deal_id so legacy rows without analysis_id are removed
  await admin.from("deal_competitors").delete().eq("deal_id", dealId);
  const competitors = solutionAnalysis.competitor_landscape;
  if (Array.isArray(competitors)) {
    for (const c of competitors) {
      const row = toRecord(c);
      const { error: ce } = await admin.from("deal_competitors").insert({
        deal_id: dealId,
        analysis_id: analysisId,
        competitor_name: typeof row.name === "string" ? row.name : null,
        category: typeof row.category === "string" ? row.category : null,
        threat_assessment: typeof row.threat_assessment === "string" ? row.threat_assessment : null,
        threat_level: null,
      });
      if (ce) console.error("persistDealAnalysis: deal_competitors insert", ce);
    }
  }

  await admin.from("deal_differentiation").delete().eq("deal_id", dealId);
  for (const p of diffPoints) {
    if (typeof p === "string" && p.trim()) {
      const { error: de } = await admin.from("deal_differentiation").insert({
        deal_id: dealId,
        analysis_id: analysisId,
        proof_point: p.trim(),
        proof_type: "differentiation_proof_point",
      });
      if (de) console.error("persistDealAnalysis: deal_differentiation insert", de);
    }
  }

  // ----- deal_traction (Phase 1 snapshot + traction agent JSON — V2-2) -----
  const inferredContext = toRecord(tractionSignal.inferred_context);
  const tractionEvidence = toRecord(tractionSignal.traction_evidence);
  const detectedMetrics = toRecord(tractionEvidence.detected_metrics);

  const phase1TractionObj =
    Object.keys(tractionPhase1).length > 0 ? tractionPhase1 : null;

  const { error: tractionErr } = await admin.from("deal_traction").insert({
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
    traction_strength_score: scoreAsInt(tractionSignal, "traction_strength_score"),
    growth_acceleration_score: scoreAsInt(tractionSignal, "growth_acceleration_score"),
    stage_adjusted_signal_score: scoreAsInt(tractionSignal, "stage_adjusted_signal_score"),
    signal_completeness:
      typeof tractionSignal.signal_completeness === "string"
        ? tractionSignal.signal_completeness
        : null,
    traction_evidence_json: Object.keys(tractionEvidence).length > 0 ? tractionEvidence : null,
    phase1_traction_json: phase1TractionObj,
    revenue_data:
      typeof detectedMetrics.revenue_data === "string" ? detectedMetrics.revenue_data : null,
    growth_signals:
      typeof detectedMetrics.growth_signals === "string" ? detectedMetrics.growth_signals : null,
    customer_depth:
      typeof detectedMetrics.customer_depth === "string" ? detectedMetrics.customer_depth : null,
    user_traction:
      typeof detectedMetrics.user_traction === "string" ? detectedMetrics.user_traction : null,
    notable_partners_and_validation: Array.isArray(tractionEvidence.notable_partners_and_validation)
      ? tractionEvidence.notable_partners_and_validation
      : null,
    investor_list: Array.isArray(tractionEvidence.investor_list) ? tractionEvidence.investor_list : null,
    milestones_detected: Array.isArray(tractionEvidence.milestones_detected)
      ? tractionEvidence.milestones_detected
      : null,
  });
  if (tractionErr) console.error("persistDealAnalysis: deal_traction insert", tractionErr);

  // ----- deal_assumptions (Phase 4 strategic assumption JSON) -----
  const criticalAssumptions = Array.isArray(coreAssumption.critical_assumptions)
    ? (coreAssumption.critical_assumptions as unknown[])
    : [];
  const linchpin = toRecord(coreAssumption.the_linchpin_assumption);
  const riskDyn = toRecord(coreAssumption.risk_dynamics);

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
        index === 0 ? scoreAsInt(linchpin, "fragility_score") : null,
      why_fragile:
        index === 0 && typeof linchpin.why_it_is_fragile === "string"
          ? (linchpin.why_it_is_fragile as string)
          : null,
      failure_mode:
        index === 0 && typeof riskDyn.failure_mode_analysis === "string"
          ? riskDyn.failure_mode_analysis
          : null,
    };
  });

  if (assumptionRows.length) {
    const { error: assErr } = await admin.from("deal_assumptions").insert(assumptionRows);
    if (assErr) console.error("persistDealAnalysis: deal_assumptions insert", assErr);
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
    const { error: qErr } = await admin.from("deal_questions").insert(
      questionTexts.slice(0, 20).map((text) => ({
        deal_id: dealId,
        analysis_id: analysisId,
        question_text: text,
        source_signal: "assumptions_questions",
        question_type: "generated",
      }))
    );
    if (qErr) console.error("persistDealAnalysis: deal_questions insert", qErr);
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
  const { error: scoresErr } = await admin.from("deal_scores").insert(scoreRows);
  if (scoresErr) console.error("persistDealAnalysis: deal_scores insert", scoresErr);

  // deal_flags (auto-reject from thesis if present)
  if (typeof result.thesis_auto_reject === "boolean" && result.thesis_auto_reject) {
    const { error: flagErr } = await admin.from("deal_flags").insert({
      deal_id: dealId,
      analysis_id: analysisId,
      flag_type: "thesis_auto_reject",
      flag_message: "Thesis fit scores below threshold",
      auto_reject: true,
      triggered_by: "thesis_agent",
    });
    if (flagErr) console.error("persistDealAnalysis: deal_flags insert", flagErr);
  }

  try {
    await materializeDealContextFromPipeline(admin, dealId, analysisId, result);
  } catch (e) {
    console.warn("persistDealAnalysis: materializeDealContextFromPipeline", e);
  }

  try {
    await syncPipelineScoresToFeatureGrid(admin, userId, dealId, result);
  } catch (e) {
    console.warn("persistDealAnalysis: syncPipelineScoresToFeatureGrid", e);
  }

  return { dealId, analysisId };
}
