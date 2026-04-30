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
  parsePlanPageSignals,
  planNextActionWithAgenda,
  sortPreferredRowsForSteering,
} from "@/lib/copilot/plan-next";
import {
  applyAgendaPatch,
  emptyAgenda,
  recomputeAgendaFacts,
  type ResearchAgenda,
} from "@/lib/copilot/research-agenda";
import { copilotPreflight, withCopilotCors } from "@/lib/copilot/cors";
import { getUserSitePreferences } from "@/lib/research/preferences";

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

function normalizeOutboundLinks(v: unknown): Array<{ url: string; text: string }> {
  if (!Array.isArray(v)) return [];
  const out: Array<{ url: string; text: string }> = [];
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
      text: typeof r.text === "string" ? r.text.trim().slice(0, 120) : "",
    });
    if (out.length >= 36) break;
  }
  return out;
}

function normalizeCopilotExploreLinks(v: unknown): Array<{ url: string; text: string }> {
  if (!Array.isArray(v)) return [];
  const out: Array<{ url: string; text: string }> = [];
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
    out.push({ url: normalized, text: text || "Copilot explore target" });
    if (out.length >= 10) break;
  }
  return out;
}

function buildPreferencesSummary(args: {
  preferred: Array<{ domain: string; category?: string; preference_score: number }>;
  disliked: Array<{ domain: string }>;
}): string {
  const top = args.preferred
    .slice(0, 8)
    .map((p) => (p.category ? `${p.domain} (${p.category})` : p.domain))
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
        snapshot?: {
          visible_text?: unknown;
          page_title?: unknown;
          hostname?: unknown;
          key_value_claims?: unknown;
          outbound_links?: unknown;
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

  const [dealRes, recentClaims, sitePrefs] = await Promise.all([
    admin
      .schema("deal_intel")
      .from("deal")
      .select("metadata")
      .eq("id", session.deal_id)
      .eq("user_id", user.id)
      .maybeSingle(),
    getRecentDealClaims({ admin, dealId: session.deal_id, userId: user.id, limit: 12 }),
    getUserSitePreferences({ admin, userId: user.id, limit: 80 }),
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
  const steeringNote = getAutoSteeringNote(session.metadata);
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
    })),
    disliked: sitePrefs.disliked.map((d) => ({ domain: d.domain })),
  });
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
    maxSeeds: 14,
    companyName,
    companyContext,
    steeringNote,
    openGaps,
  });

  const focus = (steeringNote ?? "").trim();
  const storedAgenda = getResearchAgenda(session.metadata);
  const baseAgenda: ResearchAgenda = storedAgenda ?? emptyAgenda({
    company: companyContext,
    focus,
    preferencesSummary,
    openGaps,
  });
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

  const planResult = await planNextActionWithAgenda({
    agenda: refreshedAgenda,
    currentUrl,
    pageTitle,
    visibleTextExcerpt,
    pageSignals,
    outboundLinks: domOutbound,
    exploreSeeds,
    copilotExploreHints,
    visitedUrls,
    visitedHostCounts,
    dislikedHostnames: sitePrefs.disliked.map((d) => d.domain),
  });

  const next = planResult.action;
  const nextAgenda = applyAgendaPatch(
    refreshedAgenda,
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
      },
    }),
  );
}
