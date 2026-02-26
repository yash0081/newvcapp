/**
 * Deal-sourcing pipeline: Phase 1 (PDF parse) → Phase 2 (thesis fit) → Phase 3A–3E → Phase 4.
 * See Deal Sourcing Gemini Prompts.md and lib/deal-sourcing-prompts.ts.
 */
import { runWithPdf, runWithText, runWithTextMulti } from "@/lib/gemini";
import {
  PROMPT_PHASE_1_PARSER,
  PROMPT_PHASE_2_THESIS_FIT,
  PROMPT_PHASE_3A_FOUNDER_SIGNAL,
  PROMPT_PHASE_3B_TRACTION_SIGNAL,
  PROMPT_PHASE_3C_PROBLEM_QUALITY,
  PROMPT_PHASE_3D_SOLUTION_DEFENSIBILITY,
  PROMPT_PHASE_3E_MARKET_POWER,
  PROMPT_PHASE_4_CORE_ASSUMPTION,
} from "@/lib/deal-sourcing-prompts";

export interface DealSourcingResult {
  parsing_json: unknown;
  thesis_fit_json: unknown;
  founder_signal_json: unknown;
  traction_signal_json: unknown;
  problem_quality_3c_json: unknown;
  solution_defensibility_json: unknown;
  market_power_json: unknown;
  core_assumption_json: unknown;
  thesis_fit_score: number;
  founder_signal_score: number;
  traction_signal_score: number;
  problem_quality_score: number;
  solution_defensibility_score: number;
  market_power_score: number;
  composite_score: number;
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

/**
 * Run the full deal-sourcing pipeline. Uses fund_thesis_statement for Phase 2; if null, Phase 2 still runs but scores may be conservative.
 */
export async function runDealSourcingPipeline(
  pdfBuffer: Buffer,
  fundThesisStatement: string | null
): Promise<DealSourcingResult> {
  const thesis = fundThesisStatement?.trim() ?? "";

  // Phase 1: PDF → structured JSON (Flash Lite)
  const parsing_json = await runWithPdf(PROMPT_PHASE_1_PARSER, pdfBuffer, "flash_lite");

  // Phase 2: thesis + Phase 1 → thesis fit (Flash Lite)
  const thesis_fit_json = await runWithTextMulti(
    PROMPT_PHASE_2_THESIS_FIT,
    [
      { label: "fund_thesis_statement", value: thesis || "(No fund thesis provided.)" },
      { label: "startup_structured_json", value: parsing_json },
    ],
    "flash_lite"
  );

  // Phase 3A–3E: can run in parallel (each takes Phase 1 output)
  const [
    founder_signal_json,
    traction_signal_json,
    problem_quality_3c_json,
    solution_defensibility_json,
    market_power_json,
  ] = await Promise.all([
    runWithText(PROMPT_PHASE_3A_FOUNDER_SIGNAL, parsing_json, "flash"),
    runWithText(PROMPT_PHASE_3B_TRACTION_SIGNAL, parsing_json, "flash"),
    runWithText(PROMPT_PHASE_3C_PROBLEM_QUALITY, parsing_json, "flash_lite"),
    runWithText(PROMPT_PHASE_3D_SOLUTION_DEFENSIBILITY, parsing_json, "flash_lite"),
    runWithText(PROMPT_PHASE_3E_MARKET_POWER, parsing_json, "flash"),
  ]);

  // Phase 4: Phase 1 + 2 + all Phase 3 → core assumption (Gemini 3 Flash)
  const phase3Combined = {
    parsing: parsing_json,
    thesis_fit: thesis_fit_json,
    founder_signal: founder_signal_json,
    traction_signal: traction_signal_json,
    problem_quality: problem_quality_3c_json,
    solution_defensibility: solution_defensibility_json,
    market_power: market_power_json,
  };
  const core_assumption_json = await runWithText(
    PROMPT_PHASE_4_CORE_ASSUMPTION,
    phase3Combined,
    "heavy"
  );

  // Compute scores
  const thesisFit = thesis_fit_json as Record<string, unknown>;
  const thesis_fit_score = avgScore(thesisFit, [
    "sector_fit_score",
    "stage_fit_score",
    "geo_fit_score",
    "check_size_fit_score",
  ]);

  const founderSignal = founder_signal_json as Record<string, unknown>;
  const founder_signal_score = avgScore(founderSignal, [
    "asymmetric_talent_score",
    "insight_edge_score",
    "recruiting_magnetism_proxy",
  ]);

  const tractionSignal = traction_signal_json as Record<string, unknown>;
  const traction_signal_score = avgScore(tractionSignal, [
    "traction_strength_score",
    "growth_acceleration_score",
    "stage_adjusted_signal_score",
  ]);

  const problemQuality = problem_quality_3c_json as Record<string, unknown>;
  const problem_quality_score = avgScore(problemQuality, [
    "pain_severity_score",
    "budget_signal_score",
    "recurrence_score",
    "buyer_clarity_score",
    "venture_plausibility_score",
  ]);

  const solutionDef = solution_defensibility_json as Record<string, unknown>;
  const solution_defensibility_score = avgScore(solutionDef, [
    "10x_improvement_plausibility",
    "defensibility_potential",
    "moat_compounding_potential",
    "differentiation_clarity",
  ]);

  const marketPower = market_power_json as Record<string, unknown>;
  const market_power_score = avgScore(marketPower, [
    "TAM_plausibility_score",
    "winner_take_most_potential",
    "structural_tailwinds_score",
    "market_fragmentation_score",
    "venture_scale_probability_estimate",
  ]);

  const composite_score =
    (thesis_fit_score +
      founder_signal_score +
      traction_signal_score +
      problem_quality_score +
      solution_defensibility_score +
      market_power_score) /
    6;

  return {
    parsing_json,
    thesis_fit_json,
    founder_signal_json,
    traction_signal_json,
    problem_quality_3c_json,
    solution_defensibility_json,
    market_power_json,
    core_assumption_json,
    thesis_fit_score,
    founder_signal_score,
    traction_signal_score,
    problem_quality_score,
    solution_defensibility_score,
    market_power_score,
    composite_score,
  };
}
