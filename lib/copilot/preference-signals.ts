import "server-only";

type CategoryRule = {
  category: string;
  fields: string[];
  re: RegExp;
};

const CATEGORY_RULES: CategoryRule[] = [
  {
    category: "team",
    fields: [
      "founders",
      "founder_education",
      "founder_experience",
      "founder_achievements",
      "team_size",
      "team_cohesion",
    ],
    re: /\b(founder|co-?founder|ceo|cto|executive|leadership|team|headcount|employee|education|university|college|degree|alma mater|experience|prior role|previous company|worked at|award|patent|publication|github)\b/i,
  },
  {
    category: "company_profile",
    fields: ["headquarters", "founded_year", "company_makeup"],
    re: /\b(headquarters|hq|office|location|based in|founded|incorporated|established|company profile)\b/i,
  },
  {
    category: "funding",
    fields: ["funding", "lead_investor"],
    re: /\b(funding|raised|round|seed|series [a-z]|investor|valuation|lead investor|venture|crunchbase|pitchbook)\b/i,
  },
  {
    category: "market",
    fields: ["customers", "economic_buyer", "urgency", "market_size"],
    re: /\b(customer|client|buyer|persona|budget owner|urgency|pain|cost of inaction|tam|sam|som|market size|market opportunity)\b/i,
  },
  {
    category: "product",
    fields: ["business_model", "pricing", "product", "product_stage", "customer_benefit", "tech_stack"],
    re: /\b(product|platform|feature|pricing|plans|subscription|business model|monetization|gtm|api|docs|documentation|architecture|tech stack|beta|pilot|launched|mvp|roi|benefit)\b/i,
  },
  {
    category: "competition",
    fields: ["competitors", "defensibility"],
    re: /\b(competitor|alternative|versus| vs\.?|comparison|competition|moat|defensibility|ip|proprietary|switching cost|network effect)\b/i,
  },
  {
    category: "traction",
    fields: ["revenue", "traction"],
    re: /\b(revenue|arr|mrr|sales|growth|traction|metric|milestone|partner|logo|customer count|users)\b/i,
  },
  {
    category: "market_signals",
    fields: [],
    re: /\b(stock price|share price|ticker|market cap|nasdaq|nyse|shares?|equity|public market)\b/i,
  },
  {
    category: "risk",
    fields: ["negative_aspects", "security_certifications"],
    re: /\b(risk|red flag|negative|weakness|concern|contradiction|lawsuit|churn|security|compliance|soc ?2|iso 27001|gdpr|hipaa|trust)\b/i,
  },
];

const META_SAVE_PATTERNS: RegExp[] = [
  /\b(this|the)\s+(page|article|site|website|source|document|profile)\s+(contains|has|provides|includes|offers|shows|lists)\s+((good|useful|relevant|important)\s+)?(info|information|details|data|insight|content)\b/i,
  /\b(good|useful|relevant|important)\s+(info|information|details|data|source|page|site)\s+(about|on|for)\b/i,
  /\b(page|site|website|source|article|document)\s+is\s+(good|useful|helpful|relevant|important)\b/i,
  /\b(can|could)\s+be\s+used\s+to\s+(verify|research|learn|find|understand|explore)\b/i,
  /\b(worth|useful)\s+(checking|reviewing|visiting|exploring)\b/i,
];

function compact(parts: Array<string | null | undefined>): string {
  return parts
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .slice(0, 1000);
}

export function normalizePreferenceDomain(raw: string | null | undefined): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  let domain = value.toLowerCase();
  try {
    if (value.startsWith("http://") || value.startsWith("https://")) {
      domain = new URL(value).hostname.toLowerCase();
    }
  } catch {
    return null;
  }
  if (!domain || domain === "localhost" || domain.endsWith(".local")) return null;
  if (!domain.includes(".")) return null;
  return domain;
}

export function normalizePreferenceUrl(raw: string | null | undefined): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function inferCopilotPreferenceCategory(args: {
  summary?: string | null;
  snippet?: string | null;
  task?: string | null;
  focus?: string | null;
  kind?: string | null;
  openGapFields?: string[];
}): string {
  const text = compact([args.focus, args.task, args.summary, args.snippet, args.kind]);
  const openFields = new Set((args.openGapFields ?? []).map((f) => f.toLowerCase()));

  for (const rule of CATEGORY_RULES) {
    if (rule.fields.some((field) => openFields.has(field))) {
      if (!text || rule.re.test(text)) return rule.category;
    }
  }
  for (const rule of CATEGORY_RULES) {
    if (rule.re.test(text)) return rule.category;
  }
  return "general";
}

export function buildCopilotPreferenceTask(args: {
  companyName?: string | null;
  focus?: string | null;
  summary?: string | null;
  snippet?: string | null;
  pageTitle?: string | null;
}): string {
  const parts = [
    args.companyName ? `Company: ${args.companyName}` : null,
    args.focus ? `Focus: ${args.focus}` : null,
    args.summary,
    args.pageTitle,
    args.snippet,
  ];
  return compact(parts).slice(0, 400) || "Copilot research session";
}

export function isLowValueSaveSuggestion(args: {
  kind: string | null | undefined;
  summary: string;
  snippet: string;
}): boolean {
  if (args.kind === "explore") return false;
  if (args.kind === "contradicts" && /\bcurrent\s*:.*\bnew\s*:/i.test(args.snippet)) return false;
  const text = compact([args.summary, args.snippet]);
  if (!text) return true;
  return META_SAVE_PATTERNS.some((re) => re.test(text));
}
