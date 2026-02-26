/**
 * Aggregate analysis for the UI. Supports:
 * - Deal-sourcing pipeline (Phase 1–4): parsing_json, thesis_fit_json, founder_signal_json, etc.
 * - Legacy pipeline: parsing_json, problem_extraction_json, solution_extraction_json, *_web_json.
 *
 * Order: problem statement + commentary, solution + commentary, founder/team + commentary,
 * metrics/traction + commentary, thesis fit, market, core assumptions, sources.
 */

export interface CommentaryInputs {
  parsing_json: Record<string, unknown> | null;
  problem_extraction_json?: Record<string, unknown> | null;
  solution_extraction_json?: Record<string, unknown> | null;
  problem_web_json?: Record<string, unknown> | null;
  solution_web_json?: Record<string, unknown> | null;
  founder_web_json?: Record<string, unknown> | null;
  metrics_web_json?: Record<string, unknown> | null;
  // Deal-sourcing (Phase 2–4)
  thesis_fit_json?: Record<string, unknown> | null;
  founder_signal_json?: Record<string, unknown> | null;
  traction_signal_json?: Record<string, unknown> | null;
  problem_quality_3c_json?: Record<string, unknown> | null;
  solution_defensibility_json?: Record<string, unknown> | null;
  market_power_json?: Record<string, unknown> | null;
  core_assumption_json?: Record<string, unknown> | null;
}

function getStr(obj: Record<string, unknown> | null, key: string): string | null {
  if (!obj) return null;
  const v = obj[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function pickCompanyName(input: CommentaryInputs): string | null {
  const co = input.parsing_json?.company_overview as Record<string, unknown> | undefined;
  if (co && typeof co.company_name === "string" && co.company_name.trim()) return co.company_name.trim();
  const fromParsing = getStr(input.parsing_json, "company_name");
  if (fromParsing) return fromParsing;
  const fromProblem = input.problem_extraction_json ? getStr(input.problem_extraction_json, "company_name") : null;
  if (fromProblem) return fromProblem;
  const fromSolution = input.solution_extraction_json ? getStr(input.solution_extraction_json, "company_name") : null;
  if (fromSolution) return fromSolution;
  return null;
}

function arrOfStrings(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((s) => s.trim());
}

function buildProblemSection(input: CommentaryInputs, paragraphs: string[]) {
  const company = pickCompanyName(input);
  const problemObj = input.parsing_json?.problem as Record<string, unknown> | undefined;
  const summary = problemObj ? getStr(problemObj, "problem_statement") : getStr(input.problem_extraction_json ?? null, "summary_problem");
  const targetCustomer = problemObj ? getStr(problemObj, "target_customer") : getStr(input.problem_extraction_json ?? null, "target_customer");
  const painPoints = problemObj ? arrOfStrings(problemObj.pain_points) : [];

  const statementLines: string[] = [];
  if (company) statementLines.push(`${company}.`);
  if (summary) statementLines.push(summary);
  if (targetCustomer) statementLines.push(`Target customer: ${targetCustomer}`);
  if (painPoints.length > 0) statementLines.push("Pain points: " + painPoints.join("; "));

  if (statementLines.length > 0) {
    paragraphs.push("Problem\n" + statementLines.join(" "));
  }

  const pQuality = getStr(input.problem_quality_3c_json ?? null, "problem_quality_summary") ?? getStr(input.problem_web_json ?? null, "problem_quality_commentary");
  const pUncertainty = getStr(input.problem_web_json ?? null, "uncertainty_commentary");
  if (pQuality) paragraphs.push("Problem commentary\n" + pQuality);
  if (pUncertainty) paragraphs.push("Problem uncertainty\n" + pUncertainty);
}

function buildSolutionSection(input: CommentaryInputs, paragraphs: string[]) {
  const solutionObj = input.parsing_json?.solution as Record<string, unknown> | undefined;
  const summary = solutionObj ? getStr(solutionObj, "solution_summary") : getStr(input.solution_extraction_json ?? null, "summary_solution");
  const productType = solutionObj ? getStr(solutionObj, "product_type") : getStr(input.solution_extraction_json ?? null, "product_type");
  const coreFeatures = solutionObj ? arrOfStrings(solutionObj.core_features) : [];
  const differentiation = solutionObj ? arrOfStrings(solutionObj.claimed_differentiation) : [];

  const statementLines: string[] = [];
  if (summary) statementLines.push(summary);
  if (productType) statementLines.push(`Product type: ${productType}`);
  if (coreFeatures.length > 0) statementLines.push("Core features: " + coreFeatures.join("; "));
  if (differentiation.length > 0) statementLines.push("Differentiation: " + differentiation.join("; "));

  if (statementLines.length > 0) {
    paragraphs.push("Solution\n" + statementLines.join(" "));
  }

  const sQuality = getStr(input.solution_defensibility_json ?? null, "solution_summary") ?? getStr(input.solution_web_json ?? null, "solution_quality_commentary");
  const sUncertainty = getStr(input.solution_web_json ?? null, "uncertainty_commentary");
  if (sQuality) paragraphs.push("Solution commentary\n" + sQuality);
  if (sUncertainty) paragraphs.push("Solution uncertainty\n" + sUncertainty);
}

function buildTeamSection(input: CommentaryInputs, paragraphs: string[]) {
  const parsing = input.parsing_json;
  const teamVal = parsing?.["team"] ?? parsing?.["team_members"];

  if (Array.isArray(teamVal) && teamVal.length > 0) {
    const memberLines = teamVal.slice(0, 5).map((mRaw) => {
      const m = mRaw as Record<string, unknown>;
      const name = typeof m.name === "string" ? m.name : getStr(m, "name") ?? "Unknown";
      const role = getStr(m, "role");
      const background = getStr(m, "background_summary");
      let line = role ? `${name} (${role})` : name;
      if (background) line += ` — ${background}`;
      return line;
    });
    paragraphs.push("Founder / team\n" + memberLines.join("\n"));
  }

  const founderCommentary = getStr(input.founder_signal_json ?? null, "founder_signal_summary") ?? getStr(input.founder_web_json ?? null, "founder_team_quality_commentary");
  if (founderCommentary) paragraphs.push("Team commentary\n" + founderCommentary);
}

function buildMetricsSection(input: CommentaryInputs, paragraphs: string[]) {
  const parsing = input.parsing_json;
  const tractionVal = parsing?.traction as Record<string, unknown> | undefined;
  const fundraisingVal = parsing?.fundraising as Record<string, unknown> | undefined;
  const metricsVal = (parsing?.metrics ?? tractionVal) as Record<string, unknown> | undefined;
  const parts: string[] = [];

  const addMetric = (obj: Record<string, unknown> | undefined, label: string, key: string) => {
    if (!obj) return;
    const v = obj[key];
    if (v === null || v === undefined) return;
    const str = typeof v === "string" ? v.trim() : typeof v === "number" ? v.toString() : "";
    if (str) parts.push(`${label}: ${str}`);
  };

  if (metricsVal) {
    addMetric(metricsVal, "Revenue", "revenue");
    addMetric(metricsVal, "ARR", "arr");
    addMetric(metricsVal, "Growth rate", "growth_rate");
    addMetric(metricsVal, "Customers", "customers");
    addMetric(metricsVal, "Total customers", "total_customers");
    addMetric(metricsVal, "Active users", "active_users");
    addMetric(metricsVal, "Churn", "retention_or_churn");
    addMetric(metricsVal, "Churn", "churn");
    addMetric(metricsVal, "LTV", "ltv");
    addMetric(metricsVal, "CAC", "cac");
    addMetric(metricsVal, "LTV/CAC", "ltv_cac_ratio");
    const logos = arrOfStrings(metricsVal.notable_logos);
    if (logos.length > 0) parts.push("Notable logos: " + logos.join(", "));
    const partnerships = arrOfStrings(metricsVal.partnerships);
    if (partnerships.length > 0) parts.push("Partnerships: " + partnerships.join(", "));
  }

  if (parts.length > 0) paragraphs.push("Traction / metrics\n" + parts.join(" · "));

  if (fundraisingVal) {
    const fundParts: string[] = [];
    addMetric(fundraisingVal, "Raising", "raising_amount");
    addMetric(fundraisingVal, "Round", "round_type");
    addMetric(fundraisingVal, "Valuation", "valuation");
    const useOfFunds = arrOfStrings(fundraisingVal.use_of_funds);
    if (useOfFunds.length > 0) fundParts.push("Use of funds: " + useOfFunds.join("; "));
    if (fundParts.length > 0) paragraphs.push("Fundraising\n" + fundParts.join(" · "));
  }

  const metricsCommentary = getStr(input.traction_signal_json ?? null, "signal_summary") ?? getStr(input.metrics_web_json ?? null, "metrics_quality_commentary");
  if (metricsCommentary) paragraphs.push("Traction commentary\n" + metricsCommentary);
}

function collectSources(obj: Record<string, unknown> | null): string[] {
  if (!obj) return [];
  const raw = obj["sources"];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      if (entry.trim()) out.push(entry.trim());
      continue;
    }
    if (entry && typeof entry === "object") {
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
  const paragraphs: string[] = [];

  buildProblemSection(input, paragraphs);
  buildSolutionSection(input, paragraphs);
  buildTeamSection(input, paragraphs);
  buildMetricsSection(input, paragraphs);

  // Thesis fit (Phase 2)
  const thesisReasoning = getStr(input.thesis_fit_json ?? null, "thesis_alignment_reasoning");
  if (thesisReasoning) paragraphs.push("Thesis fit\n" + thesisReasoning);

  // Market: from deck (Phase 1) + commentary (Phase 3E)
  const marketObj = input.parsing_json?.market as Record<string, unknown> | undefined;
  const marketStatementParts: string[] = [];
  if (marketObj) {
    const tam = getStr(marketObj, "tam_claim");
    const sam = getStr(marketObj, "sam_claim");
    const som = getStr(marketObj, "som_claim");
    const growthClaims = arrOfStrings(marketObj.market_growth_claims);
    if (tam) marketStatementParts.push(`TAM: ${tam}`);
    if (sam) marketStatementParts.push(`SAM: ${sam}`);
    if (som) marketStatementParts.push(`SOM: ${som}`);
    if (growthClaims.length > 0) marketStatementParts.push("Growth: " + growthClaims.join("; "));
  }
  if (marketStatementParts.length > 0) paragraphs.push("Market (from deck)\n" + marketStatementParts.join(" · "));
  const marketSummary = getStr(input.market_power_json ?? null, "market_power_summary");
  if (marketSummary) paragraphs.push("Market commentary\n" + marketSummary);

  // Core assumptions (Phase 4)
  const core = input.core_assumption_json as Record<string, unknown> | null | undefined;
  if (core) {
    const coreAssumptions = arrOfStrings(core.core_assumptions);
    if (coreAssumptions.length > 0) {
      paragraphs.push("Core assumptions\n" + coreAssumptions.map((a) => "• " + a).join("\n"));
    }
    const dominantAssumption = getStr(core, "dominant_fragile_assumption");
    if (dominantAssumption) paragraphs.push("Dominant fragile assumption\n" + dominantAssumption);
    const failureMode = getStr(core, "failure_mode_summary");
    if (failureMode) paragraphs.push("Failure mode\n" + failureMode);
  }

  // Sources (from any step that returns them)
  const sources = [
    ...collectSources(input.problem_web_json ?? null),
    ...collectSources(input.solution_web_json ?? null),
    ...collectSources(input.founder_web_json ?? null),
    ...collectSources(input.metrics_web_json ?? null),
  ];
  const uniqueSources = Array.from(new Set(sources)).slice(0, 10);
  if (uniqueSources.length > 0) {
    paragraphs.push("Sources\n" + uniqueSources.map((s) => "- " + s).join("\n"));
  }

  return paragraphs.join("\n\n");
}
