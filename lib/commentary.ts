/**
 * Evidence-rich aggregation for deal-sourcing pipeline (Phase 1–4).
 * Surfaces from-deck content, *_evidence fields, scores, signal_completeness, and summaries.
 * Supports legacy pipeline fields where present.
 */

export interface CommentaryInputs {
  parsing_json: Record<string, unknown> | null;
  problem_extraction_json?: Record<string, unknown> | null;
  solution_extraction_json?: Record<string, unknown> | null;
  problem_web_json?: Record<string, unknown> | null;
  solution_web_json?: Record<string, unknown> | null;
  founder_web_json?: Record<string, unknown> | null;
  metrics_web_json?: Record<string, unknown> | null;
  thesis_fit_json?: Record<string, unknown> | null;
  founder_signal_json?: Record<string, unknown> | null;
  traction_signal_json?: Record<string, unknown> | null;
  problem_quality_3c_json?: Record<string, unknown> | null;
  solution_defensibility_json?: Record<string, unknown> | null;
  market_power_json?: Record<string, unknown> | null;
  core_assumption_json?: Record<string, unknown> | null;
}

const SECTION_SEP = "\n\n";

function getStr(obj: Record<string, unknown> | null, key: string): string | null {
  if (!obj) return null;
  const v = obj[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function pickCompanyName(input: CommentaryInputs): string | null {
  const co = input.parsing_json?.company_overview as Record<string, unknown> | undefined;
  if (co && typeof co.company_name === "string" && co.company_name.trim()) return co.company_name.trim();
  return getStr(input.parsing_json, "company_name")
    ?? (input.problem_extraction_json ? getStr(input.problem_extraction_json, "company_name") : null)
    ?? (input.solution_extraction_json ? getStr(input.solution_extraction_json, "company_name") : null);
}

function arrOfStrings(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((s) => s.trim());
}

/** Format an evidence object: only non-null/non-empty; optional label map for keys. */
function formatEvidence(
  obj: Record<string, unknown> | null | undefined,
  keyLabels?: Record<string, string>
): string[] {
  if (!obj || typeof obj !== "object") return [];
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    const label = keyLabels?.[key] ?? key.replace(/_/g, " ");
    if (Array.isArray(value)) {
      const strs = arrOfStrings(value);
      if (strs.length > 0) lines.push(`${label}: ${strs.join("; ")}`);
    } else if (typeof value === "boolean") {
      lines.push(`${label}: ${value ? "Yes" : "No"}`);
    } else if (typeof value === "string" && value.trim()) {
      lines.push(`${label}: ${value.trim()}`);
    } else if (typeof value === "number") {
      lines.push(`${label}: ${value}`);
    }
  }
  return lines;
}

/** Format nested evidence objects (e.g. TAM_evidence, winner_take_most_evidence). */
function formatNestedEvidence(
  parent: Record<string, unknown> | null | undefined,
  keys: string[],
  keyLabels?: Record<string, string>
): string[] {
  if (!parent) return [];
  const out: string[] = [];
  for (const key of keys) {
    const child = parent[key];
    if (child && typeof child === "object" && !Array.isArray(child)) {
      const label = keyLabels?.[key] ?? key.replace(/_/g, " ");
      const lines = formatEvidence(child as Record<string, unknown>, keyLabels);
      if (lines.length > 0) out.push(`${label}\n${lines.map((l) => "  " + l).join("\n")}`);
    }
  }
  return out;
}

function scoresLine(obj: Record<string, unknown> | null | undefined, keys: string[]): string | null {
  if (!obj) return null;
  const parts: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && !Number.isNaN(v)) parts.push(`${k.replace(/_/g, " ")}: ${v}`);
    else if (typeof v === "string") {
      const n = parseFloat(v);
      if (!Number.isNaN(n)) parts.push(`${k.replace(/_/g, " ")}: ${n}`);
    }
  }
  const completeness = getStr(obj, "signal_completeness");
  if (completeness) parts.push(`Completeness: ${completeness}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

// ——— Problem ———
function buildProblem(input: CommentaryInputs, out: string[]) {
  const company = pickCompanyName(input);
  const problemObj = input.parsing_json?.problem as Record<string, unknown> | undefined;
  const summary = problemObj ? getStr(problemObj, "problem_statement") : getStr(input.problem_extraction_json ?? null, "summary_problem");
  const targetCustomer = problemObj ? getStr(problemObj, "target_customer") : null;
  const painPoints = problemObj ? arrOfStrings(problemObj.pain_points) : [];

  const fromDeck: string[] = [];
  if (company) fromDeck.push(company);
  if (summary) fromDeck.push(summary);
  if (targetCustomer) fromDeck.push(`Target customer: ${targetCustomer}`);
  if (painPoints.length > 0) fromDeck.push("Pain points: " + painPoints.join("; "));
  if (fromDeck.length > 0) out.push("Problem (from deck)\n" + fromDeck.join(" "));

  const p3 = input.problem_quality_3c_json as Record<string, unknown> | undefined;
  const ev = p3?.problem_evidence as Record<string, unknown> | undefined;
  if (ev) {
    const lines = formatEvidence(ev, {
      stated_problem_summary: "Stated problem summary",
      affected_customer_persona: "Affected customer persona",
      economic_impact_described: "Economic impact described",
      mission_critical_indicators: "Mission critical indicators",
      explicit_budget_owner_mentioned: "Explicit budget owner",
      frequency_indicators: "Frequency indicators",
      scope_of_affected_users_described: "Scope of affected users",
      expansion_or_upsell_potential_described: "Expansion/upsell potential",
    });
    if (lines.length > 0) out.push("Problem evidence\n" + lines.join("\n"));
  }
  const scoreStr = scoresLine(p3, ["pain_severity_score", "budget_signal_score", "recurrence_score", "buyer_clarity_score", "venture_plausibility_score"]);
  if (scoreStr) out.push("Problem scores\n" + scoreStr);
  const pSummary = getStr(p3 ?? null, "problem_quality_summary") ?? getStr(input.problem_web_json ?? null, "problem_quality_commentary");
  if (pSummary) out.push("Problem summary\n" + pSummary);
}

// ——— Solution ———
function buildSolution(input: CommentaryInputs, out: string[]) {
  const solutionObj = input.parsing_json?.solution as Record<string, unknown> | undefined;
  const summary = solutionObj ? getStr(solutionObj, "solution_summary") : getStr(input.solution_extraction_json ?? null, "summary_solution");
  const productType = solutionObj ? getStr(solutionObj, "product_type") : null;
  const coreFeatures = solutionObj ? arrOfStrings(solutionObj.core_features) : [];
  const differentiation = solutionObj ? arrOfStrings(solutionObj.claimed_differentiation) : [];

  const fromDeck: string[] = [];
  if (summary) fromDeck.push(summary);
  if (productType) fromDeck.push(`Product type: ${productType}`);
  if (coreFeatures.length > 0) fromDeck.push("Core features: " + coreFeatures.join("; "));
  if (differentiation.length > 0) fromDeck.push("Differentiation: " + differentiation.join("; "));
  if (fromDeck.length > 0) out.push("Solution (from deck)\n" + fromDeck.join(" "));

  const s3 = input.solution_defensibility_json as Record<string, unknown> | undefined;
  const ev = s3?.solution_evidence as Record<string, unknown> | undefined;
  if (ev) {
    const lines = formatEvidence(ev, {
      stated_solution_summary: "Stated solution summary",
      core_technology_or_approach: "Core technology/approach",
      claimed_improvement_over_alternatives: "Claimed improvement over alternatives",
      identified_competitors: "Identified competitors",
      differentiation_claims_stated: "Differentiation claims",
      ip_or_proprietary_assets_detected: "IP/proprietary assets",
      network_effect_indicators: "Network effect indicators",
      data_advantage_indicators: "Data advantage indicators",
      regulatory_or_structural_barriers: "Regulatory/structural barriers",
      switching_cost_indicators: "Switching cost indicators",
      distribution_advantages_detected: "Distribution advantages",
    });
    if (lines.length > 0) out.push("Solution evidence\n" + lines.join("\n"));
  }
  const scoreStr = scoresLine(s3, ["10x_improvement_plausibility", "defensibility_potential", "moat_compounding_potential", "differentiation_clarity"]);
  if (scoreStr) out.push("Solution scores\n" + scoreStr);
  const sSummary = getStr(s3 ?? null, "solution_summary") ?? getStr(input.solution_web_json ?? null, "solution_quality_commentary");
  if (sSummary) out.push("Solution summary\n" + sSummary);
}

// ——— Founder / team ———
function buildTeam(input: CommentaryInputs, out: string[]) {
  const parsing = input.parsing_json;
  const teamVal = parsing?.["team"] ?? parsing?.["team_members"];
  if (Array.isArray(teamVal) && teamVal.length > 0) {
    const memberLines = teamVal.slice(0, 8).map((mRaw) => {
      const m = mRaw as Record<string, unknown>;
      const name = typeof m.name === "string" ? m.name : getStr(m, "name") ?? "Unknown";
      const role = getStr(m, "role");
      const background = getStr(m, "background_summary");
      let line = role ? `${name} (${role})` : name;
      if (background) line += ` — ${background}`;
      return line;
    });
    out.push("Founder / team (from deck)\n" + memberLines.join("\n"));
  }

  const f3 = input.founder_signal_json as Record<string, unknown> | undefined;
  const ev = f3?.founder_evidence as Record<string, unknown> | undefined;
  if (ev) {
    const lines = formatEvidence(ev, {
      founder_names: "Founder names",
      prior_exits_detected: "Prior exits detected",
      elite_institutions_detected: "Elite institutions",
      notable_companies_detected: "Notable companies",
      technical_credentials_detected: "Technical credentials",
      awards_or_distinctions_detected: "Awards/distinctions",
      repeat_founder_flag: "Repeat founder",
      industry_recognition_signals: "Industry recognition",
      recruiting_signals_detected: "Recruiting signals",
    });
    if (lines.length > 0) out.push("Founder evidence\n" + lines.join("\n"));
  }
  const insightSignals = f3 ? arrOfStrings(f3.insight_edge_signals) : [];
  if (insightSignals.length > 0) out.push("Insight edge signals\n" + insightSignals.map((s) => "• " + s).join("\n"));
  const scoreStr = scoresLine(f3, ["asymmetric_talent_score", "insight_edge_score", "recruiting_magnetism_proxy"]);
  if (scoreStr) out.push("Founder scores\n" + scoreStr);
  const fSummary = getStr(f3 ?? null, "founder_signal_summary") ?? getStr(input.founder_web_json ?? null, "founder_team_quality_commentary");
  if (fSummary) out.push("Founder summary\n" + fSummary);
}

// ——— Traction ———
function buildTraction(input: CommentaryInputs, out: string[]) {
  const parsing = input.parsing_json;
  const tractionVal = parsing?.traction as Record<string, unknown> | undefined;
  const fundVal = parsing?.fundraising as Record<string, unknown> | undefined;
  const metricsVal = (parsing?.metrics ?? tractionVal) as Record<string, unknown> | undefined;

  const fromDeck: string[] = [];
  const add = (o: Record<string, unknown> | undefined, label: string, key: string) => {
    if (!o) return;
    const v = o[key];
    if (v != null && typeof v === "string" && v.trim()) fromDeck.push(`${label}: ${v.trim()}`);
    else if (v != null && typeof v === "number") fromDeck.push(`${label}: ${v}`);
  };
  if (metricsVal) {
    add(metricsVal, "Revenue", "revenue");
    add(metricsVal, "ARR", "arr");
    add(metricsVal, "Growth rate", "growth_rate");
    add(metricsVal, "Customers", "customers");
    add(metricsVal, "Active users", "active_users");
    add(metricsVal, "Retention/churn", "retention_or_churn");
    const logos = arrOfStrings(metricsVal.notable_logos);
    if (logos.length > 0) fromDeck.push("Notable logos: " + logos.join(", "));
    const partner = arrOfStrings(metricsVal.partnerships);
    if (partner.length > 0) fromDeck.push("Partnerships: " + partner.join(", "));
  }
  if (fundVal) {
    add(fundVal, "Raising", "raising_amount");
    add(fundVal, "Round", "round_type");
    add(fundVal, "Valuation", "valuation");
    const useOfFunds = arrOfStrings(fundVal.use_of_funds);
    if (useOfFunds.length > 0) fromDeck.push("Use of funds: " + useOfFunds.join("; "));
  }
  if (fromDeck.length > 0) out.push("Traction (from deck)\n" + fromDeck.join(" · "));

  const t3 = input.traction_signal_json as Record<string, unknown> | undefined;
  const ev = t3?.traction_evidence as Record<string, unknown> | undefined;
  if (ev) {
    const lines = formatEvidence(ev, {
      reported_arr: "Reported ARR",
      reported_revenue_growth_rate: "Revenue growth rate",
      customer_count: "Customer count",
      user_count: "User count",
      retention_metrics: "Retention metrics",
      expansion_revenue_signals: "Expansion revenue signals",
      notable_customers_or_logos: "Notable customers/logos",
      public_announcements_detected: "Public announcements",
      funding_stage_detected: "Funding stage detected",
      funding_history_detected: "Funding history",
    });
    if (lines.length > 0) out.push("Traction evidence\n" + lines.join("\n"));
  }
  const inf = t3?.inferred_context as Record<string, unknown> | undefined;
  if (inf) {
    const infLines = formatEvidence(inf, {
      estimated_stage_if_missing: "Estimated stage (if missing)",
      stage_assumption_used_for_scoring: "Stage assumption for scoring",
      benchmark_comparison_note: "Benchmark comparison",
    });
    if (infLines.length > 0) out.push("Inferred context\n" + infLines.join("\n"));
  }
  const scoreStr = scoresLine(t3, ["traction_strength_score", "growth_acceleration_score", "stage_adjusted_signal_score"]);
  if (scoreStr) out.push("Traction scores\n" + scoreStr);
  const tSummary = getStr(t3 ?? null, "signal_summary") ?? getStr(input.metrics_web_json ?? null, "metrics_quality_commentary");
  if (tSummary) out.push("Traction summary\n" + tSummary);
}

// ——— Thesis fit ———
function buildThesis(input: CommentaryInputs, out: string[]) {
  const t2 = input.thesis_fit_json as Record<string, unknown> | undefined;
  if (!t2) return;
  const scoreStr = scoresLine(t2, ["sector_fit_score", "stage_fit_score", "geo_fit_score", "check_size_fit_score"]);
  if (scoreStr) out.push("Thesis fit scores\n" + scoreStr);
  const reasoning = getStr(t2, "thesis_alignment_reasoning");
  if (reasoning) out.push("Thesis fit reasoning\n" + reasoning);
}

// ——— Market ———
function buildMarket(input: CommentaryInputs, out: string[]) {
  const marketObj = input.parsing_json?.market as Record<string, unknown> | undefined;
  const fromDeck: string[] = [];
  if (marketObj) {
    const tam = getStr(marketObj, "tam_claim");
    const sam = getStr(marketObj, "sam_claim");
    const som = getStr(marketObj, "som_claim");
    const growth = arrOfStrings(marketObj.market_growth_claims);
    if (tam) fromDeck.push(`TAM: ${tam}`);
    if (sam) fromDeck.push(`SAM: ${sam}`);
    if (som) fromDeck.push(`SOM: ${som}`);
    if (growth.length > 0) fromDeck.push("Growth claims: " + growth.join("; "));
  }
  if (fromDeck.length > 0) out.push("Market (from deck)\n" + fromDeck.join(" · "));

  const m3 = input.market_power_json as Record<string, unknown> | undefined;
  if (m3) {
    const nested = formatNestedEvidence(m3, [
      "TAM_evidence", "winner_take_most_evidence", "structural_tailwinds_evidence",
      "market_fragmentation_evidence", "venture_scale_evidence",
    ], {
      TAM_evidence: "TAM evidence",
      winner_take_most_evidence: "Winner-take-most evidence",
      structural_tailwinds_evidence: "Structural tailwinds evidence",
      market_fragmentation_evidence: "Market fragmentation evidence",
      venture_scale_evidence: "Venture scale evidence",
    });
    if (nested.length > 0) out.push("Market evidence\n" + nested.join("\n\n"));
  }
  const scoreStr = scoresLine(m3, [
    "TAM_plausibility_score", "winner_take_most_potential", "structural_tailwinds_score",
    "market_fragmentation_score", "venture_scale_probability_estimate",
  ]);
  if (scoreStr) out.push("Market scores\n" + scoreStr);
  const mSummary = getStr(m3 ?? null, "market_power_summary");
  if (mSummary) out.push("Market summary\n" + mSummary);
}

// ——— Core assumptions ———
function buildCoreAssumptions(input: CommentaryInputs, out: string[]) {
  const core = input.core_assumption_json as Record<string, unknown> | null | undefined;
  if (!core) return;
  const assumptions = arrOfStrings(core.core_assumptions);
  if (assumptions.length > 0) out.push("Core assumptions\n" + assumptions.map((a) => "• " + a).join("\n"));
  const dominant = getStr(core, "dominant_fragile_assumption");
  if (dominant) out.push("Dominant fragile assumption\n" + dominant);
  const fragility = core.fragility_score;
  const dependency = core.dependency_score;
  if (typeof fragility === "number" || typeof dependency === "number") {
    const parts: string[] = [];
    if (typeof fragility === "number") parts.push(`Fragility: ${fragility}`);
    if (typeof dependency === "number") parts.push(`Dependency: ${dependency}`);
    out.push("Assumption scores\n" + parts.join(" · "));
  }
  const failure = getStr(core, "failure_mode_summary");
  if (failure) out.push("Failure mode\n" + failure);
}

// ——— Sources ———
function collectSources(obj: Record<string, unknown> | null): string[] {
  if (!obj) return [];
  const raw = obj["sources"];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.trim()) out.push(entry.trim());
    else if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      const title = getStr(e, "title");
      const url = getStr(e, "url") ?? getStr(e, "link");
      if (title && url) out.push(`${title} - ${url}`);
      else if (url) out.push(url);
      else if (title) out.push(title);
    }
  }
  return out;
}

export function aggregateCommentary(input: CommentaryInputs): string {
  const out: string[] = [];
  buildProblem(input, out);
  buildSolution(input, out);
  buildTeam(input, out);
  buildTraction(input, out);
  buildThesis(input, out);
  buildMarket(input, out);
  buildCoreAssumptions(input, out);

  const sources = [
    ...collectSources(input.problem_web_json ?? null),
    ...collectSources(input.solution_web_json ?? null),
    ...collectSources(input.founder_web_json ?? null),
    ...collectSources(input.metrics_web_json ?? null),
  ];
  const unique = Array.from(new Set(sources)).slice(0, 15);
  if (unique.length > 0) out.push("Sources\n" + unique.map((s) => "- " + s).join("\n"));

  return out.join(SECTION_SEP);
}

/** Character count for card preview; full text is on the analysis page. */
export const PREVIEW_CHARS = 520;

/** Return a short preview of the full analysis for the card (truncate + "… View full analysis" is shown via UI). */
export function getAnalysisPreview(fullAnalysis: string, maxChars: number = PREVIEW_CHARS): string {
  if (!fullAnalysis.trim()) return "";
  const trimmed = fullAnalysis.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars).trim();
}
