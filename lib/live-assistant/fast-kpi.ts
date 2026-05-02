import type { ClaimIntent, ClaimSection, ClassifiedClaim } from "@/lib/live-assistant/claim-classifier";

export type NormalizedMetric = {
  key: string;
  rawValue: string;
  normalizedValue: number;
  unit: "usd" | "percent" | "count" | "unknown";
  sourceText: string;
};

export type FastSignal = {
  claims: ClassifiedClaim[];
  metrics: NormalizedMetric[];
  hasNotableEntityClaim: boolean;
  missingPrompts: string[];
};

type Pattern = { key: string; re: RegExp; unit: NormalizedMetric["unit"] };

const USD_KEYS = [
  "arr",
  "mrr",
  "revenue",
  "run_rate",
  "bookings",
  "gmv",
  "burn",
  "cash",
  "profit",
  "gross_profit",
  "net_income",
  "opex",
  "cogs",
  "capex",
  "pipeline",
  "acv",
  "arpa",
  "arpu",
  "ltv",
  "cac",
  "payback",
  "valuation",
  "round",
  "funding",
  "raised",
  "check_size",
  "tam",
  "sam",
  "som",
  "price",
  "contract_value",
  "spend",
  "budget",
  "savings",
  "margin_dollars",
  "runway_cash",
  "cash_burn",
  "gross_margin_dollars",
  "net_retention_dollars",
  "expansion",
  "retention_revenue",
  "sales",
];

const PCT_KEYS = [
  "growth",
  "mom_growth",
  "yoy_growth",
  "qoq_growth",
  "churn",
  "logo_churn",
  "nrr",
  "grr",
  "retention",
  "conversion",
  "activation",
  "engagement",
  "gross_margin",
  "net_margin",
  "ebitda_margin",
  "win_rate",
  "close_rate",
  "take_rate",
  "ctr",
  "cvr",
  "bounce_rate",
  "attach_rate",
  "adoption",
  "utilization",
  "uptime",
  "latency_reduction",
  "cost_reduction",
  "satisfaction",
  "nps",
  "csat",
  "renewal_rate",
  "expansion_rate",
  "discount_rate",
  "gross_churn",
  "net_churn",
  "margin",
  "growth_rate",
  "compounded_growth",
];

const COUNT_KEYS = [
  "customers",
  "users",
  "logos",
  "accounts",
  "seats",
  "employees",
  "fte",
  "headcount",
  "countries",
  "cities",
  "meetings",
  "calls",
  "trials",
  "pilots",
  "deployments",
  "integrations",
  "partners",
  "investors",
  "months_runway",
  "weeks_runway",
  "days_runway",
  "deals",
  "opportunities",
  "leads",
  "signups",
];

function keywordRegex(key: string): RegExp {
  const k = key.replaceAll("_", "\\s*");
  // Support comma-formatted numbers: 50,000,000 revenue; plus optional k/m/b suffix.
  // Capture group 1 becomes the numeric token for parseNumberToken (which strips commas).
  return new RegExp(`\\b(\\$?\\s*\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?\\s*(?:k|m|b)?)\\s*(?:${k})\\b`, "i");
}

function percentRegex(key: string): RegExp {
  const k = key.replaceAll("_", "\\s*");
  return new RegExp(`\\b(\\d+(?:\\.\\d+)?)\\s*%\\s*(?:${k})\\b`, "i");
}

function countRegex(key: string): RegExp {
  const k = key.replaceAll("_", "\\s*");
  return new RegExp(`\\b(\\d+(?:,\\d{3})*|\\d+(?:\\.\\d+)?\\s*(?:k|m))\\s+(?:${k})\\b`, "i");
}

const KPI_PATTERNS: Pattern[] = [
  // Hand-tuned common phrasing
  { key: "growth", re: /\b(\d+(?:\.\d+)?)\s*%\s*(?:mom|m\/m|qoq|yoy|growth)\b/i, unit: "percent" },
  { key: "runway_months", re: /\b(\d+(?:\.\d+)?)\s+(months?)\s+of\s+runway\b/i, unit: "count" },
  // Generated patterns (100+)
  ...USD_KEYS.map((k) => ({ key: k, re: keywordRegex(k), unit: "usd" as const })),
  ...PCT_KEYS.map((k) => ({ key: k, re: percentRegex(k), unit: "percent" as const })),
  ...COUNT_KEYS.map((k) => ({ key: k, re: countRegex(k), unit: "count" as const })),
];

const NOTABLE_ENTITY_RE =
  /\b(partnered with|working with|customers include|signed with|investor|investors|raised|funding|round led by|backed by)\b/i;

function parseNumberToken(token: string, unit: NormalizedMetric["unit"]): number | null {
  const raw = String(token || "").replace(/\$/g, "").replace(/,/g, "").trim().toLowerCase();
  const m = raw.match(/^(\d+(?:\.\d+)?)([kmb])?$/i);
  if (!m) return null;
  const base = Number(m[1]);
  if (!Number.isFinite(base)) return null;
  const suffix = m[2]?.toLowerCase();
  const scaled = suffix === "k" ? base * 1_000 : suffix === "m" ? base * 1_000_000 : suffix === "b" ? base * 1_000_000_000 : base;
  if (unit === "percent") return scaled / 100;
  return scaled;
}

function isFuzzy(text: string): boolean {
  const s = text.toLowerCase();
  return /\b(about|around|roughly|approximately|approx|~|nearly|close to)\b/.test(s);
}

export function confidenceForMetric(sourceText: string, metricKey: string, rawValue: string): number {
  const base = 0.85;
  const fuzzyPenalty = isFuzzy(sourceText) ? 0.15 : 0;
  const noDollarPenalty =
    ["arr", "mrr", "revenue", "funding", "raised", "valuation", "round"].includes(metricKey) && !/\$/.test(rawValue) ? 0.08 : 0;
  const shortPenalty = sourceText.trim().split(/\s+/).length < 6 ? 0.1 : 0;
  return Math.max(0.25, Math.min(0.98, base - fuzzyPenalty - noDollarPenalty - shortPenalty));
}

function inferSection(text: string): ClaimSection {
  const s = text.toLowerCase();
  if (/\b(arr|revenue|churn|growth|customers|runway|gm|margin)\b/.test(s)) return "traction";
  if (/\b(enterprise|smb|mid-market|tam|sam|som|market)\b/.test(s)) return "market";
  if (/\b(launch|roadmap|release|ship)\b/.test(s)) return "product";
  if (/\b(founder|team|hiring)\b/.test(s)) return "team";
  if (/\b(risk|concern|downside|challenge)\b/.test(s)) return "risks";
  return "other";
}

function inferIntent(text: string): ClaimIntent {
  const s = text.toLowerCase();
  if (/\d/.test(s) || /\b(arr|revenue|churn|runway|growth|users?|customers?)\b/.test(s)) return "metric";
  if (/\b(plan|will|launch|target|next quarter)\b/.test(s)) return "plan";
  if (/\b(i think|we believe|opinion)\b/.test(s)) return "opinion";
  return "claim";
}

function spokenArrOrRevenue(text: string): NormalizedMetric | null {
  const patterns: RegExp[] = [
    /\b(\d+(?:\.\d+)?)\s*(million|billion|thousand|mn|mil|bill)\b[\s\S]{0,60}?\b(?:arr|mrr|annual recurring revenue|revenue)\b/i,
    /\b(?:arr|mrr|annual recurring revenue)\b[\s\S]{0,60}?\$?\s*(\d+(?:\.\d+)?)\s*(million|billion|thousand|m|b|k)\b/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const rawNum = String(m[1] ?? "").trim();
    const base = Number(rawNum);
    if (!Number.isFinite(base)) continue;
    const w = String(m[2] ?? "").toLowerCase();
    let mult = 1;
    if (w.startsWith("million") || w === "m" || w === "mn" || w === "mil") mult = 1_000_000;
    else if (w.startsWith("billion") || w === "b") mult = 1_000_000_000;
    else if (w.startsWith("thousand") || w === "k") mult = 1_000;
    return {
      key: /\b(?:mrr)\b/i.test(m[0] || "") ? "mrr" : "arr",
      rawValue: m[0]!.slice(0, 48),
      normalizedValue: base * mult,
      unit: "usd",
      sourceText: text.slice(0, 500),
    };
  }
  return null;
}

function spokenFundingRound(text: string): NormalizedMetric | null {
  const m = text.match(
    /\b(\d+(?:\.\d+)?)\s*(million|billion|thousand|mn|mil|m|b|k)\b[\s\S]{0,55}?\b(?:raised|raising|funding|seed|series|round|valuation)\b/i,
  );
  if (!m) return null;
  const base = Number(m[1]);
  if (!Number.isFinite(base)) return null;
  const w = String(m[2] ?? "").toLowerCase();
  let mult = 1;
  if (w.startsWith("million") || w === "m" || w === "mn" || w === "mil") mult = 1_000_000;
  else if (w.startsWith("billion") || w === "b") mult = 1_000_000_000;
  else if (w.startsWith("thousand") || w === "k") mult = 1_000;
  return {
    key: "raised",
    rawValue: m[0]!.slice(0, 48),
    normalizedValue: base * mult,
    unit: "usd",
    sourceText: text.slice(0, 500),
  };
}

export function extractFastSignals(text: string): FastSignal {
  const source = String(text || "").trim();
  const metrics: NormalizedMetric[] = [];
  for (const p of KPI_PATTERNS) {
    const m = source.match(p.re);
    if (!m) continue;
    // Hard guard: never infer count metrics unless the keyword is actually present in the match.
    // Prevents mis-reads like "1B in revenue" being interpreted as "1B customers".
    if (p.unit === "count") {
      const matchText = String(m[0] ?? "").toLowerCase();
      const keyWord = p.key.replaceAll("_", " ").toLowerCase();
      if (!matchText.includes(keyWord.split(" ")[0] || p.key.toLowerCase())) continue;
    }
    const rawValue = String(m[1] ?? "").trim();
    const normalized = parseNumberToken(rawValue.replace(/\s+/g, ""), p.unit);
    if (normalized == null) continue;
    metrics.push({
      key: p.key,
      rawValue,
      normalizedValue: normalized,
      unit: p.unit,
      sourceText: source.slice(0, 500),
    });
  }

  const arrSpoken = spokenArrOrRevenue(source);
  if (arrSpoken) metrics.push(arrSpoken);
  const fundSpoken = spokenFundingRound(source);
  if (fundSpoken && !/\b(?:arr|mrr|annual recurring)\b/i.test(source)) metrics.push(fundSpoken);

  // De-dupe within the same chunk: keep the highest-magnitude instance per metric key.
  const bestByKey = new Map<string, NormalizedMetric>();
  for (const it of metrics) {
    const prev = bestByKey.get(it.key);
    if (!prev || Math.abs(it.normalizedValue) > Math.abs(prev.normalizedValue)) bestByKey.set(it.key, it);
  }
  const deduped = Array.from(bestByKey.values());

  const missingPrompts: string[] = [];
  if (/\barr|revenue|growth\b/i.test(source) && !/\bchurn\b/i.test(source)) {
    missingPrompts.push("Ask about churn to validate growth quality.");
  }
  if (/\bcustomers|users\b/i.test(source) && !/\bcac|ltv|payback\b/i.test(source)) {
    missingPrompts.push("Ask about CAC/LTV to qualify customer growth.");
  }

  return {
    claims: [
      {
        text: source.slice(0, 500),
        section: inferSection(source),
        intent: inferIntent(source),
        confidence: metrics.length ? 0.85 : 0.6,
      },
    ],
    metrics: deduped,
    hasNotableEntityClaim: NOTABLE_ENTITY_RE.test(source),
    missingPrompts,
  };
}
