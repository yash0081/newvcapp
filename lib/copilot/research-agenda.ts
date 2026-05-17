/**
 * ResearchAgenda — durable, model-owned plan for an auto-research session.
 *
 * Lives on session.metadata.research_agenda. The plan-next route refreshes
 * its facts (open_gaps, visited outcomes) from session state, the model
 * updates its intent/learned/hypotheses each tick, and a small set of
 * deterministic guards (visit cap, candidate allow-list) keep things sane.
 *
 * No topical heuristics live here — the agenda is structure, not policy.
 */

export type CompanyContext = {
  name: string;
  sector?: string;
  stage?: string;
  geography?: string;
  competitors?: string[];
};

export type ResearchGap = { field: string; synonyms: string[] };

/** Canonical fields we want to learn about a deal, with link-text synonyms used for gap detection. */
export const RESEARCH_GAP_FIELDS: ReadonlyArray<ResearchGap> = [
  { field: "founders", synonyms: ["founder", "founders", "ceo", "cto", "co-founder", "leadership", "executives", "team", "about us"] },
  { field: "founder_education", synonyms: ["education", "university", "college", "degree", "major", "gpa", "alma mater"] },
  { field: "founder_experience", synonyms: ["experience", "previous company", "past employer", "worked at", "career", "prior role"] },
  { field: "founder_achievements", synonyms: ["award", "honor", "olympiad", "fellowship", "patent", "research", "publication", "project", "github"] },
  { field: "team_size", synonyms: ["team size", "employees", "headcount", "staff", "people"] },
  { field: "team_cohesion", synonyms: ["cohesion", "worked together", "co-founded", "lab mate", "classmate", "founding story", "origin"] },
  { field: "headquarters", synonyms: ["headquarters", "hq", "office", "location", "based in", "address"] },
  { field: "founded_year", synonyms: ["founded", "founding year", "incorporated", "established"] },
  { field: "funding", synonyms: ["funding", "raised", "series", "round", "seed", "investors", "valuation", "crunchbase"] },
  { field: "lead_investor", synonyms: ["lead investor", "led by", "partners", "venture", "vc"] },
  { field: "business_model", synonyms: ["business model", "how we make money", "monetization", "go-to-market", "gtm"] },
  { field: "pricing", synonyms: ["pricing", "plans", "subscription", "cost", "tiers"] },
  { field: "customers", synonyms: ["customers", "clients", "case studies", "logos", "users"] },
  { field: "economic_buyer", synonyms: ["buyer", "persona", "budget owner", "decision maker", "economic buyer"] },
  { field: "urgency", synonyms: ["urgency", "priority", "must have", "pain", "cost of inaction", "cost of doing nothing"] },
  { field: "market_size", synonyms: ["tam", "sam", "som", "market size", "market opportunity"] },
  { field: "competitors", synonyms: ["competitors", "alternatives", "vs", "comparison", "competition"] },
  { field: "defensibility", synonyms: ["moat", "defensibility", "patent", "ip", "proprietary", "switching cost", "network effect"] },
  { field: "customer_benefit", synonyms: ["benefit", "roi", "10x", "saves", "faster", "cheaper", "better"] },
  { field: "revenue", synonyms: ["revenue", "arr", "mrr", "sales", "growth"] },
  { field: "traction", synonyms: ["traction", "metrics", "growth", "milestones"] },
  { field: "product_stage", synonyms: ["product stage", "beta", "pilot", "ga", "launched", "prototype", "mvp"] },
  { field: "product", synonyms: ["product", "features", "platform", "docs", "documentation", "how it works"] },
  { field: "tech_stack", synonyms: ["tech stack", "engineering", "architecture", "open source", "github", "api"] },
  { field: "security_certifications", synonyms: ["security", "compliance", "soc 2", "soc2", "iso 27001", "gdpr", "hipaa", "trust", "certifications"] },
  { field: "negative_aspects", synonyms: ["risk", "risks", "red flag", "negative", "weakness", "concern", "contradiction", "reason to pass"] },
];

/** Returns gaps still open after considering deal metadata, recent claims, and accepted snippets. */
export function computeOpenGaps(args: {
  metadata?: Record<string, unknown> | null;
  recentClaims?: Array<{ key?: string; value: string; source?: string }>;
  sessionAcceptedSnippets?: Array<{ text: string; source_label?: string | null; accepted_at?: string | null }>;
}): ResearchGap[] {
  const haystack = collectGapHaystack(args).toLowerCase();
  const open: ResearchGap[] = [];
  for (const gap of RESEARCH_GAP_FIELDS) {
    const fieldLower = gap.field.toLowerCase();
    const fieldSpaced = fieldLower.replace(/_/g, " ");
    let closed = haystack.includes(fieldLower) || haystack.includes(fieldSpaced);
    if (!closed) {
      for (const syn of gap.synonyms) {
        if (syn.length < 3) continue;
        if (haystack.includes(syn.toLowerCase())) {
          closed = true;
          break;
        }
      }
    }
    if (!closed) open.push(gap);
  }
  return open;
}

function collectGapHaystack(args: {
  metadata?: Record<string, unknown> | null;
  recentClaims?: Array<{ key?: string; value: string; source?: string }>;
  sessionAcceptedSnippets?: Array<{ text: string; source_label?: string | null; accepted_at?: string | null }>;
}): string {
  const parts: string[] = [];
  const meta = args.metadata;
  if (meta && typeof meta === "object") {
    for (const [k, v] of Object.entries(meta)) {
      if (v == null) continue;
      if (typeof v === "string") {
        const trimmed = v.trim();
        if (!trimmed) continue;
        parts.push(k, trimmed);
      } else if (typeof v === "number" || typeof v === "boolean") {
        parts.push(k, String(v));
      } else if (Array.isArray(v)) {
        if (v.length === 0) continue;
        parts.push(k);
        try {
          parts.push(JSON.stringify(v).slice(0, 600));
        } catch {
          // skip non-serializable
        }
      } else if (typeof v === "object") {
        try {
          const serialized = JSON.stringify(v);
          if (!serialized || serialized === "{}" || serialized === "null") continue;
          parts.push(k, serialized.slice(0, 600));
        } catch {
          // skip non-serializable
        }
      }
    }
  }
  for (const c of args.recentClaims ?? []) {
    if (c.key) parts.push(c.key);
    if (c.value) parts.push(c.value);
  }
  for (const s of args.sessionAcceptedSnippets ?? []) {
    if (s.text) parts.push(s.text);
    if (s.source_label) parts.push(s.source_label);
  }
  return parts.join(" \n ");
}

export function buildCompanyContext(args: {
  name: string;
  metadata?: Record<string, unknown> | null;
}): CompanyContext {
  const ctx: CompanyContext = { name: args.name };
  const meta = args.metadata;
  if (!meta || typeof meta !== "object") return ctx;
  const m = meta as Record<string, unknown>;
  const pickStr = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = m[k];
      if (typeof v === "string" && v.trim()) return v.trim().slice(0, 240);
    }
    return undefined;
  };
  const pickList = (...keys: string[]): string[] | undefined => {
    for (const k of keys) {
      const v = m[k];
      if (Array.isArray(v)) {
        const list = v
          .map((x) => (typeof x === "string" ? x.trim() : ""))
          .filter((x): x is string => Boolean(x))
          .slice(0, 8);
        if (list.length) return list;
      }
    }
    return undefined;
  };
  const sector = pickStr("sector", "industry", "category", "vertical");
  if (sector) ctx.sector = sector;
  const stage = pickStr("stage", "round", "funding_stage");
  if (stage) ctx.stage = stage;
  const geography = pickStr("headquarters", "hq", "geography", "region", "location");
  if (geography) ctx.geography = geography;
  const competitors = pickList("competitors", "alternatives");
  if (competitors) ctx.competitors = competitors;
  return ctx;
}

// ---------- Agenda types ----------

export const SOURCE_KINDS = [
  "company_site",
  "filings",
  "news",
  "database",
  "blog",
  "social",
  "reference",
  "other",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export type ExpectedValue = "high" | "medium" | "low";

export type LearnedFact = {
  field: string;
  value: string;
  source_url?: string;
  confidence: number;
  added_at: string;
};

export type Hypothesis = {
  id: string;
  text: string;
  confidence: number;
  evidence_urls: string[];
  status: "open" | "supported" | "contradicted";
  updated_at?: string;
};

export type CandidateIntent = {
  url: string;
  why: string;
  supports: string[];
  expected_kind: SourceKind;
  expected_value: ExpectedValue;
};

export type AvoidNote = { target: string; reason: string };

export type AgendaIntent = {
  next_question: string;
  expected_kind: SourceKind;
  candidate_urls: CandidateIntent[];
  avoid_urls: AvoidNote[];
  avoid_hosts: AvoidNote[];
  stop_when: string;
};

export type VisitedOutcome = "pending" | "yielded" | "partial" | "empty";

export type VisitedRecord = {
  url: string;
  host: string;
  visited_at: string;
  outcome: VisitedOutcome;
  drafts_added: number;
  notes?: string;
};

export type TrailEntry = {
  ts: string;
  action: "navigate" | "scroll" | "stop";
  target?: string;
  rationale: string;
};

export type ResearchTask = {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "abandoned";
  strategy: "skimming" | "deep_research";
  priority: number;
  evidence_need: string;
  target_gap_fields: string[];
  source_kinds: SourceKind[];
  query_terms: string[];
  completion: {
    evidence_count: number;
    exhausted_hosts: string[];
  };
  // New hybrid exploration fields
  research_strategy?: "seek_primary_sources" | "compare_claims" | "find_contradictions" | "drill_deep" | "broad_survey";
  abandon_criteria?: string;
  expected_evidence_type?: string;
  fallback_queries?: string[];
  information_gain_priority?: number;
};

export type ResearchAgenda = {
  version: 1;
  updated_at: string;
  focus: string;
  company: CompanyContext;
  preferences_summary: string;
  open_gaps: ResearchGap[];
  learned: LearnedFact[];
  hypotheses: Hypothesis[];
  intent: AgendaIntent;
  visited: VisitedRecord[];
  trail: TrailEntry[];
  blocked_hosts: string[];
  declined_hosts: string[];
  /** Fingerprints (summary+snippet) of suggestions explicitly rejected by the user. */
  rejected_suggestion_keys: string[];
  /**
   * Learned browsing depth profile — computed from manual-mode behavior.
   * Used by auto mode to decide how much to scroll/read before navigating away.
   */
  depth_profile: DepthProfile;
  /** Current research strategy decomposition. */
  decomposed_tasks: ResearchTask[];
  /** Global toggle for deep research. */
  is_deep_research: boolean;
  // New hybrid exploration tracking
  /** Information gain history per host for novelty scoring. */
  information_gain_history: Map<string, { claims: number; facts: number; entities: number; timestamp: string }>;
  /** Novelty scores per host (0-1, higher = more novel information). */
  novelty_scores: Map<string, number>;
  /** Failed queries and hosts for dead-end avoidance. */
  failed_queries: Map<string, { timestamp: string; reason: string }>;
  failed_hosts: Set<string>;
};

/** Learned browsing-depth thresholds from manual-mode user behavior. */
export type DepthProfile = {
  /** Running average scroll depth ratio (0-1) when the user leaves a page. */
  avg_scroll_depth: number;
  /** Running average draft items accepted per page before the user leaves. */
  avg_drafts_per_page: number;
  /** Running average number of distinct sections/headings the user viewed before leaving. */
  avg_viewed_sections: number;
  /** Running average dwell time spent studying page sections before leaving. */
  avg_section_dwell_ms: number;
  /** Headings repeatedly focused in manual mode. */
  focused_headings: string[];
  /** Number of page transitions observed to compute the averages. */
  sample_count: number;
  /** Running average distinct visits per host before user moves on (used to normalize freq_penalty). */
  avg_visits_per_host: number;
};

const DEFAULT_DEPTH_PROFILE: DepthProfile = {
  avg_scroll_depth: 0.55,
  avg_drafts_per_page: 2,
  avg_viewed_sections: 3,
  avg_section_dwell_ms: 18_000,
  focused_headings: [],
  sample_count: 0,
  avg_visits_per_host: 2,
};

/** Trim limits so the agenda stays compact in JSON storage and prompt budgets. */
const LIMITS = {
  visited: 60,
  trail: 50,
  learned: 80,
  hypotheses: 30,
  candidateUrls: 8,
  avoidEntries: 30,
  text: 600,
  why: 240,
  supports: 6,
  tasks: 12,
} as const;

const SOURCE_KIND_SET: ReadonlySet<string> = new Set(SOURCE_KINDS);
const EXPECTED_VALUE_SET: ReadonlySet<string> = new Set(["high", "medium", "low"]);
const HYPOTHESIS_STATUSES: ReadonlySet<string> = new Set(["open", "supported", "contradicted"]);

function safeUrl(u: unknown): string | null {
  if (typeof u !== "string") return null;
  const trimmed = u.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function safeHost(u: string): string {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function trim(s: unknown, max: number): string {
  if (typeof s !== "string") return "";
  return s.trim().slice(0, max);
}

function clamp01(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0.5;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function asSourceKind(v: unknown): SourceKind {
  if (typeof v === "string" && SOURCE_KIND_SET.has(v)) return v as SourceKind;
  return "other";
}

function asExpectedValue(v: unknown): ExpectedValue {
  if (typeof v === "string" && EXPECTED_VALUE_SET.has(v)) return v as ExpectedValue;
  return "medium";
}

function uniqStrings(items: ReadonlyArray<string>, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed.slice(0, 120));
    if (out.length >= limit) break;
  }
  return out;
}

function tokenizeForTask(text: string, limit = 16): string[] {
  return uniqStrings(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((t) => t.length > 2 && !["the", "and", "for", "with", "this", "that", "from", "into", "about", "company"].includes(t)),
    limit,
  );
}

function sourceKindsForGap(field: string): SourceKind[] {
  if (field.includes("funding") || field.includes("investor") || field.includes("revenue")) return ["database", "news", "filings"];
  if (field.includes("customer") || field.includes("traction") || field.includes("pricing")) return ["company_site", "blog", "news", "database"];
  if (field.includes("competitor") || field.includes("market")) return ["reference", "news", "database", "blog"];
  if (field.includes("negative") || field.includes("risk")) return ["news", "blog", "social"];
  if (field.includes("tech") || field.includes("product") || field.includes("security")) return ["company_site", "blog", "other"];
  return ["company_site", "news", "database", "blog", "reference"];
}

export function normalizeResearchTask(raw: unknown, fallback: Partial<ResearchTask> & { id: string; description: string }): ResearchTask | null {
  const o = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const id = trim(o.id, 40) || fallback.id;
  const description = trim(o.description, 220) || fallback.description;
  if (!id || !description) return null;
  const target_gap_fields = uniqStrings(
    Array.isArray(o.target_gap_fields)
      ? o.target_gap_fields.filter((g): g is string => typeof g === "string")
      : fallback.target_gap_fields ?? [],
    8,
  );
  const source_kinds = uniqStrings(
    Array.isArray(o.source_kinds)
      ? o.source_kinds.filter((s): s is string => typeof s === "string" && SOURCE_KIND_SET.has(s))
      : fallback.source_kinds ?? [],
    8,
  ) as SourceKind[];
  const query_terms = uniqStrings(
    [
      ...(Array.isArray(o.query_terms) ? o.query_terms.filter((q): q is string => typeof q === "string") : []),
      ...(fallback.query_terms ?? []),
      ...tokenizeForTask(`${description} ${target_gap_fields.join(" ")}`),
    ],
    20,
  );
  const completionRaw = o.completion && typeof o.completion === "object" ? o.completion as Record<string, unknown> : {};
  return {
    id,
    description,
    status: o.status === "completed" || o.status === "in_progress" || o.status === "abandoned" ? o.status : fallback.status ?? "pending",
    strategy: o.strategy === "deep_research" || fallback.strategy === "deep_research" ? "deep_research" : "skimming",
    priority: typeof o.priority === "number" && Number.isFinite(o.priority) ? o.priority : fallback.priority ?? 1,
    evidence_need: trim(o.evidence_need, LIMITS.text) || fallback.evidence_need || description,
    target_gap_fields,
    source_kinds: source_kinds.length ? source_kinds : ["company_site", "news", "database"],
    query_terms,
    completion: {
      evidence_count: Number.isFinite(Number(completionRaw.evidence_count))
        ? Math.max(0, Math.round(Number(completionRaw.evidence_count)))
        : fallback.completion?.evidence_count ?? 0,
      exhausted_hosts: uniqStrings(
        Array.isArray(completionRaw.exhausted_hosts)
          ? completionRaw.exhausted_hosts.filter((h): h is string => typeof h === "string")
          : fallback.completion?.exhausted_hosts ?? [],
        20,
      ),
    },
  };
}

// ---------- Persistence helpers ----------

export function emptyAgenda(args: {
  company: CompanyContext;
  focus: string;
  preferencesSummary: string;
  openGaps: ResearchGap[];
  isDeepResearch?: boolean;
}): ResearchAgenda {
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    focus: args.focus,
    company: args.company,
    preferences_summary: args.preferencesSummary,
    open_gaps: args.openGaps,
    learned: [],
    hypotheses: [],
    intent: {
      next_question: "What are the core value propositions and traction signals for this company?",
      expected_kind: "company_site",
      candidate_urls: [],
      avoid_urls: [],
      avoid_hosts: [],
      stop_when: "I have a solid understanding of the company's team, product, and market position.",
    },
    visited: [],
    trail: [],
    blocked_hosts: [],
    declined_hosts: [],
    rejected_suggestion_keys: [],
    depth_profile: { ...DEFAULT_DEPTH_PROFILE },
    decomposed_tasks: [],
    is_deep_research: !!args.isDeepResearch,
    // New hybrid exploration tracking (initialize empty)
    information_gain_history: new Map(),
    novelty_scores: new Map(),
    failed_queries: new Map(),
    failed_hosts: new Set(),
  };
}

/**
 * The planner model often leaves intent.next_question empty or vague, which yields generic plans.
 * Seed a concrete question tied to company + focus + open gaps before calling the LLM.
 */
export function ensureAgendaHasConcreteIntent(agenda: ResearchAgenda, companyName: string): ResearchAgenda {
  const name = (companyName || "Company").trim() || "Company";
  const focus = (agenda.focus ?? "").trim();
  const nq = (agenda.intent.next_question ?? "").trim();
  const tooShort = nq.length < 18;
  const generic =
    /^(research|continue|next|more|investigate|explore)\b/i.test(nq) ||
    /^what (else|more|other)\b/i.test(nq) ||
    /^find (out|more)\b/i.test(nq);
  if (!tooShort && !generic) return agenda;
  const gapFields = agenda.open_gaps.slice(0, 5).map((g) => g.field).filter(Boolean);
  const gapBit = gapFields.length ? ` Priority schema gaps: ${gapFields.join(", ")}.` : "";
  const nextQ = focus
    ? `For ${name}, what on this page (or via which outbound link) best answers: "${focus.slice(0, 160)}"?${gapBit}`
    : `For ${name}, which concrete diligence facts are still missing here, and which outbound link is most likely to supply them?${gapBit}`;
  const stopWhen = focus
    ? `At least one cited snippet addresses "${focus.slice(0, 90)}" or we confirm it is absent on-page.`
    : `Materially reduce open gaps with cited facts or documented absence.`;
  return {
    ...agenda,
    intent: {
      ...agenda.intent,
      next_question: nextQ.slice(0, LIMITS.text),
      stop_when: stopWhen.slice(0, LIMITS.text),
    },
  };
}

export function getActiveResearchTask(agenda: ResearchAgenda): ResearchTask | null {
  return agenda.decomposed_tasks.find((t) => t.status === "in_progress")
    ?? agenda.decomposed_tasks.find((t) => t.status === "pending")
    ?? null;
}

function seedTasksFromAgenda(agenda: ResearchAgenda): ResearchTask[] {
  const focus = agenda.focus.trim();
  const open = agenda.open_gaps.slice(0, 8);
  const tasks: ResearchTask[] = [];
  const add = (task: Partial<ResearchTask> & { id: string; description: string }) => {
    const normalized = normalizeResearchTask(null, task);
    if (normalized) tasks.push(normalized);
  };

  if (focus) {
    const focusLower = focus.toLowerCase();
    const focusGaps = open.filter((g) => [g.field, ...g.synonyms].some((term) => focusLower.includes(term.toLowerCase())));
    const gaps = focusGaps.length ? focusGaps : open.slice(0, 3);
    add({
      id: "focus-task",
      description: `Answer the user focus: ${focus.slice(0, 180)}`,
      status: "in_progress",
      strategy: agenda.is_deep_research ? "deep_research" : "skimming",
      priority: 100,
      evidence_need: focus,
      target_gap_fields: gaps.map((g) => g.field),
      source_kinds: uniqStrings(gaps.flatMap((g) => sourceKindsForGap(g.field)), 8) as SourceKind[],
      query_terms: tokenizeForTask(`${agenda.company.name} ${focus}`, 20),
    });
  }

  const groups = [
    { id: "team-and-origin", label: "Find team, founder, and company-origin evidence", fields: ["founders", "founder_experience", "founder_education", "team_cohesion", "founded_year", "headquarters"] },
    { id: "traction-and-funding", label: "Find traction, customer, revenue, and funding evidence", fields: ["traction", "customers", "revenue", "funding", "lead_investor", "product_stage"] },
    { id: "product-and-market", label: "Find product, buyer, market, pricing, and competitor evidence", fields: ["product", "business_model", "economic_buyer", "market_size", "pricing", "competitors"] },
    { id: "risks-and-defensibility", label: "Find risks, negative signals, defensibility, security, and technical evidence", fields: ["negative_aspects", "defensibility", "security_certifications", "tech_stack", "customer_benefit"] },
  ];

  for (const group of groups) {
    const gaps = open.filter((g) => group.fields.includes(g.field));
    if (!gaps.length) continue;
    add({
      id: group.id,
      description: group.label,
      status: tasks.some((t) => t.status === "in_progress") ? "pending" : "in_progress",
      strategy: agenda.is_deep_research ? "deep_research" : "skimming",
      priority: 80 - tasks.length,
      evidence_need: `${group.label} for ${agenda.company.name}`,
      target_gap_fields: gaps.map((g) => g.field),
      source_kinds: uniqStrings(gaps.flatMap((g) => sourceKindsForGap(g.field)), 8) as SourceKind[],
      query_terms: tokenizeForTask(`${agenda.company.name} ${group.label} ${gaps.map((g) => `${g.field} ${g.synonyms.join(" ")}`).join(" ")}`, 20),
    });
  }

  if (!tasks.length) {
    add({
      id: "general-diligence",
      description: `Find the next material diligence evidence for ${agenda.company.name}`,
      status: "in_progress",
      strategy: agenda.is_deep_research ? "deep_research" : "skimming",
      priority: 50,
      evidence_need: `Material diligence evidence for ${agenda.company.name}`,
      target_gap_fields: open.slice(0, 4).map((g) => g.field),
      source_kinds: ["company_site", "news", "database", "blog", "reference"],
      query_terms: tokenizeForTask(`${agenda.company.name} ${agenda.focus} ${open.map((g) => g.field).join(" ")}`, 20),
    });
  }

  return tasks.slice(0, LIMITS.tasks);
}

export function ensureTaskPlanForAgenda(agenda: ResearchAgenda): ResearchAgenda {
  const existing = agenda.decomposed_tasks
    .map((task) => normalizeResearchTask(task, { id: task.id, description: task.description }))
    .filter((task): task is ResearchTask => Boolean(task));
  const tasks = existing.length ? existing : seedTasksFromAgenda(agenda);
  let activeSeen = false;
  const normalized = tasks
    .sort((a, b) => b.priority - a.priority)
    .map((task) => {
      if (task.status === "completed" || task.status === "abandoned") return task;
      if (!activeSeen) {
        activeSeen = true;
        return { ...task, status: "in_progress" as const, strategy: agenda.is_deep_research ? "deep_research" as const : task.strategy };
      }
      return { ...task, status: "pending" as const };
    });
  if (!activeSeen && normalized.length) {
    normalized[0] = { ...normalized[0], status: "in_progress", strategy: agenda.is_deep_research ? "deep_research" : normalized[0].strategy };
  }
  return { ...agenda, decomposed_tasks: normalized.slice(0, LIMITS.tasks) };
}

/** Best-effort parse of a stored agenda; returns null if the shape is unrecoverable. */
export function parseStoredAgenda(raw: unknown): ResearchAgenda | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return null;
  const company = parseCompany(r.company);
  if (!company) return null;
  return {
    version: 1,
    updated_at: typeof r.updated_at === "string" ? r.updated_at : new Date().toISOString(),
    focus: trim(r.focus, LIMITS.text),
    company,
    preferences_summary: trim(r.preferences_summary, LIMITS.text),
    open_gaps: parseGaps(r.open_gaps),
    learned: parseLearnedList(r.learned),
    hypotheses: parseHypothesesList(r.hypotheses),
    intent: parseIntent(r.intent),
    visited: parseVisitedList(r.visited),
    trail: parseTrailList(r.trail),
    blocked_hosts: Array.isArray(r.blocked_hosts) ? (r.blocked_hosts.filter((h) => typeof h === "string") as string[]) : [],
    declined_hosts: Array.isArray(r.declined_hosts) ? (r.declined_hosts.filter((h) => typeof h === "string") as string[]) : [],
    rejected_suggestion_keys: Array.isArray(r.rejected_suggestion_keys) ? (r.rejected_suggestion_keys.filter((k) => typeof k === "string") as string[]) : [],
    depth_profile: parseDepthProfile(r.depth_profile),
    decomposed_tasks: parseTasksList(r.decomposed_tasks),
    is_deep_research: typeof r.is_deep_research === "boolean" ? r.is_deep_research : false,
    // New hybrid exploration tracking (initialize empty for backward compatibility)
    information_gain_history: new Map(),
    novelty_scores: new Map(),
    failed_queries: new Map(),
    failed_hosts: new Set(),
  };
}

function parseDepthProfile(v: unknown): DepthProfile {
  if (!v || typeof v !== "object") return { ...DEFAULT_DEPTH_PROFILE };
  const o = v as Record<string, unknown>;
  const avg_scroll_depth = typeof o.avg_scroll_depth === "number" && Number.isFinite(o.avg_scroll_depth)
    ? Math.max(0, Math.min(1, o.avg_scroll_depth))
    : DEFAULT_DEPTH_PROFILE.avg_scroll_depth;
  const avg_drafts_per_page = typeof o.avg_drafts_per_page === "number" && Number.isFinite(o.avg_drafts_per_page)
    ? Math.max(0, o.avg_drafts_per_page)
    : DEFAULT_DEPTH_PROFILE.avg_drafts_per_page;
  const avg_viewed_sections = typeof o.avg_viewed_sections === "number" && Number.isFinite(o.avg_viewed_sections)
    ? Math.max(0, o.avg_viewed_sections)
    : DEFAULT_DEPTH_PROFILE.avg_viewed_sections;
  const avg_section_dwell_ms = typeof o.avg_section_dwell_ms === "number" && Number.isFinite(o.avg_section_dwell_ms)
    ? Math.max(0, o.avg_section_dwell_ms)
    : DEFAULT_DEPTH_PROFILE.avg_section_dwell_ms;
  const focused_headings = Array.isArray(o.focused_headings)
    ? o.focused_headings.filter((h): h is string => typeof h === "string" && h.trim().length > 0).slice(0, 20)
    : [];
  const sample_count = typeof o.sample_count === "number" && Number.isFinite(o.sample_count)
    ? Math.max(0, Math.round(o.sample_count))
    : 0;
  const avg_visits_per_host = typeof o.avg_visits_per_host === "number" && Number.isFinite(o.avg_visits_per_host)
    ? Math.max(0, o.avg_visits_per_host)
    : DEFAULT_DEPTH_PROFILE.avg_visits_per_host;
  return { avg_scroll_depth, avg_drafts_per_page, avg_viewed_sections, avg_section_dwell_ms, focused_headings, sample_count, avg_visits_per_host };
}

/**
 * Update the depth profile with a new observation from manual-mode page transition.
 * Uses exponential moving average so recent behavior weighs more than old behavior.
 */
export function updateDepthProfile(
  current: DepthProfile,
  observation: {
    scroll_depth: number;
    draft_count: number;
    viewed_section_count?: number;
    section_dwell_ms?: number;
    focused_headings?: string[];
    /** Visits to the host being left, at the moment the user transitions away. */
    visits_to_host?: number;
  },
): DepthProfile {
  const n = current.sample_count;
  // Exponential moving average: alpha starts high (learns fast) and decays as samples grow.
  const alpha = Math.max(0.15, 0.5 / (1 + n * 0.1));
  const avg_scroll_depth = n === 0
    ? observation.scroll_depth
    : current.avg_scroll_depth * (1 - alpha) + observation.scroll_depth * alpha;
  const avg_drafts_per_page = n === 0
    ? observation.draft_count
    : current.avg_drafts_per_page * (1 - alpha) + observation.draft_count * alpha;
  const viewedSections = Math.max(0, observation.viewed_section_count ?? current.avg_viewed_sections);
  const sectionDwellMs = Math.max(0, observation.section_dwell_ms ?? current.avg_section_dwell_ms);
  const avg_viewed_sections = n === 0
    ? viewedSections
    : current.avg_viewed_sections * (1 - alpha) + viewedSections * alpha;
  const avg_section_dwell_ms = n === 0
    ? sectionDwellMs
    : current.avg_section_dwell_ms * (1 - alpha) + sectionDwellMs * alpha;
  const visitsToHost = Math.max(0, observation.visits_to_host ?? current.avg_visits_per_host);
  const avg_visits_per_host = n === 0
    ? visitsToHost
    : current.avg_visits_per_host * (1 - alpha) + visitsToHost * alpha;
  const focused = [
    ...(observation.focused_headings ?? []),
    ...(current.focused_headings ?? []),
  ].map((h) => h.trim()).filter(Boolean);
  const focused_headings = Array.from(new Set(focused)).slice(0, 20);
  return {
    avg_scroll_depth: Math.max(0, Math.min(1, avg_scroll_depth)),
    avg_drafts_per_page: Math.max(0, avg_drafts_per_page),
    avg_viewed_sections,
    avg_section_dwell_ms,
    focused_headings,
    sample_count: n + 1,
    avg_visits_per_host,
  };
}

function parseCompany(v: unknown): CompanyContext | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== "string" || !o.name.trim()) return null;
  const ctx: CompanyContext = { name: o.name.trim().slice(0, 240) };
  if (typeof o.sector === "string" && o.sector.trim()) ctx.sector = o.sector.trim().slice(0, 240);
  if (typeof o.stage === "string" && o.stage.trim()) ctx.stage = o.stage.trim().slice(0, 240);
  if (typeof o.geography === "string" && o.geography.trim()) ctx.geography = o.geography.trim().slice(0, 240);
  if (Array.isArray(o.competitors)) {
    const comps = o.competitors
      .map((x) => (typeof x === "string" ? x.trim() : ""))
      .filter((x): x is string => Boolean(x))
      .slice(0, 8);
    if (comps.length) ctx.competitors = comps;
  }
  return ctx;
}

function parseGaps(v: unknown): ResearchGap[] {
  if (!Array.isArray(v)) return [];
  const out: ResearchGap[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const field = typeof o.field === "string" ? o.field.trim() : "";
    if (!field) continue;
    const synonyms = Array.isArray(o.synonyms)
      ? (o.synonyms.filter((s) => typeof s === "string" && s.trim().length > 0) as string[])
      : [];
    out.push({ field, synonyms });
  }
  return out;
}

function parseLearnedList(v: unknown): LearnedFact[] {
  if (!Array.isArray(v)) return [];
  const out: LearnedFact[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const field = trim(o.field, 80);
    const value = trim(o.value, LIMITS.text);
    if (!field || !value) continue;
    const fact: LearnedFact = {
      field,
      value,
      confidence: clamp01(o.confidence),
      added_at: typeof o.added_at === "string" ? o.added_at : new Date().toISOString(),
    };
    const src = safeUrl(o.source_url);
    if (src) fact.source_url = src;
    out.push(fact);
    if (out.length >= LIMITS.learned) break;
  }
  return out;
}

function parseHypothesesList(v: unknown): Hypothesis[] {
  if (!Array.isArray(v)) return [];
  const out: Hypothesis[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const id = trim(o.id, 60);
    const text = trim(o.text, LIMITS.text);
    if (!id || !text) continue;
    const status = typeof o.status === "string" && HYPOTHESIS_STATUSES.has(o.status)
      ? (o.status as Hypothesis["status"])
      : "open";
    const evidence: string[] = [];
    if (Array.isArray(o.evidence_urls)) {
      for (const e of o.evidence_urls) {
        const u = safeUrl(e);
        if (u && !evidence.includes(u)) evidence.push(u);
        if (evidence.length >= 8) break;
      }
    }
    out.push({
      id,
      text,
      confidence: clamp01(o.confidence),
      evidence_urls: evidence,
      status,
      updated_at: typeof o.updated_at === "string" ? o.updated_at : undefined,
    });
    if (out.length >= LIMITS.hypotheses) break;
  }
  return out;
}

function parseCandidate(v: unknown): CandidateIntent | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const url = safeUrl(o.url);
  if (!url) return null;
  const supports = Array.isArray(o.supports)
    ? (o.supports
      .map((s) => (typeof s === "string" ? s.trim() : ""))
      .filter((s) => s.length > 0)
      .slice(0, LIMITS.supports) as string[])
    : [];
  return {
    url,
    why: trim(o.why, LIMITS.why),
    supports,
    expected_kind: asSourceKind(o.expected_kind),
    expected_value: asExpectedValue(o.expected_value),
  };
}

function parseAvoidList(v: unknown): AvoidNote[] {
  if (!Array.isArray(v)) return [];
  const out: AvoidNote[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const target = trim(o.target, 240);
    if (!target || seen.has(target)) continue;
    seen.add(target);
    out.push({ target, reason: trim(o.reason, 240) });
    if (out.length >= LIMITS.avoidEntries) break;
  }
  return out;
}

function parseIntent(v: unknown): AgendaIntent {
  const empty: AgendaIntent = {
    next_question: "",
    expected_kind: "other",
    candidate_urls: [],
    avoid_urls: [],
    avoid_hosts: [],
    stop_when: "",
  };
  if (!v || typeof v !== "object") return empty;
  const o = v as Record<string, unknown>;
  const candidates: CandidateIntent[] = [];
  if (Array.isArray(o.candidate_urls)) {
    for (const raw of o.candidate_urls) {
      const c = parseCandidate(raw);
      if (c) candidates.push(c);
      if (candidates.length >= LIMITS.candidateUrls) break;
    }
  }
  return {
    next_question: trim(o.next_question, LIMITS.text),
    expected_kind: asSourceKind(o.expected_kind),
    candidate_urls: candidates,
    avoid_urls: parseAvoidList(o.avoid_urls),
    avoid_hosts: parseAvoidList(o.avoid_hosts),
    stop_when: trim(o.stop_when, LIMITS.text),
  };
}

function parseVisitedList(v: unknown): VisitedRecord[] {
  if (!Array.isArray(v)) return [];
  const out: VisitedRecord[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const url = safeUrl(o.url);
    if (!url) continue;
    const outcome: VisitedOutcome =
      o.outcome === "yielded" || o.outcome === "partial" || o.outcome === "empty" || o.outcome === "pending"
        ? o.outcome
        : "pending";
    out.push({
      url,
      host: typeof o.host === "string" && o.host ? o.host.toLowerCase() : safeHost(url),
      visited_at: typeof o.visited_at === "string" ? o.visited_at : new Date().toISOString(),
      outcome,
      drafts_added: Number.isFinite(Number(o.drafts_added)) ? Math.max(0, Math.round(Number(o.drafts_added))) : 0,
      notes: typeof o.notes === "string" ? o.notes.slice(0, 240) : undefined,
    });
    if (out.length >= LIMITS.visited) break;
  }
  return out;
}

function parseTrailList(v: unknown): TrailEntry[] {
  if (!Array.isArray(v)) return [];
  const out: TrailEntry[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const action = o.action === "navigate" || o.action === "scroll" || o.action === "stop" ? o.action : null;
    if (!action) continue;
    out.push({
      ts: typeof o.ts === "string" ? o.ts : new Date().toISOString(),
      action,
      target: typeof o.target === "string" ? o.target.slice(0, 240) : undefined,
      rationale: trim(o.rationale, 240),
    });
    if (out.length >= LIMITS.trail) break;
  }
  return out;
}

function parseTasksList(v: unknown): ResearchTask[] {
  if (!Array.isArray(v)) return [];
  const out: ResearchTask[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const id = trim(o.id, 60);
    const description = trim(o.description, 200);
    const status = typeof o.status === "string" && ["pending", "in_progress", "completed", "abandoned"].includes(o.status)
      ? (o.status as ResearchTask["status"])
      : "pending";
    const strategy = typeof o.strategy === "string" && (o.strategy === "skimming" || o.strategy === "deep_research")
      ? o.strategy
      : "skimming";
    const priority = typeof o.priority === "number" && Number.isFinite(o.priority) ? o.priority : 50;
    const evidence_need = trim(o.evidence_need, 300);
    const target_gap_fields = Array.isArray(o.target_gap_fields)
      ? (o.target_gap_fields.filter((f) => typeof f === "string") as string[])
      : [];
    const source_kinds = Array.isArray(o.source_kinds)
      ? (o.source_kinds.filter((k) => typeof k === "string" && SOURCE_KIND_SET.has(k)) as SourceKind[])
      : [];
    const query_terms = Array.isArray(o.query_terms)
      ? (o.query_terms.filter((q) => typeof q === "string") as string[])
      : [];
    const completion = typeof o.completion === "object" && o.completion
      ? {
          evidence_count: typeof (o.completion as Record<string, unknown>).evidence_count === "number" ? (o.completion as Record<string, unknown>).evidence_count as number : 0,
          exhausted_hosts: Array.isArray((o.completion as Record<string, unknown>).exhausted_hosts)
            ? ((o.completion as Record<string, unknown>).exhausted_hosts as unknown[]).filter((h: unknown): h is string => typeof h === "string")
            : [],
        }
      : { evidence_count: 0, exhausted_hosts: [] };
    
    const task: ResearchTask = {
      id,
      description,
      status,
      strategy,
      priority,
      evidence_need,
      target_gap_fields,
      source_kinds,
      query_terms,
      completion,
    };
    
    // Optional new fields
    if (typeof o.research_strategy === "string") {
      const rs = o.research_strategy as string;
      if (["seek_primary_sources", "compare_claims", "find_contradictions", "drill_deep", "broad_survey"].includes(rs)) {
        task.research_strategy = rs as ResearchTask["research_strategy"];
      }
    }
    if (typeof o.abandon_criteria === "string") task.abandon_criteria = o.abandon_criteria;
    if (typeof o.expected_evidence_type === "string") task.expected_evidence_type = o.expected_evidence_type;
    if (Array.isArray(o.fallback_queries)) task.fallback_queries = (o.fallback_queries as unknown[]).filter((q: unknown): q is string => typeof q === "string");
    if (typeof o.information_gain_priority === "number") task.information_gain_priority = o.information_gain_priority;
    
    out.push(task);
  }
  return out;
}

// ---------- Hybrid Exploration Helpers ----------

/**
 * Track information gain from a page visit.
 * Used to calculate novelty scores for candidate ranking.
 */
export function trackInformationGain(agenda: ResearchAgenda, url: string, claims: number, facts: number, entities: number): ResearchAgenda {
  const host = safeHost(url);
  if (!host) return agenda;
  
  const history = agenda.information_gain_history.get(host) || { claims: 0, facts: 0, entities: 0, timestamp: new Date().toISOString() };
  const updated = {
    claims: history.claims + claims,
    facts: history.facts + facts,
    entities: history.entities + entities,
    timestamp: new Date().toISOString(),
  };
  
  const newHistory = new Map(agenda.information_gain_history);
  newHistory.set(host, updated);
  
  // Calculate novelty score (0-1, higher = more novel)
  // Novelty decreases as we accumulate information from the same host
  const totalGain = updated.claims + updated.facts + updated.entities;
  const noveltyScore = Math.min(1, totalGain / 10); // Normalize to 0-1 range
  
  const newNoveltyScores = new Map(agenda.novelty_scores);
  newNoveltyScores.set(host, noveltyScore);
  
  return { ...agenda, information_gain_history: newHistory, novelty_scores: newNoveltyScores };
}

/**
 * Calculate novelty score for a host based on historical information gain.
 */
export function calculateNoveltyScore(agenda: ResearchAgenda, host: string): number {
  return agenda.novelty_scores.get(host) ?? 0.5; // Default to 0.5 for unknown hosts
}

/**
 * Mark a path (query/host) as failed (dead end).
 * Used to avoid revisiting unproductive paths.
 */
export function markPathAsFailed(agenda: ResearchAgenda, query: string, host: string, reason: string): ResearchAgenda {
  const newFailedQueries = new Map(agenda.failed_queries);
  newFailedQueries.set(query, { timestamp: new Date().toISOString(), reason });
  
  const newFailedHosts = new Set(agenda.failed_hosts);
  newFailedHosts.add(host);
  
  return { ...agenda, failed_queries: newFailedQueries, failed_hosts: newFailedHosts };
}

/**
 * Check if a path should be avoided based on failure history.
 */
export function shouldAvoidPath(agenda: ResearchAgenda, query: string, host: string): boolean {
  if (agenda.failed_hosts.has(host)) return true;
  
  const failedQuery = agenda.failed_queries.get(query);
  if (failedQuery) {
    const timeSinceFailure = Date.now() - new Date(failedQuery.timestamp).getTime();
    // Avoid for at least 1 hour
    if (timeSinceFailure < 60 * 60 * 1000) return true;
  }
  
  return false;
}

// ---------- Recompute (deterministic facts) ----------

/**
 * Refresh the model-independent fields of the agenda before each tick:
 * focus + preferences_summary + open_gaps from inputs, and visited record
 * outcomes from current draft/accept source URLs.
 *
 * Also seeds visited records for any visitedUrls that were appended outside
 * the agenda (e.g. legacy sessions or extension-side appendVisitedUrl).
 */
export function recomputeAgendaFacts(
  prev: ResearchAgenda,
  args: {
    company: CompanyContext;
    focus: string;
    preferencesSummary: string;
    openGaps: ResearchGap[];
    visitedUrls: string[];
    currentUrl: string;
    draftSourceUrls: ReadonlyArray<string | null | undefined>;
    acceptedSourceUrls: ReadonlyArray<string | null | undefined>;
  },
): ResearchAgenda {
  const yieldByUrl = new Map<string, number>();
  for (const raw of [...args.draftSourceUrls, ...args.acceptedSourceUrls]) {
    const u = safeUrl(raw ?? "");
    if (!u) continue;
    yieldByUrl.set(u, (yieldByUrl.get(u) ?? 0) + 1);
  }

  const visitedByUrl = new Map<string, VisitedRecord>();
  for (const v of prev.visited) visitedByUrl.set(v.url, v);

  for (const rawUrl of args.visitedUrls) {
    const u = safeUrl(rawUrl);
    if (!u) continue;
    if (visitedByUrl.has(u)) continue;
    visitedByUrl.set(u, {
      url: u,
      host: safeHost(u),
      visited_at: new Date().toISOString(),
      outcome: "pending",
      drafts_added: 0,
    });
  }

  const currentNorm = safeUrl(args.currentUrl);
  const updatedVisited: VisitedRecord[] = [];
  for (const rec of visitedByUrl.values()) {
    const yielded = yieldByUrl.get(rec.url) ?? 0;
    let outcome: VisitedOutcome = rec.outcome;
    let draftsAdded = rec.drafts_added;
    if (yielded > 0) {
      outcome = "yielded";
      draftsAdded = yielded;
    } else if (currentNorm && currentNorm !== rec.url && (rec.outcome === "pending" || rec.outcome === "empty")) {
      outcome = "empty";
    }
    updatedVisited.push({ ...rec, outcome, drafts_added: draftsAdded });
  }
  updatedVisited.sort((a, b) => (a.visited_at < b.visited_at ? 1 : -1));

  return {
    ...prev,
    company: args.company,
    focus: args.focus,
    preferences_summary: args.preferencesSummary,
    open_gaps: args.openGaps,
    visited: updatedVisited.slice(0, LIMITS.visited),
    blocked_hosts: prev.blocked_hosts || [],
    declined_hosts: prev.declined_hosts || [],
    decomposed_tasks: prev.decomposed_tasks || [],
    is_deep_research: !!prev.is_deep_research,
    depth_profile: prev.depth_profile || { ...DEFAULT_DEPTH_PROFILE },
    updated_at: new Date().toISOString(),
  };
}

// ---------- Patch validation + merge (model-owned fields) ----------

export type AgendaPatch = {
  intent?: AgendaIntent;
  learned_add?: LearnedFact[];
  hypotheses_upsert?: Hypothesis[];
  decomposed_tasks?: ResearchTask[];
};

export const EMPTY_AGENDA_PATCH: AgendaPatch = {};

/**
 * Validate a model-emitted agenda_patch. Drops invalid entries rather than
 * rejecting the whole patch, but enforces:
 *   - every candidate_urls[i].url must be in allowedCandidateUrls
 *   - every candidate_urls[i].supports must include at least one known anchor
 *     (open-gap field or existing hypothesis id)
 *
 * Returns the cleaned patch plus a short list of errors for logging.
 */
export function validateAgendaPatch(
  raw: unknown,
  ctx: {
    allowedCandidateUrls: ReadonlySet<string>;
    openGapFields: ReadonlySet<string>;
    knownHypothesisIds: ReadonlySet<string>;
  },
): { patch: AgendaPatch; errors: string[] } {
  const errors: string[] = [];
  const patch: AgendaPatch = {};
  if (!raw || typeof raw !== "object") return { patch, errors };
  const r = raw as Record<string, unknown>;

  if (r.intent && typeof r.intent === "object") {
    const intent = parseIntent(r.intent);
    const filteredCandidates: CandidateIntent[] = [];
    for (const c of intent.candidate_urls) {
      if (!ctx.allowedCandidateUrls.has(c.url)) {
        errors.push(`candidate_url not in allowed set: ${c.url}`);
        continue;
      }
      const validSupports = c.supports.filter(
        (s) => ctx.openGapFields.has(s) || ctx.knownHypothesisIds.has(s),
      );
      if (!validSupports.length) {
        errors.push(`candidate_url ${c.url} dropped: supports must include an open_gap field or hypothesis id`);
        continue;
      }
      filteredCandidates.push({ ...c, supports: validSupports });
    }
    patch.intent = { ...intent, candidate_urls: filteredCandidates };
  }

  if (Array.isArray(r.learned_add)) {
    const learned = parseLearnedList(r.learned_add);
    if (learned.length) patch.learned_add = learned;
  }

  if (Array.isArray(r.hypotheses_upsert)) {
    const hyps = parseHypothesesList(r.hypotheses_upsert);
    if (hyps.length) patch.hypotheses_upsert = hyps;
  }

  if (Array.isArray(r.decomposed_tasks)) {
    const tasks: ResearchTask[] = [];
    for (const t of r.decomposed_tasks) {
      if (!t || typeof t !== "object") continue;
      const ot = t as Record<string, unknown>;
      const id = trim(ot.id, 40);
      const description = trim(ot.description, 200);
      if (!id || !description) continue;
      const normalized = normalizeResearchTask(t, {
        id,
        description,
        status: (ot.status === "completed" || ot.status === "in_progress" || ot.status === "abandoned") ? ot.status : "pending",
        strategy: ot.strategy === "deep_research" ? "deep_research" : "skimming",
        priority: typeof ot.priority === "number" ? ot.priority : 1,
      });
      if (normalized) tasks.push(normalized);
    }
    if (tasks.length) patch.decomposed_tasks = tasks;
  }

  return { patch, errors };
}

function dedupeLearned(list: LearnedFact[]): LearnedFact[] {
  const seen = new Set<string>();
  const out: LearnedFact[] = [];
  for (const l of list) {
    const key = `${l.field.toLowerCase()}|${l.value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

function upsertHypotheses(prev: Hypothesis[], incoming: Hypothesis[]): Hypothesis[] {
  if (!incoming.length) return prev;
  const byId = new Map(prev.map((h) => [h.id, h]));
  const now = new Date().toISOString();
  for (const h of incoming) byId.set(h.id, { ...h, updated_at: now });
  return [...byId.values()].slice(-LIMITS.hypotheses);
}

/**
 * Apply a validated patch + record the chosen action on the agenda. Pure.
 *
 * For navigate actions we mark the page being LEFT (ctx.currentUrl) as visited
 * so the agenda stays internally consistent even before the next plan-next
 * recompute. The TARGET URL is not added — it becomes the next tick's
 * currentUrl and is recorded then.
 */
export function applyAgendaPatch(
  prev: ResearchAgenda,
  patch: AgendaPatch,
  action: { kind: "navigate"; url: string; rationale: string }
    | { kind: "scroll"; rationale: string }
    | { kind: "stop"; rationale: string },
  ctx: { currentUrl: string },
): ResearchAgenda {
  const nowIso = new Date().toISOString();

  const intent = patch.intent ?? prev.intent;

  const learnedAdd = patch.learned_add ?? [];
  const learned = dedupeLearned([...prev.learned, ...learnedAdd]).slice(-LIMITS.learned);
  const hypotheses = upsertHypotheses(prev.hypotheses, patch.hypotheses_upsert ?? []);

  const trail: TrailEntry[] = [
    ...prev.trail,
    {
      ts: nowIso,
      action: action.kind,
      target: action.kind === "navigate" ? action.url : undefined,
      rationale: trim(action.rationale, 240),
    },
  ].slice(-LIMITS.trail);

  let visited = prev.visited;
  if (action.kind === "navigate") {
    const leftUrl = safeUrl(ctx.currentUrl);
    if (leftUrl && !visited.some((v) => v.url === leftUrl)) {
      const fresh: VisitedRecord = {
        url: leftUrl,
        host: safeHost(leftUrl),
        visited_at: nowIso,
        outcome: "pending",
        drafts_added: 0,
      };
      visited = [fresh, ...visited].slice(0, LIMITS.visited);
    }
  }

  const decomposed_tasks = patch.decomposed_tasks ?? prev.decomposed_tasks;

  return {
    ...prev,
    intent,
    learned,
    hypotheses,
    trail,
    visited,
    decomposed_tasks,
    updated_at: nowIso,
  };
}

// ---------- Prompt summary ----------

/** Compact JSON-friendly summary of the agenda for the planner prompt. */
export function summarizeAgendaForPrompt(agenda: ResearchAgenda): Record<string, unknown> {
  return {
    focus: agenda.focus,
    company: agenda.company,
    preferences_summary: agenda.preferences_summary,
    open_gaps: agenda.open_gaps.map((g) => ({ field: g.field, synonyms: g.synonyms.slice(0, 6) })),
    learned: agenda.learned.slice(-25).map((l) => ({
      field: l.field,
      value: l.value,
      source_url: l.source_url,
      confidence: l.confidence,
    })),
    hypotheses: agenda.hypotheses.slice(-15).map((h) => ({
      id: h.id,
      text: h.text,
      confidence: h.confidence,
      status: h.status,
      evidence_urls: h.evidence_urls.slice(0, 3),
    })),
    intent: {
      next_question: agenda.intent.next_question,
      expected_kind: agenda.intent.expected_kind,
      stop_when: agenda.intent.stop_when,
      candidate_urls: agenda.intent.candidate_urls.slice(0, 5).map(c => ({ url: c.url, why: c.why, supports: c.supports })),
    },
    decomposed_tasks: agenda.decomposed_tasks,
    is_deep_research: agenda.is_deep_research,
    depth_profile: agenda.depth_profile,
    visited_summary: agenda.visited.slice(0, 10).map(v => ({ host: v.host, outcome: v.outcome, drafts: v.drafts_added })),
  };
}
/** Two-line user-facing readout of the agenda's current intent. */
export function describeAgendaForUI(agenda: ResearchAgenda): { nextQuestion: string; avoidHosts: string[] } {
  return {
    nextQuestion: agenda.intent.next_question,
    avoidHosts: agenda.intent.avoid_hosts.map((a) => a.target).slice(0, 6),
  };
}

/**
 * Mark the visited records matching any of the given source URLs as "yielded"
 * and increment drafts_added by 1 each. Used by auto-draft / accept routes so
 * the planner sees fresh outcomes without waiting for the next plan-next recompute.
 */
export function bumpVisitedYieldOnAgenda(
  agenda: ResearchAgenda | null,
  args: { sourceUrls: ReadonlyArray<string | null | undefined> },
): ResearchAgenda | null {
  if (!agenda) return null;
  const targets = new Set<string>();
  for (const raw of args.sourceUrls) {
    const u = safeUrl(raw ?? "");
    if (u) targets.add(u);
  }
  if (!targets.size) return agenda;
  let touched = false;
  const visited = agenda.visited.map((v) => {
    if (!targets.has(v.url)) return v;
    touched = true;
    return { ...v, outcome: "yielded" as VisitedOutcome, drafts_added: v.drafts_added + 1 };
  });
  if (!touched) return agenda;
  return { ...agenda, visited, updated_at: new Date().toISOString() };
}
