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
import {
  profileMaxSteps,
  profilePlannerModelTier,
  type ResearchProfile,
} from "@/lib/research/mode-router";
import type { ResearchPlanScope, ResearchPlanStepInput, ResearchPlanSuggestion, WebsiteCategory } from "@/lib/research/types";
import {
  DEAL_INTEL_LAYER1A_SCHEMA_GUIDE,
  DEAL_INTEL_RESEARCH_FOCUS_GUIDE,
  USER_PREFERENCE_GUARDRAILS,
} from "@/lib/deal-intel/prompt-guidance";
import { stripMarkdownText } from "@/lib/plain-text";

type UserPref = {
  domain: string;
  category: string;
  preference_score: number;
  success_rate?: number;
  usage_count: number;
  focus_guidance?: string;
  confidence?: number;
  recency_weight?: number;
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

type ResearchPlanIntent = ResearchPlanScope;

/** Prefer a capable model for intent + review; keeps plans from collapsing into generic one-liners. */
function researchPlannerReasoningModel(): string {
  try {
    return getResearchModel("flash");
  } catch {
    return getResearchModel("flash_lite");
  }
}

const BROAD_WEB_SOURCE = "web";
const ALL_CATEGORIES: WebsiteCategory[] = ["founder", "product", "market", "traction", "hiring", "legal", "news", "general"];
const BROAD_PLAN_SOFT_LIMIT = Number(process.env.RESEARCH_PLANNER_BROAD_MAX_STEPS || 14);

const CATEGORY_TOPIC_HINTS: Record<WebsiteCategory, string[]> = {
  founder: ["founder", "team", "leadership", "education", "university", "school", "career", "background", "achievement"],
  product: ["product", "solution", "technology", "technical", "patent", "ip", "moat", "defensibility", "pricing"],
  market: ["market", "competitor", "competition", "customer", "buyer", "problem", "tam", "sam", "som", "alternative", "substitute"],
  traction: ["traction", "revenue", "funding", "investor", "backer", "cap table", "overlap", "round", "valuation", "customer", "partner", "growth"],
  hiring: ["hiring", "headcount", "employee", "team size", "open roles", "recruiting"],
  legal: ["legal", "risk", "negative", "lawsuit", "compliance", "security", "privacy", "regulatory", "patent", "ip"],
  news: ["news", "announcement", "press", "recent", "latest"],
  general: ["overview", "summary", "everything", "deep research", "diligence"],
};

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

function isCompanyNameSourceHint(raw: string, companyNames: string[]): boolean {
  const hint = stripMarkdownText(raw).trim().toLowerCase().replace(/\s+/g, " ");
  if (!hint) return false;
  // If the hint is literally "web" or "company-website", it's valid.
  if (hint === "web" || hint === "company-website") return false;
  // If the hint has a space and no dot, it's almost certainly a company name hallucinated as a source
  if (hint.includes(" ") && !hint.includes(".")) return true;
  // If it matches a known peer/company name exactly or contains it
  return companyNames.some((name) => {
    const normalized = name.trim().toLowerCase().replace(/\s+/g, " ");
    return normalized.length >= 2 && (hint === normalized || hint.includes(normalized));
  });
}

function normalizePlannerWebsiteHint(args: {
  rawWebsite: string;
  candidates?: PlannerCandidate[];
  companyName?: string;
  peerCompanyNames?: string[];
}): { website: string; candidate?: PlannerCandidate } {
  const rawWebsite = args.rawWebsite.trim();
  if (!rawWebsite) return { website: BROAD_WEB_SOURCE };
  const companyNames = [args.companyName ?? "", ...(args.peerCompanyNames ?? [])].filter(Boolean);
  if (isCompanyNameSourceHint(rawWebsite, companyNames)) return { website: BROAD_WEB_SOURCE };
  const candidateByWebsite = new Map<string, PlannerCandidate>(
    (args.candidates ?? []).map((c): [string, PlannerCandidate] => [c.website.toLowerCase(), c])
  );
  const candidateByDomain = new Map<string, PlannerCandidate>();
  for (const candidate of args.candidates ?? []) {
    const domain = normalizeDomain(candidate.website);
    if (domain) candidateByDomain.set(domain, candidate);
  }
  const exact = candidateByWebsite.get(rawWebsite.toLowerCase());
  const domainMatch = candidateByDomain.get(normalizeDomain(rawWebsite));
  const candidate = rawWebsite && args.candidates?.length ? exact ?? domainMatch : undefined;
  return { website: candidate?.website ?? BROAD_WEB_SOURCE, candidate };
}

function parseSuggestion(raw: string, candidates?: PlannerCandidate[], companyName?: string, peerCompanyNames?: string[]): ResearchPlanSuggestion | null {
  const parsed = parseJsonFromResponseOrNull(raw) as
    | {
        summary?: unknown;
        steps?: Array<{ website?: unknown; sourceHint?: unknown; task?: unknown; category?: unknown; dependsOnStepIds?: unknown }>;
      }
    | null;
  if (!parsed || typeof parsed !== "object") return null;

  const steps = Array.isArray(parsed.steps)
    ? parsed.steps
        .map((s): ResearchPlanStepInput | null => {
          const rawWebsite = (toStringSafe(s.website) || toStringSafe(s.sourceHint)).trim();
          const { website, candidate } = normalizePlannerWebsiteHint({ rawWebsite, candidates, companyName, peerCompanyNames });
          return {
            website,
            task: stripMarkdownText(toStringSafe(s.task)),
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
  const co = (companyName ?? "").trim();
  return {
    summary:
      stripMarkdownText(toStringSafe(parsed.summary)) ||
      (co ? `Research steps for ${co} (structured plan).` : "Research plan."),
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
    if (enumeratedTasks.length >= 12) break;
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
  focus?: string;
  intent?: ResearchPlanIntent;
  openGapFields?: string[];
}): ResearchPlanSuggestion {
  const focus = args.focus?.trim();
  const co = (args.companyName || "this company").trim() || "this company";
  const maxSteps = args.intent?.maxSteps ?? 5;
  const gaps = (args.openGapFields ?? []).map((g) => g.trim()).filter(Boolean);

  if (gaps.length && !focus) {
    const steps = gaps.slice(0, maxSteps).map((field) => ({
      website: BROAD_WEB_SOURCE,
      task: `For ${co}, find current sourced evidence for ${field.replace(/_/g, " ")}; capture primary URLs, dates, and any conflicts with saved records.`,
      category: categoryForGap(field),
      dependsOnStepIds: [] as string[],
    }));
    return {
      summary: `Targeted plan for ${co}: close open schema gaps (${gaps.slice(0, maxSteps).map((g) => g.replace(/_/g, " ")).join(", ")}).`,
      steps,
    };
  }

  const fallbackCandidate: PlannerCandidate = {
    website: BROAD_WEB_SOURCE,
    label: "Web",
    category: args.intent?.allowedCategories[0] ?? "general",
    supports: args.intent?.requiredTopics.length ? args.intent.requiredTopics : ["focused_user_request"],
    rationale: "Broad web research fallback.",
    preference_score: 0,
    is_preferred: false,
  };
  const candidates = args.candidates.length ? args.candidates : [fallbackCandidate];
  const steps = candidates.slice(0, maxSteps).map((candidate) => {
    const support = candidate.supports[0]?.replace(/_/g, " ") || candidate.category;
    return {
      website: BROAD_WEB_SOURCE,
      task: focus
        ? `For ${co}, find sourced evidence that directly answers: ${focus}. Map findings to Deal Intel fields; note uncertainty and contradictions.`
        : `For ${co}, find sourced evidence on ${support} (${candidate.label || candidate.category}); cite primary pages and dates.`,
      category: candidate.category,
      dependsOnStepIds: [],
    };
  });

  return {
    summary: focus
      ? `Plan for ${co}: ${focus.slice(0, 200)}${focus.length > 200 ? "…" : ""}`
      : `Initial plan for ${co}: default source-guided passes on open diligence areas.`,
    steps,
  };
}

function categoryForGap(field: string): WebsiteCategory {
  if (field === "founders" || field === "founder_education" || field === "founder_experience" || field === "founder_achievements" || field === "team_cohesion" || field === "founded_year") return "founder";
  if (field === "product" || field === "product_stage" || field === "business_model" || field === "pricing" || field === "tech_stack" || field === "customer_benefit" || field === "defensibility") return "product";
  if (field === "competitors" || field === "headquarters" || field === "market_size" || field === "economic_buyer" || field === "urgency") return "market";
  if (field === "funding" || field === "lead_investor" || field === "customers" || field === "revenue" || field === "traction" || field === "team_size") {
    return "traction";
  }
  if (field === "security_certifications") return "legal";
  if (field === "negative_aspects") return "general";
  return "general";
}

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function stepBudgetForBreadth(breadth: ResearchPlanIntent["breadth"]): number {
  if (breadth === "broad") return Math.max(12, BROAD_PLAN_SOFT_LIMIT);
  if (breadth === "standard") return 6;
  return 3;
}

function capIntentSteps(intent: ResearchPlanIntent, profile: ResearchProfile = "standard"): ResearchPlanIntent {
  const profileCap = profileMaxSteps(profile);
  const budget = Math.min(stepBudgetForBreadth(intent.breadth), profileCap);
  let minSteps = profile === "fast" ? 1 : 2;
  if (intent.breadth === "standard") minSteps = profile === "fast" ? 1 : 3;
  if (intent.breadth === "broad") minSteps = profile === "fast" ? 2 : profile === "standard" ? 3 : 5;
  const capped = {
    ...intent,
    maxSteps: intent.breadth === "broad"
      ? Math.max(minSteps, Number.isFinite(intent.maxSteps) ? Math.round(intent.maxSteps) : budget)
      : clampInt(intent.maxSteps, minSteps, budget),
  };
  return {
    ...capped,
    maxSteps: Math.min(capped.maxSteps, profileCap),
    breadth: profile === "fast" && capped.breadth === "broad" ? "standard" : capped.breadth,
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueCleanStrings(values: unknown[], max = 16): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const s = stripMarkdownText(toStringSafe(value)).trim().replace(/\s+/g, " ");
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s.slice(0, 160));
    if (out.length >= max) break;
  }
  return out;
}

function inferCategoriesFromText(text: string): WebsiteCategory[] {
  const lower = text.toLowerCase();
  if (!lower.trim()) return [];
  const categories: WebsiteCategory[] = [];
  for (const category of ALL_CATEGORIES) {
    if (CATEGORY_TOPIC_HINTS[category].some((hint) => lower.includes(hint))) categories.push(category);
  }
  return categories;
}

function extractTopicHints(text: string): string[] {
  const lower = text.toLowerCase();
  const hints: string[] = [];
  for (const terms of Object.values(CATEGORY_TOPIC_HINTS)) {
    for (const term of terms) {
      if (lower.includes(term)) hints.push(term);
    }
  }
  return uniqueCleanStrings(hints, 14);
}

function topicNeedlesForIntent(intent: ResearchPlanIntent): string[] {
  const text = [intent.userGoal, ...intent.requiredTopics].join(" ");
  return uniqueCleanStrings(extractTopicHints(text), 18)
    .map((x) => x.toLowerCase())
    .filter((x) => x.length >= 3);
}

const TASK_DEDUPE_STOPWORDS = new Set([
  "about",
  "against",
  "available",
  "based",
  "capture",
  "check",
  "company",
  "current",
  "directly",
  "evidence",
  "exact",
  "find",
  "from",
  "into",
  "research",
  "search",
  "source",
  "sources",
  "startup",
  "that",
  "this",
  "user",
  "using",
  "verify",
  "with",
]);

const TASK_CONCEPT_GROUPS: Array<{ key: string; terms: string[] }> = [
  { key: "competitors", terms: ["competitor", "competitors", "competition", "alternative", "alternatives", "substitute", "substitutes", "similar product", "similar products"] },
  { key: "investors", terms: ["investor", "investors", "backer", "backers", "cap table", "funding", "round", "common investor", "overlap"] },
  { key: "patents", terms: ["patent", "patents", "ip", "intellectual property", "filing", "filings"] },
  { key: "product", terms: ["product", "solution", "technology", "platform", "architecture", "differentiator", "differentiation"] },
  { key: "customers", terms: ["customer", "customers", "buyer", "buyers", "partner", "partners"] },
  { key: "traction", terms: ["traction", "revenue", "growth", "usage", "deployment", "deployments"] },
  { key: "founders", terms: ["founder", "founders", "team", "leadership", "background", "education"] },
  { key: "risk", terms: ["risk", "risks", "negative", "concern", "concerns", "lawsuit", "regulatory"] },
];

function normalizedTaskText(text: string): string {
  return stripMarkdownText(text)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function taskConceptSignature(step: ResearchPlanStepInput): string {
  const text = normalizedTaskText(`${step.task} ${step.website || ""} ${step.category || ""}`);
  const concepts = TASK_CONCEPT_GROUPS
    .filter((group) => group.terms.some((term) => text.includes(term)))
    .map((group) => group.key);
  if (concepts.length) return Array.from(new Set(concepts)).sort().join("+");

  const tokens = text
    .split(" ")
    .filter((token) => token.length >= 4 && !TASK_DEDUPE_STOPWORDS.has(token))
    .slice(0, 8)
    .sort();
  return `${step.category || "general"}:${tokens.join("+") || text.slice(0, 80)}`;
}

function isExplicitFollowUpTask(task: string): boolean {
  return /\b(follow[- ]?up|newly found|newly discovered|after finding|after identifying|resolve|cross[- ]?check|pressure[- ]?test|validate|verify (?:the|whether|if).{0,80}(?:claim|conflict|discrepancy|source|filing|patent|investor|competitor))\b/i.test(task);
}

function dedupeResearchSteps(steps: ResearchPlanStepInput[]): ResearchPlanStepInput[] {
  const seen = new Set<string>();
  const out: ResearchPlanStepInput[] = [];
  for (const step of steps) {
    const signature = taskConceptSignature(step);
    if (seen.has(signature) && !isExplicitFollowUpTask(step.task)) continue;
    seen.add(signature);
    out.push(step);
  }
  return out;
}

function extractExplicitExclusions(text: string): string[] {
  const lower = text.toLowerCase();
  const excluded: string[] = [];
  const prefix = "(?:do not|don't|dont|skip|exclude|without|no need for|not interested in)";
  for (const [category, terms] of Object.entries(CATEGORY_TOPIC_HINTS) as Array<[WebsiteCategory, string[]]>) {
    if (terms.some((term) => new RegExp(`${prefix}[^.!?]{0,80}\\b${escapeRegExp(term)}\\b`).test(lower))) {
      excluded.push(category, ...terms.slice(0, 4));
    }
  }
  return uniqueCleanStrings(excluded, 12);
}

/** Sync planner intent (no LLM) — used for fast chat web checks and query shaping. */
export function inferLightweightResearchIntent(args: {
  message: string;
  openGapFields?: string[];
}): Pick<
  ResearchPlanIntent,
  "userGoal" | "requiredTopics" | "allowedCategories" | "excludedTopics" | "includeRiskCheck" | "mustCompare"
> {
  const intent = defaultIntent({
    focus: args.message.trim().slice(0, 1800),
    openGapFields: args.openGapFields ?? [],
  });
  return {
    userGoal: intent.userGoal,
    requiredTopics: intent.requiredTopics,
    allowedCategories: intent.allowedCategories,
    excludedTopics: intent.excludedTopics,
    includeRiskCheck: intent.includeRiskCheck,
    mustCompare: intent.mustCompare,
  };
}

function defaultIntent(args: {
  focus: string;
  openGapFields: string[];
}): ResearchPlanIntent {
  const focus = args.focus.trim();
  const broad = !focus || /\b(everything|full|complete|comprehensive|deep dive|deep research|all fields|all schema|general diligence)\b/i.test(focus);
  const inferred = inferCategoriesFromText(focus);
  const gapCategories = args.openGapFields.map(categoryForGap);
  const allowedCategories = broad
    ? ALL_CATEGORIES
    : uniqueCleanStrings([...(inferred.length ? inferred : gapCategories.slice(0, 5))], 8)
        .map((c) => asCategory(c))
        .filter((c): c is WebsiteCategory => Boolean(c));
  const finalCategories = allowedCategories.length ? allowedCategories : (["general"] as WebsiteCategory[]);
  const requiredTopics = focus ? uniqueCleanStrings([...extractTopicHints(focus), focus], 10) : args.openGapFields.slice(0, 8);

  return capIntentSteps(
    {
    userGoal: focus || "Fill the highest-signal open diligence gaps for this company.",
    breadth: broad ? "broad" : finalCategories.length <= 2 ? "narrow" : "standard",
    requiredTopics,
    excludedTopics: extractExplicitExclusions(focus),
    allowedCategories: finalCategories,
    sourceStrategy: "Use user-preferred sources only when they fit the inferred task categories and avoid disliked sources.",
    maxSteps: broad ? 8 : finalCategories.length <= 2 ? 3 : 6,
    includeRiskCheck: /\b(risk|negative|red flag|concern|lawsuit|compliance|security|privacy|regulatory)\b/i.test(focus),
    mustCompare: /\b(compare|versus| vs |similar|overlap|common|between|against|alternative|competitor)\b/i.test(focus),
  },
    "standard",
  );
}

function parseIntent(raw: string, fallback: ResearchPlanIntent): ResearchPlanIntent | null {
  const parsed = parseJsonFromResponseOrNull(raw) as
    | {
        userGoal?: unknown;
        breadth?: unknown;
        requiredTopics?: unknown;
        excludedTopics?: unknown;
        allowedCategories?: unknown;
        sourceStrategy?: unknown;
        maxSteps?: unknown;
        includeRiskCheck?: unknown;
        mustCompare?: unknown;
      }
    | null;
  if (!parsed || typeof parsed !== "object") return null;

  const breadthRaw = toStringSafe(parsed.breadth);
  const breadth: ResearchPlanIntent["breadth"] =
    breadthRaw === "narrow" || breadthRaw === "standard" || breadthRaw === "broad" ? breadthRaw : fallback.breadth;
  const allowed = Array.isArray(parsed.allowedCategories)
    ? parsed.allowedCategories
        .map((c) => asCategory(c))
        .filter((c): c is WebsiteCategory => Boolean(c))
    : [];
  const allowedCategories = allowed.length ? Array.from(new Set(allowed)) : fallback.allowedCategories;
  const parsedMax = Number(parsed.maxSteps ?? fallback.maxSteps);
  const maxSteps = breadth === "broad"
    ? Math.max(4, Number.isFinite(parsedMax) ? Math.round(parsedMax) : fallback.maxSteps)
    : clampInt(parsedMax, 1, stepBudgetForBreadth(breadth));

  return capIntentSteps({
    userGoal: stripMarkdownText(toStringSafe(parsed.userGoal)).trim() || fallback.userGoal,
    breadth,
    requiredTopics: uniqueCleanStrings(Array.isArray(parsed.requiredTopics) ? parsed.requiredTopics : fallback.requiredTopics, 16),
    excludedTopics: uniqueCleanStrings(Array.isArray(parsed.excludedTopics) ? parsed.excludedTopics : fallback.excludedTopics, 16),
    allowedCategories,
    sourceStrategy: stripMarkdownText(toStringSafe(parsed.sourceStrategy)).trim() || fallback.sourceStrategy,
    maxSteps,
    includeRiskCheck: typeof parsed.includeRiskCheck === "boolean" ? parsed.includeRiskCheck : fallback.includeRiskCheck,
    mustCompare: typeof parsed.mustCompare === "boolean" ? parsed.mustCompare : fallback.mustCompare,
  });
}

async function deriveResearchIntent(args: {
  companyName: string;
  metadata?: Record<string, unknown> | null;
  recentClaims?: Array<{ key?: string; value: string; source?: string }>;
  focus: string;
  preferencesSummary: string;
  researchProfile?: ResearchProfile;
}): Promise<ResearchPlanIntent> {
  const profile = args.researchProfile ?? "standard";
  const openGaps = computeOpenGaps({
    metadata: args.metadata ?? undefined,
    recentClaims: args.recentClaims ?? [],
    sessionAcceptedSnippets: [],
  });
  const fallback = capIntentSteps(
    defaultIntent({
      focus: args.focus,
      openGapFields: openGaps.map((g) => g.field),
    }),
    profile,
  );
  if (profile === "fast" && process.env.RESEARCH_ENABLE_LLM_INTENT !== "1") {
    return fallback;
  }
  if (process.env.RESEARCH_ENABLE_LLM_INTENT !== "1") {
    return fallback;
  }
  const prompt = `You are the intent and pruning layer for a VC research planner.

Before planning research, infer what the user actually needs. The output controls which schema buckets, source families, and research tasks are allowed. This must be generalized: do not use a fixed diligence checklist unless the user asked for broad diligence.

Return strict JSON only:
{
  "userGoal": "plain text description of the exact user request",
  "breadth": "narrow|standard|broad",
  "requiredTopics": ["topics that must be answered"],
  "excludedTopics": ["topics or schema areas that would be unnecessary noise"],
  "allowedCategories": ["founder|product|market|traction|hiring|legal|news|general"],
  "sourceStrategy": "how user preferences should steer source choice without changing scope",
  "maxSteps": 1,
  "includeRiskCheck": false,
  "mustCompare": false
}

Rules:
- Narrow asks should stay narrow. Standard asks can combine adjacent topics. Broad asks are only for requests like full diligence, everything, comprehensive, or deep research.
- allowedCategories must include only task/source families needed to answer the userGoal.
- excludedTopics should name schema areas that should not be researched for this prompt.
- Classify named companies by role. If a company is named only as a matrix row, benchmark row, peer reference, or common-investor counterpart, do not turn that company into a product, founder, market, or competitor research target.
- For competitor requests, only companies explicitly framed as competitors, alternatives, substitutes, or similar products should drive competitor/product research. Other named companies should stay limited to the role the user gave them.
- A matrix, table, or side-by-side output request changes the output format/tool choice; it does not expand the research scope.
- Use user source preferences for source selection and evidence style only; never expand the research scope just because a preferred website exists.
- For narrow asks, use 2-3 maxSteps. For standard asks, 3-6 steps. For broad/deep asks, use 5-12 steps. Never produce 1-2 giant vague steps.
- userGoal must name the company (or "this company" if unknown) and state the **deliverable** in plain language (what will be verified, mapped, or decided) — not "do diligence" or "research the startup."
- Use plain text only inside JSON strings; do not use formatting markers.`;

  try {
    const raw = await vertexRunWithTextMulti(
      researchPlannerReasoningModel(),
      prompt,
      [
        { label: "Company name", value: args.companyName || "Unknown" },
        { label: "User focus", value: args.focus || "No explicit focus." },
        { label: "Open research gaps with categories", value: openGaps.map((g) => ({ field: g.field, category: categoryForGap(g.field) })) },
        { label: "Known metadata keys", value: Object.keys(args.metadata ?? {}).slice(0, 80) },
        { label: "User website preferences summary", value: args.preferencesSummary || "No learned source preferences yet." },
        { label: "Fallback intent", value: fallback },
      ],
      false,
    );
    const parsed = parseIntent(raw, fallback);
    return parsed ? capIntentSteps(parsed, profile) : fallback;
  } catch {
    return fallback;
  }
}

function filterSuggestionForIntent(suggestion: ResearchPlanSuggestion, intent: ResearchPlanIntent): ResearchPlanSuggestion {
  const allowed = new Set(intent.allowedCategories);
  const excluded = uniqueCleanStrings(intent.excludedTopics, 16).map((x) => x.toLowerCase());
  const topicNeedles = topicNeedlesForIntent(intent);

  const filtered = suggestion.steps.filter((step) => {
    const category = step.category ?? "general";
    const searchable = [step.task, step.website, category].join(" ").toLowerCase();
    if (excluded.some((term) => searchable.includes(term))) return false;
    if (intent.breadth === "broad") return true;
    const directTopicHit = topicNeedles.some((term) => searchable.includes(term));
    if (!topicNeedles.length) return allowed.has(category);
    if (intent.breadth === "narrow") return directTopicHit;
    return directTopicHit || (allowed.has(category) && category === "general");
  });

  const scopedFallback = suggestion.steps.filter((step) => intent.breadth === "broad" || allowed.has(step.category ?? "general"));
  const steps = dedupeResearchSteps(filtered.length ? filtered : scopedFallback.length ? scopedFallback : suggestion.steps.slice(0, 1));
  const cappedSteps = intent.breadth === "broad" ? steps : steps.slice(0, intent.maxSteps);
  return {
    summary: suggestion.summary,
    steps: cappedSteps,
  };
}

async function reviewResearchPlan(args: {
  companyName: string;
  intent: ResearchPlanIntent;
  suggestion: ResearchPlanSuggestion;
  candidates: PlannerCandidate[];
  preferencesSummary: string;
  peerCompanyNames?: string[];
  researchProfile?: ResearchProfile;
}): Promise<ResearchPlanSuggestion> {
  const profile = args.researchProfile ?? "standard";
  if (profile === "fast" || process.env.RESEARCH_ENABLE_LLM_PLAN_REVIEW !== "1") {
    return filterSuggestionForIntent(args.suggestion, args.intent);
  }
  const prompt = `You are the lightweight review and pruning agent for a VC research plan.

Your job is to review each draft task independently so the plan answers the research intent exactly, with no unrelated work.

Return strict JSON only:
{
  "summary": "plain text with no formatting markers",
  "steps": [
    {
      "website": "domain, source hint, or web",
      "task": "plain text task",
      "category": "founder|product|market|traction|hiring|legal|news|general",
      "dependsOnStepIds": []
    }
  ]
}

Rules:
- The draft plan has already passed cheap keyword and category filtering. Your job is the semantic gate: keep, narrow, or remove each task based on that task's relevance — not collapse the whole plan into vague one-liners.
- Keep only steps necessary for intent.userGoal.
- When intent.breadth is **broad** and the draft has multiple **materially different** angles (e.g. team vs funding vs product), keep **at least two** distinct steps unless they are true duplicates.
- Remove steps covered by intent.excludedTopics.
- Stay within intent.allowedCategories unless a step directly answers one of intent.requiredTopics.
- If a step would merely help understand the whole company, remove it unless the user asked for broad diligence.
- If a named company is only present as a matrix row, peer reference, benchmark row, or common-investor counterpart, remove steps that compare its product, market, founders, or technology unless intent.requiredTopics explicitly asks for that comparison.
- Do not research how two companies compare just because both are named. Compare only the dimensions requested by intent.userGoal.
- Treat matrix/table output as an output format request, not as permission to add broad comparison dimensions.
- Remove duplicate steps that research the same concept from the same angle. If a second pass is genuinely needed because it follows up on a new hypothesis, contradiction, missing source, or newly found entity, the task text must say what changed and what the new angle is.
- For narrow asks, keep 2-3 focused steps. For standard asks, 3-6 steps. For broad/deep asks, 5-12 steps. Never produce 1-2 giant vague steps.
- Preserve user website preferences when they fit the intent, but never let preferences add irrelevant topics.
- Never use a company name as the website/source hint. If a step is not constrained to a real source family or candidate hint, use "web".
- Peer/benchmark company names are not source hints and should not appear in the website field.
- Every task must be directly answerable, company-specific, and useful to the final answer.
- summary must **start with the company name** and state what this plan will **produce** (outcome), not generic "research" language.
- Use plain text only inside JSON strings; do not use formatting markers.`;
  try {
    const raw = await vertexRunWithTextMulti(
      researchPlannerReasoningModel(),
      prompt,
      [
        { label: "Company name", value: args.companyName || "Unknown" },
        { label: "Research intent", value: args.intent },
        { label: "Draft plan", value: args.suggestion },
        { label: "Candidate source hints", value: args.candidates },
        { label: "Peer or benchmark company names that must not be source hints", value: args.peerCompanyNames ?? [] },
        { label: "User website preferences summary", value: args.preferencesSummary || "No learned source preferences yet." },
      ],
      false,
    );
    const parsed = parseSuggestion(raw, args.candidates, args.companyName, args.peerCompanyNames);
    return filterSuggestionForIntent(parsed ?? args.suggestion, args.intent);
  } catch {
    return filterSuggestionForIntent(args.suggestion, args.intent);
  }
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
    .map((p) => {
      const guidance = p.focus_guidance ? `: ${p.focus_guidance}` : "";
      return `${p.domain}${p.category ? ` (${p.category})` : ""}${guidance}`;
    })
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
  intent: ResearchPlanIntent;
}): { candidates: PlannerCandidate[]; openGapFields: string[]; preferencesSummary: string; seedQuery: string } {
  const company = buildCompanyContext({ name: args.companyName, metadata: args.metadata ?? undefined });
  const openGaps = computeOpenGaps({
    metadata: args.metadata ?? undefined,
    recentClaims: args.recentClaims ?? [],
    sessionAcceptedSnippets: [],
  });
  const focus = args.focus?.trim().slice(0, 1800) || "";
  const allowedCategories = new Set(args.intent.allowedCategories);
  const broadIntent = args.intent.breadth === "broad" || !allowedCategories.size;
  const relevantOpenGaps = broadIntent ? openGaps : openGaps.filter((g) => allowedCategories.has(categoryForGap(g.field)));
  const gapFields = relevantOpenGaps.map((g) => g.field);
  const steeringText = [
    args.intent.userGoal,
    args.intent.requiredTopics.join(" "),
    gapFields.slice(0, 8).join(" "),
  ]
    .filter(Boolean)
    .join(" ");
  const preferred = sortPreferredRowsForSteering(
    args.preferences
      .filter((p) => normalizeDomain(p.domain) && Number(p.preference_score ?? 0) >= 0.05)
      .map((p) => ({ ...p, domain: normalizeDomain(p.domain), category: asCategory(p.category) ?? "general" }))
      .filter((p) => broadIntent || p.category === "general" || allowedCategories.has(p.category)),
    steeringText,
  );
  const disliked = (args.dislikedPreferences ?? args.preferences.filter((p) => Number(p.preference_score ?? 0) <= -0.05))
    .map((p) => ({ ...p, domain: normalizeDomain(p.domain), category: p.category || "general" }))
    .filter((p) => p.domain);
  const dislikedDomains = new Set(disliked.map((p) => p.domain));
  const seedQuery = buildResearchSeedQuery({
    companyName: args.companyName,
    companyContext: company,
    steeringNote: focus || args.intent.userGoal || gapFields.slice(0, 4).join(" "),
    openGaps: relevantOpenGaps,
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

  const topGaps = relevantOpenGaps.slice(0, 8);
  const defaultSupports = topGaps.length
    ? topGaps.slice(0, 3).map((g) => g.field)
    : args.intent.requiredTopics.length
      ? args.intent.requiredTopics.slice(0, 3)
      : ["focused_user_request"];
  const companySupports = topGaps.slice(0, 4).map((g) => g.field);
  const companyWebsiteFits =
    broadIntent ||
    allowedCategories.has("product") ||
    allowedCategories.has("market") ||
    allowedCategories.has("traction") ||
    allowedCategories.has("general") ||
    /\b(first-party|company website|website|pricing|product|customer|positioning)\b/i.test(args.intent.userGoal);
  if (companyWebsiteFits) {
    add({
      website: "company-website",
      label: "Company website",
      category: allowedCategories.has("product") ? "product" : allowedCategories.has("traction") ? "traction" : "general",
      supports: companySupports.length ? companySupports : defaultSupports,
      rationale: "First-party source for official product, customer, pricing, positioning, and company claims that fit the request.",
      preference_score: 0,
      is_preferred: false,
    });
  }

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
    if (!broadIntent && !site.categories.some((category) => allowedCategories.has(category))) continue;
    const supportGaps = topGaps.filter((g) => site.categories.includes(categoryForGap(g.field))).map((g) => g.field);
    const category = site.categories.find((c) => broadIntent || allowedCategories.has(c)) ?? "general";
    const searchUrl = trustedDomainSearchUrl(site.domain, seedQuery);
    add({
      website: searchUrl ?? site.domain,
      label: site.label,
      category: siteCategory(site.domain, supportGaps[0] ? categoryForGap(supportGaps[0]) : category),
      supports: supportGaps.length ? supportGaps : defaultSupports,
      rationale: site.useCases.join("; "),
      preference_score: 0,
      is_preferred: false,
    });
  }

  const preferencesSummary = buildPreferencesSummary({ preferred, disliked });
  return {
    candidates: candidates.slice(0, Math.min(18, Math.max(8, args.intent.maxSteps * 3))),
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
  peerCompanyNames?: string[];
  researchProfile?: ResearchProfile;
}): Promise<ResearchPlanSuggestion> {
  const profile = args.researchProfile ?? "standard";
  const focus = args.focus?.trim().slice(0, 1800) || "";
  const initialPreferencesSummary = buildPreferencesSummary({
    preferred: args.preferences,
    disliked: args.dislikedPreferences,
  });
  const intent = await deriveResearchIntent({
    companyName: args.companyName,
    metadata: args.metadata,
    recentClaims: args.recentClaims,
    focus,
    preferencesSummary: initialPreferencesSummary,
    researchProfile: profile,
  });
  const plannerContext = buildPlannerCandidates({
    companyName: args.companyName,
    metadata: args.metadata,
    preferences: args.preferences,
    dislikedPreferences: args.dislikedPreferences,
    recentClaims: args.recentClaims,
    focus,
    intent,
  });

  const prompt = `You are creating an auto-research plan for one startup diligence workflow.

Use the same source-selection style as an autonomous browsing copilot: choose the next high-yield source/search target based on the research intent, relevant open gaps, source quality, prior user preferences, and what each site is actually good for. The executor will use Google Search grounding/server-side browsing; do not describe UI navigation.

The plan should fill or pressure-test this canonical Deal Intel schema, not a generic VC memo:
${DEAL_INTEL_LAYER1A_SCHEMA_GUIDE}

Prioritize:
${DEAL_INTEL_RESEARCH_FOCUS_GUIDE}

${USER_PREFERENCE_GUARDRAILS}

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
- For narrow/fast asks, produce no more than intent maxSteps and prefer 1-3 steps. For broad/deep asks, include every materially distinct step needed to answer the request instead of forcing a tiny fixed cap. They should usually be source-agnostic tasks, not website tasks.
- **summary** (required): 1–2 sentences. **First sentence must include the company name** and the concrete outcome (e.g. "verify X", "map Y competitors", "reconcile Z"). No boilerplate like "comprehensive research plan" or "diligence workflow" without naming what gets decided.
- Each task must be a clear, answerable research question for this exact company.
- Tie every task to the research intent first, then to a real relevant open gap or hypothesis. Avoid vague "look into X" work and whole-company background sweeps.
- Each task should name the exact schema field(s) it is trying to fill, verify, or falsify.
- Do not compare products, markets, founders, or technology for a named company that the user only mentioned as a matrix row, peer reference, benchmark row, or common-investor counterpart.
- When the user asks for competitors, keep competitor/product-similarity work focused on companies explicitly framed as competitors, alternatives, substitutes, or similar products.
- Matrix/table output is not a reason to add broad research steps.
- Do not produce duplicate steps for the same concept. A second pass is allowed only when the task explains the new angle, such as a newly discovered competitor, source conflict, missing patent assignee, or investor overlap that needs validation.
- Include a negative/risk pressure-test step only when intent.includeRiskCheck is true or intent.breadth is broad.
- Research only intent.allowedCategories and intent.requiredTopics. Exclude intent.excludedTopics.
- User preferences steer source choice and evidence style; they must not expand the task scope.
- If open gaps are empty, pressure-test current records with high-signal sources instead of inventing gaps.
- Leave website omitted/blank unless the step truly needs a specific source or source family.
- When website is present, choose only from Candidate source hints and make the task require that source.
- If you need the company's own website, use "company-website".`;

  let raw = "";
  try {
    raw = await vertexRunWithTextMulti(
      getResearchModel(profilePlannerModelTier(profile)),
      prompt,
      [
        { label: "Company name", value: args.companyName || "Unknown" },
        { label: "Known company context", value: args.companyContext || "No context available yet." },
        { label: "Research profile", value: profile },
        { label: "User focus", value: focus || "No specific focus; choose the best next diligence plan." },
        { label: "Research intent", value: intent },
        { label: "Relevant open research gaps", value: plannerContext.openGapFields },
        { label: "Candidate source hints for source-constrained steps", value: plannerContext.candidates },
        { label: "Peer or benchmark company names that must not be source hints", value: args.peerCompanyNames ?? [] },
        { label: "User website preferences summary", value: plannerContext.preferencesSummary || "No learned source preferences yet." },
        { label: "Search seed query", value: plannerContext.seedQuery },
      ],
      false
    );
    const parsed = parseSuggestion(raw, plannerContext.candidates, args.companyName, args.peerCompanyNames);
    if (parsed) {
      const reviewed = await reviewResearchPlan({
        companyName: args.companyName,
        intent,
        suggestion: filterSuggestionForIntent(parsed, intent),
        candidates: plannerContext.candidates,
        preferencesSummary: plannerContext.preferencesSummary,
        peerCompanyNames: args.peerCompanyNames,
        researchProfile: profile,
      });
      return {
        ...reviewed,
        intent,
        pruningNotes: [
          "Each draft task was checked against the requested topics before optional lightweight LLM review.",
          "Task-level pruning kept only steps needed for the user goal and removed duplicate or adjacent-company work.",
        ],
      };
    }

    const recovered = fallbackFromRaw({
      raw,
      companyName: args.companyName,
    });
    if (recovered) {
      return {
        ...filterSuggestionForIntent(recovered, intent),
        intent,
        pruningNotes: ["Recovered an unstructured plan, then applied task-level keyword/category pruning."],
      };
    }
  } catch {
    // Fall through to deterministic fallback below
  }

  const fallback = filterSuggestionForIntent(
    deterministicFallback({
      companyName: args.companyName,
      candidates: plannerContext.candidates,
      focus,
      intent,
      openGapFields: plannerContext.openGapFields,
    }),
    intent,
  );
  return {
    ...fallback,
    intent,
    pruningNotes: ["Used the deterministic fallback, then applied the same task-level scope and duplicate pruning gates."],
  };
}
