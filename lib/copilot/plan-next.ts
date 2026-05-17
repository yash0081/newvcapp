import "server-only";
import { parseJsonFromResponseOrNull } from "@/lib/gemini";
import { vertexRunWithTextMulti } from "@/lib/vertex";
import { getResearchModel } from "@/lib/research/research-model-env";
import {
  type AgendaPatch,
  type CompanyContext,
  type ResearchAgenda,
  type ResearchGap,
  type ResearchTask,
  EMPTY_AGENDA_PATCH,
  getActiveResearchTask,
  summarizeAgendaForPrompt,
  validateAgendaPatch,
} from "@/lib/copilot/research-agenda";
import {
  buildCandidateFeatures,
  explorationEpsilon,
  RECOMMENDER_PRIORS,
  scoreFeatures,
  type FeatureContext,
  type RecommenderFeatures,
  type RecommenderWeights,
} from "@/lib/copilot/recommender-weights";
import { type Extracted } from "@/lib/copilot/types";

export type NextAction =
  | { action: "navigate"; url: string; rationale: string }
  | { action: "scroll"; rationale: string; targetScrollRatio?: number; targetSectionHeading?: string }
  | { action: "stop"; rationale: string };

/** Per-host visit cap. Deterministic, non-topical. */
export const MAX_VISITS_PER_HOST = 4;

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
  skimSectionCount: number;
  skimVisibleSectionCount: number;
  skimRelevantSectionCount: number;
  sectionDwellMs: number;
  viewedSectionCount: number;
  focusedSectionHeadings?: string[];
};

export function parsePlanPageSignals(v: unknown): PlanPageSignals | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const visibleTextChars = Number(o.visible_text_chars);
  const scrollDepthRatio = Number(o.scroll_depth_ratio);
  const draftItemsOnUrl = Number(o.draft_items_this_url);
  const pendingSuggestionsCount = Number(o.pending_suggestions_count);
  const consecutivePlanScrolls = Number(o.consecutive_plan_scrolls);
  const skimSectionCount = Number(o.skim_section_count);
  const skimVisibleSectionCount = Number(o.skim_visible_section_count);
  const skimRelevantSectionCount = Number(o.skim_relevant_section_count);
  const sectionDwellMs = Number(o.section_dwell_ms);
  const viewedSectionCount = Number(o.viewed_section_count);
  const focusedSectionHeadings = Array.isArray(o.focused_section_headings)
    ? o.focused_section_headings.filter((h): h is string => typeof h === "string").slice(0, 8)
    : [];
  if (!Number.isFinite(visibleTextChars) || !Number.isFinite(scrollDepthRatio)) return undefined;
  return {
    visibleTextChars: Math.max(0, Math.round(visibleTextChars)),
    scrollDepthRatio: Math.max(0, Math.min(1, scrollDepthRatio)),
    draftItemsOnUrl: Number.isFinite(draftItemsOnUrl) ? Math.max(0, Math.round(draftItemsOnUrl)) : 0,
    pendingSuggestionsCount: Number.isFinite(pendingSuggestionsCount) ? Math.max(0, Math.round(pendingSuggestionsCount)) : 0,
    consecutivePlanScrolls: Number.isFinite(consecutivePlanScrolls)
      ? Math.max(0, Math.min(24, Math.round(consecutivePlanScrolls)))
      : 0,
    skimSectionCount: Number.isFinite(skimSectionCount) ? Math.max(0, Math.round(skimSectionCount)) : 0,
    skimVisibleSectionCount: Number.isFinite(skimVisibleSectionCount) ? Math.max(0, Math.round(skimVisibleSectionCount)) : 0,
    skimRelevantSectionCount: Number.isFinite(skimRelevantSectionCount) ? Math.max(0, Math.round(skimRelevantSectionCount)) : 0,
    sectionDwellMs: Number.isFinite(sectionDwellMs) ? Math.max(0, Math.round(sectionDwellMs)) : 0,
    viewedSectionCount: Number.isFinite(viewedSectionCount) ? Math.max(0, Math.round(viewedSectionCount)) : 0,
    focusedSectionHeadings,
  };
}

function taskScrollTarget(args: {
  agenda: ResearchAgenda;
  pageSignals?: PlanPageSignals;
  snapshot?: { skim_outline?: { sections?: Array<{ heading?: string; lead_text?: string; top_ratio?: number }> } | null };
}): { targetScrollRatio?: number; targetSectionHeading?: string } {
  const task = getActiveResearchTask(args.agenda);
  const sections = args.snapshot?.skim_outline?.sections ?? [];
  if (!task || !sections.length) return {};
  const viewed = new Set((args.pageSignals?.focusedSectionHeadings ?? []).map((h) => h.toLowerCase()));
  const tokens = [...task.query_terms, task.evidence_need, ...task.target_gap_fields]
    .flatMap((t) => focusKeywordTokens(t))
    .filter((t) => t.length > 2);
  let best: { heading: string; top: number; score: number } | null = null;
  for (const section of sections) {
    const heading = (section.heading ?? "").trim();
    const blob = `${heading} ${section.lead_text ?? ""}`.toLowerCase();
    const score = tokens.reduce((sum, token) => sum + (blob.includes(token) ? 1 : 0), 0);
    if (score <= 0) continue;
    if (heading && viewed.has(heading.toLowerCase())) continue;
    const top = typeof section.top_ratio === "number" && Number.isFinite(section.top_ratio) ? section.top_ratio : 0;
    if (!best || score > best.score || (score === best.score && top > best.top)) {
      best = { heading, top, score };
    }
  }
  if (!best) return {};
  return {
    targetScrollRatio: Math.max(0, Math.min(1, best.top)),
    targetSectionHeading: best.heading || undefined,
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
export function deferLeavingPage(
  sig: PlanPageSignals | undefined, 
  currentUrl: string | undefined,
  agenda: ResearchAgenda,
  unexploredRelevantLinksCount?: number,
): "scroll" | "wait" | null {
  if (!sig) return null;
  const { scrollDepthRatio: S, draftItemsOnUrl: D, pendingSuggestionsCount: P } = sig;
  const scrollStreak = sig.consecutivePlanScrolls ?? 0;
  
  // Find the active task strategy
  const activeTask = agenda.decomposed_tasks.find(t => t.status === "in_progress") || agenda.decomposed_tasks.find(t => t.status === "pending");
  const strategy = activeTask?.strategy ?? (agenda.is_deep_research ? "deep_research" : "skimming");
  
  const dp = agenda.depth_profile;
  
  // Dynamic thresholds based on strategy and learned profile
  const baseDepth = dp?.avg_scroll_depth ?? 0.55;
  const targetDrafts = dp?.avg_drafts_per_page ?? 2;
  const targetSections = Math.max(2, Math.round(dp?.avg_viewed_sections ?? 3));
  const targetDwell = Math.max(8_000, Math.round((dp?.avg_section_dwell_ms ?? 18_000) * 0.75));
  const skimCoverageKnown = sig.skimSectionCount > 0;
  const skimHasRelevantSections = sig.skimRelevantSectionCount > 0;
  const skimCoverageMet = !skimCoverageKnown || sig.viewedSectionCount >= Math.min(sig.skimSectionCount, targetSections) || sig.sectionDwellMs >= targetDwell;
  
  // Page exhaustion check: if current page has unexplored relevant links, force scroll
  const hasUnexploredRelevantLinks = (unexploredRelevantLinksCount ?? 0) > 0;
  
  if (agenda.is_deep_research) {
    const deepDepth = Math.max(0.85, Math.min(0.98, baseDepth * 1.5));
    const deepDrafts = Math.max(targetDrafts * 2, 5);
    if (P > 0 && S < 0.98) return "scroll";
    if (S < deepDepth && scrollStreak < 10) return "scroll";
    if (D < deepDrafts && scrollStreak < 12) return "scroll";
    // If there are unexplored relevant links, keep scrolling
    if (hasUnexploredRelevantLinks && S < 0.95) return "scroll";
    return P > 0 ? "wait" : null;
  }

  if (strategy === "skimming") {
    if (P > 0 && !skimCoverageMet) return "scroll";
    if (skimHasRelevantSections && !skimCoverageMet && scrollStreak < 6) return "scroll";
    // Increased minimum scroll depth from 0.6 to 0.75
    if (!skimCoverageKnown && S < Math.max(0.75, baseDepth) && scrollStreak < 4) return "scroll";
    if (D > 0 && skimCoverageMet) return null;
    if (D === 0 && P === 0 && skimCoverageMet) return null;
    // Reduced consecutivePlanScrolls threshold from 6 to 4
    if (scrollStreak >= 4) return null;
    // If there are unexplored relevant links, keep scrolling
    if (hasUnexploredRelevantLinks && S < 0.8) return "scroll";
    return S < Math.max(0.75, baseDepth) ? "scroll" : null;
  }

  // DEEP RESEARCH: Stay and dig.
  const deepDepth = Math.min(0.98, baseDepth * 1.5);
  const deepDrafts = Math.max(targetDrafts * 2, 5);

  // If we have pending suggestions, wait for them
  if (P > 0) {
    if (S < deepDepth) return "scroll";
    return "wait";
  }

  // If we haven't reached the learned depth or draft count, keep scrolling
  if (S < deepDepth && D < deepDrafts) {
    if (scrollStreak < 6) return "scroll";
  }

  // If there are unexplored relevant links, keep scrolling
  if (hasUnexploredRelevantLinks && S < 0.85) return "scroll";

  return null;
}

/**
 * Count how many relevant outbound links on the current page haven't been visited yet.
 * Used to determine if the page is "exhausted" or still has unexplored content.
 */
function countUnexploredRelevantLinks(
  outboundLinks: ReadonlyArray<{ url: string; text?: string; heading?: string }>,
  visitedUrls: ReadonlyArray<string>,
): number {
  const visitedSet = new Set(visitedUrls.map(u => normalizeUrl(u)).filter((u): u is string => Boolean(u)));
  let count = 0;
  for (const link of outboundLinks) {
    const normalized = normalizeUrl(link.url);
    if (normalized && !visitedSet.has(normalized)) {
      count++;
    }
  }
  return count;
}

/**
 * When the user set a focus and we've already drafted facts on this URL, stop
 * "mining" the same page forever — let navigation pick a focus-aligned link.
 */
function relaxDeferAfterFocusYield(
  defer: "scroll" | "wait" | null,
  focusTrim: string,
  sig: PlanPageSignals | undefined,
  agenda: ResearchAgenda,
): "scroll" | "wait" | null {
  if (!defer || !focusTrim || !sig) return defer;
  const D = sig.draftItemsOnUrl ?? 0;
  const P = sig.pendingSuggestionsCount ?? 0;
  
  // Use learned threshold or default.
  let threshold = agenda.depth_profile?.avg_drafts_per_page ?? 2;
  if (agenda.is_deep_research) threshold = Math.max(threshold * 1.5, 4);

  // Only allow leaving when we've actually extracted substantial evidence.
  if (D >= threshold) return null;
  if (D >= Math.ceil(threshold * 0.6) && defer === "scroll" && P === 0) return null;
  
  return defer;
}

/** Focused sessions should move on after multiple scroll ticks, not just one. */
function relaxFocusNavigationMomentum(
  defer: "scroll" | "wait" | null,
  focusTrim: string,
  sig: PlanPageSignals | undefined,
  agenda: ResearchAgenda,
): "scroll" | "wait" | null {
  if (!defer || !focusTrim || !sig) return defer;
  if (agenda.is_deep_research) return defer;
  if (sig.draftItemsOnUrl >= 1 && sig.scrollDepthRatio > 0.45) return null;
  return defer;
}

function trimPlannerRationale(s: string, max = 120): string {
  return s.replace(/\s+/g, " ").trim().slice(0, max);
}

function plannerCompanyLabel(companyDisplayName: string, agenda: ResearchAgenda): string {
  const fromArg = companyDisplayName.trim();
  const fromAgenda = (agenda.company?.name ?? "").trim();
  return (fromArg || fromAgenda || "Company").slice(0, 56);
}

/** Deterministic rationales when the model omits text or we take a mechanical fallback — avoids vague UI copy. */
function mechanicalPlannerRationale(args: {
  kind: "scroll" | "wait" | "stop_no_candidates" | "stop_generic" | "navigate_fallback";
  companyLabel: string;
  agenda: ResearchAgenda;
  navigate?: { url: string; text: string };
}): string {
  const co = args.companyLabel;
  const focus = (args.agenda.focus ?? "").trim().slice(0, 44);
  const gap0 = args.agenda.open_gaps[0]?.field?.replace(/_/g, " ") ?? "";
  const focusBit = focus ? ` — ${focus}` : "";
  const gapBit = gap0 ? ` (${gap0})` : "";

  switch (args.kind) {
    case "scroll":
      return trimPlannerRationale(`${co}: scroll for more on-page evidence${gapBit || focusBit || ""}`);
    case "wait":
      return trimPlannerRationale(`${co}: pause for on-page suggestions${focusBit}`);
    case "stop_no_candidates":
      return trimPlannerRationale(`${co}: no agenda-safe links here — steer or open another source${focusBit}`);
    case "stop_generic":
      return trimPlannerRationale(`${co}: holding on this page${focusBit} — review suggestions or steer`);
    case "navigate_fallback": {
      const nav = args.navigate!;
      const host = safeHost(nav.url);
      const hint = (nav.text || "").trim().slice(0, 40);
      if (gap0) {
        return trimPlannerRationale(`${co}: open ${host} for ${gap0}${hint ? ` — ${hint}` : ""}`);
      }
      return trimPlannerRationale(`${co}: open ${host}${focusBit}${hint ? ` — ${hint}` : ""}`);
    }
  }
}

export function normalizeUrl(u: string): string | null {
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Generate a simple fingerprint of page content to detect if navigation actually changed the page.
 * Used for state change verification.
 */
export function generatePageFingerprint(snapshot: Extracted | null): string {
  if (!snapshot) return "";
  const parts = [
    snapshot.hostname || "",
    snapshot.page_title || "",
    (snapshot.visible_text || "").slice(0, 500), // First 500 chars of visible text
    snapshot.key_value_claims.map((kv) => `${kv.key}:${kv.value}`).join("|"),
  ];
  return parts.join("||");
}

/**
 * Check if navigation resulted in a meaningful content change.
 * Returns true if content changed significantly, false otherwise.
 */
export function verifyStateChange(previousFingerprint: string, currentFingerprint: string): boolean {
  if (!previousFingerprint || !currentFingerprint) return true; // Assume change if we can't verify
  if (previousFingerprint === currentFingerprint) return false; // No change detected
  
  // Simple similarity check: if fingerprints are > 90% similar, consider it no change
  const maxLength = Math.max(previousFingerprint.length, currentFingerprint.length);
  const diffCount = previousFingerprint.split("").filter((char, i) => char !== currentFingerprint[i]).length;
  const similarity = 1 - (diffCount / maxLength);
  
  return similarity < 0.9; // Return true if less than 90% similar
}

/**
 * Reformulate a query if it fails (no results, paywall, dead end).
 * Uses the active task's fallback_queries or broader terms.
 */
export function reformulateQuery(
  failedQuery: string,
  activeTask: ResearchTask | null,
  companyName: string,
): string[] {
  const reformulations: string[] = [];
  
  // Use task's fallback_queries if available
  if (activeTask?.fallback_queries && activeTask.fallback_queries.length > 0) {
    reformulations.push(...activeTask.fallback_queries);
  }
  
  // Generate broader reformulations
  const queryLower = failedQuery.toLowerCase();
  
  // Remove specific qualifiers to broaden the search
  const broadened = queryLower
    .replace(/\b(specific|exact|precise|particular)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (broadened !== queryLower && broadened.length > 5) {
    reformulations.push(broadened);
  }
  
  // Try with company name + general terms
  const generalTerms = ["overview", "information", "details", "about"];
  for (const term of generalTerms) {
    if (!queryLower.includes(term)) {
      reformulations.push(`${companyName} ${term}`);
    }
  }
  
  // Remove domain-specific terms
  const simplified = queryLower
    .replace(/\b(funding|investment|revenue|customers|team|product)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (simplified.length > 5) {
    reformulations.push(simplified);
  }
  
  return reformulations.slice(0, 5); // Limit to 5 reformulations
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function mergeLinkCandidates(
  outboundLinks: Array<{ url: string; text?: string; heading?: string }>,
  exploreSeeds: Array<{ url: string; text?: string }>,
): Array<{ url: string; text: string; heading?: string }> {
  const seen = new Set<string>();
  const out: Array<{ url: string; text: string; heading?: string }> = [];
  for (const l of outboundLinks) {
    const url = normalizeUrl(l.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, text: (l.text ?? "").trim(), heading: l.heading });
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
  activeTask?: ResearchTask | null;
  /** Hosts blocked for this session (user skipped). */
  blockedHosts?: string[];
  /** Per-host visit counts — skip hosts already at or above MAX_VISITS_PER_HOST. */
  visitedHostCounts?: Map<string, number>;
  unexploredRelevantLinksCount?: number;
}): Array<{ url: string; text: string }> {
  const maxSeeds = Math.max(0, Math.min(20, args.maxSeeds ?? 4)); // reduced from 6 to 4 to prioritize outbound links
  
  // If current page has unexplored relevant links, skip seeds entirely
  if ((args.unexploredRelevantLinksCount ?? 0) > 0) {
    return [];
  }
  
  const current = normalizeUrl(args.currentUrl);
  if (!current) return [];
  const curHost = new URL(current).hostname.toLowerCase();
  const visited = new Set(args.visitedUrls.map((u) => normalizeUrl(u)).filter((u): u is string => Boolean(u)));
  const disliked = new Set(args.dislikedDomains.map((d) => d.toLowerCase().trim()).filter(Boolean));
  const blocked = new Set((args.blockedHosts ?? []).map((h) => h.toLowerCase().trim()));
  const hostCounts = args.visitedHostCounts ?? new Map<string, number>();
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
  
  // Also track which hosts we've already visited via URL list
  const visitedHosts = new Set<string>();
  for (const vu of args.visitedUrls) {
    try { visitedHosts.add(new URL(vu).hostname.toLowerCase()); } catch { /* skip */ }
  }

  const query = args.activeTask
    ? [args.companyName, args.activeTask.evidence_need, ...args.activeTask.query_terms.slice(0, 8)].join(" ").replace(/\s+/g, " ").trim().slice(0, 160)
    : buildResearchSeedQuery({
    companyName: args.companyName,
    companyContext: args.companyContext,
    steeringNote: args.steeringNote,
    openGaps: args.openGaps,
  });
  const activeTaskTokens = args.activeTask
    ? new Set([...args.activeTask.query_terms, args.activeTask.evidence_need, ...args.activeTask.target_gap_fields].flatMap((t) => focusKeywordTokens(t)))
    : null;
  const seeds: Array<{ url: string; text: string }> = [];
  
  // Hybrid scoring: 0.4 * preference_score + 0.6 * task_alignment_score
  const scoredRows = args.preferredRows.map(row => {
    const taskAlignmentScore = args.activeTask ? calculateTaskAlignmentScore(row, args.activeTask, query, activeTaskTokens) : 0.5;
    const combinedScore = 0.4 * row.preference_score + 0.6 * taskAlignmentScore;
    return { ...row, combinedScore };
  });
  
  const sorted = scoredRows.sort((a, b) => b.combinedScore - a.combinedScore);
  
  for (const row of sorted) {
    if (seeds.length >= maxSeeds) break;
    const domain = String(row.domain || "")
      .trim()
      .toLowerCase();
    if (!domain || domain === curHost) continue;
    if (domain === "localhost" || domain.endsWith(".local")) continue;
    const apex = apexHost(domain);
    if (disliked.has(apex) || disliked.has(domain)) continue;
    // Skip hosts that are blocked or already visited at the cap.
    if (blocked.has(apex) || blocked.has(domain)) continue;
    const count = hostCounts.get(apex) ?? hostCounts.get(domain) ?? 0;
    if (count >= MAX_VISITS_PER_HOST) continue;
    // Skip hosts we've already visited at all — seeds are for new exploration.
    if (visitedHosts.has(apex) || visitedHosts.has(domain)) continue;
    if (outboundHosts.has(apex) || outboundHosts.has(domain)) continue;

    const seedUrl =
      trustedDomainSearchUrl(domain, query) ??
      trustedDomainSearchUrl(apex, query);
    if (!seedUrl || visited.has(seedUrl)) continue;

    const cat = String(row.category || "research").trim() || "research";
    if (args.activeTask) {
      const blob = `${domain} ${apex} ${cat} ${query}`.toLowerCase();
      const categoryMatchesSource = args.activeTask.source_kinds.some((kind) => cat.toLowerCase().includes(kind.replace(/_/g, " ")) || cat.toLowerCase().includes(kind));
      const tokenMatchesTask = activeTaskTokens ? Array.from(activeTaskTokens).some((token) => blob.includes(token)) : false;
      if (!categoryMatchesSource && !tokenMatchesTask) continue;
    }
    const qShort = query.length > 52 ? `${query.slice(0, 49)}…` : query;
    seeds.push({
      url: seedUrl,
      text: `Trusted ${cat} · ${apex} · ${qShort}`,
    });
  }
  return seeds;
}

/**
 * Calculate task alignment score for a domain based on how well it matches the active task.
 */
function calculateTaskAlignmentScore(
  row: { domain: string; category: string },
  activeTask: ResearchTask,
  query: string,
  activeTaskTokens: ReadonlySet<string> | null,
): number {
  const domain = row.domain.toLowerCase();
  const cat = row.category.toLowerCase();
  const blob = `${domain} ${cat} ${query}`.toLowerCase();
  
  let score = 0;
  
  // Category match boost
  if (activeTask.source_kinds.some((kind) => cat.includes(kind.replace(/_/g, " ")) || cat.includes(kind))) {
    score += 0.5;
  }
  
  // Token match boost
  if (activeTaskTokens && Array.from(activeTaskTokens).some((token) => blob.includes(token))) {
    score += 0.3;
  }
  
  // Domain relevance boost (if domain contains terms from evidence_need)
  const evidenceNeedLower = activeTask.evidence_need.toLowerCase();
  const evidenceTokens = evidenceNeedLower.split(/\s+/).filter(t => t.length > 3);
  if (evidenceTokens.some(token => domain.includes(token))) {
    score += 0.2;
  }
  
  return Math.min(score, 1);
}

/**
 * Sort preferred-domain rows by user preference_score, with a soft bias for
 * categories whose label appears in the steering note. Pure ordering hint —
 * does not filter or rank link candidates, only seeds.
 */
export function sortPreferredRowsForSteering<T extends { category: string; preference_score: number; success_rate?: number }>(
  rows: T[],
  steeringNote: string | null | undefined,
): T[] {
  const sorted = [...rows];
  const noteLower = (steeringNote ?? "").trim().toLowerCase();
  
  const isDealSourcing = noteLower.includes("deal sourcing") || noteLower.includes("sourcing");
  const dealSourcingCategories = ["traction", "founder", "product", "market"];

  const getEffectiveScore = (row: T) => {
    let score = row.preference_score;
    // Add success rate if available
    if (row.success_rate != null) {
      score += (row.success_rate - 0.5); // Add up to 0.5 to the score for a 100% success rate
    }
    // Boost deal sourcing categories
    if (isDealSourcing && dealSourcingCategories.includes(row.category.toLowerCase().trim())) {
      score += 0.2;
    }
    return score;
  };

  if (!noteLower) {
    sorted.sort((a, b) => getEffectiveScore(b) - getEffectiveScore(a));
    return sorted;
  }

  sorted.sort((a, b) => {
    const ma = noteLower.includes(a.category.toLowerCase().trim()) ? 1 : 0;
    const mb = noteLower.includes(b.category.toLowerCase().trim()) ? 1 : 0;
    if (ma !== mb) return mb - ma;
    return getEffectiveScore(b) - getEffectiveScore(a);
  });
  return sorted;
}

// ---------- Agenda-driven planner ----------

const PLAN_NEXT_PROMPT = `You are an Investor Cognition Copilot. Your goal is to conduct high-conviction research by finding evidence to close specific knowledge gaps.

REASONING DIRECTION:
- CORRECT: "The 'Founding Story' on about.com is evidence for the 'Company Origin' gap. I will navigate there."
- INCORRECT: "My focus is 'Company Origin', so I will go to about.com (generic evidence)."

RESEARCH STRATEGIES:
1. SKIMMING: Fast navigation. If the page doesn't have focus-relevant headers or keywords within the first 1000 characters, NAVIGATE away immediately. Do not linger on generic landing pages.
2. DEEP RESEARCH: Stay and SCROLL until you have exhausted every fact. Extract nuances, pricing, and specific names.
3. FORAGING: If a host has yielded 2+ facts, you've likely reached "Information Saturation". Move to a DIFFERENT domain to cross-reference or find new types of data.

DECISION SIGNALS:
- Depth Profile: Honor the user's learned behavior (scroll depth and draft density).
- Decomposed Tasks: Pursue the active sub-task with its assigned strategy.
- Redundancy: If you have already visited a host 2+ times, it is now "Low Information Scent". Prioritize UNVISITED domains.

Strict JSON output:
{
  "action": "navigate" | "scroll" | "stop",
  "url": "https://...",
  "rationale": "Strategy (Skim/Deep) + Gap being chased + Domain choice logic",
  "agenda_patch": {
    "intent": {
      "next_question": "specific question",
      "candidate_urls": [
        {
          "url": "https://...",
          "why": "Specific evidence expected for <gap>",
          "supports": ["gap_id"]
        }
      ]
    },
    "decomposed_tasks": [
      {"id": "t1", "status": "completed|in_progress|pending", "strategy": "skimming|deep_research"}
    ]
  }
}

Rules:
- NEVER visit the same URL twice.
- AVOID host loops. If you hit a paywall/login, add the host to avoid_hosts immediately.
- EVIDENCE FIRST: Choose candidates based on their likelihood of closing a SPECIFIC gap, not just because they are popular sites.
- Never output anything except valid JSON.`;

function buildPlanNextPrompt(agendaFocus: string, isDeepResearch: boolean): string {
  const trimmed = agendaFocus.trim();
  let base = PLAN_NEXT_PROMPT;
  if (isDeepResearch) {
    base = `${base}\n**DEEP RESEARCH MODE ACTIVE**: Exhaust the current page thoroughly for every possible detail before navigating. Prefer "scroll" if there is ANY chance of finding more data.`;
  }
  if (!trimmed) return base;
  const safe = trimmed.slice(0, 480).replace(/"/g, "'");
  return `${base}

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
  /** Whether this candidate came from the current page's outbound links (vs. a trusted seed). */
  is_outbound_link: boolean;
  /** Whether this outbound link sits inside a skim-outline section the user already viewed. */
  in_viewed_section: boolean;
  heading?: string;
  utility_score?: number;
  /** Feature vector built at decision time — logged to copilot_ranking_event. */
  features?: RecommenderFeatures;
  /** Linear score from features · weights (no sigmoid). Used for ranking + UI rationale. */
  model_score?: number;
  /** Human-readable feature breakdown for UI rationale. */
  rationale_breakdown?: string;
};

function focusKeywordTokens(focus: string): string[] {
  return focus
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 2);
}

function activeTaskTokens(agenda: ResearchAgenda, focus: string): string[] {
  const active = getActiveResearchTask(agenda);
  const taskText = active?.description ?? "";
  const taskSpecific = active
    ? `${active.evidence_need} ${active.target_gap_fields.join(" ")} ${active.query_terms.join(" ")}`
    : "";
  return focusKeywordTokens(`${focus} ${taskText} ${taskSpecific}`);
}

/**
 * Build the feature context shared by all candidates this tick.
 * Pulls accepted/rejected hosts from the agenda + caller-supplied snippets.
 */
function buildFeatureContext(args: {
  agenda: ResearchAgenda;
  acceptedSnippets: ReadonlyArray<{ hostname?: string | null; source_url?: string | null }>;
  rejectedHosts?: ReadonlyArray<string>;
  draftSourceUrls?: ReadonlyArray<string>;
  currentUrl?: string;
}): FeatureContext {
  const focus = args.agenda.focus ?? "";
  const taskTokens = activeTaskTokens(args.agenda, focus);
  const active = getActiveResearchTask(args.agenda);
  const taskSourceKinds = active?.source_kinds ?? [];
  const currentHost = args.currentUrl ? safeHost(args.currentUrl) ?? "" : "";
  const taskEvidenceNeed = active?.evidence_need ?? "";
  const informationGainHistory = args.agenda.information_gain_history;
  const failedPaths = args.agenda.failed_hosts;

  const acceptedHosts = new Set<string>();
  for (const s of args.acceptedSnippets) {
    const fromUrl = s.source_url ? safeHost(s.source_url) : "";
    const host = (fromUrl || (s.hostname ?? "")).toLowerCase().replace(/^www\./, "");
    if (host) acceptedHosts.add(host);
  }
  for (const u of args.draftSourceUrls ?? []) {
    const h = safeHost(u);
    if (h) acceptedHosts.add(h.replace(/^www\./, ""));
  }

  const rejectedHosts = new Set<string>();
  for (const h of args.rejectedHosts ?? []) {
    const norm = h.toLowerCase().replace(/^www\./, "");
    if (norm) rejectedHosts.add(norm);
  }
  for (const note of args.agenda.intent.avoid_hosts) {
    const norm = note.target.toLowerCase().replace(/^www\./, "");
    if (norm) rejectedHosts.add(norm);
  }
  for (const h of args.agenda.declined_hosts ?? []) {
    const norm = h.toLowerCase().replace(/^www\./, "");
    if (norm) rejectedHosts.add(norm);
  }

  const blockedHosts = new Set<string>();
  for (const h of args.agenda.blocked_hosts ?? []) {
    const norm = h.toLowerCase().replace(/^www\./, "");
    if (norm) blockedHosts.add(norm);
  }

  const avgVisits = args.agenda.depth_profile?.avg_visits_per_host ?? 2;

  return {
    taskTokens,
    taskSourceKinds,
    avgVisitsPerHost: avgVisits,
    acceptedHosts,
    rejectedHosts,
    blockedHosts,
    // New hybrid exploration context
    currentHost,
    taskEvidenceNeed,
    informationGainHistory,
    failedPaths,
  };
}

/**
 * Score every candidate with the feature-vector model.
 *
 * Mutates `args.candidates` in place: assigns features/model_score/rationale_breakdown
 * and sorts descending by model_score. Candidates whose host is in
 * `featureContext.blockedHosts` are removed (hard exclude).
 */
function rankCandidates(args: {
  candidates: CandidateMeta[];
  weights: RecommenderWeights;
  featureContext: FeatureContext;
  /** Apex hosts of recently visited URLs (last N) — drop candidates already there. */
  recentVisitedHosts?: ReadonlySet<string>;
  currentUrl?: string;
  trustedSeeds?: ReadonlySet<string>;
  unexploredRelevantLinksCount?: number;
}): void {
  const currentHost = args.currentUrl ? safeHost(args.currentUrl) ?? "" : "";
  const trustedSeeds = args.trustedSeeds ?? new Set();
  const unexploredRelevantLinksCount = args.unexploredRelevantLinksCount ?? 0;

  // Hard exclude blocked hosts
  for (let i = args.candidates.length - 1; i >= 0; i--) {
    const c = args.candidates[i];
    const host = c.host.toLowerCase().replace(/^www\./, "");
    const norm = host.toLowerCase().replace(/^www\./, "");
    if (args.featureContext.blockedHosts.has(norm)) {
      args.candidates.splice(i, 1);
      continue;
    }
    if (args.recentVisitedHosts?.has(norm)) {
      args.candidates.splice(i, 1);
      continue;
    }
  }

  for (const c of args.candidates) {
    const features = buildCandidateFeatures(
      {
        url: c.url,
        host: c.host,
        text: c.text,
        heading: c.heading,
        hostVisitCount: c.host_visit_count,
        isOutboundLink: c.is_outbound_link,
        inViewedSection: c.in_viewed_section,
        // New hybrid exploration inputs
        currentHost,
        isTrustedSeed: trustedSeeds.has(c.host),
        unexploredRelevantLinks: unexploredRelevantLinksCount,
      },
      args.featureContext,
    );
    c.features = features;
    c.model_score = scoreFeatures(features, args.weights);
    c.utility_score = c.model_score;
    c.rationale_breakdown = formatFeatureBreakdown(features, args.weights);
  }

  args.candidates.sort((a, b) => {
    const sa = a.model_score ?? 0;
    const sb = b.model_score ?? 0;
    if (sa !== sb) return sb - sa;
    // Tie-break: lower visit-count, then alphabetical host.
    if (a.host_visit_count !== b.host_visit_count) return a.host_visit_count - b.host_visit_count;
    return a.host.localeCompare(b.host);
  });
}

/** Compose a short feature breakdown for the rationale UI. */
function formatFeatureBreakdown(x: RecommenderFeatures, w: RecommenderWeights): string {
  const parts: string[] = [];
  const fmt = (label: string, contribution: number): void => {
    if (Math.abs(contribution) < 0.05) return;
    const sign = contribution >= 0 ? "+" : "";
    parts.push(`${label} (${sign}${contribution.toFixed(2)})`);
  };
  fmt("task fit", w.w_task * x.task_fit);
  fmt("freq penalty", w.w_freq * x.freq_penalty);
  fmt("accept history", w.w_accept * x.accept_signal);
  fmt("reject history", w.w_reject * x.reject_signal);
  fmt("page relevance", w.w_page * x.page_relevance);
  return parts.join("; ");
}

/**
 * ε-greedy exploration. With probability ε, swap the top candidate with one of
 * the next 3 (uniformly). Decays as we accumulate updates.
 */
function applyExploration(candidates: CandidateMeta[], updatesCount: number): void {
  if (candidates.length < 2) return;
  const eps = explorationEpsilon(updatesCount);
  if (Math.random() >= eps) return;
  const swapWith = 1 + Math.floor(Math.random() * Math.min(3, candidates.length - 1));
  const top = candidates[0];
  candidates[0] = candidates[swapWith];
  candidates[swapWith] = top;
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
  if (P > 0 && P <= 8 && S < 0.92) return "scroll";
  return defer;
}

function buildAvoidHostSet(agenda: ResearchAgenda, dislikedHostnames?: string[]): Set<string> {
  const set = new Set<string>();
  for (const a of agenda.intent.avoid_hosts) set.add(apexHost(a.target));
  for (const d of dislikedHostnames ?? []) set.add(apexHost(d));
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
  outboundLinks: Array<{ url: string; text?: string; heading?: string }>;
  exploreSeeds: Array<{ url: string; text?: string }>;
  copilotExploreHints: Array<{ url: string; text?: string; heading?: string }>;
  currentUrl: string;
  visitedUrls: string[];
  visitedHostCounts: Map<string, number>;
  dislikedHostnames: string[];
  /** Lower-cased headings the user has already viewed on the current page. */
  viewedSectionHeadings?: ReadonlySet<string>;
}): CandidateMeta[] {
  const merged = mergeLinkCandidates(
    [...args.outboundLinks, ...args.copilotExploreHints],
    args.exploreSeeds,
  );
  const outboundUrlSet = new Set(
    [...args.outboundLinks, ...args.copilotExploreHints]
      .map((l) => normalizeUrl(l.url))
      .filter((u): u is string => Boolean(u)),
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
  const viewed = args.viewedSectionHeadings ?? new Set<string>();

  const out: CandidateMeta[] = [];
  for (const c of merged) {
    if (c.url === currentNorm) continue;
    if (visited.has(c.url)) continue;
    const host = safeHost(c.url);
    if (!host) continue;

    const isExploreHint = exploreHintSet.has(c.url);
    const isTrustedSeed = trustedSeedSet.has(c.url);
    const isOutboundLink = outboundUrlSet.has(c.url);

    if (avoidUrls.has(c.url)) continue;
    if (avoidHosts.has(host)) continue;

    const visitCount = host === currentHost ? 0 : args.visitedHostCounts.get(host) ?? 0;
    const maxVisits = isExploreHint ? 4 : MAX_VISITS_PER_HOST;
    if (visitCount >= maxVisits) continue;

    out.push({
      url: c.url,
      text: c.text,
      host,
      host_visit_count: visitCount,
      in_avoid_url: false,
      in_avoid_host: false,
      is_explore_hint: isExploreHint,
      is_trusted_seed: isTrustedSeed,
      is_outbound_link: isOutboundLink,
      in_viewed_section: c.heading ? viewed.has(c.heading.toLowerCase()) : false,
      heading: c.heading,
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
  // Don't blindly prefer explore hints or trusted seeds — those are the generic
  // aggregators that cause loops. Just use the top-ranked candidate (which is
  // already scored by information gain, nav cost, etc.).
  return pickFallbackCandidate(agenda, candidates);
}

function fallbackResult(args: {
  agenda: ResearchAgenda;
  candidates: CandidateMeta[];
  defer: "scroll" | "wait" | null;
  reason: string;
  companyLabel: string;
}): { action: NextAction; patch: AgendaPatch; errors: string[] } {
  if (args.defer === "scroll") {
    return {
      action: {
        action: "scroll",
        rationale: mechanicalPlannerRationale({
          kind: "scroll",
          companyLabel: args.companyLabel,
          agenda: args.agenda,
        }),
      },
      patch: EMPTY_AGENDA_PATCH,
      errors: [args.reason],
    };
  }
  if (args.defer === "wait") {
    return {
      action: {
        action: "stop",
        rationale: mechanicalPlannerRationale({
          kind: "wait",
          companyLabel: args.companyLabel,
          agenda: args.agenda,
        }),
      },
      patch: EMPTY_AGENDA_PATCH,
      errors: [args.reason],
    };
  }
  const choice = pickFallbackCandidate(args.agenda, args.candidates);
  if (!choice) {
    return {
      action: {
        action: "stop",
        rationale: mechanicalPlannerRationale({
          kind: "stop_no_candidates",
          companyLabel: args.companyLabel,
          agenda: args.agenda,
        }),
      },
      patch: EMPTY_AGENDA_PATCH,
      errors: [args.reason],
    };
  }
  return {
    action: {
      action: "navigate",
      url: choice.url,
      rationale: mechanicalPlannerRationale({
        kind: "navigate_fallback",
        companyLabel: args.companyLabel,
        agenda: args.agenda,
        navigate: { url: choice.url, text: choice.text },
      }),
    },
    patch: EMPTY_AGENDA_PATCH,
    errors: [args.reason],
  };
}

function coerceModelAction(
  raw: unknown,
  ctx: { allowedNavigateUrls: ReadonlySet<string>; companyLabel: string; agenda: ResearchAgenda },
): NextAction | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const rationale = typeof r.rationale === "string" ? r.rationale.trim().slice(0, 120) : "";
  if (r.action === "scroll") {
    return {
      action: "scroll",
      rationale:
        rationale ||
        mechanicalPlannerRationale({ kind: "scroll", companyLabel: ctx.companyLabel, agenda: ctx.agenda }),
    };
  }
  if (r.action === "stop") {
    return {
      action: "stop",
      rationale:
        rationale ||
        mechanicalPlannerRationale({ kind: "stop_generic", companyLabel: ctx.companyLabel, agenda: ctx.agenda }),
    };
  }
  if (r.action !== "navigate") return null;
  const url = typeof r.url === "string" ? normalizeUrl(r.url) : null;
  if (!url || !ctx.allowedNavigateUrls.has(url)) return null;
  return {
    action: "navigate",
    url,
    rationale:
      rationale ||
      mechanicalPlannerRationale({
        kind: "navigate_fallback",
        companyLabel: ctx.companyLabel,
        agenda: ctx.agenda,
        navigate: { url, text: "" },
      }),
  };
}

export type PlanNextResult = {
  action: NextAction;
  patch: AgendaPatch;
  errors: string[];
  /** Compact list of deterministic-allowed candidates that went into the prompt (debugging/UI). */
  candidates: CandidateMeta[];
  /** Top-K (default 5) candidates with their feature vectors — caller logs these for SGD attribution. */
  rankingEvents?: Array<{
    candidate_url: string;
    candidate_host: string;
    features: RecommenderFeatures;
    chosen: boolean;
  }>;
};

/** Prefer lite model for faster plan-next; fall back to flash if lite env is not configured. */
function copilotPlannerModel(): string {
  try {
    return getResearchModel("flash_lite");
  } catch {
    return getResearchModel("flash");
  }
}

/** Race a promise against a timeout; on timeout rejects with `Error("timeout")`. */
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

/** Top-K candidates → ranking-event payload (only candidates whose features were computed). */
function buildRankingEvents(
  candidates: CandidateMeta[],
  chosenUrl: string | null,
  topK = 5,
): NonNullable<PlanNextResult["rankingEvents"]> {
  const out: NonNullable<PlanNextResult["rankingEvents"]> = [];
  for (const c of candidates.slice(0, topK)) {
    if (!c.features) continue;
    out.push({
      candidate_url: c.url,
      candidate_host: c.host,
      features: c.features,
      chosen: chosenUrl !== null && c.url === chosenUrl,
    });
  }
  return out;
}

export async function planNextActionWithAgenda(args: {
  agenda: ResearchAgenda;
  /** Shown in prompts and fallbacks so rationales stay company-specific. */
  companyDisplayName: string;
  currentUrl: string;
  pageTitle?: string | null;
  visibleTextExcerpt?: string | null;
  snapshot?: { skim_outline?: { sections?: Array<{ heading?: string; lead_text?: string; top_ratio?: number }> } | null };
  pageSignals?: PlanPageSignals;
  outboundLinks: Array<{ url: string; text?: string }>;
  exploreSeeds?: Array<{ url: string; text?: string }>;
  copilotExploreHints?: Array<{ url: string; text?: string }>;
  visitedUrls: string[];
  visitedHostCounts?: Map<string, number>;
  dislikedHostnames?: string[];
  preferredHostnames?: import("@/lib/research/preferences").UserSitePreference[];
  playbook?: import("@/lib/research/playbook").LearnedPlaybook;
  isDeepResearch?: boolean;
  /** User's learned recommender weights (defaults to RECOMMENDER_PRIORS). */
  weights?: RecommenderWeights;
  /** Number of SGD updates already applied — drives ε-greedy decay. */
  weightsUpdatesCount?: number;
  /** Snippets the user has accepted in this session — used for accept_signal feature. */
  acceptedSnippets?: ReadonlyArray<{ hostname?: string | null; source_url?: string | null; text?: string }>;
  /** Source URLs of unaccepted-but-drafted snippets — used for accept_signal (smaller weight). */
  draftSourceUrls?: ReadonlyArray<string>;
  /** Hosts the user has rejected snippets from. */
  rejectedHosts?: ReadonlyArray<string>;
  /** Hard server-side timeout (ms) around the LLM call. Defaults to 5_000. */
  llmTimeoutMs?: number;
}): Promise<PlanNextResult> {
  const PAYWALL_REGEX = /(sign in to continue|log in to|subscribe to read|create an account to|please log in|paywall|join now to see|unlock this profile|sign up for free to|login to view)/i;
  const isPaywall =
    /\/(login|signin|signup|auth|register|subscribe)/i.test(args.currentUrl) ||
    ((args.visibleTextExcerpt?.length || 0) < 1500 && PAYWALL_REGEX.test(args.visibleTextExcerpt || ""));

  const currentApex = apexHost(safeHost(args.currentUrl));
  const isBlocked =
    args.agenda.blocked_hosts?.some((h) => apexHost(h) === currentApex) ||
    args.agenda.intent.avoid_hosts?.some((h) => apexHost(h.target) === currentApex);

  if (isPaywall && !isBlocked) {
    const host = safeHost(args.currentUrl);
    return {
      action: { action: "stop", rationale: "Hit a paywall or login screen on this site. Pausing so you can log in, or you can steer me elsewhere." },
      patch: host
        ? {
            intent: {
              ...args.agenda.intent,
              avoid_hosts: [
                ...args.agenda.intent.avoid_hosts,
                { target: host, reason: "Paywall or login detected" },
              ],
            },
          }
        : EMPTY_AGENDA_PATCH,
      errors: [],
      candidates: [],
      rankingEvents: [],
    };
  }

  const companyLabel = plannerCompanyLabel(args.companyDisplayName, args.agenda);
  const weights = args.weights ?? { ...RECOMMENDER_PRIORS };
  const updatesCount = Math.max(0, args.weightsUpdatesCount ?? 0);

  const visitedHostCounts = args.visitedHostCounts ?? new Map<string, number>();

  // Recently visited hosts (last 3 entries) → hard filter from candidates.
  const recentVisitedHosts = new Set<string>();
  for (const u of args.visitedUrls.slice(0, 3)) {
    const h = safeHost(u);
    if (h) recentVisitedHosts.add(h.replace(/^www\./, ""));
  }

  const viewedSectionHeadings = new Set<string>(
    (args.pageSignals?.focusedSectionHeadings ?? []).map((h) => h.toLowerCase()),
  );

  const candidates = buildCandidateMetas({
    agenda: args.agenda,
    outboundLinks: args.outboundLinks,
    exploreSeeds: args.exploreSeeds ?? [],
    copilotExploreHints: args.copilotExploreHints ?? [],
    currentUrl: args.currentUrl,
    visitedUrls: args.visitedUrls,
    visitedHostCounts,
    dislikedHostnames: args.dislikedHostnames ?? [],
    viewedSectionHeadings,
  });

  const featureContext = buildFeatureContext({
    agenda: args.agenda,
    acceptedSnippets: args.acceptedSnippets ?? [],
    rejectedHosts: args.rejectedHosts ?? [],
    draftSourceUrls: args.draftSourceUrls ?? [],
    currentUrl: args.currentUrl,
  });

  rankCandidates({
    candidates,
    weights,
    featureContext,
    recentVisitedHosts,
    currentUrl: args.currentUrl,
    trustedSeeds: new Set((args.exploreSeeds ?? []).map(s => safeHost(s.url)).filter((h): h is string => Boolean(h))),
    unexploredRelevantLinksCount: countUnexploredRelevantLinks(args.outboundLinks, args.visitedUrls),
  });

  // ε-greedy exploration once ranking is settled.
  applyExploration(candidates, updatesCount);

  const focusTrim = (args.agenda.focus ?? "").trim();
  const activeTask = getActiveResearchTask(args.agenda);

  // Limit to top 8 candidates for the LLM.
  const topCandidates = candidates.slice(0, 8);
  const allowedNavigateUrls = new Set(topCandidates.map((c) => c.url));
  const scrollTarget = taskScrollTarget({ agenda: args.agenda, pageSignals: args.pageSignals, snapshot: args.snapshot });

  const defer = relaxFocusNavigationMomentum(
    relaxDeferAfterFocusYield(
      relaxDeferWhenFocused(
        deferLeavingPage(args.pageSignals, args.currentUrl, args.agenda, countUnexploredRelevantLinks(args.outboundLinks, args.visitedUrls)),
        focusTrim,
        args.pageSignals,
      ),
      focusTrim,
      args.pageSignals,
      args.agenda,
    ),
    focusTrim,
    args.pageSignals,
    args.agenda,
  );

  // Defer short-circuit: when mechanics say "scroll" or "wait", skip the LLM
  // entirely (this is the main p99-latency win).
  if (defer === "scroll") {
    return {
      action: {
        action: "scroll",
        rationale: mechanicalPlannerRationale({ kind: "scroll", companyLabel, agenda: args.agenda }),
        ...scrollTarget,
      },
      patch: EMPTY_AGENDA_PATCH,
      errors: ["defer_short_circuit"],
      candidates,
      rankingEvents: buildRankingEvents(candidates, null),
    };
  }
  if (defer === "wait") {
    return {
      action: {
        action: "stop",
        rationale: mechanicalPlannerRationale({ kind: "wait", companyLabel, agenda: args.agenda }),
      },
      patch: EMPTY_AGENDA_PATCH,
      errors: ["defer_short_circuit"],
      candidates,
      rankingEvents: buildRankingEvents(candidates, null),
    };
  }

  if (candidates.length === 0) {
    return {
      ...fallbackResult({ agenda: args.agenda, candidates, defer, reason: "no_candidates", companyLabel }),
      candidates,
      rankingEvents: [],
    };
  }

  // Cold-start fast path: when the user has never had a labeled outcome,
  // skip the LLM and trust the deterministic ranking + priors. This avoids
  // 8s LLM round-trips on day one when the model can't yet help.
  if (updatesCount === 0) {
    const top = candidates[0];
    if (top) {
      const breakdown = top.rationale_breakdown ? ` — ${top.rationale_breakdown}` : "";
      return {
        action: {
          action: "navigate",
          url: top.url,
          rationale: mechanicalPlannerRationale({
            kind: "navigate_fallback",
            companyLabel,
            agenda: args.agenda,
            navigate: { url: top.url, text: top.text },
          }) + breakdown.slice(0, 60),
        },
        patch: EMPTY_AGENDA_PATCH,
        errors: ["cold_start_skipped_llm"],
        candidates,
        rankingEvents: buildRankingEvents(candidates, top.url),
      };
    }
  }

  const plannerPrompt = buildPlanNextPrompt(args.agenda.focus ?? "", args.agenda.is_deep_research);

  const inputs: Array<{ label: string; value: unknown }> = [
    { label: "ResearchAgenda", value: summarizeAgendaForPrompt(args.agenda) },
    {
      label: "Current page",
      value: {
        url: args.currentUrl,
        host: safeHost(args.currentUrl),
        title: args.pageTitle ?? null,
      },
    },
    { label: "On-screen visible text excerpt", value: args.visibleTextExcerpt || "" },
    { label: "Page yield signals", value: args.pageSignals ?? {} },
    { label: "Active decomposed task", value: activeTask ?? null },
    {
      label: "Allowed next candidate URLs (prioritized by recommender)",
      value: topCandidates.map((c) => ({
        url: c.url,
        text: c.text,
        host: c.host,
        visits_to_host: c.host_visit_count,
        recommender_score: Math.round((c.model_score ?? 0) * 100) / 100,
        feature_breakdown: c.rationale_breakdown,
      })),
    },
    { label: "Learned User Playbook Rules", value: args.playbook?.rules.map((r) => r.rule_text) ?? [] },
    {
      label: "Defer hint (mechanical page-yield rule — honor when present)",
      value: defer ?? "none",
    },
    {
      label: "Rationale discipline",
      value: `Company: "${args.companyDisplayName.trim() || "Company"}". Every action.rationale must follow the EVIDENCE-FIRST pattern: "Choosing [domain] to find [evidence type] for the [gap_id] gap." Do NOT use the focus as generic evidence.`,
    },
  ];

  let raw = "";
  try {
    raw = await withTimeout(
      vertexRunWithTextMulti(copilotPlannerModel(), plannerPrompt, inputs, false),
      args.llmTimeoutMs ?? 5_000,
    );
  } catch (err) {
    // Timeout / model error → use the deterministic top candidate.
    const top = candidates[0];
    const reason = err instanceof Error ? err.message : String(err);
    if (top) {
      return {
        action: {
          action: "navigate",
          url: top.url,
          rationale: `${companyLabel}: open ${top.host} (LLM ${reason} — used recommender ranking)`.slice(0, 120),
        },
        patch: EMPTY_AGENDA_PATCH,
        errors: [`llm_${reason}`],
        candidates,
        rankingEvents: buildRankingEvents(candidates, top.url),
      };
    }
    return {
      ...fallbackResult({ agenda: args.agenda, candidates, defer, reason: `model_error: ${reason}`, companyLabel }),
      candidates,
      rankingEvents: buildRankingEvents(candidates, null),
    };
  }

  const parsed = parseJsonFromResponseOrNull(raw) as Record<string, unknown> | null;
  if (!parsed) {
    return {
      ...fallbackResult({ agenda: args.agenda, candidates, defer, reason: "model_unparseable", companyLabel }),
      candidates,
      rankingEvents: buildRankingEvents(candidates, candidates[0]?.url ?? null),
    };
  }

  const knownGapFields = new Set(args.agenda.open_gaps.map((g) => g.field));
  const knownHypothesisIds = new Set(args.agenda.hypotheses.map((h) => h.id));
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

  const action = coerceModelAction(parsed, { allowedNavigateUrls, companyLabel, agenda: args.agenda });
  if (!action) {
    return {
      ...fallbackResult({ agenda: args.agenda, candidates, defer, reason: "model_action_invalid", companyLabel }),
      candidates,
      patch,
      errors: ["model_action_invalid", ...errors],
      rankingEvents: buildRankingEvents(candidates, candidates[0]?.url ?? null),
    };
  }

  const chosenUrl = action.action === "navigate" ? action.url : null;

  // Anti-idle: do not honor model "stop" when real URLs are available and we are not waiting on suggestions.
  if (action.action === "stop" && candidates.length > 0) {
    const choice = pickAntiIdleCandidate(args.agenda, candidates);
    if (choice) {
      const co = (args.companyDisplayName || args.agenda.company?.name || "Company").trim() || "Company";
      const host = safeHost(choice.url);
      const breakdown = choice.rationale_breakdown ? ` — ${choice.rationale_breakdown}` : "";
      const rationale = `${co}: open ${host}${breakdown}`.slice(0, 120);
      return {
        action: { action: "navigate", url: choice.url, rationale },
        patch,
        errors: [...errors, "anti_idle_overrode_stop"],
        candidates,
        rankingEvents: buildRankingEvents(candidates, choice.url),
      };
    }
  }

  // For navigate actions, always append the recommender breakdown so the user
  // sees real reasoning instead of just the focus echo.
  if (action.action === "navigate") {
    const chosen = candidates.find((c) => c.url === action.url);
    if (chosen?.rationale_breakdown) {
      const trimmed = action.rationale.replace(/\s+—\s+task fit.*$/i, "").trim();
      action.rationale = `${trimmed} — ${chosen.rationale_breakdown}`.slice(0, 200);
    }
  }

  return {
    action,
    patch,
    errors,
    candidates,
    rankingEvents: buildRankingEvents(candidates, chosenUrl),
  };
}
