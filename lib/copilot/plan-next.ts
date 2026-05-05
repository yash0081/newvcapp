import "server-only";
import { parseJsonFromResponseOrNull } from "@/lib/gemini";
import { vertexRunWithTextMulti } from "@/lib/vertex";
import { getResearchModel } from "@/lib/research/research-model-env";
import {
  type AgendaPatch,
  type CompanyContext,
  type ResearchAgenda,
  type ResearchGap,
  EMPTY_AGENDA_PATCH,
  summarizeAgendaForPrompt,
  validateAgendaPatch,
} from "@/lib/copilot/research-agenda";
import {
  DEAL_INTEL_RESEARCH_FOCUS_GUIDE,
  USER_PREFERENCE_GUARDRAILS,
} from "@/lib/deal-intel/prompt-guidance";

export type NextAction =
  | { action: "navigate"; url: string; rationale: string }
  | { action: "scroll"; rationale: string }
  | { action: "stop"; rationale: string };

/** Per-host visit cap. Deterministic, non-topical. */
export const MAX_VISITS_PER_HOST = 2;

// Re-exports for callers — keep historical import path stable.
export {
  type CompanyContext,
  type ResearchGap,
  RESEARCH_GAP_FIELDS,
  buildCompanyContext,
  computeOpenGaps,
} from "@/lib/copilot/research-agenda";

/** Client-reported hints so we do not jump sites before mining the current page. */
export type PlanPageSignals = {
  visibleTextChars: number;
  scrollDepthRatio: number;
  draftItemsOnUrl: number;
  pendingSuggestionsCount: number;
  /** How many times PLAN_NEXT returned "scroll" in a row (extension); used to escape citation churn. */
  consecutivePlanScrolls?: number;
};

export function parsePlanPageSignals(v: unknown): PlanPageSignals | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const visibleTextChars = Number(o.visible_text_chars);
  const scrollDepthRatio = Number(o.scroll_depth_ratio);
  const draftItemsOnUrl = Number(o.draft_items_this_url);
  const pendingSuggestionsCount = Number(o.pending_suggestions_count);
  const consecutivePlanScrolls = Number(o.consecutive_plan_scrolls);
  if (!Number.isFinite(visibleTextChars) || !Number.isFinite(scrollDepthRatio)) return undefined;
  return {
    visibleTextChars: Math.max(0, Math.round(visibleTextChars)),
    scrollDepthRatio: Math.max(0, Math.min(1, scrollDepthRatio)),
    draftItemsOnUrl: Number.isFinite(draftItemsOnUrl) ? Math.max(0, Math.round(draftItemsOnUrl)) : 0,
    pendingSuggestionsCount: Number.isFinite(pendingSuggestionsCount) ? Math.max(0, Math.round(pendingSuggestionsCount)) : 0,
    consecutivePlanScrolls: Number.isFinite(consecutivePlanScrolls)
      ? Math.max(0, Math.min(24, Math.round(consecutivePlanScrolls)))
      : 0,
  };
}

/**
 * Wikipedia / Fandom etc. — pages where we tend to scroll less before leaving
 * (citation churn). Mechanical hint for `deferLeavingPage`, NOT a topical gate.
 */
export function isReferenceHeavyHostUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return (
      h.endsWith(".wikipedia.org") ||
      h === "wikipedia.org" ||
      h.endsWith(".fandom.com") ||
      h.endsWith(".wiktionary.org") ||
      h.endsWith(".wikimedia.org")
    );
  } catch {
    return false;
  }
}

/**
 * When non-null, skip navigation this tick — scroll to see more, or stop and wait for observe.
 * Null means outbound navigation is allowed if candidates exist.
 */
export function deferLeavingPage(sig: PlanPageSignals | undefined, currentUrl?: string): "scroll" | "wait" | null {
  if (!sig) return null;
  const { visibleTextChars: V, scrollDepthRatio: S, draftItemsOnUrl: D, pendingSuggestionsCount: P } = sig;
  const scrollStreak = sig.consecutivePlanScrolls ?? 0;
  const enc = currentUrl ? isReferenceHeavyHostUrl(currentUrl) : false;

  if (scrollStreak >= 2) return null;

  if (D === 0 && P === 0) {
    if (enc && S >= 0.18) return null;
    if (!enc && S >= 0.36) return null;
  }

  if (D === 0 && P >= 1 && P <= 8) {
    if (enc && S >= 0.22) return null;
    if (!enc && S >= 0.42) return null;
  }

  if (V < 720) return null;

  if (P >= 4) return S < 0.88 ? "scroll" : "wait";
  if (P >= 2) return S < 0.76 ? "scroll" : "wait";

  if (P >= 1 && D === 0 && V > 900) {
    if (enc && S >= 0.2) return null;
    if (!enc && S >= 0.46) return null;
    return S < 0.62 ? "scroll" : "wait";
  }

  if (!enc && V >= 2400 && S < 0.58) return "scroll";
  if (enc && V >= 2400 && S < 0.28) return "scroll";

  if (D === 0 && V >= 1400 && S < 0.68) {
    if (enc) return S < 0.26 ? "scroll" : null;
    return "scroll";
  }

  if (D >= 1 && D < 3 && V >= 3200 && S < 0.52) return "scroll";

  return null;
}

function normalizeUrl(u: string): string | null {
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function mergeLinkCandidates(
  outboundLinks: Array<{ url: string; text?: string }>,
  exploreSeeds: Array<{ url: string; text?: string }>,
): Array<{ url: string; text: string }> {
  const seen = new Set<string>();
  const out: Array<{ url: string; text: string }> = [];
  for (const l of outboundLinks) {
    const url = normalizeUrl(l.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, text: (l.text ?? "").trim() });
  }
  for (const s of exploreSeeds) {
    const url = normalizeUrl(s.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const text = (s.text ?? "").trim();
    out.push({ url, text: text || "User-trusted domain entry point" });
  }
  return out;
}

/** Stripped hostname for template lookup (no www). */
function apexHost(domainRaw: string): string {
  let h = domainRaw.toLowerCase().trim();
  if (h.startsWith("www.")) h = h.slice(4);
  return h;
}

// ---------- Trusted-domain explore seeds ----------

/** Builds a short query for site-internal search URLs (company + geography + steering + gap hint). */
export function buildResearchSeedQuery(args: {
  companyName: string;
  companyContext?: CompanyContext;
  steeringNote?: string | null;
  openGaps?: ReadonlyArray<ResearchGap>;
}): string {
  const parts: string[] = [];
  const name = args.companyName.trim();
  if (name && name !== "Company") parts.push(name);
  const geo = args.companyContext?.geography?.trim();
  if (geo) {
    const head = geo.split(",")[0]?.trim();
    if (head && !parts.some((p) => p.toLowerCase().includes(head.toLowerCase()))) parts.push(head);
  }
  const steer = args.steeringNote?.trim();
  if (steer) parts.push(steer.slice(0, 100));
  const comp0 = args.companyContext?.competitors?.[0]?.trim();
  if (comp0 && parts.length < 5 && !parts.some((p) => p.toLowerCase().includes(comp0.toLowerCase()))) {
    parts.push(comp0);
  }
  const gaps = args.openGaps ?? [];
  if (gaps.length && parts.length < 4 && gaps[0]?.field) {
    parts.push(gaps[0].field.replace(/_/g, " "));
  }
  if (parts.length === 0) {
    const sector = args.companyContext?.sector?.trim();
    const stage = args.companyContext?.stage?.trim();
    if (sector) parts.push(sector);
    if (stage) parts.push(stage);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 160);
}

/**
 * Known trusted-domain search entry points (avoid naked homepages).
 * Returns null when we have no safe template — caller should skip that seed.
 */
export function trustedDomainSearchUrl(domainRaw: string, query: string): string | null {
  const q = query.trim();
  if (!q) return null;
  const enc = encodeURIComponent(q.slice(0, 140));
  const host = apexHost(domainRaw);

  const apexTemplates: Record<string, string> = {
    "britannica.com": `https://www.britannica.com/search?query=${enc}`,
    "britannica.co.uk": `https://www.britannica.co.uk/search?query=${enc}`,
    "crunchbase.com": `https://www.crunchbase.com/text-search?q=${enc}`,
    "linkedin.com": `https://www.linkedin.com/search/results/all/?keywords=${enc}`,
    "bloomberg.com": `https://www.bloomberg.com/search?query=${enc}`,
    "reuters.com": `https://www.reuters.com/site-search/?query=${enc}`,
    "wsj.com": `https://www.wsj.com/search?query=${enc}`,
    "ft.com": `https://www.ft.com/search?q=${enc}`,
    "nytimes.com": `https://www.nytimes.com/search?query=${enc}`,
    "pitchbook.com": `https://pitchbook.com/profiles/search?q=${enc}`,
    "techcrunch.com": `https://techcrunch.com/?s=${enc}`,
    "news.google.com": `https://news.google.com/search?q=${enc}`,
    "wellfound.com": `https://wellfound.com/company?q=${enc}`,
    "g2.com": `https://www.g2.com/search?query=${enc}`,
  };

  const direct = apexTemplates[host];
  if (direct) return normalizeUrl(direct);

  const wiki = /^([a-z]{2,12})\.wikipedia\.org$/.exec(host);
  if (wiki) {
    const u = `https://${wiki[1]}.wikipedia.org/w/index.php?search=${enc}&title=Special%3ASearch&ns0=1`;
    return normalizeUrl(u);
  }
  if (host === "wikipedia.org") {
    const u = `https://en.wikipedia.org/w/index.php?search=${enc}&title=Special%3ASearch&ns0=1`;
    return normalizeUrl(u);
  }

  if (host === "sec.gov" || host === "www.sec.gov") {
    const u = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${enc}&owner=exclude&count=40`;
    return normalizeUrl(u);
  }

  return null;
}

/** Contextual search URLs for user-preferred domains not already linked on-page (auto mode only). */
export function buildTrustedDomainExploreSeeds(args: {
  preferredRows: Array<{ domain: string; preference_score: number; category: string }>;
  visitedUrls: string[];
  currentUrl: string;
  outboundUrls: string[];
  dislikedDomains: string[];
  maxSeeds?: number;
  companyName: string;
  companyContext?: CompanyContext;
  steeringNote?: string | null;
  openGaps?: ReadonlyArray<ResearchGap>;
}): Array<{ url: string; text: string }> {
  const maxSeeds = Math.max(0, Math.min(20, args.maxSeeds ?? 12));
  const current = normalizeUrl(args.currentUrl);
  if (!current) return [];
  const curHost = new URL(current).hostname.toLowerCase();
  const visited = new Set(args.visitedUrls.map((u) => normalizeUrl(u)).filter((u): u is string => Boolean(u)));
  const disliked = new Set(args.dislikedDomains.map((d) => d.toLowerCase().trim()).filter(Boolean));
  const outboundHosts = new Set<string>();
  for (const raw of args.outboundUrls) {
    const u = normalizeUrl(raw);
    if (!u) continue;
    try {
      outboundHosts.add(new URL(u).hostname.toLowerCase());
    } catch {
      // ignore
    }
  }
  const query = buildResearchSeedQuery({
    companyName: args.companyName,
    companyContext: args.companyContext,
    steeringNote: args.steeringNote,
    openGaps: args.openGaps,
  });
  const seeds: Array<{ url: string; text: string }> = [];
  const sorted = [...args.preferredRows].sort((a, b) => b.preference_score - a.preference_score);
  for (const row of sorted) {
    if (seeds.length >= maxSeeds) break;
    const domain = String(row.domain || "")
      .trim()
      .toLowerCase();
    if (!domain || domain === curHost) continue;
    if (domain === "localhost" || domain.endsWith(".local")) continue;
    const apex = apexHost(domain);
    if (disliked.has(apex) || disliked.has(domain)) continue;
    if (outboundHosts.has(apex) || outboundHosts.has(domain)) continue;

    const seedUrl =
      trustedDomainSearchUrl(domain, query) ??
      trustedDomainSearchUrl(apex, query);
    if (!seedUrl || visited.has(seedUrl)) continue;

    const cat = String(row.category || "research").trim() || "research";
    const qShort = query.length > 52 ? `${query.slice(0, 49)}…` : query;
    seeds.push({
      url: seedUrl,
      text: `Trusted ${cat} · ${apex} · ${qShort}`,
    });
  }
  return seeds;
}

/**
 * Sort preferred-domain rows by user preference_score, with a soft bias for
 * categories whose label appears in the steering note. Pure ordering hint —
 * does not filter or rank link candidates, only seeds.
 */
export function sortPreferredRowsForSteering<T extends { category: string; preference_score: number }>(
  rows: T[],
  steeringNote: string | null | undefined,
): T[] {
  const sorted = [...rows];
  const noteLower = (steeringNote ?? "").trim().toLowerCase();
  if (!noteLower) {
    sorted.sort((a, b) => b.preference_score - a.preference_score);
    return sorted;
  }
  sorted.sort((a, b) => {
    const ma = noteLower.includes(a.category.toLowerCase().trim()) ? 1 : 0;
    const mb = noteLower.includes(b.category.toLowerCase().trim()) ? 1 : 0;
    if (ma !== mb) return mb - ma;
    return b.preference_score - a.preference_score;
  });
  return sorted;
}

// ---------- Agenda-driven planner ----------

const PLAN_NEXT_PROMPT = `You are an autonomous research analyst running an auto-browse session for ONE specific company deal.

Each tick you receive:
  - Your ResearchAgenda (focus, company, prefs summary, open_gaps, learned, hypotheses, intent, visited, trail).
  - The current page (url, host, title, visible_text_excerpt, page_yield_signals).
  - A list of allowed candidate URLs you may navigate to, each with metadata.

Choose ONE action and update your agenda.

Your research objective is to fill and pressure-test the canonical Deal Intel schema:
${DEAL_INTEL_RESEARCH_FOCUS_GUIDE}

${USER_PREFERENCE_GUARDRAILS}

Strict JSON output:
{
  "action": "navigate" | "scroll" | "stop",
  "url": "https://...",                 // required when action=navigate; MUST appear in candidates
  "rationale": "<= 120 chars",
  "agenda_patch": {
    "intent": {
      "next_question": "single concrete question about THIS company",
      "expected_kind": "company_site|filings|news|database|blog|social|reference|other",
      "stop_when": "concrete success criterion (when this question is answered)",
      "candidate_urls": [
        {
          "url": "https://...",          // MUST be in candidates
          "why": "1 sentence tied to a gap or hypothesis",
          "supports": ["<open_gap field id>" or "<hypothesis id>"],   // >= 1 required
          "expected_kind": "company_site|filings|news|database|blog|social|reference|other",
          "expected_value": "high|medium|low"
        }
      ],
      "avoid_urls":  [{"target": "https://...",   "reason": "..."}],
      "avoid_hosts": [{"target": "host.com",      "reason": "..."}]
    },
    "learned_add": [
      {"field": "<gap field or freeform key>", "value": "<short fact>", "source_url": "<url>", "confidence": 0.0-1.0}
    ],
    "hypotheses_upsert": [
      {"id": "h_short_id", "text": "...", "confidence": 0.0-1.0, "evidence_urls": ["..."], "status": "open|supported|contradicted"}
    ]
  }
}

Rules (structural — no topical denylists):
- Each candidate_urls[i] MUST include >= 1 entry in "supports" referencing an open_gap field or a hypothesis id.
- The user's focus and agenda.open_gaps are the reason to navigate. Website preferences are a strong tie-breaker only when the source can plausibly answer the active focus or a remaining gap.
- Never propose a URL listed in agenda.visited or in agenda.intent.avoid_urls or whose host is in agenda.intent.avoid_hosts.
- Hosts already at the visit cap are pre-filtered from candidates — don't re-add them.
- Prefer hosts whose recent visited outcome is "yielded"; demote hosts whose last visits were "empty".
- Prefer sources that match learned website preferences for this situation; avoid disliked hosts unless the candidate list has no credible alternative for the active focus or an open gap.
- learned_add facts should use schema-aligned field names where possible, such as founder_education, founder_experience, team_cohesion, urgency, market_size, defensibility, product_stage, traction, or negative_aspects.
- Do NOT return action "stop" just because founders/HQ/founding-year-style basics look filled. Deal research continues across funding, product, traction, competitors, security, etc. If **Open research gaps** is non-empty, you must usually **navigate** to the best candidate that targets a remaining gap (or scroll if defer hint says so).
- Return action "stop" ONLY when: (1) defer hint is effectively "wait" on pending on-page suggestions, OR (2) the candidate list truly offers no reasonable next URL for any remaining gap and you need the user to steer or change tabs — say so clearly in rationale.
- agenda_patch.intent.candidate_urls is your top 1-5 next moves in priority order. Use it to remember plans across ticks.
- "scroll" is appropriate only when the current page is still likely to yield more drafts below the fold; otherwise prefer navigate over stopping.
- Never output anything except valid JSON.`;

function buildPlanNextPrompt(agendaFocus: string): string {
  const trimmed = agendaFocus.trim();
  if (!trimmed) return PLAN_NEXT_PROMPT;
  const safe = trimmed.slice(0, 480).replace(/"/g, "'");
  return `${PLAN_NEXT_PROMPT}

BINDING USER FOCUS (highest priority — avoid drift):
The session focus is: "${safe}"
- For action=navigate, pick a candidate URL that plausibly advances THIS focus or an open_gap that supports it. Avoid tangential links.
- intent.next_question must be one concrete question about THIS company that serves THIS focus.
- If multiple candidates qualify, prefer is_explore_hint / is_trusted_seed rows whose link text or URL matches focus keywords.
- If the page may still hold focus-relevant content below the fold, prefer "scroll" over "stop".
- Return action "stop" only when the defer hint is "wait", or there is no reasonable next URL for this focus (say so clearly in rationale).`;
}

type CandidateMeta = {
  url: string;
  text: string;
  host: string;
  host_visit_count: number;
  in_avoid_url: boolean;
  in_avoid_host: boolean;
  is_explore_hint: boolean;
  is_trusted_seed: boolean;
};

function focusKeywordTokens(focus: string): string[] {
  return focus
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 2);
}

/** Boost candidate order so the model sees focus-aligned links first (reduces generic navigations). */
function sortCandidatesForFocus(candidates: CandidateMeta[], focusRaw: string): void {
  const focus = focusRaw.trim();
  if (!focus) return;
  const tokens = focusKeywordTokens(focus);
  if (!tokens.length) return;
  const score = (c: CandidateMeta): number => {
    const blob = `${c.text} ${c.url} ${c.host}`.toLowerCase();
    let n = 0;
    for (const t of tokens) if (blob.includes(t)) n += 1;
    if (c.is_explore_hint) n += 2;
    if (c.is_trusted_seed) n += 1;
    return n;
  };
  candidates.sort((a, b) => score(b) - score(a));
}

/** With an explicit user focus, avoid stalling in "wait" when a few suggestions are pending — scroll to mine the page for focus evidence. */
function relaxDeferWhenFocused(
  defer: "scroll" | "wait" | null,
  focusTrim: string,
  sig: PlanPageSignals | undefined,
): "scroll" | "wait" | null {
  if (!focusTrim || !sig) return defer;
  if (defer !== "wait") return defer;
  const P = sig.pendingSuggestionsCount;
  const S = sig.scrollDepthRatio;
  if (P > 0 && P <= 6 && S < 0.9) return "scroll";
  return defer;
}

function buildAvoidHostSet(agenda: ResearchAgenda, dislikedHostnames?: string[]): Set<string> {
  const set = new Set<string>();
  for (const a of agenda.intent.avoid_hosts) set.add(a.target.toLowerCase().trim());
  for (const d of dislikedHostnames ?? []) set.add(d.toLowerCase().trim());
  return set;
}

function buildAvoidUrlSet(agenda: ResearchAgenda): Set<string> {
  const set = new Set<string>();
  for (const a of agenda.intent.avoid_urls) {
    const u = normalizeUrl(a.target);
    if (u) set.add(u);
  }
  return set;
}

function buildVisitedUrlSet(agenda: ResearchAgenda, extraVisitedUrls: string[]): Set<string> {
  const set = new Set<string>();
  for (const v of agenda.visited) set.add(v.url);
  for (const v of extraVisitedUrls) {
    const u = normalizeUrl(v);
    if (u) set.add(u);
  }
  return set;
}

function buildCandidateMetas(args: {
  agenda: ResearchAgenda;
  outboundLinks: Array<{ url: string; text?: string }>;
  exploreSeeds: Array<{ url: string; text?: string }>;
  copilotExploreHints: Array<{ url: string; text?: string }>;
  currentUrl: string;
  visitedUrls: string[];
  visitedHostCounts: Map<string, number>;
  dislikedHostnames: string[];
}): CandidateMeta[] {
  const merged = mergeLinkCandidates(
    [...args.outboundLinks, ...args.copilotExploreHints],
    args.exploreSeeds,
  );
  const exploreHintSet = new Set(
    args.copilotExploreHints.map((h) => normalizeUrl(h.url)).filter((u): u is string => Boolean(u)),
  );
  const trustedSeedSet = new Set(
    args.exploreSeeds.map((s) => normalizeUrl(s.url)).filter((u): u is string => Boolean(u)),
  );
  const avoidHosts = buildAvoidHostSet(args.agenda, args.dislikedHostnames);
  const avoidUrls = buildAvoidUrlSet(args.agenda);
  const visited = buildVisitedUrlSet(args.agenda, args.visitedUrls);
  const currentHost = safeHost(args.currentUrl);
  const currentNorm = normalizeUrl(args.currentUrl) ?? args.currentUrl;

  const out: CandidateMeta[] = [];
  for (const c of merged) {
    if (c.url === currentNorm) continue;
    if (visited.has(c.url)) continue;
    const host = safeHost(c.url);
    if (!host) continue;

    const isExploreHint = exploreHintSet.has(c.url);
    const isTrustedSeed = trustedSeedSet.has(c.url);

    if (avoidUrls.has(c.url)) continue;
    if (avoidHosts.has(host)) continue;

    const visitCount = host === currentHost ? 0 : args.visitedHostCounts.get(host) ?? 0;
    if (visitCount >= MAX_VISITS_PER_HOST && !isExploreHint) continue;

    out.push({
      url: c.url,
      text: c.text,
      host,
      host_visit_count: visitCount,
      in_avoid_url: false,
      in_avoid_host: false,
      is_explore_hint: isExploreHint,
      is_trusted_seed: isTrustedSeed,
    });
  }
  return out;
}

function pickFallbackCandidate(
  agenda: ResearchAgenda,
  candidates: CandidateMeta[],
): CandidateMeta | null {
  if (!candidates.length) return null;
  const allowed = new Set(candidates.map((c) => c.url));
  // First try the model's prior intent (what it planned last tick).
  for (const intended of agenda.intent.candidate_urls) {
    if (allowed.has(intended.url)) {
      const m = candidates.find((c) => c.url === intended.url);
      if (m) return m;
    }
  }
  return candidates[0] ?? null;
}

/** Prefer explore hints and trusted seeds when forcing navigation (anti-idle). */
function pickAntiIdleCandidate(agenda: ResearchAgenda, candidates: CandidateMeta[]): CandidateMeta | null {
  if (!candidates.length) return null;
  const hint = candidates.find((c) => c.is_explore_hint);
  if (hint) return hint;
  const seed = candidates.find((c) => c.is_trusted_seed);
  if (seed) return seed;
  return pickFallbackCandidate(agenda, candidates);
}

function fallbackResult(args: {
  agenda: ResearchAgenda;
  candidates: CandidateMeta[];
  defer: "scroll" | "wait" | null;
  reason: string;
}): { action: NextAction; patch: AgendaPatch; errors: string[] } {
  if (args.defer === "scroll") {
    return {
      action: { action: "scroll", rationale: "Page may still yield more — scrolling before leaving." },
      patch: EMPTY_AGENDA_PATCH,
      errors: [args.reason],
    };
  }
  if (args.defer === "wait") {
    return {
      action: { action: "stop", rationale: "Holding on this page until suggestions settle." },
      patch: EMPTY_AGENDA_PATCH,
      errors: [args.reason],
    };
  }
  const choice = pickFallbackCandidate(args.agenda, args.candidates);
  if (!choice) {
    return {
      action: { action: "stop", rationale: "No on-agenda candidates available." },
      patch: EMPTY_AGENDA_PATCH,
      errors: [args.reason],
    };
  }
  return {
    action: { action: "navigate", url: choice.url, rationale: choice.text || "Following next planned candidate." },
    patch: EMPTY_AGENDA_PATCH,
    errors: [args.reason],
  };
}

function coerceModelAction(
  raw: unknown,
  ctx: { allowedNavigateUrls: ReadonlySet<string> },
): NextAction | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const rationale = typeof r.rationale === "string" ? r.rationale.trim().slice(0, 120) : "";
  if (r.action === "scroll") return { action: "scroll", rationale: rationale || "Scan more content on this page." };
  if (r.action === "stop") return { action: "stop", rationale: rationale || "No strong next step." };
  if (r.action !== "navigate") return null;
  const url = typeof r.url === "string" ? normalizeUrl(r.url) : null;
  if (!url || !ctx.allowedNavigateUrls.has(url)) return null;
  return { action: "navigate", url, rationale: rationale || "Following candidate URL." };
}

export type PlanNextResult = {
  action: NextAction;
  patch: AgendaPatch;
  errors: string[];
  /** Compact list of deterministic-allowed candidates that went into the prompt (debugging/UI). */
  candidates: CandidateMeta[];
};

export async function planNextActionWithAgenda(args: {
  agenda: ResearchAgenda;
  currentUrl: string;
  pageTitle?: string | null;
  visibleTextExcerpt?: string | null;
  pageSignals?: PlanPageSignals;
  outboundLinks: Array<{ url: string; text?: string }>;
  exploreSeeds?: Array<{ url: string; text?: string }>;
  copilotExploreHints?: Array<{ url: string; text?: string }>;
  visitedUrls: string[];
  visitedHostCounts?: Map<string, number>;
  dislikedHostnames?: string[];
}): Promise<PlanNextResult> {
  const visitedHostCounts = args.visitedHostCounts ?? new Map<string, number>();
  const candidates = buildCandidateMetas({
    agenda: args.agenda,
    outboundLinks: args.outboundLinks,
    exploreSeeds: args.exploreSeeds ?? [],
    copilotExploreHints: args.copilotExploreHints ?? [],
    currentUrl: args.currentUrl,
    visitedUrls: args.visitedUrls,
    visitedHostCounts,
    dislikedHostnames: args.dislikedHostnames ?? [],
  });
  const focusTrim = (args.agenda.focus ?? "").trim();
  if (focusTrim) sortCandidatesForFocus(candidates, focusTrim);
  const allowedNavigateUrls = new Set(candidates.map((c) => c.url));
  const defer = relaxDeferWhenFocused(
    deferLeavingPage(args.pageSignals, args.currentUrl),
    focusTrim,
    args.pageSignals,
  );
  const plannerPrompt = buildPlanNextPrompt(args.agenda.focus ?? "");

  if (candidates.length === 0) {
    return {
      ...fallbackResult({ agenda: args.agenda, candidates, defer, reason: "no_candidates" }),
      candidates,
    };
  }

  const inputs: Array<{ label: string; value: unknown }> = [
    { label: "ResearchAgenda", value: summarizeAgendaForPrompt(args.agenda) },
    {
      label: "Current page",
      value: {
        url: args.currentUrl,
        host: safeHost(args.currentUrl),
        title: args.pageTitle ?? null,
        visible_text_excerpt: typeof args.visibleTextExcerpt === "string"
          ? args.visibleTextExcerpt.slice(0, 1600)
          : null,
        page_yield_signals: args.pageSignals ?? null,
      },
    },
    {
      label: `Candidates (only choose navigate URLs from this list; max ${MAX_VISITS_PER_HOST} visits/host already enforced)`,
      value: candidates.slice(0, 30).map((c) => ({
        url: c.url,
        text: c.text,
        host: c.host,
        host_visit_count: c.host_visit_count,
        is_explore_hint: c.is_explore_hint,
        is_trusted_seed: c.is_trusted_seed,
      })),
    },
    {
      label: "Defer hint (mechanical page-yield rule — honor when present)",
      value: defer ?? "none",
    },
  ];

  let raw = "";
  try {
    raw = await vertexRunWithTextMulti(getResearchModel("flash_lite"), plannerPrompt, inputs, false);
  } catch (err) {
    return {
      ...fallbackResult({
        agenda: args.agenda,
        candidates,
        defer,
        reason: `model_error: ${err instanceof Error ? err.message : String(err)}`,
      }),
      candidates,
    };
  }

  const parsed = parseJsonFromResponseOrNull(raw) as Record<string, unknown> | null;
  if (!parsed) {
    return {
      ...fallbackResult({ agenda: args.agenda, candidates, defer, reason: "model_unparseable" }),
      candidates,
    };
  }

  const knownGapFields = new Set(args.agenda.open_gaps.map((g) => g.field));
  const knownHypothesisIds = new Set(args.agenda.hypotheses.map((h) => h.id));
  // Allow newly-introduced hypothesis ids (in this same patch) to be cited by candidate_urls in the same tick.
  const patchInput = (parsed.agenda_patch as unknown) ?? {};
  if (patchInput && typeof patchInput === "object") {
    const upsert = (patchInput as Record<string, unknown>).hypotheses_upsert;
    if (Array.isArray(upsert)) {
      for (const h of upsert) {
        if (h && typeof h === "object") {
          const id = (h as Record<string, unknown>).id;
          if (typeof id === "string" && id.trim()) knownHypothesisIds.add(id.trim());
        }
      }
    }
  }
  const { patch, errors } = validateAgendaPatch(patchInput, {
    allowedCandidateUrls: allowedNavigateUrls,
    openGapFields: knownGapFields,
    knownHypothesisIds,
  });

  const action = coerceModelAction(parsed, { allowedNavigateUrls });
  if (!action) {
    return {
      ...fallbackResult({ agenda: args.agenda, candidates, defer, reason: "model_action_invalid" }),
      candidates,
      patch,
      errors: ["model_action_invalid", ...errors],
    };
  }

  // Defer overrides: never let the model navigate when mechanics say "scroll first".
  if (defer === "scroll" && action.action === "navigate") {
    return {
      action: { action: "scroll", rationale: "Page may still yield more — scrolling before leaving." },
      patch,
      errors,
      candidates,
    };
  }
  if (defer === "wait" && action.action === "navigate") {
    return {
      action: { action: "stop", rationale: "Holding on this page until suggestions settle." },
      patch,
      errors,
      candidates,
    };
  }

  // Same defer rule when the model pessimistically says "stop" but the page still warrants scrolling.
  if (defer === "scroll" && action.action === "stop") {
    return {
      action: { action: "scroll", rationale: "Page may still yield more — scrolling before leaving." },
      patch,
      errors: [...errors, "defer_scroll_overrode_stop"],
      candidates,
    };
  }

  // Anti-idle: do not honor model "stop" when real URLs are available and we are not waiting on suggestions.
  if (action.action === "stop" && defer !== "wait" && candidates.length > 0) {
    const choice = pickAntiIdleCandidate(args.agenda, candidates);
    if (choice) {
      const gapFields = args.agenda.open_gaps.map((g) => g.field);
      const rationale =
        gapFields.length > 0
          ? `More research needed (${gapFields.slice(0, 5).join(", ")}) — opening another source.`
          : "Continuing across sources — basic facts are not the whole diligence story.";
      return {
        action: { action: "navigate", url: choice.url, rationale: rationale.slice(0, 120) },
        patch,
        errors: [...errors, "anti_idle_overrode_stop"],
        candidates,
      };
    }
  }

  return { action, patch, errors, candidates };
}
