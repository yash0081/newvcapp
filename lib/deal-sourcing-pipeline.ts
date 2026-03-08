/**
 * Deal-sourcing pipeline V2. Matches Prompts V2-2.md.
 * Flow: Phase 1 (PDF) → Phase 2 (Thesis; gate) → Founder A per founder → Founder B → Traction → 3C Problem → 3D Solution → Phase 4.
 * Models: 3.1 Flash Lite (flash_lite), 3 Flash (flash).
 */
import {
  runWithPdf,
  runWithText,
  runWithTextMulti,
  runWithPromptOnly,
  runWithTextMultiOnModel,
  GEMINI_MODEL_FLASH_SUMMARY,
} from "@/lib/gemini";
import {
  PROMPT_PHASE_1_PARSER,
  PROMPT_PHASE_2_THESIS,
  getFounderAPrompt,
  getFounderBPrompt,
  PROMPT_TRACTION,
  PROMPT_PHASE_3C_PROBLEM,
  PROMPT_PHASE_3D_SOLUTION,
  PROMPT_PHASE_4_ASSUMPTION,
  SUMMARY_FOUNDER_PROMPT,
  SUMMARY_TRACTION_PROMPT,
  SUMMARY_PROBLEM_PROMPT,
  SUMMARY_SOLUTION_PROMPT,
  SUMMARY_ASSUMPTIONS_PROMPT,
  PROMPT_QUESTIONS_FIRST_ORDER,
  PROMPT_QUESTIONS_STRUCTURAL,
} from "@/lib/deal-sourcing-prompts";

export interface DealSourcingResult {
  parsing_json: unknown;
  thesis_fit_json: unknown;
  founder_signal_json: unknown; // { per_founder: unknown[]; collective: unknown }
  traction_signal_json: unknown;
  problem_quality_3c_json: unknown;
  solution_defensibility_json: unknown;
  market_power_json: null; // V2 has no market phase
  core_assumption_json: unknown;
  thesis_fit_score: number;
  founder_signal_score: number;
  traction_signal_score: number;
  problem_quality_score: number;
  solution_defensibility_score: number;
  market_power_score: number; // 0 in V2
  composite_score: number;
  thesis_auto_reject?: boolean;
}

function avgScore(obj: Record<string, unknown> | null, keys: string[]): number {
  if (!obj) return 0;
  let sum = 0;
  let n = 0;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && !Number.isNaN(v)) {
      sum += v;
      n++;
    } else if (typeof v === "string") {
      const num = parseFloat(v);
      if (!Number.isNaN(num)) {
        sum += num;
        n++;
      }
    }
  }
  return n ? sum / n : 0;
}

function getCompanyName(parsing: Record<string, unknown>): string {
  const co = parsing.company_overview as Record<string, unknown> | undefined;
  const name = co && typeof co.company_name === "string" ? co.company_name.trim() : "";
  return name || "Unknown Company";
}

function getTeamForFounderA(parsing: Record<string, unknown>): { name: string; role?: string }[] {
  const team = parsing.team;
  if (!Array.isArray(team) || team.length === 0) return [];
  const members = team.slice(0, 2).map((m) => {
    const r = m as Record<string, unknown>;
    const name = (typeof r.name === "string" ? r.name : String(r.name ?? "Unknown")).trim();
    const role = typeof r.role === "string" ? r.role : undefined;
    return { name, role };
  });
  return members;
}

async function summarizeSection(
  prompt: string,
  inputs: { label: string; value: unknown }[],
  resultKey: string
): Promise<string | null> {
  try {
    const result = (await runWithTextMultiOnModel(
      GEMINI_MODEL_FLASH_SUMMARY,
      prompt,
      inputs
    )) as Record<string, unknown>;
    const summary = (result?.[resultKey] ?? result?.summary) as string | undefined;
    return typeof summary === "string" && summary.trim() ? summary.trim() : null;
  } catch {
    return null;
  }
}

export async function runDealSourcingPipeline(
  pdfBuffer: Buffer,
  fundThesisStatement: string | null
): Promise<DealSourcingResult> {
  const thesisText = fundThesisStatement?.trim() ?? "(No fund thesis provided.)";

  // ——— Phase 1: PDF parsing (3.1 Flash Lite) ———
  const parsing_json = await runWithPdf(PROMPT_PHASE_1_PARSER, pdfBuffer, "flash_lite");
  const parsing = (parsing_json ?? {}) as Record<string, unknown>;
  const companyName = getCompanyName(parsing);

  // ——— Phase 2: Thesis Agent (3.1 Flash Lite) ———
  const startup_thesis_info = {
    company_overview: parsing.company_overview,
    traction: parsing.traction,
    fundraising: parsing.fundraising,
  };
  const thesis_fit_json = await runWithTextMulti(
    PROMPT_PHASE_2_THESIS,
    [
      { label: "fund_thesis_json", value: thesisText },
      { label: "startup_thesis_info", value: startup_thesis_info },
    ],
    "flash_lite"
  );

  const thesisFit = thesis_fit_json as Record<string, unknown>;
  const ind = (thesisFit?.industry_evaluation as Record<string, unknown>)?.score;
  const stg = (thesisFit?.stage_evaluation as Record<string, unknown>)?.score;
  const fund = (thesisFit?.funding_evaluation as Record<string, unknown>)?.score;
  const scores = [ind, stg, fund].filter((v) => typeof v === "number" && !Number.isNaN(v)) as number[];
  const thesis_fit_score = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

  // ——— Founder A: per founder (3.1 Flash Lite) ———
  const teamMembers = getTeamForFounderA(parsing);
  const perFounderResults: unknown[] = [];
  for (const member of teamMembers) {
    const prompt = getFounderAPrompt(member.name, companyName);
    const result = await runWithPromptOnly(prompt, "flash_lite");
    perFounderResults.push(result);
  }

  // ——— Founder B: collective (3.1 Flash Lite) ———
  const founderBCheck = await runWithPromptOnly(getFounderBPrompt(companyName), "flash_lite");
  const founderB = founderBCheck as Record<string, unknown>;
  const founder_signal_json = {
    per_founder: perFounderResults,
    collective: founderBCheck,
  };

  const founder_signal_score = avgScore(
    founderB?.scores as Record<string, unknown>,
    ["asymmetric_talent_score", "insight_edge_score", "recruiting_magnetism_proxy"]
  );

  // ——— Traction (3.1 Flash Lite) ———
  const startup_traction_info = {
    company_overview: parsing.company_overview,
    traction: parsing.traction,
    fundraising: parsing.fundraising,
  };
  const traction_signal_json = await runWithTextMulti(
    PROMPT_TRACTION,
    [
      { label: "startup_traction_info", value: startup_traction_info },
      { label: "company_name", value: companyName },
    ],
    "flash_lite"
  );

  const tractionSignal = traction_signal_json as Record<string, unknown>;
  const traction_signal_score = avgScore(tractionSignal, [
    "traction_strength_score",
    "growth_acceleration_score",
    "stage_adjusted_signal_score",
  ]);

  // ——— Phase 3C: Problem (3.1 Flash Lite) ———
  const problemInput = {
    problem: parsing.problem,
    company_overview: parsing.company_overview,
  };
  const problem_quality_3c_json = await runWithTextMulti(
    PROMPT_PHASE_3C_PROBLEM,
    [
      { label: "parsed_startup_data", value: problemInput },
      { label: "company_name", value: companyName },
    ],
    "flash_lite"
  );

  const problem3C = problem_quality_3c_json as Record<string, unknown>;
  const problem_quality_score = avgScore(problem3C?.scores as Record<string, unknown>, [
    "pain_severity_score",
    "buyer_authority_score",
    "structural_tailwinds_score",
    "venture_scale_plausibility",
  ]);

  // ——— Phase 3D: Solution (3.1 Flash Lite) ———
  const solutionInput = {
    solution: parsing.solution,
    company_overview: parsing.company_overview,
  };
  const solution_defensibility_json = await runWithTextMulti(
    PROMPT_PHASE_3D_SOLUTION,
    [
      { label: "parsed_startup_data", value: solutionInput },
      { label: "company_name", value: companyName },
    ],
    "flash_lite"
  );

  const solution3D = solution_defensibility_json as Record<string, unknown>;
  const solution_defensibility_score = avgScore(solution3D?.scores as Record<string, unknown>, [
    "10x_improvement_plausibility",
    "defensibility_potential",
    "competitive_edge_score",
  ]);

  // ——— Phase 4: Strategic Assumption (3 Flash) ———
  const core_signal_scores = {
    founder: founderB?.scores,
    traction: {
      traction_strength_score: tractionSignal?.traction_strength_score,
      growth_acceleration_score: tractionSignal?.growth_acceleration_score,
      stage_adjusted_signal_score: tractionSignal?.stage_adjusted_signal_score,
    },
    problem: problem3C?.scores,
    solution: solution3D?.scores,
  };
  const core_assumption_json = await runWithTextMulti(
    PROMPT_PHASE_4_ASSUMPTION,
    [
      { label: "parsed_startup_data", value: parsing_json },
      { label: "thesis_fit_report", value: thesis_fit_json },
      { label: "core_signal_scores", value: core_signal_scores },
    ],
    "flash"
  );

  // ——— Section summaries via aggregation prompts (GEMINI_MODEL_FLASH_SUMMARY) ———
  const founder_summary_text =
    (await summarizeSection(
      SUMMARY_FOUNDER_PROMPT,
      [
        { label: "founder_data", value: perFounderResults },
        { label: "team_density_data", value: founderB },
      ],
      "human_capital_summary"
    )) ?? "";

  const traction_summary_text =
    (await summarizeSection(
      SUMMARY_TRACTION_PROMPT,
      [{ label: "traction_data", value: tractionSignal }],
      "traction_summary"
    )) ?? "";

  const problem_summary_text =
    (await summarizeSection(
      SUMMARY_PROBLEM_PROMPT,
      [{ label: "problem_customer_data", value: problem3C }],
      "problem_summary"
    )) ?? "";

  const solution_summary_text =
    (await summarizeSection(
      SUMMARY_SOLUTION_PROMPT,
      [{ label: "solution_defensibility_data", value: solution3D }],
      "solution_summary"
    )) ?? "";

  const assumptions_summary_text =
    (await summarizeSection(
      SUMMARY_ASSUMPTIONS_PROMPT,
      [{ label: "risk_assumption_data", value: core_assumption_json }],
      "risk_summary"
    )) ?? "";

  // ——— Question generation via assumptions JSON (Gemini 3 Flash) ———
  const first_order_questions_json = await runWithTextMulti(
    PROMPT_QUESTIONS_FIRST_ORDER,
    [{ label: "parsed_assumptions_json", value: core_assumption_json }],
    "flash"
  );

  const structural_questions_json = await runWithTextMulti(
    PROMPT_QUESTIONS_STRUCTURAL,
    [{ label: "parsed_assumptions_json", value: core_assumption_json }],
    "flash"
  );

  const enriched_founder_signal_json = {
    per_founder: perFounderResults,
    collective: founderBCheck,
    summary_text: founder_summary_text,
  };

  const enriched_traction_signal_json = {
    ...(tractionSignal ?? {}),
    summary_text: traction_summary_text,
  };

  const enriched_problem_quality_3c_json = {
    ...(problem3C ?? {}),
    summary_text: problem_summary_text,
  };

  const enriched_solution_defensibility_json = {
    ...(solution3D ?? {}),
    summary_text: solution_summary_text,
  };

  const enriched_core_assumption_json = {
    ...(core_assumption_json as Record<string, unknown>),
    summary_text: assumptions_summary_text,
    first_order_questions: first_order_questions_json,
    structural_auditor_questions: structural_questions_json,
  };

  // V2: no market phase; composite over 5 dimensions
  const composite_score =
    (thesis_fit_score +
      founder_signal_score +
      traction_signal_score +
      problem_quality_score +
      solution_defensibility_score) /
    5;

  return {
    parsing_json,
    thesis_fit_json,
    founder_signal_json: enriched_founder_signal_json,
    traction_signal_json: enriched_traction_signal_json,
    problem_quality_3c_json: enriched_problem_quality_3c_json,
    solution_defensibility_json: enriched_solution_defensibility_json,
    market_power_json: null,
    core_assumption_json: enriched_core_assumption_json,
    thesis_fit_score,
    founder_signal_score,
    traction_signal_score,
    problem_quality_score,
    solution_defensibility_score,
    market_power_score: 0,
    composite_score,
  };
}
