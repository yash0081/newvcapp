import type { SupabaseClient } from "@supabase/supabase-js";
import type { DealSourcingResult } from "@/lib/deal-sourcing-pipeline";
import {
  snippetPartsFromMarkdownRawOutput,
  tractionHumanSummaryFromProfile,
  tractionSnippetFromDealTractionRow,
} from "@/lib/markdown-corpus-snippets";

/**
 * `supabase/seed-invested-companies.sql` stores markdown-derived company profiles in
 * `deal_analyses.raw_output` (company_name, problem_statement, solution, traction, founders, …)
 * — not a full DealSourcingResult. Map that into the shape `materializeDealContextFromPipeline` expects.
 */
function joinStringLines(arr: unknown): string | null {
  if (!Array.isArray(arr)) return null;
  return arr.map((x) => String(x)).join("\n");
}

function problemStatementFromMarkdownProfile(ps: unknown): string {
  if (typeof ps === "string") return ps;
  if (!ps || typeof ps !== "object") return "";
  const o = ps as Record<string, unknown>;
  const bits: string[] = [];
  for (const k of ["core_concept", "core_issue", "description"]) {
    if (typeof o[k] === "string") bits.push(o[k] as string);
  }
  const b1 = joinStringLines(o.key_barriers);
  const b2 = joinStringLines(o.barriers);
  if (b1) bits.push(b1);
  if (b2) bits.push(b2);
  return bits.join("\n\n").trim();
}

function solutionSummaryFromMarkdownProfile(sol: unknown): string {
  if (typeof sol === "string") return sol;
  if (!sol || typeof sol !== "object") return "";
  const o = sol as Record<string, unknown>;
  const bits: string[] = [];
  for (const k of ["primary_product", "architecture"]) {
    if (typeof o[k] === "string") bits.push(o[k] as string);
  }
  const feats = joinStringLines(o.key_features);
  if (feats) bits.push(feats);
  if (typeof o.value_proposition === "string") bits.push(o.value_proposition as string);
  return bits.join("\n\n").trim();
}

function sstr(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export type MarkdownCorpusSynthContext = {
  decision: string | null;
  dealProblem?: Record<string, unknown> | null;
  dealSolution?: Record<string, unknown> | null;
  dealTraction?: Record<string, unknown> | null;
  scoreByDimension?: Map<string, number>;
};

function inferIndustryLabel(problemOneLiner: string): string {
  const line = problemOneLiner.split(/\n/)[0]?.trim() || "General enterprise software";
  return line.length > 96 ? `${line.slice(0, 96)}…` : line;
}

function inferStageLabel(traction: unknown): string {
  if (!traction || typeof traction !== "object") return "Venture (stage per corpus)";
  const blob = JSON.stringify(traction);
  const m = blob.match(/Series\s+[A-Z0-9]+|Pre-Seed|Seed|Growth|IPO|Series\s+[A-Z]/i);
  return m ? m[0] : "Venture (stage per corpus)";
}

function inferFundingLabel(traction: unknown): string {
  if (!traction || typeof traction !== "object") return "Venture-backed (historical)";
  const o = traction as Record<string, unknown>;
  const fund = o.funding;
  if (fund && typeof fund === "object") {
    const f = fund as Record<string, unknown>;
    const bits = [
      typeof f.latest_round === "string" ? f.latest_round : null,
      typeof f.total_equity === "string" ? f.total_equity : null,
      typeof f.total_funding === "string" ? f.total_funding : null,
    ].filter((x): x is string => Boolean(x && x.trim()));
    if (bits.length) return bits.join(" · ");
  }
  if (typeof o.latest_round === "string" && o.latest_round.trim()) return o.latest_round.trim();
  if (typeof o.total_funding === "string" && o.total_funding.trim()) return o.total_funding.trim();
  return "Venture-backed (historical)";
}

function syntheticThesisFitJson(
  cn: string,
  decision: string | null,
  problemOneLiner: string,
  solutionOneLiner: string,
  traction: unknown,
  profile: Record<string, unknown>
): Record<string, unknown> {
  const dec = (decision ?? "").toLowerCase();
  const invested = dec === "invested";
  const passed = dec === "passed" || dec === "pass" || dec === "reject";
  const industryLabel = inferIndustryLabel(problemOneLiner);
  const stageLabel = inferStageLabel(traction);
  const fundLabel = inferFundingLabel(traction);
  const indScore = invested ? 8.2 : passed ? 3.8 : 6.0;
  const stageScore = invested ? 7.8 : passed ? 3.5 : 6.0;
  const fundScore = invested ? 8.0 : passed ? 3.6 : 6.0;

  let rejectionNote = "";
  const rej = profile.hypothetical_investment_rejection_reasoning;
  if (passed && rej && typeof rej === "object" && rej !== null) {
    const parts = Object.values(rej as Record<string, unknown>)
      .filter((x) => typeof x === "string" && String(x).trim().length > 0)
      .map((x) => String(x).trim().slice(0, 420));
    if (parts.length) {
      rejectionNote = `\n\nPass themes (corpus excerpt): ${parts.slice(0, 2).join(" ")}`;
    }
  }

  const p1 = problemOneLiner.slice(0, 900) + (problemOneLiner.length > 900 ? "…" : "");
  const s1 = solutionOneLiner.slice(0, 900) + (solutionOneLiner.length > 900 ? "…" : "");

  let reasoning: string;
  if (invested) {
    reasoning = [
      `${cn} — thesis fit (historical corpus, invested).`,
      `Problem (${industryLabel}): ${p1}`,
      `Solution direction: ${s1}`,
      `Institutional context: ${stageLabel} financing profile (${fundLabel}); team and milestones are consistent with a venture-scale wedge and repeatable GTM.`,
      `Why this cleared the bar at the time: clear buyer pain, differentiated product narrative versus incumbents, and execution depth we could underwrite at the seed mark.${rejectionNote}`,
    ].join("\n\n");
  } else if (passed) {
    reasoning = [
      `${cn} — thesis fit (historical corpus, passed).`,
      `Problem (${industryLabel}): ${p1}`,
      `Solution direction: ${s1}`,
      `At the time of the corpus record, upside was offset by mandate fit, timing, concentration, or regulatory/execution risk relative to our bar.${rejectionNote}`,
      `Revisit if traction, proof points, or market structure meaningfully improve versus the snapshot above.`,
    ].join("\n\n");
  } else {
    reasoning = [
      `${cn} — thematic review (no invest/pass label in corpus).`,
      `Problem: ${p1}`,
      `Solution: ${s1}`,
      `Stage / funding context: ${stageLabel}; ${fundLabel}.`,
    ].join("\n\n");
  }

  return {
    overall_thesis_alignment_reasoning: reasoning,
    fit_summary: invested
      ? `Strong fit — ${cn} is recorded as invested in the markdown corpus.`
      : passed
        ? `Weak fit — ${cn} is recorded as passed in the markdown corpus.`
        : `Neutral — ${cn} (no decision flag in corpus).`,
    industry_evaluation: { startup_industry: industryLabel, score: indScore },
    stage_evaluation: { stage: stageLabel, score: stageScore },
    funding_evaluation: { funding: fundLabel, score: fundScore },
  };
}

/** Merge markdown profile rows with synthetic pipeline blobs so `deal_analyses.raw_output` matches what the UI reads. */
export function mergeMarkdownProfileWithSyntheticPipeline(
  profile: Record<string, unknown>,
  synth: DealSourcingResult
): Record<string, unknown> {
  return {
    ...profile,
    parsing_json: synth.parsing_json,
    thesis_fit_json: synth.thesis_fit_json,
    founder_signal_json: synth.founder_signal_json,
    traction_signal_json: synth.traction_signal_json,
    problem_quality_3c_json: synth.problem_quality_3c_json,
    solution_defensibility_json: synth.solution_defensibility_json,
    market_power_json: synth.market_power_json,
    core_assumption_json: synth.core_assumption_json,
    questions_first_order_json: synth.questions_first_order_json,
    questions_structural_json: synth.questions_structural_json,
    pipeline_summaries: synth.pipeline_summaries,
  };
}

function syntheticQuestionsJson(cn: string): {
  first: Record<string, unknown>;
  structural: Record<string, unknown>;
} {
  return {
    first: {
      critical_assumption_interrogation: [
        {
          assumption: `Customers will pay and expand for ${cn}'s core wedge at venture-scale unit economics.`,
          killer_questions: {
            evidence: `What signed contracts or paid pilots prove budget and urgency for ${cn}?`,
            behavioral_proof: `What would we observe in customer usage that proves repeat, not one-off, adoption?`,
            failure_boundary: `At what ARR or retention threshold would you declare the GTM hypothesis failed?`,
            contradictory_signal: `What single metric trending wrong would force a strategy reset for ${cn}?`,
          },
        },
      ],
      linchpin_questions: {
        real_world_evidence: `What third-party or customer-attributable proof de-risks ${cn}'s main claim?`,
        structural_dependency_test: `Which single integration, partner, or regulatory dependency could stall ${cn} if it slips?`,
        market_contradiction: `What incumbent or substitute motion would make ${cn}'s wedge irrelevant in 18–24 months?`,
      },
    },
    structural: {
      dependency_chain_questions: {
        weakest_link_verification: `Which step in ${cn}'s delivery chain (data, compliance, distribution) is least proven?`,
        unvalidated_step_check: `What assumption in the sales or onboarding funnel has not been stress-tested at scale?`,
        cascade_failure_test: `If the primary acquisition channel degrades, what is the fallback path to quota?`,
      },
      failure_mode_questions: [
        `How does ${cn} lose to a well-funded incumbent copying the feature set?`,
        `What breaks first if hiring or roadmap slips by two quarters?`,
      ],
      conviction_delta_credibility_questions: [
        `What would increase conviction in ${cn} by two points on a 10-point scale in 90 days?`,
      ],
    },
  };
}

function normalizePerFounderWithFounderName(founders: unknown[]): unknown[] {
  return founders.map((f) => {
    if (!f || typeof f !== "object") return f;
    const x = f as Record<string, unknown>;
    const name = typeof x.name === "string" ? x.name.trim() : "";
    const fn = typeof x.founder_name === "string" ? x.founder_name.trim() : "";
    return { ...x, founder_name: fn || name || "Founder" };
  });
}

function buildFounderCollectiveNarrative(
  cn: string,
  founders: Record<string, unknown>[],
  foundingTeam: unknown,
  teamSummary: string
): string {
  const ft =
    foundingTeam && typeof foundingTeam === "object" && foundingTeam !== null
      ? (foundingTeam as Record<string, unknown>)
      : null;
  const expertise =
    (ft && typeof ft.key_expertise === "string" ? ft.key_expertise : null) ||
    (ft && typeof ft.specialization === "string" ? ft.specialization : null) ||
    "";
  const size =
    ft?.size != null
      ? String(ft.size)
      : ft && (ft as Record<string, unknown>).approximate_size != null
        ? String((ft as Record<string, unknown>).approximate_size)
        : "";
  const head = founders.length
    ? `The ${cn} team lists ${founders.length} named leaders with complementary operating and technical depth.`
    : `Team data for ${cn} is drawn from the historical corpus profile.`;
  const mid: string[] = [];
  if (size) mid.push(`Approximate team scale / focus: ${size}.`);
  if (expertise.trim()) {
    mid.push(
      `Collective expertise: ${expertise.slice(0, 620)}${expertise.length > 620 ? "…" : ""}`
    );
  }
  const diligence = `Diligence focus: verify prior operating scale (revenue / mandate), hiring velocity, domain-specific proof points, and cohesion between GTM and technical leads; cross-check claims against references and attributed public sources.`;
  const roster = teamSummary.trim() ? `Per-founder roster (summary):\n${teamSummary}` : "";
  return [head, mid.join(" "), roster, diligence].filter((s) => s && String(s).trim().length > 0).join("\n\n");
}

/** Exported for `scripts/generate-corpus-enrichment-sql.ts` — same shape as DB reconstruction for markdown corpus. */
export function syntheticResultFromMarkdownCompanyProfile(
  o: Record<string, unknown>,
  ctx?: MarkdownCorpusSynthContext | null
): DealSourcingResult | null {
  if (typeof o.company_name !== "string" || !o.company_name.trim()) return null;
  const hasProfileShape =
    o.problem_statement != null ||
    o.solution != null ||
    o.traction != null ||
    (Array.isArray(o.founders) && o.founders.length > 0);
  if (!hasProfileShape) return null;

  const cn = o.company_name.trim();
  const problemStatement = problemStatementFromMarkdownProfile(o.problem_statement);
  const solutionSummary = solutionSummaryFromMarkdownProfile(o.solution);
  if (!problemStatement && !solutionSummary && !o.traction) return null;

  const founders = Array.isArray(o.founders) ? o.founders : [];
  const perFounderNorm = normalizePerFounderWithFounderName(founders);

  const snippets = snippetPartsFromMarkdownRawOutput(o);
  const teamSummary =
    snippets.team ??
    founders
      .map((f) => {
        if (!f || typeof f !== "object") return "";
        const x = f as Record<string, unknown>;
        return [sstr(x.name), sstr(x.role), sstr(x.background)].filter(Boolean).join(" — ");
      })
      .filter(Boolean)
      .join("\n");

  const founderDeep = buildFounderCollectiveNarrative(
    cn,
    founders.filter((f): f is Record<string, unknown> => f != null && typeof f === "object") as Record<
      string,
      unknown
    >[],
    o.founding_team,
    teamSummary
  );

  const collective: Record<string, unknown> = {};
  if (o.founding_team != null) collective.founding_team = o.founding_team;
  if (founders.length) collective.founders = founders;
  collective.signal_interpretation = {
    founder_signal_summary: founderDeep,
    team_evidence: {
      high_bar_previous_employers: "Prior employers and titles are listed per founder in the corpus.",
      technical_authority_proof: "Technical authority inferred from roles and prior companies.",
      team_cohesion_signals:
        typeof o.founding_team === "object" && o.founding_team !== null
          ? String(
              (o.founding_team as Record<string, unknown>).key_expertise ??
                (o.founding_team as Record<string, unknown>).specialization ??
                ""
            ).slice(0, 400) || "See founding team narrative in corpus."
          : "See founding team narrative in corpus.",
    },
  };

  const dp = ctx?.dealProblem ?? null;
  const ds = ctx?.dealSolution ?? null;
  const dt = ctx?.dealTraction ?? null;

  const problem_quality_3c_json: Record<string, unknown> = {
    summary_text: sstr(dp?.problem_statement) ?? problemStatement,
    root_cause_depth: sstr(dp?.root_cause_depth) ?? problemStatement.split("\n")[0] ?? problemStatement,
    economic_gravity: sstr(dp?.economic_gravity) ?? problemStatement,
    structural_urgency: sstr(dp?.structural_urgency) ?? problemStatement,
    persona_clarity: sstr(dp?.persona_clarity) ?? null,
    stated_problem_ref: sstr(dp?.stated_problem_ref) ?? null,
    signal_completeness: sstr(dp?.signal_completeness) ?? "historical_seed",
  };

  const solution_defensibility_json: Record<string, unknown> = {
    summary_text: sstr(ds?.solution_summary) ?? solutionSummary,
    moat_type: sstr(ds?.moat_type) ?? null,
    replication_difficulty: sstr(ds?.replication_difficulty) ?? null,
    compounding_potential: sstr(ds?.compounding_potential) ?? null,
    technical_moat_evidence: sstr(ds?.technical_moat_evidence) ?? null,
    signal_completeness: sstr(ds?.signal_completeness) ?? "historical_seed",
  };

  const tractionFromRow = tractionSnippetFromDealTractionRow(dt ?? undefined);
  const tractionSummary =
    tractionFromRow ??
    snippets.traction ??
    tractionHumanSummaryFromProfile(o.traction) ??
    "";

  const traction_signal_json: Record<string, unknown> = {
    inferred_context:
      o.traction != null && typeof o.traction === "object"
        ? (o.traction as Record<string, unknown>)
        : {},
    summary_text: tractionSummary,
    signal_completeness: sstr(dt?.signal_completeness) ?? "historical_seed",
  };

  const decision = ctx?.decision ?? null;
  const thesis_fit_json = syntheticThesisFitJson(
    cn,
    decision,
    problemStatement,
    solutionSummary,
    o.traction,
    o
  );

  const assumptionsLines: string[] = [];
  if (Array.isArray(o.critical_assumptions)) {
    for (const a of o.critical_assumptions) {
      if (!a || typeof a !== "object") continue;
      const r = a as Record<string, unknown>;
      const t = sstr(r.must_be_true) ?? sstr(r.assumption_text);
      if (t) assumptionsLines.push(t);
    }
  }
  const assumptionsPreview =
    assumptionsLines.length > 0 ? assumptionsLines.join("\n\n") : `Key assumptions for ${cn} (historical corpus).`;

  const pipeline_summaries: NonNullable<DealSourcingResult["pipeline_summaries"]> = {
    problem: snippets.problem ?? problemStatement,
    solution: snippets.solution ?? solutionSummary,
    traction: tractionSummary,
    founder: teamSummary,
    assumptions: assumptionsPreview,
  };

  const founder_signal_json: DealSourcingResult["founder_signal_json"] = {
    per_founder: perFounderNorm as unknown[],
    collective,
    summary_text: teamSummary,
    founder_signal_summary: founderDeep,
  };

  const qSynth = syntheticQuestionsJson(cn);

  const core_assumption_json: Record<string, unknown> = (() => {
    const core: Record<string, unknown> = {
      the_linchpin_assumption: {},
      risk_dynamics: {},
      first_order_questions: qSynth.first,
      structural_auditor_questions: qSynth.structural,
    };
    if (Array.isArray(o.critical_assumptions)) {
      core.critical_assumptions = o.critical_assumptions;
    }
    const rej = o.hypothetical_investment_rejection_reasoning;
    if (rej && typeof rej === "object" && rej !== null) {
      const parts = Object.values(rej as Record<string, unknown>)
        .filter((x) => typeof x === "string" && String(x).trim().length > 0)
        .map((x) => String(x).trim());
      if (parts.length) {
        core.markdown_rejection_blob =
          `Historical pass / rejection reasoning (markdown corpus):\n\n${parts.join("\n\n")}`;
      }
    }
    return core;
  })();

  const nan = Number.NaN;
  const sm = ctx?.scoreByDimension;
  const pick = (d: string) => {
    const v = sm?.get(d);
    return typeof v === "number" && !Number.isNaN(v) ? v : nan;
  };
  const tf = pick("thesis_fit");
  const ff = pick("founder");
  const tr = pick("traction");
  const pr = pick("problem");
  const so = pick("solution");
  const hasScores = sm && [...sm.values()].some((x) => typeof x === "number" && !Number.isNaN(x));
  const composite = hasScores ? (tf + ff + tr + pr + so) / 5 : nan;

  return {
    parsing_json: {
      company_overview: { company_name: cn },
      problem: { problem_statement: problemStatement || `See company: ${cn}` },
      solution: { solution_summary: solutionSummary || "" },
    },
    thesis_fit_json,
    founder_signal_json,
    traction_signal_json,
    problem_quality_3c_json,
    solution_defensibility_json,
    market_power_json: null,
    core_assumption_json,
    questions_first_order_json: qSynth.first,
    questions_structural_json: qSynth.structural,
    pipeline_summaries,
    thesis_fit_score: tf,
    founder_signal_score: ff,
    traction_signal_score: tr,
    problem_quality_score: pr,
    solution_defensibility_score: so,
    market_power_score: nan,
    composite_score: composite,
  };
}

function num(v: unknown, fallback = 0): number {
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isNaN(n) ? fallback : n;
  }
  return fallback;
}

/**
 * Build a DealSourcingResult for backfill: prefer full `deal_analyses.raw_output`, else stitch pipeline JSON tables + deal_scores.
 */
export async function reconstructDealSourcingResultFromDb(
  admin: SupabaseClient,
  dealId: string,
  analysisId: string
): Promise<DealSourcingResult | null> {
  const { data: analysis } = await admin
    .from("deal_analyses")
    .select("raw_output")
    .eq("id", analysisId)
    .maybeSingle();

  const raw = analysis?.raw_output;
  if (raw && typeof raw === "object" && raw !== null) {
    const o = raw as Record<string, unknown>;
    const thesis = o.thesis_fit_json;
    const hasNonEmptyThesis =
      thesis != null &&
      typeof thesis === "object" &&
      Object.keys(thesis as object).length > 0;
    if (hasNonEmptyThesis) {
      return raw as DealSourcingResult;
    }
    const [{ data: dealRow }, { data: dp }, { data: ds }, { data: dtr }, { data: scRows }] =
      await Promise.all([
        admin.from("deals").select("decision").eq("id", dealId).maybeSingle(),
        admin.from("deal_problem").select("*").eq("analysis_id", analysisId).maybeSingle(),
        admin.from("deal_solution").select("*").eq("analysis_id", analysisId).maybeSingle(),
        admin.from("deal_traction").select("*").eq("analysis_id", analysisId).maybeSingle(),
        admin.from("deal_scores").select("dimension, raw_score").eq("analysis_id", analysisId),
      ]);
    const scoreMap = new Map<string, number>();
    for (const row of scRows ?? []) {
      const d = row.dimension as string;
      const rs = row.raw_score;
      if (typeof rs === "number" && !Number.isNaN(rs)) scoreMap.set(d, rs);
    }
    const fromMd = syntheticResultFromMarkdownCompanyProfile(o, {
      decision: (dealRow as { decision?: string | null } | null)?.decision ?? null,
      dealProblem: (dp as Record<string, unknown> | null) ?? null,
      dealSolution: (ds as Record<string, unknown> | null) ?? null,
      dealTraction: (dtr as Record<string, unknown> | null) ?? null,
      scoreByDimension: scoreMap.size > 0 ? scoreMap : undefined,
    });
    if (fromMd) return fromMd;
  }

  const [
    { data: parsing },
    { data: thesis },
    { data: founder },
    { data: traction },
    { data: p3c },
    { data: s3d },
    { data: market },
    { data: core },
    { data: scores },
  ] = await Promise.all([
    admin.from("deal_pipeline_json_parsing").select("parsing_json").eq("analysis_id", analysisId).maybeSingle(),
    admin.from("deal_pipeline_json_thesis_fit").select("thesis_fit_json").eq("analysis_id", analysisId).maybeSingle(),
    admin.from("deal_pipeline_json_founder_signals").select("founder_signal_json").eq("analysis_id", analysisId).maybeSingle(),
    admin.from("deal_pipeline_json_traction_signals").select("traction_signal_json").eq("analysis_id", analysisId).maybeSingle(),
    admin.from("deal_pipeline_json_problem_3c").select("problem_quality_3c_json").eq("analysis_id", analysisId).maybeSingle(),
    admin.from("deal_pipeline_json_solution_3d").select("solution_defensibility_json").eq("analysis_id", analysisId).maybeSingle(),
    admin.from("deal_pipeline_json_market_power").select("market_power_json").eq("analysis_id", analysisId).maybeSingle(),
    admin.from("deal_pipeline_json_core_assumptions").select("core_assumption_json").eq("analysis_id", analysisId).maybeSingle(),
    admin.from("deal_scores").select("dimension, raw_score").eq("analysis_id", analysisId),
  ]);

  if (!parsing?.parsing_json || typeof parsing.parsing_json !== "object") {
    return null;
  }

  const sm = new Map<string, number>();
  for (const row of scores ?? []) {
    sm.set(row.dimension as string, num(row.raw_score));
  }

  const founderJson = founder?.founder_signal_json;
  const founderNorm: DealSourcingResult["founder_signal_json"] =
    founderJson && typeof founderJson === "object" && founderJson !== null && "collective" in (founderJson as object)
      ? (founderJson as DealSourcingResult["founder_signal_json"])
      : { per_founder: [], collective: {} };

  const tf = num(sm.get("thesis_fit"));
  const ff = num(sm.get("founder"));
  const tr = num(sm.get("traction"));
  const pr = num(sm.get("problem"));
  const so = num(sm.get("solution"));

  return {
    parsing_json: parsing.parsing_json,
    thesis_fit_json: thesis?.thesis_fit_json ?? {},
    founder_signal_json: founderNorm,
    traction_signal_json: traction?.traction_signal_json ?? {},
    problem_quality_3c_json: p3c?.problem_quality_3c_json ?? {},
    solution_defensibility_json: s3d?.solution_defensibility_json ?? {},
    market_power_json: null,
    core_assumption_json: core?.core_assumption_json ?? {},
    questions_first_order_json: {},
    questions_structural_json: {},
    thesis_fit_score: tf,
    founder_signal_score: ff,
    traction_signal_score: tr,
    problem_quality_score: pr,
    solution_defensibility_score: so,
    market_power_score: 0,
    composite_score: (tf + ff + tr + pr + so) / 5,
  };
}
