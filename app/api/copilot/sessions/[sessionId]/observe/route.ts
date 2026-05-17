import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/research/db";
import {
  appendVisitedUrl,
  getAutoSteeringNote,
  getRecentDealClaims,
  getResearchAgenda,
  getSessionForUser,
  getVisitedUrls,
  insertCopilotEvent,
  insertCopilotEvents,
  mergeSessionMetadata,
} from "@/lib/copilot/db";
import { analyzeAgainstDeal } from "@/lib/copilot/analyze";
import { normalizeExtractedSnapshot } from "@/lib/copilot/extracted-snapshot";
import { generatePageFingerprint, verifyStateChange } from "@/lib/copilot/plan-next";
import { suggestionRepeatKey } from "@/lib/copilot/repeat-key";
import { copilotPreflight, withCopilotCors } from "@/lib/copilot/cors";
import {
  computeOpenGaps,
  markPathAsFailed,
  trackInformationGain,
  type ResearchGap,
  updateDepthProfile,
} from "@/lib/copilot/research-agenda";
import {
  buildCopilotPreferenceTask,
  inferCopilotPreferenceCategory,
  normalizePreferenceUrl,
} from "@/lib/copilot/preference-signals";
import { getUserSitePreferences, recordResearchPreferenceEvents } from "@/lib/research/preferences";
import { getLearnedPlaybook } from "@/lib/research/playbook";
import { attributeRankingEvents } from "@/lib/copilot/recommender-weights";

const MIN_TEXT_CHARS = 40;

function asCompanyName(meta: unknown): string {
  if (!meta || typeof meta !== "object") return "Company";
  const m = meta as Record<string, unknown>;
  return typeof m.company_name === "string" ? m.company_name : "Company";
}

function getSessionAcceptedSnippets(meta: unknown): Array<{ text: string; source_label?: string | null; accepted_at?: string | null }> {
  if (!meta || typeof meta !== "object") return [];
  const m = meta as Record<string, unknown>;
  if (!Array.isArray(m.acceptedSnippets)) return [];
  const out: Array<{ text: string; source_label?: string | null; accepted_at?: string | null }> = [];
  for (const raw of m.acceptedSnippets) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const text = typeof r.text === "string" ? r.text.trim() : "";
    if (!text) continue;
    out.push({
      text: text.slice(0, 1200),
      source_label: typeof r.source_label === "string" ? r.source_label : null,
      accepted_at: typeof r.accepted_at === "string" ? r.accepted_at : null,
    });
    if (out.length >= 25) break;
  }
  return out;
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
      capturedAt?: string;
      clientMode?: "manual" | "auto";
      hostnameHint?: string;
      urlHint?: string;
      /** Extension Focus field: overrides session metadata for this request when non-empty. */
      steering_hint?: unknown;
      extracted?: {
        visible_text?: unknown;
        page_title?: unknown;
        hostname?: unknown;
        key_value_claims?: unknown;
        outbound_links?: unknown;
        viewed_elements?: unknown;
        skim_outline?: unknown;
      } | null;
      page_signals?: {
        scrollDepthRatio?: unknown;
        draftItemsOnUrl?: unknown;
        sectionDwellMs?: unknown;
        viewedSectionCount?: unknown;
        focusedSectionHeadings?: unknown;
      };
    }
    | null;

  if (!body?.extracted || typeof body.extracted !== "object") {
    return withCopilotCors(
      req,
      NextResponse.json({ error: "extracted snapshot is required" }, { status: 400 }),
    );
  }

  const admin = createAdminClient();
  const session = await getSessionForUser({ admin, sessionId, userId: user.id });
  if (!session) return withCopilotCors(req, NextResponse.json({ error: "Session not found" }, { status: 404 }));
  if (session.status !== "active") {
    return withCopilotCors(req, NextResponse.json({ error: "Session is not active" }, { status: 409 }));
  }

  const extracted = normalizeExtractedSnapshot(body.extracted);
  if (!extracted || (extracted.visible_text || "").length < MIN_TEXT_CHARS) {
    return withCopilotCors(
      req,
      NextResponse.json({ ok: true, suggestions: [], reason: "no_usable_text" }),
    );
  }

  const hostname =
    (typeof body?.hostnameHint === "string" && body.hostnameHint.trim().toLowerCase()) ||
    extracted.hostname ||
    null;

  // Parallelize warm-up DB reads.
  const [dealRes, claims, recentSuggestionsRes, sitePrefs, playbook] = await Promise.all([
    admin
      .schema("deal_intel")
      .from("deal")
      .select("metadata")
      .eq("id", session.deal_id)
      .eq("user_id", user.id)
      .maybeSingle(),
    getRecentDealClaims({ admin, dealId: session.deal_id, userId: user.id, limit: 12 }),
    admin
      .schema("deal_intel")
      .from("copilot_event")
      .select("payload")
      .eq("session_id", sessionId)
      .eq("kind", "suggestion")
      .order("created_at", { ascending: false })
      .limit(40),
    getUserSitePreferences({ admin, userId: user.id, limit: 80 }),
    getLearnedPlaybook({ admin, userId: user.id }),
  ]);
  if (dealRes.error) {
    return withCopilotCors(req, NextResponse.json({ error: dealRes.error.message }, { status: 500 }));
  }

  const dealMeta = (dealRes.data?.metadata ?? {}) as Record<string, unknown>;
  const companyName = asCompanyName(dealMeta);
  // Session metadata is the live source of truth for accepts (may be ahead of company_* until background sync).
  const sessionAcceptedSnippets = getSessionAcceptedSnippets(session.metadata);
  const visitedUrls = getVisitedUrls(session.metadata);
  const clientSteeringHint =
    typeof body?.steering_hint === "string" && body.steering_hint.trim()
      ? body.steering_hint.trim().slice(0, 2000)
      : null;
  const autoSteeringNote = clientSteeringHint ?? getAutoSteeringNote(session.metadata);
  const openGaps = computeOpenGaps({
    metadata: dealMeta,
    recentClaims: claims,
    sessionAcceptedSnippets,
  });
  const recentSuggestionKeys = (recentSuggestionsRes.data ?? [])
    .map((r) => {
      const payload = (r.payload ?? {}) as Record<string, unknown>;
      const summary = typeof payload.summary === "string" ? payload.summary : "";
      const snippet = typeof payload.snippet === "string" ? payload.snippet : "";
      return summary && snippet ? suggestionRepeatKey(summary, snippet) : null;
    })
    .filter((v): v is string => Boolean(v));

  const normalizedUrlHint = normalizePreferenceUrl(typeof body?.urlHint === "string" ? body.urlHint : null);
  const alreadyVisited = normalizedUrlHint
    ? visitedUrls.some((u) => normalizePreferenceUrl(u) === normalizedUrlHint)
    : true;
  if (body?.clientMode === "manual" && normalizedUrlHint && hostname && !alreadyVisited) {
    void appendVisitedUrl({ admin, sessionId: session.id, userId: user.id, url: normalizedUrlHint }).catch(() => { });
    void recordResearchPreferenceEvents({
      admin,
      userId: user.id,
      dealId: session.deal_id,
      events: [
        {
          domain: normalizedUrlHint,
          category: inferCopilotPreferenceCategory({
            task: extracted.page_title ?? normalizedUrlHint,
            focus: autoSteeringNote,
            openGapFields: openGaps.map((g: ResearchGap) => g.field),
          }),
          deltaPreferenceScore: 0.02,
          deltaUsageCount: 1,
          reason: "User manually visited this site during a copilot research session.",
          task: buildCopilotPreferenceTask({
            companyName,
            focus: autoSteeringNote,
            pageTitle: extracted.page_title ?? null,
          }),
        },
      ],
    }).catch(() => { });
    // Label attribution for recommender SGD (non-blocking, implicit positive signal).
    void attributeRankingEvents({
      admin,
      sessionId,
      userId: user.id,
      candidateHost: hostname,
      candidateUrl: normalizedUrlHint,
      label: 1,
      labelKind: "accept_suggestion",
      sampleWeight: 0.5, // Implicit signal, lower weight
      windowMinutes: 30,
    }).catch(() => { });
  }

  // --- Learned Depth Profile logic ---
  // If in manual mode, track how much the user actually scrolls and drafts 
  // before leaving a page. Update the session's learned profile when they navigate.
  await mergeSessionMetadata({
    admin,
    sessionId,
    userId: user.id,
    transform: (meta) => {
      const lastUrl = typeof meta.last_visited_url === "string" ? meta.last_visited_url : null;
      const currentUrl = typeof body?.urlHint === "string" ? body.urlHint : (hostname || "");

      if (lastUrl && lastUrl !== currentUrl) {
        const lastStats = (meta.last_page_stats || {}) as Record<string, number>;
        const scrollDepth = typeof lastStats.max_scroll === "number" ? lastStats.max_scroll : 0;
        const draftCount = typeof lastStats.draft_count === "number" ? lastStats.draft_count : 0;
        const viewedSectionCount = typeof lastStats.viewed_section_count === "number" ? lastStats.viewed_section_count : 0;
        const sectionDwellMs = typeof lastStats.section_dwell_ms === "number" ? lastStats.section_dwell_ms : 0;
        const focusedHeadings = Array.isArray((meta.last_page_stats as Record<string, unknown> | undefined)?.focused_headings)
          ? ((meta.last_page_stats as Record<string, unknown>).focused_headings as unknown[]).filter((h): h is string => typeof h === "string")
          : [];

        const nextMeta = { ...meta };
        if (scrollDepth > 0 || draftCount > 0 || viewedSectionCount > 0 || sectionDwellMs > 0) {
          const agenda = getResearchAgenda(meta);
          if (agenda) {
            // State change verification: check if navigation actually changed content
            const currentFingerprint = generatePageFingerprint(extracted);
            const previousFingerprint = (meta.last_page_fingerprint as string) || "";
            const contentChanged = verifyStateChange(previousFingerprint, currentFingerprint);
            
            let updatedAgenda = agenda;
            
            // If navigation didn't change content, mark the path as failed
            if (!contentChanged && lastUrl && lastUrl !== currentUrl) {
              const lastHost = typeof lastUrl === "string" ? new URL(lastUrl).hostname.toLowerCase() : "";
              const currentHost = typeof currentUrl === "string" ? new URL(currentUrl).hostname.toLowerCase() : "";
              const activeTask = agenda.decomposed_tasks.find(t => t.status === "in_progress") || agenda.decomposed_tasks.find(t => t.status === "pending");
              const query = activeTask?.query_terms?.[0] || "";
              updatedAgenda = markPathAsFailed(agenda, query, currentHost, "navigation did not change page content");
            }
            
            updatedAgenda.depth_profile = updateDepthProfile(updatedAgenda.depth_profile, {
              scroll_depth: scrollDepth,
              draft_count: draftCount,
              viewed_section_count: viewedSectionCount,
              section_dwell_ms: sectionDwellMs,
              focused_headings: focusedHeadings,
            });
            // Track information gain from the page visit
            const claimsCount = extracted.key_value_claims.length;
            const factsCount = updatedAgenda.learned.length; // Count of learned facts
            const entitiesCount = extracted.key_value_claims.filter(kv => kv.key.toLowerCase().includes("name") || kv.key.toLowerCase().includes("team")).length;
            const finalAgenda = trackInformationGain(updatedAgenda, lastUrl, claimsCount, factsCount, entitiesCount);
            nextMeta.research_agenda = finalAgenda;
            // Store current fingerprint for next comparison
            nextMeta.last_page_fingerprint = currentFingerprint;
          }
        }
        nextMeta.last_visited_url = currentUrl;
        nextMeta.last_page_stats = { max_scroll: 0, draft_count: 0, viewed_section_count: 0, section_dwell_ms: 0, focused_headings: [] };
        return nextMeta;
      } else {
        const nextMeta = { ...meta };
        nextMeta.last_visited_url = currentUrl;
        const stats = (meta.last_page_stats || { max_scroll: 0, draft_count: 0 }) as Record<string, unknown>;
        const currentScroll = typeof body?.page_signals?.scrollDepthRatio === "number" ? (body.page_signals.scrollDepthRatio as number) : 0;
        const currentDrafts = typeof body?.page_signals?.draftItemsOnUrl === "number" ? (body.page_signals.draftItemsOnUrl as number) : 0;
        const currentViewedSections = typeof body?.page_signals?.viewedSectionCount === "number" ? (body.page_signals.viewedSectionCount as number) : 0;
        const currentSectionDwell = typeof body?.page_signals?.sectionDwellMs === "number" ? (body.page_signals.sectionDwellMs as number) : 0;
        const currentFocusedHeadings = Array.isArray(body?.page_signals?.focusedSectionHeadings)
          ? (body.page_signals.focusedSectionHeadings as unknown[]).filter((h): h is string => typeof h === "string").slice(0, 8)
          : [];

        stats.max_scroll = Math.max(typeof stats.max_scroll === "number" ? stats.max_scroll : 0, currentScroll);
        stats.draft_count = Math.max(typeof stats.draft_count === "number" ? stats.draft_count : 0, currentDrafts);
        stats.viewed_section_count = Math.max(typeof stats.viewed_section_count === "number" ? stats.viewed_section_count : 0, currentViewedSections);
        stats.section_dwell_ms = Math.max(typeof stats.section_dwell_ms === "number" ? stats.section_dwell_ms : 0, currentSectionDwell);
        stats.focused_headings = Array.from(new Set([...(currentFocusedHeadings), ...((Array.isArray(stats.focused_headings) ? stats.focused_headings : []) as string[])])).slice(0, 12);
        nextMeta.last_page_stats = stats;
        return nextMeta;
      }
    }
  }).catch(() => { });
// Run observation insert in parallel with analyze; analyze does not need
// the inserted observation row (we only need its id when persisting
// suggestions afterward).
const observationPromise = insertCopilotEvent({
  admin,
  event: {
    session_id: sessionId,
    kind: "observation",
    hostname,
    payload: {
      captured_at: typeof body?.capturedAt === "string" ? body.capturedAt : new Date().toISOString(),
      url_hint: typeof body?.urlHint === "string" ? body.urlHint : null,
      page_title: extracted.page_title ?? null,
      visible_text: extracted.visible_text,
      key_value_claims: extracted.key_value_claims,
      outbound_links: extracted.outbound_links ?? [],
      viewed_elements: body?.extracted?.viewed_elements ?? [],
      skim_outline: body?.extracted?.skim_outline ?? null,
      capture_kind: "extracted" as const,
    },
  },
});

const analyzePromise = analyzeAgainstDeal({
  extracted,
  hostname,
  userInstruction: autoSteeringNote ?? undefined,
  deal: {
    companyName,
    metadata: dealMeta,
    recentClaims: claims,
    sessionAcceptedSnippets,
    recentSuggestionKeys,
    visitedUrls,
    openGaps,
    preferredHostnames: sitePrefs.preferred.map((p) => ({
      domain: p.domain,
      score: p.preference_score,
      category: p.category,
      focus_guidance: p.focus_guidance,
    })),
    dislikedHostnames: sitePrefs.disliked.map((d) => d.domain),
    rejectedSuggestionKeys: getResearchAgenda(session.metadata)?.rejected_suggestion_keys || [],
    playbook,
  },
});

const [obsResult, analyzeResult] = await Promise.allSettled([observationPromise, analyzePromise]);

if (obsResult.status === "rejected") {
  return withCopilotCors(req, NextResponse.json({ error: String(obsResult.reason) }, { status: 500 }));
}
const obs = obsResult.value;
if (obs.error) return withCopilotCors(req, NextResponse.json({ error: obs.error.message }, { status: 500 }));
const observationEventId = obs.data?.id ?? null;

if (analyzeResult.status === "rejected") {
  const message = analyzeResult.reason instanceof Error ? analyzeResult.reason.message : String(analyzeResult.reason);
  await insertCopilotEvent({
    admin,
    event: {
      session_id: sessionId,
      kind: "error",
      hostname,
      payload: { stage: "analyze", message },
      parent_event_id: observationEventId,
    },
  });
  return withCopilotCors(req, NextResponse.json({ error: message }, { status: 502 }));
}
const suggestions = analyzeResult.value;

if (suggestions.length === 0) {
  return withCopilotCors(req, NextResponse.json({ ok: true, suggestions: [] }));
}

const insertedEvents = await insertCopilotEvents({
  admin,
  events: suggestions.map((s) => ({
    session_id: sessionId,
    kind: "suggestion" as const,
    hostname: s.hostname ?? hostname,
    parent_event_id: observationEventId,
    payload: {
      client_id: s.client_id,
      summary: s.summary,
      snippet: s.snippet,
      kind: s.kind,
      confidence: s.confidence,
      source_label: s.source_label,
      link_url: s.link_url ?? null,
    },
  })),
});
if (insertedEvents.error) {
  return withCopilotCors(req, NextResponse.json({ error: insertedEvents.error.message }, { status: 500 }));
}

return withCopilotCors(
  req,
  NextResponse.json({
    ok: true,
    observationEventId,
    suggestions: (insertedEvents.data ?? []).map((row, i) => ({
      ...suggestions[i],
      event_id: row.id,
    })),
  }),
);
}
