/**
 * Fast-path CRM numeric hints for live KPI contradiction (no embeddings).
 * Pulls numbers from company_traction text fields and company_fact canonical text.
 */

export type TractionRow = {
  updated_at?: string | null;
  revenue_data?: string | null;
  company_stage?: string | null;
  product_stage?: string | null;
  money_raised_per_stage?: string[] | null;
  investor_list?: string[] | null;
  customer_size_and_count?: string | null;
  growth_trends_description?: string | null;
  notable_partners_or_customers?: string[] | null;
  notable_partners_or_customors?: string[] | null;
};

export type CompanyFactRow = {
  fact_path: string;
  canonical_value_text: string | null;
};

export type CrmNumericSnapshot = {
  traction: TractionRow | null;
  facts: CompanyFactRow[];
};

/** Parse first plausible money/count/percent number from free text (incl. "9 million", "$9M"). */
export function normalizeNumberFromText(s: string): { value: number; approx: boolean } | null {
  const text = (s || "").toLowerCase();
  if (!text.trim()) return null;

  const approx = /\b(about|around|roughly|approximately|approx|~|nearly|close to)\b/.test(text);

  // Word multipliers: 15 million, 9 billion
  const wordM = text.match(
    /(?:\$)?\s*([0-9]+(?:\.[0-9]+)?)\s*(million|billion|thousand|mn|mil|bill)\b/i,
  );
  if (wordM) {
    const base = Number(wordM[1]);
    if (!Number.isFinite(base)) return null;
    const w = wordM[2].toLowerCase();
    let mult = 1;
    if (w.startsWith("million") || w === "mn" || w === "mil") mult = 1_000_000;
    else if (w.startsWith("billion") || w === "bill") mult = 1_000_000_000;
    else if (w.startsWith("thousand")) mult = 1_000;
    return { value: base * mult, approx };
  }

  const m = text.match(/(?:\$)?\s*([0-9]+(?:\.[0-9]+)?)\s*(k|m|b|thousand|million|billion)?/i);
  if (!m) return null;
  const base = Number(m[1]);
  if (!Number.isFinite(base)) return null;
  const suf = (m[2] || "").toLowerCase();
  let mult = 1;
  if (suf === "k" || suf === "thousand") mult = 1_000;
  else if (suf === "m" || suf === "million") mult = 1_000_000;
  else if (suf === "b" || suf === "billion") mult = 1_000_000_000;
  return { value: base * mult, approx };
}

function factPathMatchesMetric(metricKey: string, factPath: string): boolean {
  const k = metricKey.toLowerCase();
  const p = factPath.toLowerCase();
  if (k.includes("arr") || k.includes("mrr") || k.includes("revenue") || k.includes("bookings") || k.includes("gmv")) {
    return /\b(revenue|arr|mrr|recurring|bookings|gmv|sales)\b/.test(p) || p.includes("traction");
  }
  if (k.includes("fund") || k.includes("raise") || k.includes("valuation") || k.includes("round") || k.includes("raised")) {
    return /\b(fund|raise|round|valuation|invest|seed|series)\b/.test(p) || p.includes("traction");
  }
  if (k.includes("customer") || k.includes("logo") || k.includes("user") || k.includes("account") || k.includes("seat")) {
    return /\b(customer|logo|user|account|seat|paying)\b/.test(p) || p.includes("traction");
  }
  if (k.includes("growth") || k.includes("churn") || k.includes("retention") || k.includes("nrr") || k.includes("grr")) {
    return /\b(growth|churn|retention|nrr|grr)\b/.test(p) || p.includes("traction");
  }
  return p.includes("traction") || p.includes("financial") || p.includes("solution") || p.includes("problem");
}

function tractionFieldTexts(metricKey: string, snap: TractionRow | null): Array<{ field: string; text: string }> {
  if (!snap) return [];
  const k = metricKey.toLowerCase();
  const out: Array<{ field: string; text: string }> = [];
  const push = (field: string, v: unknown) => {
    if (v == null) return;
    if (Array.isArray(v)) out.push({ field, text: v.map((x) => String(x)).join(" | ") });
    else out.push({ field, text: String(v) });
  };
  if (k.includes("arr") || k.includes("mrr") || k.includes("revenue")) push("revenue_data", snap.revenue_data);
  if (k.includes("fund") || k.includes("raise") || k.includes("valuation") || k.includes("round")) {
    push("money_raised_per_stage", snap.money_raised_per_stage);
    push("investor_list", snap.investor_list);
  }
  if (k.includes("customer") || k.includes("logo") || k.includes("user") || k.includes("partner")) {
    push("customer_size_and_count", snap.customer_size_and_count);
    push("notable_partners_or_customers", snap.notable_partners_or_customers);
    push("notable_partners_or_customors", snap.notable_partners_or_customors);
  }
  if (k.includes("growth") || k.includes("churn") || k.includes("retention")) push("growth_trends_description", snap.growth_trends_description);
  return out;
}

/**
 * Best single numeric anchor from CRM for this metric (facts first, then traction fields).
 */
export function recordValueForMetric(metricKey: string, snap: CrmNumericSnapshot): { recordValue: number; recordText: string } | null {
  for (const f of snap.facts) {
    if (!factPathMatchesMetric(metricKey, f.fact_path)) continue;
    const t = f.canonical_value_text?.trim() || "";
    if (!t) continue;
    const parsed = normalizeNumberFromText(t);
    if (parsed && Number.isFinite(parsed.value)) {
      return { recordValue: parsed.value, recordText: `${f.fact_path}: ${t}`.slice(0, 260) };
    }
  }
  for (const c of tractionFieldTexts(metricKey, snap.traction)) {
    const parsed = normalizeNumberFromText(c.text);
    if (parsed && Number.isFinite(parsed.value)) {
      return { recordValue: parsed.value, recordText: `${c.field}: ${c.text}`.slice(0, 260) };
    }
  }
  return null;
}
