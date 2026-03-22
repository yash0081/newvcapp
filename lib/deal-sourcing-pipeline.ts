import {
  runWithPdf,
  runWithTextMulti,
  runWithTextMultiOnModel,
  GEMINI_MODEL_FLASH_SUMMARY,
} from "@/lib/gemini";
import { normalizeScore0to10 } from "@/lib/model-scores";
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

/**
 * Full pipeline result. Agent JSONs are kept separate from preview prose:
 * use `pipeline_summaries` for card previews; use `problem_quality_3c_json`, etc. for in-depth analysis.
 */
export interface DealSourcingResult {
  parsing_json: unknown;
  thesis_fit_json: unknown;
  /** Founder A JSONs + Founder B collective only (no merged summary). */
  founder_signal_json: { per_founder: unknown[]; collective: unknown };
  /** Traction agent output only. */
  traction_signal_json: unknown;
  /** Phase 3C agent output only. */
  problem_quality_3c_json: unknown;
  /** Phase 3D agent output only. */
  solution_defensibility_json: unknown;
  market_power_json: null;
  /** Phase 4 assumption agent output only (no questions, no risk summary prose). */
  core_assumption_json: unknown;
  /** Question generators — stored separately from `core_assumption_json`. */
  questions_first_order_json: unknown;
  questions_structural_json: unknown;
  /** V2-2 aggregation prompt outputs (previews); not mixed into agent JSONs above. */
  pipeline_summaries?: {
    founder: string;
    traction: string;
    problem: string;
    solution: string;
    assumptions: string;
  };
  thesis_fit_score: number;
  founder_signal_score: number;
  traction_signal_score: number;
  problem_quality_score: number;
  solution_defensibility_score: number;
  market_power_score: number;
  composite_score: number;
  thesis_auto_reject?: boolean;
}
export type PromptOutputStepName =
  | "phase1_parsing"
  | "phase2_thesis"
  | "founder_signals"
  | "traction_signals"
  | "phase3c_problem"
  | "phase3d_solution"
  | "phase4_assumptions"
  | "summary_founder"
  | "summary_traction"
  | "summary_problem"
  | "summary_solution"
  | "summary_assumptions"
  | "questions_first_order"
  | "questions_structural";

function avgScore(obj: Record<string, unknown> | null, keys: string[]): number {
  if (!obj) return 0;
  let sum = 0;
  let n = 0;
  for (const k of keys) {
    const v = obj[k];
    if (v == null || v === "") continue;
    if (typeof v === "number" && !Number.isNaN(v)) {
      sum += normalizeScore0to10(v);
      n++;
    } else if (typeof v === "string") {
      const num = parseFloat(v);
      if (!Number.isNaN(num)) {
        sum += normalizeScore0to10(num);
        n++;
      }
    }
  }
  const avg = n ? sum / n : 0;
  return Math.max(0, Math.min(10, avg));
}

function getCompanyName(parsing: Record<string, unknown>): string {
  const co = parsing.company_overview as Record<string, unknown> | undefined;
  const name = co && typeof co.company_name === "string" ? co.company_name.trim() : "";
  return name || "Unknown Company";
}

function getTeamForFounderA(parsing: Record<string, unknown>): { name: string; role?: string }[] {
  const team = (parsing as Record<string, unknown>).team;
  if (!Array.isArray(team) || team.length === 0) return [];
  const members = team.slice(0, 2).map((m) => {
    const r = m as Record<string, unknown>;
    const name = (typeof r.name === "string" ? r.name : String(r.name ?? "Unknown")).trim();
    const role = typeof r.role === "string" ? r.role : undefined;
    return { name, role };
  });
  return members;
}

/** Phase 1 team row for this founder (for search grounding). Matches by normalized name. */
function getDeckTeamMemberForFounder(team: unknown, founderName: string): Record<string, unknown> | null {
  if (!Array.isArray(team)) return null;
  const target = founderName.trim().toLowerCase();
  for (const m of team) {
    const r = m as Record<string, unknown>;
    const n = typeof r.name === "string" ? r.name.trim().toLowerCase() : "";
    if (n && n === target) return r;
  }
  return null;
}

/** Only the Phase 3C JSON fields the Problem summary prompt is allowed to see (V2-2). */
function jsonForProblemSummary(problem3C: Record<string, unknown>) {
  return {
    problem_analysis: problem3C.problem_analysis ?? null,
    customer_analysis: problem3C.customer_analysis ?? null,
    scores: problem3C.scores ?? null,
    signal_interpretation: problem3C.signal_interpretation ?? null,
  };
}

/** Only the Phase 3D JSON fields the Solution summary prompt is allowed to see (V2-2). */
function jsonForSolutionSummary(solution3D: Record<string, unknown>) {
  return {
    solution_analysis: solution3D.solution_analysis ?? null,
    defensibility_signals: solution3D.defensibility_signals ?? null,
    scores: solution3D.scores ?? null,
    signal_interpretation: solution3D.signal_interpretation ?? null,
  };
}

/** Traction agent JSON only (summary prompt must not receive unrelated phases). */
function jsonForTractionSummary(traction: Record<string, unknown>) {
  return {
    traction_evidence: traction.traction_evidence ?? null,
    inferred_context: traction.inferred_context ?? null,
    traction_strength_score: traction.traction_strength_score,
    growth_acceleration_score: traction.growth_acceleration_score,
    stage_adjusted_signal_score: traction.stage_adjusted_signal_score,
    signal_completeness: traction.signal_completeness ?? null,
  };
}

/** Phase 4 strategic assumption JSON only (no question blocks) for the Risk summary prompt. */
function jsonForAssumptionSummary(core: Record<string, unknown>) {
  return {
    critical_assumptions: core.critical_assumptions ?? null,
    the_linchpin_assumption: core.the_linchpin_assumption ?? null,
    risk_dynamics: core.risk_dynamics ?? null,
    overall_conviction_delta: core.overall_conviction_delta ?? null,
  };
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
  fundThesisStatement: string | null,
  onStep?: (step: "parse" | "thesis" | "founder" | "traction" | "problem" | "solution" | "assumptions_questions") => Promise<void> | void,
  onPromptOutput?: (stepName: PromptOutputStepName, output: unknown) => Promise<void> | void
): Promise<DealSourcingResult> {
  const thesisText = fundThesisStatement?.trim() ?? "(No fund thesis provided.)";

  // Phase 1: PDF parsing (3.1 Flash Lite)
  const parsing_json = await runWithPdf(PROMPT_PHASE_1_PARSER, pdfBuffer, "flash_lite");
  if (onPromptOutput) await onPromptOutput("phase1_parsing", parsing_json);
  if (onStep) await onStep("parse");
  const parsing = (parsing_json ?? {}) as Record<string, unknown>;
  const companyName = getCompanyName(parsing);

  // Phase 2: Thesis Agent (3.1 Flash Lite) — subset of Phase 1 JSON (V2-2).
  const startup_thesis_info = {
    company_overview: parsing.company_overview,
    traction: parsing.traction,
    fundraising: parsing.fundraising,
    market: parsing.market ?? null,
  };
  const thesis_fit_json = await runWithTextMulti(
    PROMPT_PHASE_2_THESIS,
    [
      { label: "fund_thesis_json", value: thesisText },
      { label: "startup_thesis_info", value: startup_thesis_info },
    ],
    "flash_lite"
  );
  if (onPromptOutput) await onPromptOutput("phase2_thesis", thesis_fit_json);
  if (onStep) await onStep("thesis");

  const thesisFit = thesis_fit_json as Record<string, unknown>;
  const ind = (thesisFit?.industry_evaluation as Record<string, unknown> | undefined)?.score;
  const stg = (thesisFit?.stage_evaluation as Record<string, unknown> | undefined)?.score;
  const fund = (thesisFit?.funding_evaluation as Record<string, unknown> | undefined)?.score;
  const thesisRaw = [ind, stg, fund];
  const scores: number[] = [];
  for (const v of thesisRaw) {
    if (v == null || v === "") continue;
    if (typeof v === "number" && !Number.isNaN(v)) scores.push(normalizeScore0to10(v));
    else if (typeof v === "string") {
      const n = parseFloat(v);
      if (!Number.isNaN(n)) scores.push(normalizeScore0to10(n));
    }
  }
  const thesis_fit_score = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

  // Soft thesis gate: still run downstream agents, but mark auto-reject when alignment is poor.
  const autoRejectFlagFromModel =
    typeof (thesisFit?.auto_reject_flag as unknown) === "boolean"
      ? (thesisFit.auto_reject_flag as boolean)
      : false;
  const anyScoreTooLow = scores.some((s) => s <= 3);
  const thesis_auto_reject = autoRejectFlagFromModel || anyScoreTooLow;

  // Founder A: per founder (3.1 Flash Lite) — prompt text matches V2-2; Phase 1 team row passed as labeled JSON.
  const teamMembers = getTeamForFounderA(parsing);
  const teamArray = parsing.team;
  const perFounderResults: unknown[] = [];
  for (const member of teamMembers) {
    const prompt = getFounderAPrompt(member.name, companyName);
    const deckMember = getDeckTeamMemberForFounder(teamArray, member.name);
    const result = await runWithTextMulti(
      prompt,
      [
        {
          label: "deck_founder_context_from_phase1_json",
          value: deckMember ?? { note: "No matching team row in Phase 1 parse for this founder name" },
        },
      ],
      "flash_lite"
    );
    perFounderResults.push(result);
  }

  // Founder B: collective (3.1 Flash Lite) — full team roster from Phase 1 as labeled JSON (V2-2 grounding).
  const founderBCheck = await runWithTextMulti(
    getFounderBPrompt(companyName),
    [{ label: "team_roster_from_phase1_deck_json", value: Array.isArray(teamArray) ? teamArray : [] }],
    "flash_lite"
  );
  const founderB = founderBCheck as Record<string, unknown>;
  const founder_signal_json = {
    per_founder: perFounderResults,
    collective: founderBCheck,
  };
  if (onPromptOutput) await onPromptOutput("founder_signals", founder_signal_json);

  const founder_signal_score = avgScore(
    (founderB?.scores as Record<string, unknown>) ?? null,
    ["asymmetric_talent_score", "insight_edge_score", "recruiting_magnetism_proxy"]
  );
  if (onStep) await onStep("founder");

  // Traction (3.1 Flash Lite) — Phase 1 subset + market claims (V2-2).
  const startup_traction_info = {
    company_overview: parsing.company_overview,
    traction: parsing.traction,
    fundraising: parsing.fundraising,
    market: parsing.market ?? null,
  };
  const traction_signal_json = await runWithTextMulti(
    PROMPT_TRACTION,
    [
      { label: "startup_traction_info", value: startup_traction_info },
      { label: "company_name", value: companyName },
    ],
    "flash_lite"
  );
  if (onPromptOutput) await onPromptOutput("traction_signals", traction_signal_json);
  if (onStep) await onStep("traction");

  const tractionSignal = traction_signal_json as Record<string, unknown>;
  const traction_signal_score = avgScore(tractionSignal, [
    "traction_strength_score",
    "growth_acceleration_score",
    "stage_adjusted_signal_score",
  ]);

  // Phase 3C: Problem (Gemini 3 Flash) — parsed_startup_data = problem + market + overview + fundraising (V2-2).
  const parsed_startup_data_problem = {
    problem: parsing.problem ?? null,
    market: parsing.market ?? null,
    company_overview: parsing.company_overview ?? null,
    fundraising: parsing.fundraising ?? null,
  };
  const problem_quality_3c_json = await runWithTextMulti(
    PROMPT_PHASE_3C_PROBLEM,
    [
      { label: "parsed_startup_data", value: parsed_startup_data_problem },
      { label: "company_name", value: companyName },
    ],
    "flash"
  );
  if (onPromptOutput) await onPromptOutput("phase3c_problem", problem_quality_3c_json);
  if (onStep) await onStep("problem");

  const problem3C = problem_quality_3c_json as Record<string, unknown>;
  const problem_quality_score = avgScore(
    (problem3C?.scores as Record<string, unknown>) ?? null,
    ["pain_severity_score", "buyer_authority_score", "structural_tailwinds_score", "venture_scale_plausibility"]
  );

  // Phase 3D: Solution (Gemini 3 Flash) — parsed_startup_data = solution + market + overview + notable_claims (V2-2).
  const parsed_startup_data_solution = {
    solution: parsing.solution ?? null,
    market: parsing.market ?? null,
    company_overview: parsing.company_overview ?? null,
    notable_claims: parsing.notable_claims ?? [],
  };
  const solution_defensibility_json = await runWithTextMulti(
    PROMPT_PHASE_3D_SOLUTION,
    [
      { label: "parsed_startup_data", value: parsed_startup_data_solution },
      { label: "company_name", value: companyName },
    ],
    "flash"
  );
  if (onPromptOutput) await onPromptOutput("phase3d_solution", solution_defensibility_json);
  if (onStep) await onStep("solution");

  const solution3D = solution_defensibility_json as Record<string, unknown>;
  const solution_defensibility_score = avgScore(
    (solution3D?.scores as Record<string, unknown>) ?? null,
    ["10x_improvement_plausibility", "defensibility_potential", "competitive_edge_score"]
  );

  // Phase 4: Strategic Assumption — full Phase 1 + Phase 2 thesis + structured Phase 3 signals (scores + completeness / interpretation per V2-2).
  const core_signal_scores = {
    founder: {
      collective_team_scores: founderB?.scores ?? null,
      signal_completeness:
        typeof founderB?.signal_completeness === "string" ? founderB.signal_completeness : null,
    },
    traction: {
      traction_strength_score: tractionSignal?.traction_strength_score,
      growth_acceleration_score: tractionSignal?.growth_acceleration_score,
      stage_adjusted_signal_score: tractionSignal?.stage_adjusted_signal_score,
      signal_completeness:
        typeof tractionSignal?.signal_completeness === "string"
          ? tractionSignal.signal_completeness
          : null,
    },
    problem: {
      scores: problem3C?.scores ?? null,
      signal_interpretation: problem3C?.signal_interpretation ?? null,
    },
    solution: {
      scores: solution3D?.scores ?? null,
      signal_interpretation: solution3D?.signal_interpretation ?? null,
    },
    market: parsing.market ?? null,
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
  if (onPromptOutput) await onPromptOutput("phase4_assumptions", core_assumption_json);
  if (onStep) await onStep("assumptions_questions");

  // Section summaries + question generation in parallel to reduce total latency.
  const [
    founder_summary_text,
    traction_summary_text,
    problem_summary_text,
    solution_summary_text,
    assumptions_summary_text,
    first_order_questions_json,
    structural_questions_json,
  ] = await Promise.all([
    summarizeSection(
      SUMMARY_FOUNDER_PROMPT,
      [
        { label: "founder_data", value: perFounderResults },
        { label: "team_density_data", value: founderB },
      ],
      "human_capital_summary"
    ),
    summarizeSection(
      SUMMARY_TRACTION_PROMPT,
      [{ label: "traction_data", value: jsonForTractionSummary(tractionSignal) }],
      "traction_summary"
    ),
    summarizeSection(
      SUMMARY_PROBLEM_PROMPT,
      [{ label: "problem_customer_data", value: jsonForProblemSummary(problem3C) }],
      "problem_summary"
    ),
    summarizeSection(
      SUMMARY_SOLUTION_PROMPT,
      [{ label: "solution_defensibility_data", value: jsonForSolutionSummary(solution3D) }],
      "solution_summary"
    ),
    summarizeSection(
      SUMMARY_ASSUMPTIONS_PROMPT,
      [
        {
          label: "risk_assumption_data",
          value: jsonForAssumptionSummary(core_assumption_json as Record<string, unknown>),
        },
      ],
      "risk_summary"
    ),
    runWithTextMulti(
      PROMPT_QUESTIONS_FIRST_ORDER,
      [{ label: "parsed_assumptions_json", value: core_assumption_json }],
      "flash"
    ),
    runWithTextMulti(
      PROMPT_QUESTIONS_STRUCTURAL,
      [{ label: "parsed_assumptions_json", value: core_assumption_json }],
      "flash"
    ),
  ]);

  if (onPromptOutput) await onPromptOutput("summary_founder", { human_capital_summary: founder_summary_text ?? "" });
  if (onPromptOutput) await onPromptOutput("summary_traction", { traction_summary: traction_summary_text ?? "" });
  if (onPromptOutput) await onPromptOutput("summary_problem", { problem_summary: problem_summary_text ?? "" });
  if (onPromptOutput) await onPromptOutput("summary_solution", { solution_summary: solution_summary_text ?? "" });
  if (onPromptOutput) await onPromptOutput("summary_assumptions", { risk_summary: assumptions_summary_text ?? "" });
  if (onPromptOutput) await onPromptOutput("questions_first_order", first_order_questions_json);
  if (onPromptOutput) await onPromptOutput("questions_structural", structural_questions_json);

  const pipeline_summaries = {
    founder: founder_summary_text ?? "",
    traction: traction_summary_text ?? "",
    problem: problem_summary_text ?? "",
    solution: solution_summary_text ?? "",
    assumptions: assumptions_summary_text ?? "",
  };

  // Composite score over 5 dimensions (no market phase in V2)
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
    founder_signal_json: {
      per_founder: perFounderResults,
      collective: founderBCheck,
    },
    traction_signal_json: tractionSignal,
    problem_quality_3c_json: problem3C,
    solution_defensibility_json: solution3D,
    market_power_json: null,
    core_assumption_json,
    questions_first_order_json: first_order_questions_json,
    questions_structural_json: structural_questions_json,
    pipeline_summaries,
    thesis_fit_score,
    founder_signal_score,
    traction_signal_score,
    problem_quality_score,
    solution_defensibility_score,
    market_power_score: 0,
    composite_score,
    thesis_auto_reject,
  };
}

