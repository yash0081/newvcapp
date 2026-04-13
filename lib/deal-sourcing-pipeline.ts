import type { SupabaseClient } from "@supabase/supabase-js";
import {
  runWithPdf,
  runWithTextMulti,
  runWithTextMultiOnModel,
  getGeminiSummaryModel,
  parseJsonFromResponse,
  runWithTextMultiRaw,
} from "@/lib/gemini";
import {
  buildRetrievalProfileFromParsing,
  embedRetrievalProfile,
  type DealRetrievalProfile,
} from "@/lib/deal-retrieval-profile";
import { normalizePhase1Parsing } from "@/lib/phase1-normalize";
import { registerKeywordPhrases } from "@/lib/keyword-vocabulary-graph";
import {
  fetchSimilarPeerBundlesForPipeline,
  labeledSimilarCompanyInputs,
  type SimilarPeerBundleForPipeline,
  type SimilarPeerForPrompt,
} from "@/lib/similar-deals";
import { computeInvestorOverlapSignals, extractInvestorNamesFromAny } from "@/lib/investor-overlap";
import { normalizeScore0to10 } from "@/lib/model-scores";
import {
  PROMPT_PHASE_1_PARSER,
  PROMPT_PHASE_2_THESIS,
  getFounderAPrompt,
  getFounderBPrompt,
  PROMPT_TRACTION,
  PROMPT_PHASE_3C_PROBLEM,
  PROMPT_PHASE_3D_SOLUTION,
  PROMPT_PHASE_4_ASSUMPTION_DRAFT,
  PROMPT_PHASE_4_ASSUMPTION_MERGE,
  PROMPT_PHASE_4_ASSUMPTION_VALIDATE_INFERRED,
  SUMMARY_FOUNDER_PROMPT,
  SUMMARY_TRACTION_PROMPT,
  SUMMARY_PROBLEM_PROMPT,
  SUMMARY_SOLUTION_PROMPT,
  SUMMARY_ASSUMPTIONS_PROMPT,
  PROMPT_QUESTIONS_FIRST_ORDER,
  PROMPT_QUESTIONS_STRUCTURAL,
  PROMPT_QUESTIONS_LOW_CONF_EVIDENCE,
  PROMPT_CLAIMS_PROBLEM,
  PROMPT_CLAIMS_SOLUTION,
  PROMPT_CLAIMS_TRACTION,
  PROMPT_REPAIR_CLAIMS_JSON,
  PROMPT_QUESTIONS_CONTRADICTIONS,
  PROMPT_RESOLVE_FOUNDING_TEAM,
} from "@/lib/deal-sourcing-prompts";
import {
  clusterClaimsOffline,
  embedClaims,
  normalizeClaim,
  type ClaimCluster,
  type EmbeddedClaim,
} from "@/lib/claims-clustering";
import type { DealSourcingPipelineStep } from "@/lib/deal-sourcing-types";
import {
  formatFounderInvestmentCriteriaSuffix,
  loadAggregatedRulesForUser,
  runInvestmentRulesInjectionMap,
  type AggregatedRulesBySection,
  type InjectionMapResult,
} from "@/lib/investment-rules";

export type { DealSourcingPipelineStep };

/**
 * Full pipeline result. Agent JSONs are kept separate from preview prose:
 * use `pipeline_summaries` for card previews; use `problem_quality_3c_json`, etc. for in-depth analysis.
 */
export interface DealSourcingResult {
  parsing_json: unknown;
  thesis_fit_json: unknown;
  /** Founder A JSONs + collective; optional merged summaries for commentary / corpus synthesis. */
  founder_signal_json: {
    per_founder: unknown[];
    collective: unknown;
    summary_text?: string;
    founder_signal_summary?: string;
  };
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
  questions_low_confidence_json?: unknown;
  claims_json?: {
    problem: unknown;
    solution: unknown;
    traction: unknown;
    embedded?: EmbeddedClaim[];
    clusters?: ClaimCluster[];
  };
  questions_contradictions_json?: unknown;
  questions_combined_json?: unknown;
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
  /** Fused top-3 comparables (matches similar_companies_overall_top in LLM inputs) for deal page / persistence. */
  similar_peers_context?: SimilarPeerForPrompt[];
  /** Hybrid retrieval v2 extraction snapshot (section concepts + normalized slices). */
  retrieval_profile_json?: DealRetrievalProfile;
  retrieval_embeddings_json?: {
    problem: number[];
    solution: number[];
    market: number[];
  };
}
export type PromptOutputStepName =
  | "phase1_parsing"
  | "phase2_thesis"
  | "founder_signals"
  | "traction_signals"
  | "phase3c_problem"
  | "phase3d_solution"
  | "phase4_assumptions"
  | "phase4_assumptions_merge"
  | "summary_founder"
  | "summary_traction"
  | "summary_problem"
  | "summary_solution"
  | "summary_assumptions"
  | "questions_first_order"
  | "questions_structural"
  | "questions_low_confidence"
  | "questions_contradictions"
  | "resolve_founding_team";

export type PromptRunInputContext = {
  peer_injection?: {
    has_peer_bundle: boolean;
    section: "thesis" | "traction" | "problem" | "solution" | "assumptions" | "summary" | "questions" | "parsing";
    overall_top?: Array<{ company_name: string; similarity_confidence: number; bucket: "HIGH" | "MED" | "LOW" }>;
    second_list_label?: string;
    second_list?: Array<{ company_name: string; similarity_confidence: number; bucket: "HIGH" | "MED" | "LOW" }>;
  };
};

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

type TeamMemberForFounderA = {
  name: string;
  role?: string;
  leader_kind?: string;
  title?: string | null;
};

function leaderKindScore(kind: string): number | null {
  const k = kind.trim().toLowerCase();
  if (k === "founding_ceo" || k === "current_ceo") return 0;
  if (k === "founding_technical" || k === "current_technical") return 1;
  if (k === "founding_other") return 0.5;
  if (k === "unknown") return 50;
  return null;
}

function getTeamForFounderA(parsing: Record<string, unknown>): TeamMemberForFounderA[] {
  const team = (parsing as Record<string, unknown>).team;
  if (!Array.isArray(team) || team.length === 0) return [];
  const normRole = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");
  const roleScore = (role: string): number => {
    if (!role) return 100;
    // Prefer actual founding titles before generic execs (COO/CRO etc. sort after founders/CEO/CTO).
    if (/co[- ]?founder|cofounder/.test(role) || /\bfounder\b/.test(role)) return -2;
    if (role.includes("chief executive") || role === "ceo" || /\bceo\b/.test(role)) return 0;
    if (role.includes("chief technology") || role === "cto" || /\bcto\b/.test(role)) return 1;
    if (role.includes("technical co-founder") || role.includes("tech cofounder")) return 2;
    if (role.includes("head of engineering") || role.includes("vp engineering")) return 4;
    return 50;
  };

  const normalized = team
    .map((m) => {
      const r = m as Record<string, unknown>;
      const name = (typeof r.name === "string" ? r.name : String(r.name ?? "Unknown")).trim();
      const roleRaw = typeof r.role === "string" ? r.role : undefined;
      const role = normRole(roleRaw);
      const lk =
        typeof r.leader_kind === "string" && r.leader_kind.trim()
          ? r.leader_kind.trim()
          : "";
      const score = leaderKindScore(lk) ?? roleScore(role);
      return { name, roleRaw, role, score, row: r };
    })
    .filter((m) => m.name.length > 0 && !/^unknown$/i.test(m.name));

  normalized.sort((a, b) => a.score - b.score);

  const members = normalized.slice(0, 2).map((m) => {
    const r = m.row;
    const leader_kind =
      typeof r.leader_kind === "string" && r.leader_kind.trim() ? r.leader_kind.trim() : undefined;
    const title =
      typeof r.title === "string" && r.title.trim() ? r.title.trim() : null;
    return { name: m.name, role: m.roleRaw, leader_kind, title };
  });
  return members;
}

/** Map CEO/CTO resolution JSON into Phase-1-shaped `team[]` for Founder A/B + persistence. */
function mergeResolvedFoundingTeamIntoParsing(parsing: Record<string, unknown>, resolved: unknown): void {
  const extras = {
    background_summary: null as string | null,
    previous_companies: [] as unknown[],
    institutions: [] as unknown[],
    awards_and_honors: [] as unknown[],
    past_exits: [] as unknown[],
  };
  const rows: Record<string, unknown>[] = [];
  const o = resolved && typeof resolved === "object" ? (resolved as Record<string, unknown>) : {};
  const push = (block: unknown, fallbackRole: string) => {
    if (!block || typeof block !== "object") return;
    const r = block as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (!name || /^unknown$/i.test(name)) return;
    const title =
      typeof r.title === "string" && r.title.trim() ? r.title.trim() : null;
    const legacyRole = typeof r.role === "string" && r.role.trim() ? r.role.trim() : null;
    const role = title ?? legacyRole ?? fallbackRole;
    const leaderKindRaw = typeof r.leader_kind === "string" ? r.leader_kind.trim() : "";
    const leader_kind = leaderKindRaw || "unknown";
    rows.push({ name, role, title, leader_kind, ...extras });
  };
  push(o.founder_primary, "CEO");
  if (o.founder_secondary != null && typeof o.founder_secondary === "object") {
    push(o.founder_secondary, "CTO");
  }
  parsing.team = rows.slice(0, 2);
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

/** Pull assumption excerpts from peer deals for Phase 4 merge RAG. */
async function fetchAssumptionRagSnippets(
  admin: SupabaseClient,
  userId: string,
  peerDealIds: string[]
): Promise<Array<{ company_name: string; excerpt: string }>> {
  if (peerDealIds.length === 0) return [];
  const { data: deals } = await admin
    .from("deals")
    .select("id, company_name")
    .in("id", peerDealIds)
    .eq("user_id", userId);
  const nameById = new Map(
    (deals ?? []).map((d) => [d.id as string, String(d.company_name ?? "Unknown")])
  );
  const { data: assRows } = await admin
    .from("deal_pipeline_json_core_assumptions")
    .select("deal_id, core_assumption_json")
    .in("deal_id", peerDealIds);
  const out: Array<{ company_name: string; excerpt: string }> = [];
  for (const row of assRows ?? []) {
    const did = row.deal_id as string;
    const json = row.core_assumption_json as Record<string, unknown> | null;
    if (!json) continue;
    const ca = Array.isArray(json.critical_assumptions) ? json.critical_assumptions : [];
    const first = typeof ca[0] === "string" ? ca[0] : "";
    const linchObj =
      json.the_linchpin_assumption && typeof json.the_linchpin_assumption === "object"
        ? (json.the_linchpin_assumption as Record<string, unknown>)
        : null;
    const linch =
      typeof linchObj?.description === "string" ? linchObj.description : "";
    const excerpt = [first, linch].filter(Boolean).join(" | ").slice(0, 1200);
    if (!excerpt) continue;
    out.push({ company_name: nameById.get(did) ?? "Unknown", excerpt });
  }
  return out;
}

/** Only the Phase 3C JSON fields the Problem summary prompt is allowed to see (V2-2). */
function jsonForProblemSummary(problem3C: Record<string, unknown>) {
  return {
    problem_analysis: problem3C.problem_analysis ?? null,
    customer_analysis: problem3C.customer_analysis ?? null,
    past_deal_comparisons: problem3C.past_deal_comparisons ?? null,
    scores: problem3C.scores ?? null,
    signal_interpretation: problem3C.signal_interpretation ?? null,
  };
}

/** Only the Phase 3D JSON fields the Solution summary prompt is allowed to see (V2-2). */
function jsonForSolutionSummary(solution3D: Record<string, unknown>) {
  return {
    solution_analysis: solution3D.solution_analysis ?? null,
    defensibility_signals: solution3D.defensibility_signals ?? null,
    past_deal_comparisons: solution3D.past_deal_comparisons ?? null,
    scores: solution3D.scores ?? null,
    signal_interpretation: solution3D.signal_interpretation ?? null,
  };
}

/** Traction agent JSON only (summary prompt must not receive unrelated phases). */
function jsonForTractionSummary(traction: Record<string, unknown>) {
  return {
    traction_evidence: traction.traction_evidence ?? null,
    inferred_context: traction.inferred_context ?? null,
    past_deal_comparisons: traction.past_deal_comparisons ?? null,
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
    assumption_comparisons: core.assumption_comparisons ?? null,
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
      getGeminiSummaryModel(),
      prompt,
      inputs
    )) as Record<string, unknown>;
    const summary = (result?.[resultKey] ?? result?.summary) as string | undefined;
    return typeof summary === "string" && summary.trim() ? summary.trim() : null;
  } catch {
    return null;
  }
}

export type SimilarPeersPipelineOpts = {
  admin: SupabaseClient;
  userId: string;
  /** Exclude current deal when re-running analysis on an existing deal. */
  excludeDealId?: string | null;
};

export async function runDealSourcingPipeline(
  pdfBuffer: Buffer,
  fundThesisStatement: string | null,
  onStep?: (step: DealSourcingPipelineStep) => Promise<void> | void,
  onPromptOutput?: (
    stepName: PromptOutputStepName,
    output: unknown,
    inputContext?: PromptRunInputContext | null
  ) => Promise<void> | void,
  similarPeersOpts?: SimilarPeersPipelineOpts | null
): Promise<DealSourcingResult> {
  const thesisText = fundThesisStatement?.trim() ?? "(No fund thesis provided.)";
  const perfStart = Date.now();
  const perfMs: Record<string, number> = {};
  const measure = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    const out = await fn();
    perfMs[label] = Date.now() - t0;
    return out;
  };

  // Phase 1: PDF parsing only (no Google Search); team[] is filled by resolve_founding_team next.
  const parsing_json = await measure("phase1_parsing", () =>
    runWithPdf(PROMPT_PHASE_1_PARSER, pdfBuffer, "flash_lite", false)
  );
  if (onPromptOutput) {
    await onPromptOutput("phase1_parsing", parsing_json, {
      peer_injection: { has_peer_bundle: false, section: "parsing" },
    });
  }
  if (onStep) await onStep("parse");
  let parsing = (parsing_json ?? {}) as Record<string, unknown>;
  const companyName = getCompanyName(parsing);

  parsing = normalizePhase1Parsing(parsing);
  if (!Array.isArray(parsing.team)) parsing.team = [];

  try {
    const foundingResolved = await measure("resolve_founding_team", () =>
      runWithTextMulti(
        PROMPT_RESOLVE_FOUNDING_TEAM,
        [
          { label: "company_name", value: companyName },
          { label: "phase1_company_overview", value: parsing.company_overview ?? null },
        ],
        "flash_lite",
        true
      )
    );
    if (onPromptOutput) {
      await onPromptOutput("resolve_founding_team", foundingResolved, {
        peer_injection: { has_peer_bundle: false, section: "parsing" },
      });
    }
    mergeResolvedFoundingTeamIntoParsing(parsing, foundingResolved);
  } catch (e) {
    console.warn("resolve_founding_team failed:", e);
    parsing.team = [];
  }

  // Cap / rank to two (CEO/CTO ordering) for Founder A loop and persistence.
  parsing.team = getTeamForFounderA(parsing)
    .slice(0, 2)
    .map((m) => ({
      name: m.name,
      role: m.role ?? null,
      leader_kind: m.leader_kind ?? null,
      title: m.title ?? null,
    }));

  let peerBundle: SimilarPeerBundleForPipeline | null = null;
  let retrievalProfile: DealRetrievalProfile | undefined;
  let retrievalEmbeddings:
    | {
        problem: number[];
        solution: number[];
        market: number[];
      }
    | undefined;
  if (similarPeersOpts) {
    try {
      retrievalProfile = await buildRetrievalProfileFromParsing(parsing);
      retrievalEmbeddings = await embedRetrievalProfile(retrievalProfile);
      await registerKeywordPhrases(similarPeersOpts.admin, [
        ...retrievalProfile.problem.search_concepts,
        ...retrievalProfile.solution.search_concepts,
      ]);
      peerBundle = await fetchSimilarPeerBundlesForPipeline(similarPeersOpts.admin, {
        userId: similarPeersOpts.userId,
        profile: retrievalProfile,
        queryEmbeddings: retrievalEmbeddings,
        parsing,
        excludeDealId: similarPeersOpts.excludeDealId ?? null,
      });
    } catch (e) {
      console.warn("similar peers retrieval skipped:", e);
    }
  }

  // Centralized per-section peer inputs so each agent gets a consistent slice.
  const peerInputsBySection = {
    thesis: labeledSimilarCompanyInputs(peerBundle, "thesis"),
    traction: labeledSimilarCompanyInputs(peerBundle, "traction"),
    problem: labeledSimilarCompanyInputs(peerBundle, "problem"),
    solution: labeledSimilarCompanyInputs(peerBundle, "solution"),
    assumptions: labeledSimilarCompanyInputs(peerBundle, "assumptions"),
  };

  const similarityBucket = (c: number): "HIGH" | "MED" | "LOW" => {
    if (!Number.isFinite(c)) return "LOW";
    if (c >= 0.66) return "HIGH";
    if (c >= 0.33) return "MED";
    return "LOW";
  };

  const buildPeerInputContext = (
    section: "thesis" | "traction" | "problem" | "solution" | "assumptions"
  ): PromptRunInputContext => {
    const b = peerBundle;
    const has = Boolean(b?.overall?.length);
    const overall = (b?.overall ?? []).map((p) => ({
      company_name: p.company_name,
      similarity_confidence: p.similarity_confidence,
      bucket: similarityBucket(p.similarity_confidence),
    }));
    const second =
      section === "thesis" || section === "traction"
        ? { label: "similar_companies_market_focused", peers: b?.market_focused ?? [] }
        : section === "problem"
          ? { label: "similar_companies_problem_focused", peers: b?.problem_focused ?? [] }
          : section === "solution"
            ? { label: "similar_companies_solution_focused", peers: b?.solution_focused ?? [] }
            : { label: "similar_companies_risk_focused", peers: b?.risk_focused ?? [] };
    const secondList = (second.peers ?? []).map((p) => ({
      company_name: p.company_name,
      similarity_confidence: p.similarity_confidence,
      bucket: similarityBucket(p.similarity_confidence),
    }));

    return {
      peer_injection: {
        has_peer_bundle: has,
        section,
        overall_top: overall.length ? overall : undefined,
        second_list_label: secondList.length ? second.label : undefined,
        second_list: secondList.length ? secondList : undefined,
      },
    };
  };

  // Phase 2: Thesis Agent (3.1 Flash Lite) — subset of Phase 1 JSON (V2-2).
  const startup_thesis_info = {
    company_overview: parsing.company_overview,
    traction: parsing.traction,
    fundraising: parsing.fundraising,
    market: parsing.market ?? null,
  };
  let investmentAgg: AggregatedRulesBySection | null = null;
  if (similarPeersOpts) {
    try {
      investmentAgg = await loadAggregatedRulesForUser(similarPeersOpts.admin, similarPeersOpts.userId);
    } catch (e) {
      console.warn("loadAggregatedRulesForUser:", e);
    }
  }

  // Traction inputs (needed in parallel with thesis — both depend only on Phase 1 + peers).
  const startup_traction_info = {
    company_overview: parsing.company_overview,
    traction: parsing.traction,
    fundraising: parsing.fundraising,
    market: parsing.market ?? null,
  };
  const deckInvestorNames = Array.from(
    new Set([
      ...extractInvestorNamesFromAny((parsing as Record<string, unknown>)?.fundraising),
      ...extractInvestorNamesFromAny((parsing as Record<string, unknown>)?.traction),
    ])
  );
  const tractionInvestorOverlapContext = computeInvestorOverlapSignals(
    deckInvestorNames,
    peerBundle?.overall ?? []
  );

  // Phase 3C / 3D inputs use only Phase 1 + peers + rules — no dependency on thesis or traction outputs.
  const parsed_startup_data_problem = {
    problem: parsing.problem ?? null,
    solution: parsing.solution ?? null,
    notable_claims: parsing.notable_claims ?? [],
    market: parsing.market ?? null,
    company_overview: parsing.company_overview ?? null,
    fundraising: parsing.fundraising ?? null,
  };
  const problem3cInputs: { label: string; value: unknown }[] = [
    ...peerInputsBySection.problem,
    { label: "parsed_startup_data", value: parsed_startup_data_problem },
    { label: "company_name", value: companyName },
  ];
  if (investmentAgg?.problem?.length) {
    problem3cInputs.push({ label: "investment_rules_context", value: investmentAgg.problem });
  }

  const parsed_startup_data_solution = {
    solution: parsing.solution ?? null,
    market: parsing.market ?? null,
    company_overview: parsing.company_overview ?? null,
    notable_claims: parsing.notable_claims ?? [],
  };
  const solution3dInputs: { label: string; value: unknown }[] = [
    { label: "parsed_startup_data", value: parsed_startup_data_solution },
    { label: "company_name", value: companyName },
    ...peerInputsBySection.solution,
  ];
  if (investmentAgg?.solution?.length) {
    solution3dInputs.push({ label: "investment_rules_context", value: investmentAgg.solution });
  }

  /** Thesis, traction, problem (3C), solution (3D) are mutually independent given Phase 1 + peers. */
  const [thesis_fit_json, traction_signal_json, problem_quality_3c_json, solution_defensibility_json] =
    await Promise.all([
      measure("phase2_thesis", () =>
        runWithTextMulti(
          PROMPT_PHASE_2_THESIS,
          [
            ...peerInputsBySection.thesis,
            { label: "fund_thesis_json", value: thesisText },
            { label: "startup_thesis_info", value: startup_thesis_info },
          ],
          "flash_lite",
          true
        )
      ),
      measure("traction_signals", () =>
        runWithTextMulti(
          PROMPT_TRACTION,
          [
            ...peerInputsBySection.traction,
            { label: "investor_overlap_context", value: tractionInvestorOverlapContext },
            { label: "startup_traction_info", value: startup_traction_info },
            { label: "company_name", value: companyName },
          ],
          "flash_lite",
          true
        )
      ),
      measure("phase3c_problem", () =>
        runWithTextMulti(PROMPT_PHASE_3C_PROBLEM, problem3cInputs, "flash", true)
      ),
      measure("phase3d_solution", () =>
        runWithTextMulti(PROMPT_PHASE_3D_SOLUTION, solution3dInputs, "flash", true)
      ),
    ]);

  if (onPromptOutput) await onPromptOutput("phase2_thesis", thesis_fit_json, buildPeerInputContext("thesis"));
  if (onStep) await onStep("thesis");
  if (onPromptOutput) await onPromptOutput("traction_signals", traction_signal_json, buildPeerInputContext("traction"));
  if (onStep) await onStep("traction");
  if (onPromptOutput) await onPromptOutput("phase3c_problem", problem_quality_3c_json, buildPeerInputContext("problem"));
  if (onStep) await onStep("problem");
  if (onPromptOutput) await onPromptOutput("phase3d_solution", solution_defensibility_json, buildPeerInputContext("solution"));
  if (onStep) await onStep("solution");

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

  const autoRejectFlagFromModel =
    typeof (thesisFit?.auto_reject_flag as unknown) === "boolean"
      ? (thesisFit.auto_reject_flag as boolean)
      : false;
  const anyScoreTooLow = scores.some((s) => s <= 3);
  const thesis_auto_reject = autoRejectFlagFromModel || anyScoreTooLow;

  const tractionSignal = traction_signal_json as Record<string, unknown>;
  const tractionEvidence =
    tractionSignal.traction_evidence && typeof tractionSignal.traction_evidence === "object"
      ? (tractionSignal.traction_evidence as Record<string, unknown>)
      : {};
  const detectedMetrics =
    tractionEvidence.detected_metrics && typeof tractionEvidence.detected_metrics === "object"
      ? (tractionEvidence.detected_metrics as Record<string, unknown>)
      : {};

  // Keep traction metric sections populated even when web grounding is sparse.
  const metricHints: string[] = [];
  const pushHint = (v: unknown, label: string) => {
    if (typeof v === "string" && v.trim()) metricHints.push(`${label}: ${v.trim()}`);
    else if (typeof v === "number" && Number.isFinite(v)) metricHints.push(`${label}: ${v}`);
  };
  const parsingTraction = (parsing.traction as Record<string, unknown> | undefined) ?? {};
  const parsingFundraising = (parsing.fundraising as Record<string, unknown> | undefined) ?? {};
  pushHint(parsingTraction.revenue, "Revenue");
  pushHint(parsingTraction.arr, "ARR");
  pushHint(parsingTraction.growth_rate, "Growth");
  pushHint(parsingFundraising.raising_amount, "Raise");
  if (!detectedMetrics.revenue_data && metricHints.length > 0) {
    detectedMetrics.revenue_data = metricHints.join(" | ");
  } else if (!detectedMetrics.revenue_data) {
    detectedMetrics.revenue_data = "Not publicly disclosed; no reliable ARR/revenue found.";
  }

  // Ensure investor list appears when known from deck parsing / overlap signals.
  const existingInvestors = extractInvestorNamesFromAny(tractionEvidence.investor_list);
  const overlapInvestors = tractionInvestorOverlapContext.map((s) => s.investor_name).filter(Boolean);
  const fallbackInvestors = Array.from(new Set([...existingInvestors, ...deckInvestorNames, ...overlapInvestors]));
  if (!Array.isArray(tractionEvidence.investor_list) || fallbackInvestors.length > existingInvestors.length) {
    tractionEvidence.investor_list = fallbackInvestors.slice(0, 20);
  }
  if (!tractionEvidence.detected_metrics || typeof tractionEvidence.detected_metrics !== "object") {
    tractionEvidence.detected_metrics = detectedMetrics;
  }
  tractionSignal.traction_evidence = tractionEvidence;

  const traction_signal_score = avgScore(tractionSignal, [
    "traction_strength_score",
    "growth_acceleration_score",
    "stage_adjusted_signal_score",
  ]);

  const problem3C = problem_quality_3c_json as Record<string, unknown>;
  const problem_quality_score = avgScore(
    (problem3C?.scores as Record<string, unknown>) ?? null,
    ["pain_severity_score", "buyer_authority_score", "structural_tailwinds_score", "venture_scale_plausibility"]
  );

  const solution3D = solution_defensibility_json as Record<string, unknown>;
  const solution_defensibility_score = avgScore(
    (solution3D?.scores as Record<string, unknown>) ?? null,
    ["10x_improvement_plausibility", "defensibility_potential", "competitive_edge_score"]
  );

  const emptyInjectionMap: InjectionMapResult = {
    problem_injection: "",
    solution_injection: "",
    founder_injection: "",
    founder_cross_context: "",
  };

  const parseOrRepairClaims = async (rawText: string): Promise<Record<string, unknown>> => {
    try {
      const parsed = parseJsonFromResponse(rawText);
      return (parsed ?? {}) as Record<string, unknown>;
    } catch {
      const repaired = await runWithTextMulti(
        PROMPT_REPAIR_CLAIMS_JSON,
        [{ label: "raw_claims_text", value: rawText }],
        "flash",
        false
      );
      return (repaired ?? {}) as Record<string, unknown>;
    }
  };

  /** Injection map (for founder prompts) vs claims extract — both depend only on 3C/3D/traction, not each other. */
  const [injectionMap, [claims_problem_raw, claims_solution_raw, claims_traction_raw]] = await Promise.all([
    (async (): Promise<InjectionMapResult> => {
      if (similarPeersOpts && investmentAgg) {
        const marketSnippet = JSON.stringify(parsing.market ?? null).slice(0, 4000);
        const problemSnippet = JSON.stringify(problem3C ?? null).slice(0, 8000);
        const solSnippet = JSON.stringify(solution3D ?? null).slice(0, 8000);
        return runInvestmentRulesInjectionMap({
          aggregated: investmentAgg,
          phase1MarketSnippet: marketSnippet,
          problemSignalSnippet: problemSnippet,
          solutionSignalSnippet: solSnippet,
        });
      }
      return emptyInjectionMap;
    })(),
    measure("claims_extract_parallel", async () => {
      const safe = async (run: () => Promise<string>) => {
        try {
          const raw = await run();
          return await parseOrRepairClaims(raw);
        } catch (e) {
          console.warn("claims_extract failed (non-fatal):", e);
          return { claims: [] };
        }
      };
      return Promise.all([
        safe(() =>
          runWithTextMultiRaw(
            PROMPT_CLAIMS_PROBLEM,
            [
              { label: "problem_json", value: problem3C ?? null },
              { label: "company_name", value: companyName },
            ],
            "flash",
            false
          )
        ),
        safe(() =>
          runWithTextMultiRaw(
            PROMPT_CLAIMS_SOLUTION,
            [
              { label: "solution_json", value: solution3D ?? null },
              { label: "company_name", value: companyName },
            ],
            "flash",
            false
          )
        ),
        safe(() =>
          runWithTextMultiRaw(
            PROMPT_CLAIMS_TRACTION,
            [
              { label: "traction_json", value: tractionSignal ?? null },
              { label: "company_name", value: companyName },
            ],
            "flash",
            false
          )
        ),
      ]);
    }),
  ]);

  const founderCriteriaSuffix = formatFounderInvestmentCriteriaSuffix(investmentAgg, injectionMap);

  const teamMembers = getTeamForFounderA(parsing);
  const teamArray = parsing.team;
  const perFounderResults: unknown[] = await measure("founder_signal_a_parallel", () =>
    Promise.all(
      teamMembers.map(async (member) => {
        const prompt = getFounderAPrompt(member.name, companyName, founderCriteriaSuffix);
        const deckMember = getDeckTeamMemberForFounder(teamArray, member.name);
        return runWithTextMulti(
          prompt,
          [
            {
              label: "deck_founder_context_from_phase1_json",
              value: deckMember ?? { note: "No matching team row in Phase 1 parse for this founder name" },
            },
          ],
          "flash_lite",
          true
        );
      })
    )
  );

  const founderBCheck = await measure("founder_signal_b", () =>
    runWithTextMulti(
      getFounderBPrompt(companyName, founderCriteriaSuffix),
      [{ label: "team_roster_from_phase1_deck_json", value: Array.isArray(teamArray) ? teamArray : [] }],
      "flash_lite",
      true
    )
  );
  const founderB = founderBCheck as Record<string, unknown>;
  const founder_signal_json = {
    per_founder: perFounderResults,
    collective: founderBCheck,
  };
  if (onPromptOutput) {
    await onPromptOutput("founder_signals", founder_signal_json, {
      peer_injection: { has_peer_bundle: Boolean(peerBundle?.overall?.length), section: "summary" },
    });
  }

  const founder_signal_score = avgScore(
    (founderB?.scores as Record<string, unknown>) ?? null,
    ["asymmetric_talent_score", "insight_edge_score", "recruiting_magnetism_proxy"]
  );
  if (onStep) await onStep("founder");

  const mergedClaims = [
    ...(Array.isArray((claims_problem_raw as any)?.claims) ? ((claims_problem_raw as any).claims as unknown[]) : []),
    ...(Array.isArray((claims_solution_raw as any)?.claims) ? ((claims_solution_raw as any).claims as unknown[]) : []),
    ...(Array.isArray((claims_traction_raw as any)?.claims) ? ((claims_traction_raw as any).claims as unknown[]) : []),
  ]
    .map(normalizeClaim)
    .filter((c): c is NonNullable<ReturnType<typeof normalizeClaim>> => Boolean(c));

  let embeddedClaims: EmbeddedClaim[] = [];
  let claimClusters: ClaimCluster[] = [];
  let questions_contradictions_json: unknown = { contradictions: [] };
  try {
    embeddedClaims = await measure("claims_embed", () => embedClaims(mergedClaims));
    claimClusters = clusterClaimsOffline({ embedded: embeddedClaims });
    const clustersForPrompt = claimClusters
      .filter((c) => {
        const sources = new Set(c.claims.map((x) => x.source));
        return sources.size >= 2;
      })
      .map((c, idx) => ({
        cluster_label: `cluster_${idx}`,
        medoid: c.claims[c.medoid_index] ?? null,
        claims: c.claims.map((x) => ({
          subject: x.subject,
          predicate: x.predicate,
          object: x.object,
          source: x.source,
          confidence: x.confidence,
          evidence: x.evidence,
        })),
      }))
      .slice(0, 12);
    if (clustersForPrompt.length > 0) {
      questions_contradictions_json = await measure("questions_contradictions", () =>
        runWithTextMulti(
          PROMPT_QUESTIONS_CONTRADICTIONS,
          [{ label: "claim_clusters", value: clustersForPrompt }],
          "flash",
          false
        )
      );
    }
  } catch (e) {
    console.warn("claims/contradictions generation failed:", e);
  }

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

  const tractionInvestorNames = extractInvestorNamesFromAny(
    (tractionSignal?.traction_evidence as Record<string, unknown> | undefined)?.investor_list
  );
  const assumptionsInvestorOverlapContext = computeInvestorOverlapSignals(
    Array.from(new Set([...deckInvestorNames, ...tractionInvestorNames])),
    peerBundle?.overall ?? []
  );

  const peerIdsForAssumptionRag = (peerBundle?.overall ?? []).map((p) => p.deal_id).filter(Boolean);
  let assumption_rag_snippets: Array<{ company_name: string; excerpt: string }> = [];
  if (similarPeersOpts?.admin && peerIdsForAssumptionRag.length > 0) {
    try {
      assumption_rag_snippets = await fetchAssumptionRagSnippets(
        similarPeersOpts.admin,
        similarPeersOpts.userId,
        peerIdsForAssumptionRag
      );
    } catch (e) {
      console.warn("fetchAssumptionRagSnippets:", e);
    }
  }

  const draft_assumption_json = await measure("phase4_assumptions_draft", () =>
    runWithTextMulti(
      PROMPT_PHASE_4_ASSUMPTION_DRAFT,
      [
        { label: "investor_overlap_context", value: assumptionsInvestorOverlapContext },
        { label: "parsed_startup_data", value: parsing_json },
        { label: "thesis_fit_report", value: thesis_fit_json },
        { label: "core_signal_scores", value: core_signal_scores },
      ],
      "flash",
      true
    )
  );

  const merged_assumption_json = await measure("phase4_assumptions_merge", () =>
    runWithTextMulti(
      PROMPT_PHASE_4_ASSUMPTION_MERGE,
      [
        ...peerInputsBySection.assumptions,
        { label: "draft_assumption_json", value: draft_assumption_json },
        { label: "assumption_rag_snippets", value: assumption_rag_snippets },
        { label: "investor_overlap_context", value: assumptionsInvestorOverlapContext },
        { label: "parsed_startup_data", value: parsing_json },
        { label: "thesis_fit_report", value: thesis_fit_json },
        { label: "core_signal_scores", value: core_signal_scores },
      ],
      "flash",
      true
    )
  );

  const assumptionPeerOrRagContext =
    (peerBundle?.overall ?? []).length > 0 || assumption_rag_snippets.length > 0;

  let core_assumption_json: unknown;
  if (assumptionPeerOrRagContext) {
    if (onPromptOutput) {
      await onPromptOutput(
        "phase4_assumptions_merge",
        merged_assumption_json,
        buildPeerInputContext("assumptions")
      );
    }
    core_assumption_json = await measure("phase4_assumptions_validate", () =>
      runWithTextMulti(
        PROMPT_PHASE_4_ASSUMPTION_VALIDATE_INFERRED,
        [
          ...peerInputsBySection.assumptions,
          { label: "merged_assumption_json", value: merged_assumption_json },
          { label: "assumption_rag_snippets", value: assumption_rag_snippets },
          { label: "investor_overlap_context", value: assumptionsInvestorOverlapContext },
          { label: "parsed_startup_data", value: parsing_json },
          { label: "thesis_fit_report", value: thesis_fit_json },
          { label: "core_signal_scores", value: core_signal_scores },
        ],
        "flash",
        true
      )
    );
  } else {
    core_assumption_json = merged_assumption_json;
  }

  if (onPromptOutput) await onPromptOutput("phase4_assumptions", core_assumption_json, buildPeerInputContext("assumptions"));
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
    low_confidence_questions_json,
  ] = await measure("summaries_and_questions_parallel", () =>
    Promise.all([
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
      "flash",
      false
    ),
    runWithTextMulti(
      PROMPT_QUESTIONS_STRUCTURAL,
      [{ label: "parsed_assumptions_json", value: core_assumption_json }],
      "flash",
      false
    ),
    runWithTextMulti(
      PROMPT_QUESTIONS_LOW_CONF_EVIDENCE,
      [
        {
          label: "low_confidence_bundle",
          value: {
            founder: {
              signal_completeness:
                typeof founderB?.signal_completeness === "string" ? founderB.signal_completeness : null,
              scores: founderB?.scores ?? null,
            },
            traction: {
              signal_completeness:
                typeof tractionSignal?.signal_completeness === "string"
                  ? tractionSignal.signal_completeness
                  : null,
              scores: {
                traction_strength_score: tractionSignal?.traction_strength_score,
                growth_acceleration_score: tractionSignal?.growth_acceleration_score,
                stage_adjusted_signal_score: tractionSignal?.stage_adjusted_signal_score,
              },
              traction_evidence: tractionSignal?.traction_evidence ?? null,
            },
            problem: {
              signal_completeness:
                typeof (problem3C?.signal_interpretation as Record<string, unknown> | undefined)
                  ?.signal_completeness === "string"
                  ? ((problem3C?.signal_interpretation as Record<string, unknown>).signal_completeness as string)
                  : null,
              scores: problem3C?.scores ?? null,
              problem_analysis: problem3C?.problem_analysis ?? null,
              customer_analysis: problem3C?.customer_analysis ?? null,
            },
            solution: {
              signal_completeness:
                typeof (solution3D?.signal_interpretation as Record<string, unknown> | undefined)
                  ?.signal_completeness === "string"
                  ? ((solution3D?.signal_interpretation as Record<string, unknown>).signal_completeness as string)
                  : null,
              scores: solution3D?.scores ?? null,
              solution_analysis: solution3D?.solution_analysis ?? null,
              defensibility_signals: solution3D?.defensibility_signals ?? null,
            },
            assumptions: {
              core_assumption_json,
            },
          },
        },
      ],
      "flash",
      false
    ),
    ])
  );

  if (onPromptOutput) {
    const summaryCtx: PromptRunInputContext = {
      peer_injection: { has_peer_bundle: Boolean(peerBundle?.overall?.length), section: "summary" },
    };
    const qCtx: PromptRunInputContext = {
      peer_injection: { has_peer_bundle: Boolean(peerBundle?.overall?.length), section: "questions" },
    };
    await onPromptOutput("summary_founder", { human_capital_summary: founder_summary_text ?? "" }, summaryCtx);
    await onPromptOutput("summary_traction", { traction_summary: traction_summary_text ?? "" }, summaryCtx);
    await onPromptOutput("summary_problem", { problem_summary: problem_summary_text ?? "" }, summaryCtx);
    await onPromptOutput("summary_solution", { solution_summary: solution_summary_text ?? "" }, summaryCtx);
    await onPromptOutput("summary_assumptions", { risk_summary: assumptions_summary_text ?? "" }, summaryCtx);
    await onPromptOutput("questions_first_order", first_order_questions_json, qCtx);
    await onPromptOutput("questions_structural", structural_questions_json, qCtx);
    await onPromptOutput("questions_low_confidence", low_confidence_questions_json, qCtx);
    await onPromptOutput("questions_contradictions", questions_contradictions_json, qCtx);
  }

  if (onStep) await onStep("summaries");

  const pipeline_summaries = {
    founder: founder_summary_text ?? "",
    traction: traction_summary_text ?? "",
    problem: problem_summary_text ?? "",
    solution: solution_summary_text ?? "",
    assumptions: assumptions_summary_text ?? "",
  };
  perfMs.total_pipeline = Date.now() - perfStart;
  console.info("runDealSourcingPipeline timings(ms):", perfMs);

  // Composite score over 5 dimensions (no market phase in V2)
  const composite_score =
    (thesis_fit_score +
      founder_signal_score +
      traction_signal_score +
      problem_quality_score +
      solution_defensibility_score) /
    5;

  return {
    parsing_json: parsing,
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
    questions_low_confidence_json: low_confidence_questions_json,
    claims_json: {
      problem: claims_problem_raw,
      solution: claims_solution_raw,
      traction: claims_traction_raw,
      embedded: embeddedClaims,
      clusters: claimClusters,
    },
    questions_contradictions_json,
    questions_combined_json: {
      contradictions: (questions_contradictions_json as Record<string, unknown> | null)?.contradictions ?? [],
      assumption_inversions: first_order_questions_json ?? {},
      rag_questions: structural_questions_json ?? {},
      low_confidence_evidence:
        (low_confidence_questions_json as Record<string, unknown> | null)?.low_confidence_evidence ?? [],
      all_questions: (() => {
        const out: Array<{ type: string; question: string }> = [];
        const push = (type: string, q: unknown) => {
          if (typeof q === "string" && q.trim()) out.push({ type, question: q.trim() });
        };
        const toRec = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);

        const contra = (questions_contradictions_json as Record<string, unknown> | null)?.contradictions;
        if (Array.isArray(contra)) {
          for (const item of contra) push("contradiction", toRec(item)?.question);
        }

        const low = (low_confidence_questions_json as Record<string, unknown> | null)?.low_confidence_evidence;
        if (Array.isArray(low)) {
          for (const item of low) push("low_conf", toRec(item)?.question);
        }

        const first = toRec(first_order_questions_json);
        const interrogations = Array.isArray(first?.critical_assumption_interrogation)
          ? (first?.critical_assumption_interrogation as unknown[])
          : [];
        for (const item of interrogations) {
          const killers = toRec(toRec(item)?.killer_questions);
          push("inversion", killers?.evidence);
          push("inversion", killers?.behavioral_proof);
          push("inversion", killers?.failure_boundary);
          push("inversion", killers?.contradictory_signal);
        }
        const linch = toRec(first?.linchpin_questions);
        push("inversion", linch?.real_world_evidence);
        push("inversion", linch?.structural_dependency_test);
        push("inversion", linch?.market_contradiction);

        const structural = toRec(structural_questions_json);
        const dep = toRec(structural?.dependency_chain_questions);
        push("rag", dep?.weakest_link_verification);
        push("rag", dep?.unvalidated_step_check);
        push("rag", dep?.cascade_failure_test);
        const fm = Array.isArray(structural?.failure_mode_questions)
          ? (structural?.failure_mode_questions as unknown[])
          : [];
        const deltas = Array.isArray(structural?.conviction_delta_credibility_questions)
          ? (structural?.conviction_delta_credibility_questions as unknown[])
          : [];
        for (const q of [...fm, ...deltas]) push("rag", q);

        // De-dupe while preserving order.
        const seen = new Set<string>();
        return out.filter((x) => {
          const key = `${x.type}:${x.question}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      })(),
    },
    pipeline_summaries,
    thesis_fit_score,
    founder_signal_score,
    traction_signal_score,
    problem_quality_score,
    solution_defensibility_score,
    market_power_score: 0,
    composite_score,
    thesis_auto_reject,
    similar_peers_context: peerBundle?.overall.length ? peerBundle.overall : undefined,
    retrieval_profile_json: retrievalProfile,
    retrieval_embeddings_json: retrievalEmbeddings,
  };
}

