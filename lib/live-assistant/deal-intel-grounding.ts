import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { normalizeNumberFromText, recordValueForMetric, type CompanyFactRow, type TractionRow } from "@/lib/live-assistant/fast-crm-compare";

export type ClaimGroundRow = {
  key: string | null;
  value_number: number | null;
  value_text: string | null;
  quote: string;
};

export type FactNodeGroundRow = {
  path: string;
  value_text: string | null;
};

/**
 * Everything in deal_intel that is cheap to load and useful for live KPI / contradiction checks.
 */
export type DealIntelGroundingPack = {
  traction: TractionRow | null;
  solution: Record<string, unknown> | null;
  problem: Record<string, unknown> | null;
  facts: CompanyFactRow[];
  claims: ClaimGroundRow[];
  factNodes: FactNodeGroundRow[];
};

export function kpiBufferMsFromEnv(): number {
  const raw = Number(process.env.LIVE_ASSISTANT_KPI_BUFFER_SEC ?? 22);
  const sec = Number.isFinite(raw) ? Math.min(30, Math.max(15, raw)) : 22;
  return sec * 1000;
}

/** Same KPI with different wording → dedupe on metric family + ~3 significant figures. */
export function metricFamily(metricKey: string): string {
  const k = metricKey.toLowerCase();
  if (/\b(arr|mrr|revenue|bookings|gmv|acv|arpa|arpu)\b/.test(k) || k.includes("arr") || k.includes("mrr") || k.includes("revenue"))
    return "revenue";
  if (/\b(fund|raise|round|valuation|invest|seed|series)\b/.test(k) || k.includes("raised") || k.includes("funding")) return "funding";
  if (/\b(customer|logo|user|account|seat)\b/.test(k) || k.includes("customer")) return "customers";
  if (/\b(churn|retention|nrr|grr|growth)\b/.test(k) || k.includes("growth")) return "growth";
  if (k.includes("runway") || k.includes("burn")) return "runway";
  if (k.includes("headcount") || k.includes("employee") || k.includes("fte")) return "headcount";
  return k.replace(/[^a-z0-9]+/g, "_").slice(0, 32) || "metric";
}

export function kpiCanonicalDedupeKey(meetingId: string, family: string, normalizedValue: number): string {
  const sig =
    !Number.isFinite(normalizedValue) || normalizedValue === 0
      ? "0"
      : Number(Math.abs(normalizedValue).toPrecision(3)) * Math.sign(normalizedValue);
  return createHash("sha256")
    .update(`${meetingId}|${family}|${sig}`)
    .digest("hex")
    .slice(0, 18);
}

export async function fetchDealIntelGroundingPack(admin: SupabaseClient, dealId: string): Promise<DealIntelGroundingPack> {
  const [
    tractionRes,
    solutionRes,
    problemRes,
    factsRes,
    claimsRes,
    nodesRes,
  ] = await Promise.all([
    admin
      .schema("deal_intel")
      .from("company_traction")
      .select(
        "updated_at, revenue_data, company_stage, product_stage, customer_size_and_count, growth_trends_description, money_raised_per_stage, investor_list, notable_partners_or_customers, notable_partners_or_customors",
      )
      .eq("deal_id", dealId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .schema("deal_intel")
      .from("company_solution")
      .select(
        "general_description, novelty_or_uniqueness, timeline_description, who_are_the_customers, cost_to_customer_to_buy_product, solution_price_for_company, price_per_customer_build_and_serve, defensibility, patent_ip, proprietary_tech_or_solution, competitors",
      )
      .eq("deal_id", dealId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .schema("deal_intel")
      .from("company_problem")
      .select("general_problem_description, urgency, current_cost_for_customers, tam, sam, som")
      .eq("deal_id", dealId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .schema("deal_intel")
      .from("company_fact")
      .select("fact_path, canonical_value_text, status")
      .eq("deal_id", dealId)
      .eq("status", "active")
      .order("updated_at", { ascending: false })
      .limit(200),
    admin
      .schema("deal_intel")
      .from("claim")
      .select("key, value_number, value_text, quote")
      .eq("deal_id", dealId)
      .order("created_at", { ascending: false })
      .limit(80),
    admin
      .schema("deal_intel")
      .from("deal_fact_node")
      .select("path, value_text")
      .eq("deal_id", dealId)
      .order("updated_at", { ascending: false })
      .limit(120),
  ]);

  const facts = ((factsRes.data ?? []) as Array<CompanyFactRow & { status?: string }>).filter((f) => {
    const p = (f.fact_path || "").toLowerCase();
    return (
      p.includes("traction") ||
      p.includes("solution") ||
      p.includes("problem") ||
      p.includes("revenue") ||
      p.includes("financial") ||
      p.includes("fund") ||
      p.includes("customer") ||
      p.includes("growth") ||
      p.includes("claim")
    );
  });

  const factNodes = ((nodesRes.data ?? []) as FactNodeGroundRow[]).filter((n) => {
    const p = (n.path || "").toLowerCase();
    return (
      p.includes("traction") ||
      p.includes("solution") ||
      p.includes("problem") ||
      p.includes("revenue") ||
      p.includes("financial") ||
      p.includes("fund") ||
      p.includes("customer") ||
      p.includes("growth")
    );
  });

  return {
    traction: (tractionRes.data ?? null) as TractionRow | null,
    solution: (solutionRes.data ?? null) as Record<string, unknown> | null,
    problem: (problemRes.data ?? null) as Record<string, unknown> | null,
    facts,
    claims: (claimsRes.data ?? []) as ClaimGroundRow[],
    factNodes,
  };
}

/** Flatten grounding pack into synthetic company_fact rows for LLM contradiction prompts. */
export function groundingPackToSyntheticFacts(pack: DealIntelGroundingPack): Array<{ fact_path: string; canonical_value_text: string | null }> {
  const out: Array<{ fact_path: string; canonical_value_text: string | null }> = [];

  const pushObj = (prefix: string, obj: Record<string, unknown> | null) => {
    if (!obj) return;
    for (const [k, v] of Object.entries(obj)) {
      if (v == null) continue;
      if (Array.isArray(v)) {
        const t = v.map((x) => String(x)).join(" | ");
        if (t.trim()) out.push({ fact_path: `${prefix}.${k}`, canonical_value_text: t.slice(0, 1200) });
      } else if (typeof v === "object") {
        out.push({ fact_path: `${prefix}.${k}`, canonical_value_text: JSON.stringify(v).slice(0, 1200) });
      } else {
        out.push({ fact_path: `${prefix}.${k}`, canonical_value_text: String(v).slice(0, 1200) });
      }
    }
  };

  pushObj("crm.solution", pack.solution);
  pushObj("crm.problem", pack.problem);

  if (pack.traction) {
    pushObj("crm.traction", pack.traction as unknown as Record<string, unknown>);
  }

  pack.claims.slice(0, 40).forEach((c, i) => {
    const bits = [c.quote, c.key, c.value_text, c.value_number != null ? String(c.value_number) : null].filter(Boolean).join(" | ");
    if (bits.trim()) out.push({ fact_path: `claim.ingested[${i}]`, canonical_value_text: bits.slice(0, 600) });
  });

  for (const n of pack.factNodes.slice(0, 40)) {
    if (n.value_text?.trim()) {
      out.push({ fact_path: `deal_fact_node.${n.path}`, canonical_value_text: n.value_text.slice(0, 800) });
    }
  }

  for (const f of pack.facts) {
    out.push({ fact_path: f.fact_path, canonical_value_text: f.canonical_value_text });
  }

  return out;
}

export function recordSnippetForMetric(metricKey: string, pack: DealIntelGroundingPack): { recordValue: number; recordText: string } | null {
  const fromStructured = recordValueForMetric(metricKey, {
    traction: pack.traction,
    facts: pack.facts,
  });
  if (fromStructured) return fromStructured;

  const fam = metricFamily(metricKey);
  for (const c of pack.claims) {
    const key = (c.key || "").toLowerCase();
    const quote = `${c.quote} ${c.value_text || ""}`.toLowerCase();
    const match =
      (fam === "revenue" && (key.includes("arr") || key.includes("revenue") || key.includes("mrr") || /\barr\b|\bmrr\b|\brevenue\b/.test(quote))) ||
      (fam === "funding" && (key.includes("fund") || key.includes("round") || /\braised\b|\bseries\b|\bseed\b/.test(quote))) ||
      (fam === "customers" && (key.includes("customer") || /\bcustomers?\b|\blogo\b/.test(quote))) ||
      (fam === "growth" && (key.includes("growth") || key.includes("churn") || /\bgrowth\b|\bchurn\b/.test(quote)));
    if (!match) continue;
    if (c.value_number != null && Number.isFinite(Number(c.value_number))) {
      return { recordValue: Number(c.value_number), recordText: `claim[${c.key || "key"}]: ${c.quote}`.slice(0, 260) };
    }
    const parsed = normalizeNumberFromText(`${c.value_text || ""} ${c.quote}`);
    if (parsed) return { recordValue: parsed.value, recordText: `claim[${c.key || "key"}]: ${c.quote}`.slice(0, 260) };
  }

  for (const n of pack.factNodes) {
    if (!factPathMatchesMetricFamily(fam, n.path)) continue;
    const parsed = normalizeNumberFromText(n.value_text || "");
    if (parsed) return { recordValue: parsed.value, recordText: `${n.path}: ${(n.value_text || "").slice(0, 220)}` };
  }

  return null;
}

function factPathMatchesMetricFamily(family: string, path: string): boolean {
  const p = path.toLowerCase();
  if (family === "revenue") return /\b(revenue|arr|mrr|traction|financial)\b/.test(p);
  if (family === "funding") return /\b(fund|raise|round|invest|traction|financial)\b/.test(p);
  if (family === "customers") return /\b(customer|traction|logo|user)\b/.test(p);
  if (family === "growth") return /\b(growth|churn|retention|traction)\b/.test(p);
  return true;
}
