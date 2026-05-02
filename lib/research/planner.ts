import { parseJsonFromResponseOrNull } from "@/lib/gemini";
import { vertexRunWithTextMulti } from "@/lib/vertex";
import { getResearchModel } from "@/lib/research/research-model-env";
import { DEFAULT_RESEARCH_SITES } from "@/lib/research/default-sites";
import {
  buildCompanyContext,
  buildResearchSeedQuery,
  computeOpenGaps,
  sortPreferredRowsForSteering,
  trustedDomainSearchUrl,
} from "@/lib/copilot/plan-next";
import type { ResearchPlanStepInput, ResearchPlanSuggestion, WebsiteCategory } from "@/lib/research/types";

type UserPref = {
  domain: string;
  category: string;
  preference_score: number;
  success_rate?: number;
  usage_count: number;
};

type PlannerCandidate = {
  website: string;
  label: string;
  category: WebsiteCategory;
  supports: string[];
  rationale: string;
  preference_score: number;
  is_preferred: boolean;
};

const BROAD_WEB_SOURCE = "web";

function toStringSafe(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asCategory(v: unknown): WebsiteCategory | undefined {
  const s = toStringSafe(v);
  if (
    s === "founder" ||
    s === "product" ||
    s === "market" ||
    s === "traction" ||
    s === "hiring" ||
    s === "legal" ||
    s === "news" ||
    s === "general"
  ) {
    return s;
  }
  return undefined;
}

function parseSuggestion(raw: string, candidates?: PlannerCandidate[]): ResearchPlanSuggestion | null {
  const parsed = parseJsonFromResponseOrNull(raw) as
    | {
        summary?: unknown;
        steps?: Array<{ website?: unknown; sourceHint?: unknown; task?: unknown; category?: unknown; dependsOnStepIds?: unknown }>;
      }
    | null;
  if (!parsed || typeof parsed !== "object") return null;

  const candidateByWebsite = new Map<string, PlannerCandidate>(
    (candidates ?? []).map((c): [string, PlannerCandidate] => [c.website.toLowerCase(), c])
  );
  const candidateByDomain = new Map<string, PlannerCandidate>();
  for (const candidate of candidates ?? []) {
    const domain = normalizeDomain(candidate.website);
    if (domain) candidateByDomain.set(domain, candidate);
  }

  const steps = Array.isArray(parsed.steps)
    ? parsed.steps
        .map((s): ResearchPlanStepInput | null => {
          const rawWebsite = (toStringSafe(s.website) || toStringSafe(s.sourceHint)).trim();
          const exact = candidateByWebsite.get(rawWebsite.toLowerCase());
          const domainMatch = rawWebsite ? candidateByDomain.get(normalizeDomain(rawWebsite)) : undefined;
          const candidate = rawWebsite && candidates?.length ? exact ?? domainMatch : undefined;
          return {
            website: rawWebsite ? candidate?.website ?? BROAD_WEB_SOURCE : BROAD_WEB_SOURCE,
            task: toStringSafe(s.task),
            category: asCategory(s.category) ?? candidate?.category,
            dependsOnStepIds: Array.isArray(s.dependsOnStepIds)
              ? s.dependsOnStepIds.filter((x): x is string => typeof x === "string")
              : [],
          };
        })
        .filter((s): s is ResearchPlanStepInput => Boolean(s))
        .filter((s) => s.task)
    : [];
  if (!steps.length) return null;
  return {
    summary: toStringSafe(parsed.summary) || "Auto-generated research plan.",
    steps,
  };
}

function fallbackFromRaw(args: {
  raw: string;
  companyName: string;
}): ResearchPlanSuggestion | null {
  const text = args.raw.trim();
  if (!text) return null;

  const lines = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);

  const enumeratedTasks: string[] = [];
  for (const line of lines) {
    const m = line.match(/^(?:\d+[.)]|[-*•])\s+(.+)$/);
    if (m && m[1]) enumeratedTasks.push(m[1].trim());
    if (enumeratedTasks.length >= 6) break;
  }

  if (enumeratedTasks.length < 3) return null;

  const steps = enumeratedTasks.map((task) => ({
    website: BROAD_WEB_SOURCE,
    task,
    category: "general" as WebsiteCategory,
    dependsOnStepIds: [] as string[],
  }));

  return {
    summary: `Recovered plan for ${args.companyName || "this company"} (model output was loosely structured).`,
    steps,
  };
}

function deterministicFallback(args: {
  companyName: string;
  candidates: PlannerCandidate[];
}): ResearchPlanSuggestion {
  const steps = args.candidates.slice(0, 5).map((candidate) => {
    const support = candidate.supports[0]?.replace(/_/g, " ") || candidate.category;
    return {
      website: BROAD_WEB_SOURCE,
      task: `Find current evidence about ${args.companyName || "the company"}'s ${support}; capture only sourced facts and note uncertainty.`,
      category: candidate.category,
      dependsOnStepIds: [],
    };
  });

  return {
    summary: `Initial plan for ${args.companyName || "this company"} based on default research strategy.`,
    steps,
  };
}

function categoryForGap(field: string): WebsiteCategory {
  if (field === "founders" || field === "founded_year") return "founder";
  if (field === "product" || field === "business_model" || field === "pricing" || field === "tech_stack") return "product";
  if (field === "competitors" || field === "headquarters") return "market";
  if (field === "funding" || field === "lead_investor" || field === "customers" || field === "revenue" || field === "traction" || field === "team_size") {
    return "traction";
  }
  if (field === "security_certifications") return "legal";
  return "general";
}

function siteCategory(domain: string, fallback: WebsiteCategory): WebsiteCategory {
  const site = DEFAULT_RESEARCH_SITES.find((s) => s.domain === domain);
  return site?.categories[0] ?? fallback;
}

function normalizeDomain(raw: string): string {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  try {
    if (s.startsWith("http://") || s.startsWith("https://")) return new URL(s).hostname.toLowerCase();
  } catch {
    // ignore
  }
  return s.startsWith("www.") ? s.slice(4) : s;
}

function buildPreferencesSummary(args: { preferred: UserPref[]; disliked?: UserPref[] }): string {
  const top = args.preferred
    .slice(0, 8)
    .map((p) => `${p.domain}${p.category ? ` (${p.category})` : ""}`)
    .join(", ");
  const disliked = (args.disliked ?? []).slice(0, 6).map((p) => p.domain).join(", ");
  return [top ? `Preferred: ${top}` : "", disliked ? `Avoid: ${disliked}` : ""].filter(Boolean).join(". ").slice(0, 600);
}

function buildPlannerCandidates(args: {
  companyName: string;
  metadata?: Record<string, unknown> | null;
  preferences: UserPref[];
  dislikedPreferences?: UserPref[];
  recentClaims?: Array<{ key?: string; value: string; source?: string }>;
  focus?: string;
}): { candidates: PlannerCandidate[]; openGapFields: string[]; preferencesSummary: string; seedQuery: string } {
  const company = buildCompanyContext({ name: args.companyName, metadata: args.metadata ?? undefined });
  const openGaps = computeOpenGaps({
    metadata: args.metadata ?? undefined,
    recentClaims: args.recentClaims ?? [],
    sessionAcceptedSnippets: [],
  });
  const gapFields = openGaps.map((g) => g.field);
  const focus = args.focus?.trim().slice(0, 600) || "";
  const preferred = sortPreferredRowsForSteering(
    args.preferences
      .filter((p) => normalizeDomain(p.domain) && Number(p.preference_score ?? 0) >= 0.05)
      .map((p) => ({ ...p, domain: normalizeDomain(p.domain), category: p.category || "general" })),
    focus || gapFields.join(" "),
  );
  const disliked = (args.dislikedPreferences ?? args.preferences.filter((p) => Number(p.preference_score ?? 0) <= -0.05))
    .map((p) => ({ ...p, domain: normalizeDomain(p.domain), category: p.category || "general" }))
    .filter((p) => p.domain);
  const dislikedDomains = new Set(disliked.map((p) => p.domain));
  const seedQuery = buildResearchSeedQuery({
    companyName: args.companyName,
    companyContext: company,
    steeringNote: focus || gapFields.slice(0, 4).join(" "),
    openGaps,
  });

  const candidates: PlannerCandidate[] = [];
  const seen = new Set<string>();
  const add = (candidate: PlannerCandidate) => {
    const key = candidate.website.toLowerCase();
    if (!candidate.website || seen.has(key)) return;
    const domain = normalizeDomain(candidate.website);
    if (domain && dislikedDomains.has(domain)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  const topGaps = openGaps.slice(0, 8);
  const defaultSupports = topGaps.length ? topGaps.slice(0, 3).map((g) => g.field) : ["general_diligence"];
  const companySupports = topGaps.slice(0, 4).map((g) => g.field);
  add({
    website: "company-website",
    label: "Company website",
    category: "product",
    supports: companySupports.length ? companySupports : defaultSupports,
    rationale: "First-party source for product, customers, pricing, positioning, and official leadership claims.",
    preference_score: 0,
    is_preferred: false,
  });

  for (const pref of preferred.slice(0, 10)) {
    const matchingGaps = topGaps.filter((g) => categoryForGap(g.field) === pref.category).map((g) => g.field);
    const searchUrl = trustedDomainSearchUrl(pref.domain, seedQuery);
    add({
      website: searchUrl ?? pref.domain,
      label: pref.domain,
      category: asCategory(pref.category) ?? "general",
      supports: matchingGaps.length ? matchingGaps : defaultSupports,
      rationale: `User-preferred source for ${pref.category || "general"} diligence.`,
      preference_score: Number(pref.preference_score ?? 0),
      is_preferred: true,
    });
  }

  for (const site of DEFAULT_RESEARCH_SITES) {
    if (site.domain === "company-website") continue;
    const domain = normalizeDomain(site.domain);
    if (!domain || dislikedDomains.has(domain)) continue;
    const supportGaps = topGaps.filter((g) => site.categories.includes(categoryForGap(g.field))).map((g) => g.field);
    const searchUrl = trustedDomainSearchUrl(site.domain, seedQuery);
    add({
      website: searchUrl ?? site.domain,
      label: site.label,
      category: siteCategory(site.domain, supportGaps[0] ? categoryForGap(supportGaps[0]) : "general"),
      supports: supportGaps.length ? supportGaps : defaultSupports,
      rationale: site.useCases.join("; "),
      preference_score: 0,
      is_preferred: false,
    });
  }

  const preferencesSummary = buildPreferencesSummary({ preferred, disliked });
  return {
    candidates: candidates.slice(0, 18),
    openGapFields: gapFields,
    preferencesSummary,
    seedQuery,
  };
}

export async function generateResearchPlan(args: {
  companyName: string;
  companyContext: string;
  metadata?: Record<string, unknown> | null;
  preferences: UserPref[];
  dislikedPreferences?: UserPref[];
  recentClaims?: Array<{ key?: string; value: string; source?: string }>;
  focus?: string;
}): Promise<ResearchPlanSuggestion> {
  const focus = args.focus?.trim().slice(0, 600) || "";
  const plannerContext = buildPlannerCandidates({
    companyName: args.companyName,
    metadata: args.metadata,
    preferences: args.preferences,
    dislikedPreferences: args.dislikedPreferences,
    recentClaims: args.recentClaims,
    focus,
  });

  const prompt = `You are creating an auto-research plan for one startup diligence workflow.

Use the same source-selection style as an autonomous browsing copilot: choose the next high-yield source/search target based on open research gaps, source quality, prior user preferences, and what each site is actually good for. The executor will use Google Search grounding/server-side browsing; do not describe UI navigation.

Return strict JSON only with shape:
{
  "summary": "string",
  "steps": [
    {
      "website": "optional domain-or-site-hint, or omit/blank for broad web research",
      "task": "clear task instruction",
      "category": "founder|product|market|traction|hiring|legal|news|general",
      "dependsOnStepIds": []
    }
  ]
}
Rules:
- Produce 4-7 research substeps. They should usually be source-agnostic tasks, not website tasks.
- Each task must be a clear, answerable research question for this exact company.
- Tie every task to a real open gap or hypothesis; avoid vague "look into X" work.
- When User focus is present, make the plan primarily serve that request while still choosing credible sources.
- If open gaps are empty, pressure-test current records with high-signal sources instead of inventing gaps.
- Leave website omitted/blank unless the step truly needs a specific source or source family.
- When website is present, choose only from Candidate source hints and make the task require that source.
- If you need the company's own website, use "company-website".`;

  let raw = "";
  try {
    raw = await vertexRunWithTextMulti(
      getResearchModel("flash"),
      prompt,
      [
        { label: "Company name", value: args.companyName || "Unknown" },
        { label: "Known company context", value: args.companyContext || "No context available yet." },
        { label: "User focus", value: focus || "No specific focus; choose the best next diligence plan." },
        { label: "Open research gaps", value: plannerContext.openGapFields },
        { label: "Candidate source hints for source-constrained steps", value: plannerContext.candidates },
        { label: "User website preferences summary", value: plannerContext.preferencesSummary || "No learned source preferences yet." },
        { label: "Search seed query", value: plannerContext.seedQuery },
      ],
      false
    );
    const parsed = parseSuggestion(raw, plannerContext.candidates);
    if (parsed) return parsed;

    const recovered = fallbackFromRaw({
      raw,
      companyName: args.companyName,
    });
    if (recovered) return recovered;
  } catch {
    // Fall through to deterministic fallback below
  }

  return deterministicFallback({
    companyName: args.companyName,
    candidates: plannerContext.candidates,
  });
}
