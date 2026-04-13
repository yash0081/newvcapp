/**
 * Snippets for markdown corpus deals (`Invested Companies_.md` shape): nested JSON in
 * `deal_analyses.raw_output` plus normalized `deal_*` / `founders` rows.
 */

export type CorpusSnippetParts = {
  problem: string | null;
  solution: string | null;
  traction: string | null;
  team: string | null;
};

/**
 * Human-readable traction block for markdown corpus profiles (flat, nested `funding`, metrics arrays).
 * Avoids dumping `JSON.stringify(traction)` into summaries.
 */
export function tractionHumanSummaryFromProfile(traction: unknown): string | null {
  if (traction == null) return null;
  if (typeof traction === "string") {
    const t = traction.trim();
    return t.length ? t : null;
  }
  if (typeof traction !== "object") return null;
  const o = traction as Record<string, unknown>;
  const lines: string[] = [];

  const pushFundingLine = (label: string, parts: string[]) => {
    const s = parts.filter(Boolean).join(" · ");
    if (s) lines.push(`${label}: ${s}`);
  };

  const fund = o.funding;
  if (fund && typeof fund === "object") {
    const f = fund as Record<string, unknown>;
    const bits: string[] = [];
    for (const k of [
      "latest_round",
      "total_funding",
      "total_equity",
      "debt_facility",
      "seed_round",
      "lead_investors",
      "lead_investor",
    ]) {
      const v = f[k];
      if (typeof v === "string" && v.trim()) bits.push(v.trim());
    }
    if (Array.isArray(f.participating_investors) && f.participating_investors.length) {
      bits.push(`Investors: ${f.participating_investors.map(String).join(", ")}`);
    }
    if (bits.length) pushFundingLine("Funding", bits);
  }

  const tf = typeof o.total_funding === "string" ? o.total_funding : null;
  const lr = typeof o.latest_round === "string" ? o.latest_round : null;
  if (!lines.some((l) => l.startsWith("Funding:"))) {
    const fundBits = [lr, tf].filter((x): x is string => typeof x === "string" && x.trim().length > 0);
    if (fundBits.length) pushFundingLine("Funding", fundBits);
  }
  if (Array.isArray(o.key_investors) && o.key_investors.length) {
    lines.push(`Investors: ${o.key_investors.map(String).join(", ")}`);
  }

  if (Array.isArray(o.milestones) && o.milestones.length) {
    lines.push("Milestones:");
    for (const m of o.milestones) lines.push(`• ${String(m)}`);
  }

  if (Array.isArray(o.business_metrics) && o.business_metrics.length) {
    lines.push("Business metrics:");
    for (const m of o.business_metrics) lines.push(`• ${String(m)}`);
  }

  const joined = lines.join("\n").trim();
  return joined.length ? joined : null;
}

/** One-line-ish text from markdown profile JSON (no `parsing_json`). */
export function snippetPartsFromMarkdownRawOutput(
  raw: Record<string, unknown> | null
): CorpusSnippetParts {
  if (!raw || typeof raw !== "object") {
    return { problem: null, solution: null, traction: null, team: null };
  }

  const ps = raw.problem_statement;
  let problem: string | null = null;
  if (typeof ps === "string" && ps.trim()) {
    problem = ps.trim();
  } else if (ps && typeof ps === "object") {
    const o = ps as Record<string, unknown>;
    const parts = [
      typeof o.core_concept === "string" ? o.core_concept : null,
      typeof o.description === "string" ? o.description : null,
      Array.isArray(o.key_barriers) ? o.key_barriers.map(String).join("; ") : null,
    ].filter(Boolean) as string[];
    problem = parts.length ? parts.join("\n\n") : null;
  }

  const sol = raw.solution;
  let solution: string | null = null;
  if (typeof sol === "string" && sol.trim()) {
    solution = sol.trim();
  } else if (sol && typeof sol === "object") {
    const o = sol as Record<string, unknown>;
    const parts = [
      typeof o.primary_product === "string" ? o.primary_product : null,
      typeof o.architecture === "string" ? o.architecture : null,
      typeof o.value_proposition === "string" ? o.value_proposition : null,
    ].filter(Boolean) as string[];
    solution = parts.length ? parts.join("\n\n") : null;
  }

  const tr = raw.traction;
  let traction: string | null = null;
  if (typeof tr === "string" && tr.trim()) {
    traction = tr.trim();
  } else if (tr && typeof tr === "object") {
    traction = tractionHumanSummaryFromProfile(tr);
  }

  let team: string | null = null;
  const founders = raw.founders;
  if (Array.isArray(founders) && founders.length) {
    team = founders
      .map((f) => {
        if (!f || typeof f !== "object") return "";
        const x = f as Record<string, unknown>;
        const name = typeof x.name === "string" ? x.name : "";
        const role = typeof x.role === "string" ? x.role : "";
        const bg = typeof x.background === "string" ? x.background : "";
        return [name, role, bg].filter(Boolean).join(" — ");
      })
      .filter(Boolean)
      .join("\n");
  }

  return { problem, solution, traction, team: team || null };
}

export type FounderRowForSnippet = {
  name?: string | null;
  role?: string | null;
  enrichment_raw?: unknown;
};

export function teamSnippetFromFounderRows(rows: FounderRowForSnippet[]): string | null {
  if (!rows.length) return null;
  const lines = rows.map((f) => {
    let bg = "";
    if (f.enrichment_raw && typeof f.enrichment_raw === "object" && "background" in f.enrichment_raw) {
      bg = String((f.enrichment_raw as { background?: unknown }).background ?? "").trim();
    }
    const parts = [f.name, f.role, bg].filter((p) => p && String(p).trim().length > 0);
    return parts.join(" — ");
  });
  const s = lines.filter(Boolean).join("\n");
  return s.trim() ? s : null;
}

export type DealTractionRowForSnippet = {
  inferred_stage?: string | null;
  benchmark_context?: string | null;
  revenue_data?: string | null;
  growth_signals?: string | null;
  customer_depth?: string | null;
  user_traction?: string | null;
  traction_evidence_json?: unknown;
};

/** Prefer relational columns; optionally stringify traction_evidence_json for grid preview. */
export function tractionSnippetFromDealTractionRow(row: DealTractionRowForSnippet | null | undefined): string | null {
  if (!row) return null;
  const parts = [
    row.benchmark_context,
    row.inferred_stage,
    row.revenue_data,
    row.growth_signals,
    row.customer_depth,
    row.user_traction,
  ]
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter(Boolean);
  if (parts.length) return parts.join("\n");

  const ev = row.traction_evidence_json;
  if (ev && typeof ev === "object") {
    const o = ev as Record<string, unknown>;
    const bits = [
      typeof o.total_funding === "string" ? o.total_funding : null,
      typeof o.latest_round === "string" ? o.latest_round : null,
      Array.isArray(o.milestones) ? o.milestones.map(String).join("; ") : null,
    ].filter(Boolean) as string[];
    if (bits.length) return bits.join(" · ");
  }
  return null;
}
