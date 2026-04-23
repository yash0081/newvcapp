import type { InvestedCompanyRecord } from "./parse-invested-markdown";

function asStr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function summarizeProblem(p: unknown): string | null {
  if (p == null || typeof p !== "object" || Array.isArray(p)) return null;
  const o = p as Record<string, unknown>;
  const parts = [asStr(o.core_concept), asStr(o.core_issue), asStr(o.description)]
    .map((s) => s.trim())
    .filter(Boolean);
  const barriers = o.barriers ?? o.key_barriers;
  if (Array.isArray(barriers) && barriers.length) {
    parts.push("Barriers: " + barriers.map((b) => asStr(b)).join("; "));
  }
  const s = parts.join(" — ");
  return s.length ? s.slice(0, 2000) : null;
}

function summarizeSolution(s: unknown): string | null {
  if (s == null || typeof s !== "object" || Array.isArray(s)) return null;
  const o = s as Record<string, unknown>;
  const parts = [asStr(o.primary_product), asStr(o.value_proposition), asStr(o.architecture)]
    .map((t) => t.trim())
    .filter(Boolean);
  const kf = o.key_features;
  if (Array.isArray(kf) && kf.length) {
    parts.push("Features: " + kf.map((x) => asStr(x)).join("; "));
  }
  const out = parts.join(" | ");
  return out.length ? out.slice(0, 2000) : null;
}

function decisionFromCohort(
  c: "invested" | "passed" | "unknown"
): "yes" | "no" | "open" {
  if (c === "invested") return "yes";
  if (c === "passed") return "no";
  return "open";
}

/**
 * Map corpus JSON + cohort into `deal_intel.deal.metadata` for retrieval / similar peers
 * and optional UI, without changing the fact JSON we persist.
 */
export function buildInvestedCompanyDealMetadata(
  rec: InvestedCompanyRecord
): Record<string, unknown> {
  const j = rec.rawJson;
  const name =
    (typeof j.company_name === "string" && j.company_name) ||
    (typeof (j as { company_name?: string }).company_name === "string" &&
      (j as { company_name: string }).company_name) ||
    "Unknown";

  const problem = summarizeProblem(
    (j as { problem_statement?: unknown }).problem_statement
  );
  const solution = summarizeSolution((j as { solution?: unknown }).solution);
  const traction = (j as { traction?: unknown }).traction;

  return {
    source: "invested_companies_md",
    cohort: rec.cohort,
    company_name: name,
    display_name: name,
    decision: decisionFromCohort(rec.cohort),
    pass_reason: rec.cohort === "passed" ? "see_hypothetical_rejection" : null,
    pass_reason_detail: null,
    sector: null,
    stage: null,
    problem_one_liner: problem,
    solution_one_liner: solution,
    /** Short text for root centroid / similar-deals */
    retrieval_summary: [problem, solution, typeof traction === "object" && traction != null ? JSON.stringify(traction).slice(0, 1200) : ""]
      .filter(Boolean)
      .join(" \n "),
    investors: [] as string[],
  };
}
