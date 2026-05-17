import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/research/db";
import {
  appendVisitedUrl,
  getAutoDraft,
  getAutoSteeringNote,
  getRecentDealClaims,
  getResearchAgenda,
  getSessionForUser,
  getVisitedHostCounts,
  getVisitedUrls,
  setResearchAgenda,
} from "@/lib/copilot/db";
import {
  buildCompanyContext,
  buildTrustedDomainExploreSeeds,
  computeOpenGaps,
  normalizeUrl,
  parsePlanPageSignals,
  planNextActionWithAgenda,
  reformulateQuery,
  sortPreferredRowsForSteering,
} from "@/lib/copilot/plan-next";
import {
  applyAgendaPatch,
  emptyAgenda,
  ensureAgendaHasConcreteIntent,
  ensureTaskPlanForAgenda,
  recomputeAgendaFacts,
  type ResearchAgenda,
} from "@/lib/copilot/research-agenda";
import { copilotPreflight, withCopilotCors } from "@/lib/copilot/cors";
import { getUserSitePreferences } from "@/lib/research/preferences";
import { getLearnedPlaybook } from "@/lib/research/playbook";
import { decomposeFocusIntoTasks } from "@/lib/copilot/decompose-focus";
import {
  getUserRecommenderWeights,
  logRankingEvents,
} from "@/lib/copilot/recommender-weights";

function asCompanyName(meta: unknown): string {
  if (!meta || typeof meta !== "object") return "Company";
  const m = meta as Record<string, unknown>;
  return typeof m.company_name === "string" ? m.company_name : "Company";
}

type AcceptedSnippetLite = {
  text: string;
  source_url?: string | null;
  source_label?: string | null;
  accepted_at?: string | null;
};

function getSessionAcceptedSnippets(meta: unknown): AcceptedSnippetLite[] {
  if (!meta || typeof meta !== "object") return [];
  const m = meta as Record<string, unknown>;
  if (!Array.isArray(m.acceptedSnippets)) return [];
  const out: AcceptedSnippetLite[] = [];
  for (const raw of m.acceptedSnippets) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const text = typeof r.text === "string" ? r.text.trim() : "";
    if (!text) continue;
    out.push({
      text: text.slice(0, 1200),
      source_url: typeof r.source_url === "string" ? r.source_url : null,
      source_label: typeof r.source_label === "string" ? r.source_label : null,
      accepted_at: typeof r.accepted_at === "string" ? r.accepted_at : null,
    });
    if (out.length >= 25) break;
  }
  return out;
}

function normalizeOutboundLinks(v: unknown): Array<{ url: string; text: string; heading?: string }> {
  if (!Array.isArray(v)) return [];
  const out: Array<{ url: string; text: string; heading?: string }> = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const urlRaw = typeof r.url === "string" ? r.url.trim() : "";
    if (!urlRaw) continue;
    let parsed: URL;
    try {
      parsed = new URL(urlRaw);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    const normalized = parsed.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({
      url: normalized,
      text: typeof r.text === "string" ? r.text.trim().slice(0, 120) : "Link",
      heading: typeof r.heading === "string" ? r.heading.trim().slice(0, 120) : undefined,
    });
    if (out.length >= 36) break;
  }
  return out;
}

function normalizeCopilotExploreLinks(v: unknown): Array<{ url: string; text: string; heading?: string }> {
  if (!Array.isArray(v)) return [];
  const out: Array<{ url: string; text: string; heading?: string }> = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const urlRaw = typeof r.url === "string" ? r.url.trim() : "";
    if (!urlRaw) continue;
    let parsed: URL;
    try {
      parsed = new URL(urlRaw);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    const normalized = parsed.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const text = typeof r.text === "string" ? r.text.trim().slice(0, 160) : "";
    const heading = typeof r.heading === "string" ? r.heading.trim().slice(0, 120) : undefined;
    out.push({ url: normalized, text: text || "Copilot explore target", heading });
    if (out.length >= 10) break;
  }
  return out;
}

function buildPreferencesSummary(args: {
  preferred: Array<{ domain: string; category?: string; preference_score: number; focus_guidance?: string }>;
  disliked: Array<{ domain: string }>;
}): string {
  const top = args.preferred
    .slice(0, 8)
    .map((p) => {
      const category = p.category ? p.category : "general";
      const guidance = p.focus_guidance ? `: ${p.focus_guidance.slice(0, 90)}` : "";
      return `${p.domain} (${category}${guidance})`;
    })
    .join(", ");
  const dis = args.disliked.slice(0, 6).map((d) => d.domain).join(", ");
  const parts: string[] = [];
  if (top) parts.push(`Preferred: ${top}`);
  if (dis) parts.push(`Avoid: ${dis}`);
  return parts.join(". ").slice(0, 600);
}

function getAcceptedSourceUrls(snippets: AcceptedSnippetLite[]): string[] {
  return snippets.map((s) => s.source_url ?? "").filter((u): u is string => Boolean(u));
}

function buildVisibleTextExcerpt(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 1600);
}

function pageTitleFromSnapshot(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, 240) : null;
}

function skimSnapshotForPlanner(snapshot: unknown): { skim_outline?: { sections?: Array<{ heading?: string; lead_text?: string; top_ratio?: number }> } | null } | undefined {
  if (!snapshot || typeof snapshot !== "object") return undefined;
  const skim = (snapshot as Record<string, unknown>).skim_outline;
  if (!skim || typeof skim !== "object") return undefined;
  const sectionsRaw = (skim as Record<string, unknown>).sections;
  if (!Array.isArray(sectionsRaw)) return { skim_outline: { sections: [] } };
  return {
    skim_outline: {
      sections: sectionsRaw
        .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
        .map((s) => ({
          heading: typeof s.heading === "string" ? s.heading : undefined,
          lead_text: typeof s.lead_text === "string" ? s.lead_text : undefined,
          top_ratio: typeof s.top_ratio === "number" ? s.top_ratio : undefined,
        })),
    },
  };
}

export async function OPTIONS(req: Request) {
  return copilotPreflight(req);
}

export async function POST(req: Request, ctx: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await ctx.params;
  const user = await getAuthedUser();
  if (!user) return withCopilotCors(req, NextResponse.json({ error: "Unauthorized" }, { status: 401 }));

  const body = (await req.json().catch(() => null)) as
    | {
        currentUrl?: unknown;
        copilot_explore_links?: unknown;
        plan_page_context?: unknown;
        steering_hint?: unknown;
        snapshot?: {
          visible_text?: unknown;
          page_title?: unknown;
          hostname?: unknown;
          key_value_claims?: unknown;
          outbound_links?: unknown;
          skim_outline?: unknown;
        } | null;
      }
    | null;
  const currentUrl = typeof body?.currentUrl === "string" ? body.currentUrl.trim() : "";
  if (!currentUrl) {
    return withCopilotCors(req, NextResponse.json({ error: "currentUrl is required" }, { status: 400 }));
  }
  const hasSnapshot = body?.snapshot && typeof body.snapshot === "object";
  if (!hasSnapshot) {
    return withCopilotCors(req, NextResponse.json({ error: "snapshot is required" }, { status: 400 }));
  }
  const copilotExploreHints = normalizeCopilotExploreLinks(body.copilot_explore_links);
  const pageSignals = parsePlanPageSignals(body.plan_page_context);
  const domOutbound = normalizeOutboundLinks(body.snapshot?.outbound_links);
  const visibleTextExcerpt = buildVisibleTextExcerpt(body.snapshot?.visible_text);
  const pageTitle = pageTitleFromSnapshot(body.snapshot?.page_title);

  const admin = createAdminClient();
  const session = await getSessionForUser({ admin, sessionId, userId: user.id });
  if (!session) return withCopilotCors(req, NextResponse.json({ error: "Session not found" }, { status: 404 }));
  if (session.status !== "active") {
    return withCopilotCors(req, NextResponse.json({ error: "Session is not active" }, { status: 409 }));
  }

  const [dealRes, recentClaims, sitePrefs, playbook, loadedWeights] = await Promise.all([
    admin
      .schema("deal_intel")
      .from("deal")
      .select("metadata")
      .eq("id", session.deal_id)
      .eq("user_id", user.id)
      .maybeSingle(),
    getRecentDealClaims({ admin, dealId: session.deal_id, userId: user.id, limit: 12 }),
    getUserSitePreferences({ admin, userId: user.id, limit: 80 }),
    getLearnedPlaybook({ admin, userId: user.id }),
    getUserRecommenderWeights({ admin, userId: user.id }),
  ]);
  if (dealRes.error) {
    return withCopilotCors(req, NextResponse.json({ error: dealRes.error.message }, { status: 500 }));
  }

  const dealMeta = (dealRes.data?.metadata ?? {}) as Record<string, unknown>;
  const visitedUrls = getVisitedUrls(session.metadata);
  const visitedHostCounts = getVisitedHostCounts(visitedUrls);
  const sessionAcceptedSnippets = getSessionAcceptedSnippets(session.metadata);
  const draftSnippets = getAutoDraft(session.metadata).snippets;
  const draftSourceUrls = draftSnippets.map((s) => s.source_url ?? "").filter((u): u is string => Boolean(u));
  const acceptedSourceUrls = getAcceptedSourceUrls(sessionAcceptedSnippets);
  const clientSteeringHint =
    typeof body?.steering_hint === "string" && body.steering_hint.trim()
      ? body.steering_hint.trim().slice(0, 2000)
      : null;
  const steeringNote = clientSteeringHint ?? getAutoSteeringNote(session.metadata);
  const companyName = asCompanyName(dealMeta);
  const companyContext = buildCompanyContext({ name: companyName, metadata: dealMeta });
  const openGaps = computeOpenGaps({
    metadata: dealMeta,
    recentClaims,
    sessionAcceptedSnippets,
  });
  const preferredForSession = sortPreferredRowsForSteering(sitePrefs.preferred, steeringNote);
  const preferencesSummary = buildPreferencesSummary({
    preferred: preferredForSession.map((p) => ({
      domain: p.domain,
      category: p.category,
      preference_score: p.preference_score,
      focus_guidance: p.focus_guidance,
    })),
    disliked: sitePrefs.disliked.map((d) => ({ domain: d.domain })),
  });
  const focus = (steeringNote ?? "").trim();
  const storedAgenda = getResearchAgenda(session.metadata);
  const sessionMeta = session.metadata as Record<string, unknown> | null;
  const isDeepResearch = !!sessionMeta?.is_deep_research;
  
  const baseAgenda: ResearchAgenda = storedAgenda ?? emptyAgenda({
    company: companyContext,
    focus,
    preferencesSummary,
    openGaps,
    isDeepResearch,
  });
  
  baseAgenda.is_deep_research = isDeepResearch;

  const refreshedAgenda = recomputeAgendaFacts(baseAgenda, {
    company: companyContext,
    focus,
    preferencesSummary,
    openGaps,
    visitedUrls,
    currentUrl,
    draftSourceUrls,
    acceptedSourceUrls,
  });

  const agendaForPlan = ensureTaskPlanForAgenda(ensureAgendaHasConcreteIntent(refreshedAgenda, companyName));

  // Decompose focus into tasks using LLM (async, non-blocking)
  const decomposedTasks = await decomposeFocusIntoTasks({
    agenda: agendaForPlan,
    timeoutMs: 4000,
  });

  // Update agenda with decomposed tasks if LLM succeeded
  if (decomposedTasks && decomposedTasks.length > 0) {
    agendaForPlan.decomposed_tasks = decomposedTasks;
  }

  const activeTask = agendaForPlan.decomposed_tasks.find((t) => t.status === "in_progress")
    ?? agendaForPlan.decomposed_tasks.find((t) => t.status === "pending")
    ?? null;
  
  // Query reformulation: if active task has failed queries, try reformulating
  let reformulatedQueries: string[] = [];
  if (activeTask && agendaForPlan.failed_queries.size > 0) {
    const failedQuery = activeTask.query_terms[0] || activeTask.evidence_need;
    reformulatedQueries = reformulateQuery(failedQuery, activeTask, companyName);
  }
  
  const exploreSeeds = buildTrustedDomainExploreSeeds({
    preferredRows: preferredForSession.map((p) => ({
      domain: p.domain,
      preference_score: p.preference_score,
      category: p.category,
    })),
    visitedUrls,
    currentUrl,
    outboundUrls: domOutbound.map((l) => l.url),
    dislikedDomains: sitePrefs.disliked.map((d) => d.domain),
    maxSeeds: 4, // reduced from 6 to 4 to prioritize outbound links
    companyName,
    companyContext,
    steeringNote,
    openGaps,
    activeTask,
    blockedHosts: agendaForPlan.blocked_hosts ?? [],
    visitedHostCounts,
    unexploredRelevantLinksCount: domOutbound.filter((l) => {
      const normalized = normalizeUrl(l.url);
      return normalized && !visitedUrls.includes(normalized);
    }).length,
  });
  const planResult = await planNextActionWithAgenda({
    agenda: agendaForPlan,
    companyDisplayName: companyName,
    currentUrl,
    pageTitle,
    visibleTextExcerpt,
    snapshot: skimSnapshotForPlanner(body.snapshot),
    pageSignals,
    outboundLinks: domOutbound,
    exploreSeeds,
    copilotExploreHints,
    visitedUrls,
    visitedHostCounts,
    dislikedHostnames: sitePrefs.disliked.map((d) => d.domain),
    preferredHostnames: sitePrefs.preferred,
    playbook: playbook,
    isDeepResearch: !!session.metadata?.is_deep_research,
    weights: loadedWeights.weights,
    weightsUpdatesCount: loadedWeights.updates_count,
    acceptedSnippets: sessionAcceptedSnippets,
    draftSourceUrls,
    rejectedHosts: agendaForPlan.declined_hosts ?? [],
    llmTimeoutMs: 5000,
  });

  const next = planResult.action;
  const nextAgenda = applyAgendaPatch(
    agendaForPlan,
    planResult.patch,
    next.action === "navigate"
      ? { kind: "navigate", url: next.url, rationale: next.rationale }
      : next.action === "scroll"
        ? { kind: "scroll", rationale: next.rationale }
        : { kind: "stop", rationale: next.rationale },
    { currentUrl },
  );

  await setResearchAgenda({ admin, sessionId: session.id, userId: user.id, agenda: nextAgenda });

  if (next.action === "navigate") {
    await appendVisitedUrl({ admin, sessionId: session.id, userId: user.id, url: currentUrl });
  }

  // Log ranking events for SGD attribution
  if (planResult.rankingEvents && planResult.rankingEvents.length > 0) {
    await logRankingEvents({
      admin,
      events: planResult.rankingEvents.map((e) => ({
        ...e,
        session_id: session.id,
        user_id: user.id,
      })),
    });
  }

  return withCopilotCors(
    req,
    NextResponse.json({
      ok: true,
      next,
      agenda: {
        next_question: nextAgenda.intent.next_question,
        stop_when: nextAgenda.intent.stop_when,
        avoid_hosts: nextAgenda.intent.avoid_hosts.map((a) => a.target),
        open_gaps: nextAgenda.open_gaps.map((g) => g.field),
        learned_count: nextAgenda.learned.length,
        active_task: nextAgenda.decomposed_tasks.find((t) => t.status === "in_progress") ?? null,
      },
    }),
  );
}
