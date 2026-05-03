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

// ---------- Persistence helpers ----------

export function emptyAgenda(args: {
  company: CompanyContext;
  focus: string;
  preferencesSummary: string;
  openGaps: ResearchGap[];
}): ResearchAgenda {
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    focus: trim(args.focus, LIMITS.text),
    company: args.company,
    preferences_summary: trim(args.preferencesSummary, LIMITS.text),
    open_gaps: args.openGaps,
    learned: [],
    hypotheses: [],
    intent: {
      next_question: "",
      expected_kind: "other",
      candidate_urls: [],
      avoid_urls: [],
      avoid_hosts: [],
      stop_when: "",
    },
    visited: [],
    trail: [],
  };
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
    focus: trim(args.focus, LIMITS.text),
    preferences_summary: trim(args.preferencesSummary, LIMITS.text),
    open_gaps: args.openGaps,
    visited: updatedVisited.slice(0, LIMITS.visited),
    updated_at: new Date().toISOString(),
  };
}

// ---------- Patch validation + merge (model-owned fields) ----------

export type AgendaPatch = {
  intent?: AgendaIntent;
  learned_add?: LearnedFact[];
  hypotheses_upsert?: Hypothesis[];
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

  return {
    ...prev,
    intent,
    learned,
    hypotheses,
    trail,
    visited,
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
      candidate_urls: agenda.intent.candidate_urls.slice(0, LIMITS.candidateUrls),
      avoid_urls: agenda.intent.avoid_urls.slice(-12),
      avoid_hosts: agenda.intent.avoid_hosts.slice(-12),
    },
    visited: agenda.visited.slice(0, 25).map((v) => ({
      url: v.url,
      host: v.host,
      outcome: v.outcome,
      drafts_added: v.drafts_added,
    })),
    trail: agenda.trail.slice(-10),
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
