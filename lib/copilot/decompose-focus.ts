/**
 * LLM-backed focus decomposer.
 *
 * Turns the user's free-form focus + company context + open gaps into 3-6
 * typed `ResearchTask`s that drive everything downstream:
 *   - candidate seed generation
 *   - candidate ranking (task tokens + source kinds)
 *   - scroll targeting (active task evidence_need)
 *
 * The LLM call is cached per `(focus, company, gaps, deep_research)` so it
 * runs at most once per focus change, never per plan-next call. Falls back to
 * deterministic seeding if the model errors or times out.
 */

import "server-only";
import { createHash } from "node:crypto";
import { parseJsonFromResponseOrNull } from "@/lib/gemini";
import { vertexRunWithTextMulti } from "@/lib/vertex";
import { getResearchModel } from "@/lib/research/research-model-env";
import {
  normalizeResearchTask,
  type ResearchAgenda,
  type ResearchTask,
} from "@/lib/copilot/research-agenda";

const CACHE_MAX_ENTRIES = 200;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

type CacheEntry = { tasks: ResearchTask[]; at: number };
const cache = new Map<string, CacheEntry>();

function cacheKey(args: {
  focus: string;
  companySlug: string;
  gapFields: string[];
  isDeepResearch: boolean;
}): string {
  const sorted = [...args.gapFields].sort().join(",");
  const raw = `${args.focus}|${args.companySlug}|${sorted}|${args.isDeepResearch ? "deep" : "skim"}`;
  return createHash("sha1").update(raw).digest("hex");
}

function evictExpired(): void {
  const cutoff = Date.now() - CACHE_TTL_MS;
  for (const [k, v] of Array.from(cache.entries())) {
    if (v.at < cutoff) cache.delete(k);
  }
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

/** Returns the agenda's tasks, fingerprinted by current focus/company/gaps. */
function fingerprintFromAgenda(agenda: ResearchAgenda): string {
  return cacheKey({
    focus: agenda.focus.trim(),
    companySlug: agenda.company.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60),
    gapFields: agenda.open_gaps.map((g) => g.field),
    isDeepResearch: !!agenda.is_deep_research,
  });
}

const DECOMPOSE_PROMPT = `You decompose a venture-capital research "focus" into concrete sub-tasks for an automated research agent.

You will receive:
- COMPANY: name + sector/stage/geography/competitors when known.
- FOCUS: the user's free-form research goal for this session.
- OPEN_GAPS: schema fields with no facts yet. You MUST only target gaps from this list.
- IS_DEEP_RESEARCH: when true, prefer "deep_research" strategy and broader source_kinds.
- CURRENT_PAGE_CONTEXT: (optional) the current page being explored to guide immediate next steps.

Return STRICT JSON, no prose:

{
  "tasks": [
    {
      "id": "snake_case_id",
      "description": "12-25 words describing the sub-goal.",
      "evidence_need": "What concrete evidence (one sentence) closes this sub-goal.",
      "target_gap_fields": ["one or more strings drawn from OPEN_GAPS"],
      "source_kinds": ["company_site"|"filings"|"news"|"database"|"blog"|"social"|"reference"|"other"],
      "query_terms": ["3-8 strings, lowercase, suitable for site search"],
      "priority": 100,
      "strategy": "skimming"|"deep_research",
      "research_strategy": "seek_primary_sources"|"compare_claims"|"find_contradictions"|"drill_deep"|"broad_survey",
      "abandon_criteria": "when to give up on this path (e.g., 'if 3 pages yield no relevant results')",
      "expected_evidence_type": "what specific evidence to look for (e.g., 'funding amounts with dates', 'customer logos with revenue ranges')",
      "fallback_queries": ["alternative queries if primary fails (2-3 strings)"],
      "information_gain_priority": 1-10 (higher = more novel information expected)
    }
  ]
}

Rules:
- 3 to 6 tasks total. Higher priority = run first.
- target_gap_fields MUST be a subset of OPEN_GAPS. Drop any field not present.
- Each task must be DIFFERENT (different evidence, different source mix). Do NOT echo the focus verbatim across tasks.
- query_terms must be specific to this company + this evidence (not the focus itself).
- Use "deep_research" only when the evidence is qualitative/nuanced (e.g. founder background, defensibility narrative). Use "skimming" for scannable facts (e.g. funding amount, headcount).
- research_strategy: choose the most appropriate approach for this task:
  * "seek_primary_sources" - go to original sources (filings, official docs, company site)
  * "compare_claims" - find multiple sources to verify consistency
  * "find_contradictions" - look for conflicting information
  * "drill_deep" - explore one source in depth before moving on
  * "broad_survey" - quickly scan multiple sources to build overview
- abandon_criteria: be specific about when to stop pursuing this task (e.g., "if 5 pages with no relevant information", "if all sources are paywalled")
- expected_evidence_type: be specific about what format the evidence should take (e.g., "number with currency symbol", "list of names with roles", "date ranges")
- fallback_queries: provide 2-3 alternative queries if the primary query fails (e.g., different terminology, broader/narrower scope)
- information_gain_priority: rank by how much novel information this task is likely to provide (1 = low, 10 = high)
- If CURRENT_PAGE_CONTEXT is provided, ensure at least one task guides immediate exploration of that page.
- Never output anything except the JSON object.`;

/** Sanitize id to a stable snake_case slug. */
function asSlugId(raw: unknown, fallback: string): string {
  const s = typeof raw === "string" ? raw : "";
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
  return slug || fallback;
}

/** Coerce LLM output into ResearchTask[]; drops invalid rows. */
function coerceTasks(raw: unknown, gapFieldSet: ReadonlySet<string>, isDeepResearch: boolean): Partial<ResearchTask>[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as Record<string, unknown>;
  const list = Array.isArray(r.tasks) ? r.tasks : [];
  const out: Partial<ResearchTask>[] = [];
  let priorityFloor = 100;
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const description = typeof o.description === "string" ? o.description.trim().slice(0, 220) : "";
    if (!description) continue;
    const id = asSlugId(o.id, `task-${out.length + 1}`);
    const target_gap_fields = Array.isArray(o.target_gap_fields)
      ? (o.target_gap_fields as unknown[])
          .filter((g): g is string => typeof g === "string" && gapFieldSet.has(g))
          .slice(0, 8)
      : [];
    const source_kinds = Array.isArray(o.source_kinds)
      ? (o.source_kinds as unknown[]).filter((k): k is string => typeof k === "string").slice(0, 8)
      : [];
    const query_terms = Array.isArray(o.query_terms)
      ? (o.query_terms as unknown[])
          .filter((q): q is string => typeof q === "string" && q.trim().length > 1)
          .map((q) => q.trim().toLowerCase().slice(0, 60))
          .slice(0, 8)
      : [];
    const priority = typeof o.priority === "number" && Number.isFinite(o.priority)
      ? Math.max(1, Math.min(200, Math.round(o.priority)))
      : priorityFloor;
    priorityFloor = Math.max(1, priority - 1);
    const strategy: ResearchTask["strategy"] = o.strategy === "deep_research" || isDeepResearch
      ? "deep_research"
      : "skimming";
    const evidence_need = typeof o.evidence_need === "string"
      ? o.evidence_need.trim().slice(0, 600)
      : description;
    out.push({
      id,
      description,
      status: "pending",
      strategy,
      priority,
      evidence_need,
      target_gap_fields,
      source_kinds: source_kinds as ResearchTask["source_kinds"],
      query_terms,
    });
    if (out.length >= 6) break;
  }
  return out;
}

function decomposerModel(): string {
  try {
    return getResearchModel("flash_lite");
  } catch {
    return getResearchModel("flash");
  }
}

/** Race a promise against a timeout; rejects with `Error("timeout")` after ms. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Decompose the agenda's focus into tasks. Returns partial tasks ready to be
 * passed through `normalizeResearchTask` by the caller (research-agenda owns
 * the canonical normalization to avoid circular imports).
 *
 * Cache hits return immediately; cache misses run the LLM with a 4 s timeout
 * and fall back to `null` (caller uses deterministic seeding).
 */
export async function decomposeFocusIntoTasks(args: {
  agenda: ResearchAgenda;
  /** Override timeout for tests. */
  timeoutMs?: number;
}): Promise<ResearchTask[] | null> {
  const focusTrim = (args.agenda.focus ?? "").trim();
  const gapFields = args.agenda.open_gaps.map((g) => g.field);
  if (!focusTrim || gapFields.length === 0) return null;
  evictExpired();
  const key = fingerprintFromAgenda(args.agenda);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.tasks;

  const inputs = [
    { label: "COMPANY", value: args.agenda.company },
    { label: "FOCUS", value: focusTrim.slice(0, 600) },
    { label: "OPEN_GAPS", value: gapFields },
    { label: "IS_DEEP_RESEARCH", value: !!args.agenda.is_deep_research },
    { label: "PREFERENCES_HINT", value: args.agenda.preferences_summary?.slice(0, 600) ?? "" },
  ];

  let raw = "";
  try {
    raw = await withTimeout(
      vertexRunWithTextMulti(decomposerModel(), DECOMPOSE_PROMPT, inputs, false),
      args.timeoutMs ?? 4_000,
    );
  } catch {
    return null;
  }
  const parsed = parseJsonFromResponseOrNull(raw);
  if (!parsed) return null;
  const gapFieldSet = new Set(gapFields) as Set<string>;
  const partials = coerceTasks(parsed, gapFieldSet, !!args.agenda.is_deep_research);
  if (!partials.length) return null;

  const tasks: ResearchTask[] = [];
  for (const t of partials) {
    if (!t.id || !t.description) continue;
    const normalized = normalizeResearchTask(null, {
      id: t.id,
      description: t.description,
      status: t.status ?? "pending",
      strategy: t.strategy ?? "skimming",
      priority: t.priority ?? 50,
      evidence_need: t.evidence_need ?? t.description,
      target_gap_fields: t.target_gap_fields ?? [],
      source_kinds: t.source_kinds ?? [],
      query_terms: t.query_terms ?? [],
      completion: t.completion,
    });
    if (normalized) tasks.push(normalized);
  }
  if (!tasks.length) return null;

  // Mark the highest-priority task as in_progress, the rest pending.
  tasks.sort((a, b) => b.priority - a.priority);
  tasks[0] = { ...tasks[0], status: "in_progress" };
  for (let i = 1; i < tasks.length; i += 1) tasks[i] = { ...tasks[i], status: "pending" };

  cache.set(key, { tasks, at: Date.now() });
  return tasks;
}

/** Test/admin hook: drop the in-memory cache. */
export function clearDecomposeCache(): void {
  cache.clear();
}
