import type { SupabaseClient } from "@supabase/supabase-js";

function joinLines(label: string, body: string | null | undefined): string {
  const t = typeof body === "string" ? body.trim() : "";
  if (!t) return "";
  return `${label}:\n${t}`;
}

/**
 * Build search text from Phase 1 parse only (before DB persist) — for similar-deals query after parse.
 */
export function buildSearchDocumentFromPhase1Parsing(parsing: Record<string, unknown>): string {
  const parts: string[] = [];
  const overview = parsing.company_overview as Record<string, unknown> | undefined;
  if (overview && typeof overview === "object") {
    const name = typeof overview.company_name === "string" ? overview.company_name : "";
    const tag = typeof overview.tagline === "string" ? overview.tagline : "";
    const sec = typeof overview.sector_category === "string" ? overview.sector_category : "";
    const geo = typeof overview.geography === "string" ? overview.geography : "";
    if (name) parts.push(`COMPANY: ${name}`);
    if (tag) parts.push(`TAGLINE: ${tag}`);
    if (sec) parts.push(`SECTOR: ${sec}`);
    if (geo) parts.push(`GEOGRAPHY: ${geo}`);
  }
  const problem = parsing.problem as Record<string, unknown> | undefined;
  if (problem && typeof problem === "object") {
    const ps = typeof problem.problem_statement === "string" ? problem.problem_statement : "";
    const tc = typeof problem.target_customer === "string" ? problem.target_customer : "";
    const pps = Array.isArray(problem.pain_points) ? (problem.pain_points as string[]).filter(Boolean) : [];
    parts.push(joinLines("PROBLEM", ps));
    parts.push(joinLines("TARGET_CUSTOMER", tc));
    if (pps.length) parts.push(`PAIN_POINTS:\n${pps.slice(0, 10).join("\n")}`);
  }
  const solution = parsing.solution as Record<string, unknown> | undefined;
  if (solution && typeof solution === "object") {
    const ss = typeof solution.solution_summary === "string" ? solution.solution_summary : "";
    const pt = typeof solution.product_type === "string" ? solution.product_type : "";
    parts.push(joinLines("SOLUTION", ss));
    parts.push(joinLines("PRODUCT_TYPE", pt));
    const feats = Array.isArray(solution.core_features) ? (solution.core_features as string[]).filter(Boolean) : [];
    if (feats.length) parts.push(`FEATURES:\n${feats.slice(0, 10).join("\n")}`);
  }
  const traction = parsing.traction as Record<string, unknown> | undefined;
  if (traction && typeof traction === "object") {
    const keys = ["revenue", "arr", "growth_rate", "customers", "active_users", "milestones"];
    const lines: string[] = [];
    for (const k of keys) {
      const v = traction[k];
      if (v != null && v !== "") lines.push(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
    }
    if (lines.length) parts.push(`TRACTION:\n${lines.join("\n")}`);
  }
  const fund = parsing.fundraising as Record<string, unknown> | undefined;
  if (fund && typeof fund === "object") {
    const inv = fund.investors ?? fund.notable_investors;
    if (Array.isArray(inv) && inv.length) {
      parts.push(`INVESTORS:\n${inv.slice(0, 15).map(String).join(", ")}`);
    } else if (typeof inv === "string" && inv.trim()) {
      parts.push(`INVESTORS:\n${inv.trim()}`);
    }
  }
  const team = Array.isArray(parsing.team) ? (parsing.team as Record<string, unknown>[]) : [];
  if (team.length) {
    const founderBits = team
      .slice(0, 8)
      .map((t) => {
        const n = typeof t.name === "string" ? t.name : "";
        const r = typeof t.role === "string" ? t.role : "";
        const b = typeof t.background_summary === "string" ? t.background_summary : "";
        return [n, r, b].filter(Boolean).join(" — ");
      })
      .filter(Boolean);
    if (founderBits.length) parts.push(`TEAM:\n${founderBits.join("\n")}`);
  }
  return parts.filter(Boolean).join("\n\n").slice(0, 12000);
}

/**
 * Full document from pipeline result (pre-persist) — same fields as DB path where possible.
 */
export function buildSearchDocumentFromPipelineResult(result: {
  parsing_json?: unknown;
}): string {
  const parsing = (result.parsing_json ?? {}) as Record<string, unknown>;
  return buildSearchDocumentFromPhase1Parsing(parsing);
}

type DealJoinRow = {
  id: string;
  company_name: string | null;
  geography: string | null;
  sector: string | null;
  deal_problem: Array<{
    problem_statement: string | null;
    structural_urgency: string | null;
    stated_problem_ref: string | null;
  }>;
  deal_solution: Array<{
    solution_summary: string | null;
    product_type: string | null;
    technical_moat_evidence: string | null;
  }>;
  deal_traction: Array<{
    traction_evidence_json: unknown;
    inferred_stage: string | null;
    benchmark_context: string | null;
  }>;
  founders: Array<{
    name: string | null;
    role: string | null;
    background_summary: string | null;
  }>;
  deal_investors: Array<{
    role: string | null;
    round_name: string | null;
    investors: { name: string | null } | null;
  }>;
  deal_metrics: Array<{ metric_name: string | null; metric_value: string | null }>;
};

/**
 * Rich canonical document from persisted relational rows (for embedding backfill / reindex).
 */
export function buildSearchDocumentFromJoinedRow(row: DealJoinRow): string {
  const parts: string[] = [];
  if (row.company_name) parts.push(`COMPANY: ${row.company_name}`);
  if (row.sector) parts.push(`SECTOR: ${row.sector}`);
  if (row.geography) parts.push(`GEOGRAPHY: ${row.geography}`);

  const p = row.deal_problem[0];
  if (p) {
    parts.push(joinLines("PROBLEM", p.problem_statement));
    parts.push(joinLines("PROBLEM_URGENCY", p.structural_urgency));
    parts.push(joinLines("PROBLEM_REF", p.stated_problem_ref));
  }
  const s = row.deal_solution[0];
  if (s) {
    parts.push(joinLines("SOLUTION", s.solution_summary));
    parts.push(joinLines("PRODUCT", s.product_type));
    parts.push(joinLines("MOAT", s.technical_moat_evidence));
  }
  const t = row.deal_traction[0];
  if (t) {
    if (t.benchmark_context) parts.push(joinLines("STAGE_CONTEXT", t.benchmark_context));
    if (t.inferred_stage) parts.push(joinLines("INFERRED_STAGE", t.inferred_stage));
    if (t.traction_evidence_json && typeof t.traction_evidence_json === "object") {
      parts.push(joinLines("TRACTION_JSON", JSON.stringify(t.traction_evidence_json).slice(0, 4000)));
    }
  }
  for (const f of row.founders.slice(0, 12)) {
    const line = [f.name, f.role, f.background_summary].filter(Boolean).join(" — ");
    if (line) parts.push(`FOUNDER: ${line}`);
  }
  const invLines = row.deal_investors
    .map((di) => {
      const n = di.investors?.name;
      if (!n) return null;
      return [n, di.role, di.round_name].filter(Boolean).join(" ");
    })
    .filter(Boolean) as string[];
  if (invLines.length) parts.push(`INVESTORS:\n${invLines.slice(0, 25).join("\n")}`);

  for (const m of row.deal_metrics.slice(0, 30)) {
    if (m.metric_name && m.metric_value) {
      parts.push(`METRIC ${m.metric_name}: ${m.metric_value}`);
    }
  }

  return parts.filter(Boolean).join("\n\n").slice(0, 12000);
}

/**
 * Load deal + children and build search document (latest analysis run).
 */
export async function fetchDealSearchDocumentInput(
  admin: SupabaseClient,
  dealId: string
): Promise<string | null> {
  const { data: latestA, error: aErr } = await admin
    .from("deal_analyses")
    .select("id")
    .eq("deal_id", dealId)
    .order("run_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (aErr) {
    console.error("fetchDealSearchDocumentInput: deal_analyses", aErr);
  }

  const analysisId = latestA?.id as string | undefined;

  const { data: deal, error: dErr } = await admin
    .from("deals")
    .select("id, company_name, geography, sector")
    .eq("id", dealId)
    .maybeSingle();

  if (dErr || !deal) {
    console.error("fetchDealSearchDocumentInput: deals", dErr);
    return null;
  }

  let dp: DealJoinRow["deal_problem"] = [];
  let ds: DealJoinRow["deal_solution"] = [];
  let dt: DealJoinRow["deal_traction"] = [];

  if (analysisId) {
    const [r1, r2, r3] = await Promise.all([
      admin
        .from("deal_problem")
        .select("problem_statement, structural_urgency, stated_problem_ref")
        .eq("deal_id", dealId)
        .eq("analysis_id", analysisId)
        .maybeSingle(),
      admin
        .from("deal_solution")
        .select("solution_summary, product_type, technical_moat_evidence")
        .eq("deal_id", dealId)
        .eq("analysis_id", analysisId)
        .maybeSingle(),
      admin
        .from("deal_traction")
        .select("traction_evidence_json, inferred_stage, benchmark_context")
        .eq("deal_id", dealId)
        .eq("analysis_id", analysisId)
        .maybeSingle(),
    ]);
    if (r1.data) dp = [r1.data as DealJoinRow["deal_problem"][0]];
    if (r2.data) ds = [r2.data as DealJoinRow["deal_solution"][0]];
    if (r3.data) dt = [r3.data as DealJoinRow["deal_traction"][0]];
  }

  const { data: founders } = await admin
    .from("founders")
    .select("name, role, background_summary")
    .eq("deal_id", dealId)
    .limit(20);

  const { data: diRows } = await admin
    .from("deal_investors")
    .select("role, round_name, investors ( name )")
    .eq("deal_id", dealId);

  const { data: metrics } = await admin
    .from("deal_metrics")
    .select("metric_name, metric_value")
    .eq("deal_id", dealId)
    .limit(40);

  const row: DealJoinRow = {
    id: deal.id,
    company_name: deal.company_name,
    geography: deal.geography,
    sector: deal.sector,
    deal_problem: dp,
    deal_solution: ds,
    deal_traction: dt,
    founders: (founders ?? []) as DealJoinRow["founders"],
    deal_investors: (diRows ?? []) as unknown as DealJoinRow["deal_investors"],
    deal_metrics: (metrics ?? []) as unknown as DealJoinRow["deal_metrics"],
  };

  const doc = buildSearchDocumentFromJoinedRow(row);
  return doc.trim() || null;
}
