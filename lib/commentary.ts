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

function buildProblemSection(input: CommentaryInputs, paragraphs: string[]) {
  const company = pickCompanyName(input);
  // Deal-sourcing: parsing_json.problem.problem_statement, .target_customer
  const problemObj = input.parsing_json?.problem as Record<string, unknown> | undefined;
  const summary = problemObj ? getStr(problemObj, "problem_statement") : getStr(input.problem_extraction_json ?? null, "summary_problem");
  const targetCustomer = problemObj ? getStr(problemObj, "target_customer") : getStr(input.problem_extraction_json ?? null, "target_customer");

  if (summary || targetCustomer) {
    const lines: string[] = [];
    if (company) lines.push(`Problem – ${company}:`);
    else lines.push("Problem:");
    if (summary) lines.push(summary);
    if (targetCustomer) lines.push(`Target customer: ${targetCustomer}`);
    paragraphs.push(lines.join(" "));
  }

  const pQuality = getStr(input.problem_quality_3c_json ?? null, "problem_quality_summary") ?? getStr(input.problem_web_json ?? null, "problem_quality_commentary");
  const pUncertainty = getStr(input.problem_web_json ?? null, "uncertainty_commentary");
  if (pQuality) paragraphs.push(`Problem commentary: ${pQuality}`);
  if (pUncertainty) paragraphs.push(`Problem uncertainty: ${pUncertainty}`);
}

function buildSolutionSection(input: CommentaryInputs, paragraphs: string[]) {
  const company = pickCompanyName(input);
  const solutionObj = input.parsing_json?.solution as Record<string, unknown> | undefined;
  const summary = solutionObj ? getStr(solutionObj, "solution_summary") : getStr(input.solution_extraction_json ?? null, "summary_solution");
  const productType = solutionObj ? getStr(solutionObj, "product_type") : getStr(input.solution_extraction_json ?? null, "product_type");

  if (summary || productType) {
    const lines: string[] = [];
    if (company) lines.push(`Solution – ${company}:`);
    else lines.push("Solution:");
    if (summary) lines.push(summary);
    if (productType) lines.push(`Product type: ${productType}`);
    paragraphs.push(lines.join(" "));
  }

  const sQuality = getStr(input.solution_defensibility_json ?? null, "solution_summary") ?? getStr(input.solution_web_json ?? null, "solution_quality_commentary");
  const sUncertainty = getStr(input.solution_web_json ?? null, "uncertainty_commentary");
  if (sQuality) paragraphs.push(`Solution commentary: ${sQuality}`);
  if (sUncertainty) paragraphs.push(`Solution uncertainty: ${sUncertainty}`);
}

function buildTeamSection(input: CommentaryInputs, paragraphs: string[]) {
  const parsing = input.parsing_json;
  const teamVal = parsing?.["team"] ?? parsing?.["team_members"];
  let teamSummary: string | null = null;

  if (Array.isArray(teamVal) && teamVal.length > 0) {
    const members = teamVal
      .slice(0, 3)
      .map((mRaw) => {
        const m = mRaw as Record<string, unknown>;
        const name = typeof m.name === "string" ? m.name : getStr(m, "name") ?? "Unknown";
        const role = getStr(m, "role");
        return role ? `${name} (${role})` : name;
      })
      .filter(Boolean);
    if (members.length > 0) {
      teamSummary = `Founders & team: ${members.join(", ")}${teamVal.length > members.length ? "…" : ""}`;
    }
  }

  if (teamSummary) paragraphs.push(teamSummary);

  const founderCommentary = getStr(input.founder_signal_json ?? null, "founder_signal_summary") ?? getStr(input.founder_web_json ?? null, "founder_team_quality_commentary");
  if (founderCommentary) paragraphs.push(`Team commentary: ${founderCommentary}`);
}

function buildMetricsSection(input: CommentaryInputs, paragraphs: string[]) {
  const parsing = input.parsing_json;
  const tractionVal = parsing?.traction as Record<string, unknown> | undefined;
  const metricsVal = (parsing?.metrics ?? tractionVal) as Record<string, unknown> | undefined;
  const parts: string[] = [];

  if (metricsVal) {
    const addMetric = (label: string, key: string) => {
      const v = metricsVal[key];
      if (v === null || v === undefined) return;
      const str = typeof v === "string" ? v.trim() : typeof v === "number" ? v.toString() : "";
      if (str) parts.push(`${label}: ${str}`);
    };

    addMetric("Revenue", "revenue");
    addMetric("ARR", "arr");
    addMetric("Growth rate", "growth_rate");
    addMetric("Customers", "customers");
    addMetric("Total customers", "total_customers");
    addMetric("Active users", "active_users");
    addMetric("Churn", "retention_or_churn");
    addMetric("Churn", "churn");
    addMetric("LTV", "ltv");
    addMetric("CAC", "cac");
    addMetric("LTV/CAC", "ltv_cac_ratio");
  }

  if (parts.length > 0) paragraphs.push(`Traction / metrics: ${parts.join(" · ")}`);

  const metricsCommentary = getStr(input.traction_signal_json ?? null, "signal_summary") ?? getStr(input.metrics_web_json ?? null, "metrics_quality_commentary");
  if (metricsCommentary) paragraphs.push(`Traction commentary: ${metricsCommentary}`);
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

  // Thesis fit (deal-sourcing Phase 2)
  const thesisReasoning = getStr(input.thesis_fit_json ?? null, "thesis_alignment_reasoning");
  if (thesisReasoning) paragraphs.push(`Thesis fit: ${thesisReasoning}`);

  // Market power (Phase 3E)
  const marketSummary = getStr(input.market_power_json ?? null, "market_power_summary");
  if (marketSummary) paragraphs.push(`Market: ${marketSummary}`);

  // Core assumptions (Phase 4)
  const core = input.core_assumption_json as Record<string, unknown> | null | undefined;
  const dominantAssumption = core ? getStr(core, "dominant_fragile_assumption") : null;
  const failureMode = core ? getStr(core, "failure_mode_summary") : null;
  if (dominantAssumption) paragraphs.push(`Dominant fragile assumption: ${dominantAssumption}`);
  if (failureMode) paragraphs.push(`Failure mode: ${failureMode}`);

  // Sources
  const sources = [
    ...collectSources(input.problem_web_json ?? null),
    ...collectSources(input.solution_web_json ?? null),
    ...collectSources(input.founder_web_json ?? null),
    ...collectSources(input.metrics_web_json ?? null),
  ];
  const uniqueSources = Array.from(new Set(sources)).slice(0, 10);
  if (uniqueSources.length > 0) {
    paragraphs.push("Sources:\n" + uniqueSources.map((s) => `- ${s}`).join("\n"));
  }

  return paragraphs.join("\n\n");
}
