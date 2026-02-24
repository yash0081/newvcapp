/**
 * Aggregate problem/solution/team/metrics statements + commentary + sources
 * into a single multi-paragraph description for the UI.
 *
 * The intended order:
 * 1. Problem statement, then problem commentary
 * 2. Solution statement, then solution commentary
 * 3. Founder/team info, then founder/team commentary
 * 4. Metrics info, then metrics commentary
 * 5. Sources (from all web steps)
 */

export interface CommentaryInputs {
  parsing_json: Record<string, unknown> | null;
  problem_extraction_json: Record<string, unknown> | null;
  solution_extraction_json: Record<string, unknown> | null;
  problem_web_json: Record<string, unknown> | null;
  solution_web_json: Record<string, unknown> | null;
  founder_web_json: Record<string, unknown> | null;
  metrics_web_json: Record<string, unknown> | null;
}

function getStr(obj: Record<string, unknown> | null, key: string): string | null {
  if (!obj) return null;
  const v = obj[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function pickCompanyName(input: CommentaryInputs): string | null {
  const fromParsing = getStr(input.parsing_json, "company_name");
  if (fromParsing) return fromParsing;
  const fromProblem = getStr(input.problem_extraction_json, "company_name");
  if (fromProblem) return fromProblem;
  const fromSolution = getStr(input.solution_extraction_json, "company_name");
  if (fromSolution) return fromSolution;
  return null;
}

function buildProblemSection(input: CommentaryInputs, paragraphs: string[]) {
  const company = pickCompanyName(input);
  const summary = getStr(input.problem_extraction_json, "summary_problem");
  const targetCustomer = getStr(input.problem_extraction_json, "target_customer");

  if (summary || targetCustomer) {
    const lines: string[] = [];
    if (company) {
      lines.push(`Problem – ${company}:`);
    } else {
      lines.push("Problem:");
    }
    if (summary) lines.push(summary);
    if (targetCustomer) lines.push(`Target customer: ${targetCustomer}`);
    paragraphs.push(lines.join(" "));
  }

  const pQuality = getStr(input.problem_web_json, "problem_quality_commentary");
  const pUncertainty = getStr(input.problem_web_json, "uncertainty_commentary");
  if (pQuality) paragraphs.push(`Problem commentary: ${pQuality}`);
  if (pUncertainty) paragraphs.push(`Problem uncertainty: ${pUncertainty}`);
}

function buildSolutionSection(input: CommentaryInputs, paragraphs: string[]) {
  const company = pickCompanyName(input);
  const summary = getStr(input.solution_extraction_json, "summary_solution");
  const productType = getStr(input.solution_extraction_json, "product_type");

  if (summary || productType) {
    const lines: string[] = [];
    if (company) {
      lines.push(`Solution – ${company}:`);
    } else {
      lines.push("Solution:");
    }
    if (summary) lines.push(summary);
    if (productType) lines.push(`Product type: ${productType}`);
    paragraphs.push(lines.join(" "));
  }

  const sQuality = getStr(input.solution_web_json, "solution_quality_commentary");
  const sUncertainty = getStr(input.solution_web_json, "uncertainty_commentary");
  if (sQuality) paragraphs.push(`Solution commentary: ${sQuality}`);
  if (sUncertainty) paragraphs.push(`Solution uncertainty: ${sUncertainty}`);
}

function buildTeamSection(input: CommentaryInputs, paragraphs: string[]) {
  const parsing = input.parsing_json;
  const teamVal = parsing?.["team_members"];
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

  if (teamSummary) {
    paragraphs.push(teamSummary);
  }

  const founderCommentary = getStr(input.founder_web_json, "founder_team_quality_commentary");
  if (founderCommentary) {
    paragraphs.push(`Team commentary: ${founderCommentary}`);
  }
}

function buildMetricsSection(input: CommentaryInputs, paragraphs: string[]) {
  const parsing = input.parsing_json;
  const metricsVal = parsing?.["metrics"] as Record<string, unknown> | undefined;
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
    addMetric("Total customers", "total_customers");
    addMetric("Active users", "active_users");
    addMetric("Churn", "churn");
    addMetric("LTV", "ltv");
    addMetric("CAC", "cac");
    addMetric("LTV/CAC", "ltv_cac_ratio");
  }

  if (parts.length > 0) {
    paragraphs.push(`Metrics: ${parts.join(" · ")}`);
  }

  const metricsCommentary = getStr(input.metrics_web_json, "metrics_quality_commentary");
  if (metricsCommentary) {
    paragraphs.push(`Metrics commentary: ${metricsCommentary}`);
  }
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

  // 1. Problem
  buildProblemSection(input, paragraphs);

  // 2. Solution
  buildSolutionSection(input, paragraphs);

  // 3. Founder / team
  buildTeamSection(input, paragraphs);

  // 4. Metrics
  buildMetricsSection(input, paragraphs);

  // 5. Sources (combined from all web JSONs)
  const sources = [
    ...collectSources(input.problem_web_json),
    ...collectSources(input.solution_web_json),
    ...collectSources(input.founder_web_json),
    ...collectSources(input.metrics_web_json),
  ];

  const uniqueSources = Array.from(new Set(sources)).slice(0, 10);
  if (uniqueSources.length > 0) {
    const lines = ["Sources:", ...uniqueSources.map((s) => `- ${s}`)];
    paragraphs.push(lines.join("\n"));
  }

  // Fallback: if everything is empty, return an empty string so the UI can show "No commentary yet."
  return paragraphs.join("\n\n");
}
