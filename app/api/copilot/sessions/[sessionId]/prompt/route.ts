import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/research/db";
import {
  getRecentDealClaims,
  getSessionForUser,
  getVisitedUrls,
  insertCopilotEvent,
  insertCopilotEvents,
} from "@/lib/copilot/db";
import { analyzeAgainstDeal } from "@/lib/copilot/analyze";
import { normalizeExtractedSnapshot } from "@/lib/copilot/extracted-snapshot";
import { copilotPreflight, withCopilotCors } from "@/lib/copilot/cors";
import { suggestionRepeatKey } from "@/lib/copilot/repeat-key";
import type { Extracted, ExtractedKeyValue } from "@/lib/copilot/types";
import { getUserSitePreferences } from "@/lib/research/preferences";

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
        text?: string;
        hostnameHint?: string;
        urlHint?: string;
        extracted?: {
          visible_text?: unknown;
          page_title?: unknown;
          hostname?: unknown;
          key_value_claims?: unknown;
          outbound_links?: unknown;
        } | null;
      }
    | null;
  const text = String(body?.text ?? "").trim();
  if (!text) return withCopilotCors(req, NextResponse.json({ error: "text is required" }, { status: 400 }));

  const admin = createAdminClient();
  const session = await getSessionForUser({ admin, sessionId, userId: user.id });
  if (!session) return withCopilotCors(req, NextResponse.json({ error: "Session not found" }, { status: 404 }));
  if (session.status !== "active") {
    return withCopilotCors(req, NextResponse.json({ error: "Session is not active" }, { status: 409 }));
  }

  // Parallelize: deal metadata, recent claims, recent suggestion keys, and
  // the prompt event insert all run concurrently.
  const fallbackContextPromise =
    body?.extracted && typeof body.extracted === "object"
      ? Promise.resolve(null)
      : admin
          .schema("deal_intel")
          .from("copilot_event")
          .select("hostname, payload")
          .eq("session_id", sessionId)
          .eq("kind", "observation")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

  const [dealRes, recentClaims, recentSuggestionsRes, promptEvent, fallback, sitePrefs] = await Promise.all([
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
    insertCopilotEvent({
      admin,
      event: {
        session_id: sessionId,
        kind: "prompt",
        payload: { text },
      },
    }),
    fallbackContextPromise,
    getUserSitePreferences({ admin, userId: user.id, limit: 80 }),
  ]);
  if (dealRes.error) return withCopilotCors(req, NextResponse.json({ error: dealRes.error.message }, { status: 500 }));
  const dealMeta = (dealRes.data?.metadata ?? {}) as Record<string, unknown>;
  const companyName = asCompanyName(dealMeta);
  const promptEventId = promptEvent.data?.id ?? null;

  let extracted: Extracted | null = null;
  if (body?.extracted && typeof body.extracted === "object") {
    extracted = normalizeExtractedSnapshot(body.extracted);
  } else if (fallback?.data?.payload) {
    const p = fallback.data.payload as Record<string, unknown>;
    extracted = {
      visible_text: typeof p.visible_text === "string" ? p.visible_text : "",
      page_title: typeof p.page_title === "string" ? p.page_title : undefined,
      hostname:
        typeof p.hostname === "string"
          ? p.hostname
          : typeof fallback.data.hostname === "string"
            ? fallback.data.hostname
            : undefined,
      key_value_claims: Array.isArray(p.key_value_claims)
        ? (p.key_value_claims as ExtractedKeyValue[])
        : [],
      outbound_links: Array.isArray(p.outbound_links)
        ? (p.outbound_links as Array<{ url: string; text: string }>)
        : [],
    };
  }

  if (!extracted || !extracted.visible_text) {
    return withCopilotCors(
      req,
      NextResponse.json({
        ok: true,
        suggestions: [],
        reason: "no_page_context",
        message: "I don't have a recent page snapshot. Open the copilot extension on the page and try again.",
      }),
    );
  }

  const hostname =
    (typeof body?.hostnameHint === "string" && body.hostnameHint.trim().toLowerCase()) ||
    extracted.hostname ||
    null;

  // Session metadata is the live source of truth for accepts (may be ahead of company_* until background sync).
  const sessionAcceptedSnippets = getSessionAcceptedSnippets(session.metadata);
  const visitedUrls = getVisitedUrls(session.metadata);
  const recentSuggestionKeys = (recentSuggestionsRes.data ?? [])
    .map((r) => {
      const payload = (r.payload ?? {}) as Record<string, unknown>;
      const summary = typeof payload.summary === "string" ? payload.summary : "";
      const snippet = typeof payload.snippet === "string" ? payload.snippet : "";
      return summary && snippet ? suggestionRepeatKey(summary, snippet) : null;
    })
    .filter((v): v is string => Boolean(v));

  let suggestions;
  try {
    suggestions = await analyzeAgainstDeal({
      extracted,
      hostname,
      userInstruction: text,
      deal: {
        companyName,
        metadata: dealMeta,
        recentClaims,
        sessionAcceptedSnippets,
        recentSuggestionKeys,
        visitedUrls,
        preferredHostnames: sitePrefs.preferred.map((p) => ({ domain: p.domain, score: p.preference_score, category: p.category })),
        dislikedHostnames: sitePrefs.disliked.map((d) => d.domain),
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await insertCopilotEvent({
      admin,
      event: {
        session_id: sessionId,
        kind: "error",
        hostname,
        payload: { stage: "prompt_analyze", message },
        parent_event_id: promptEventId,
      },
    });
    return withCopilotCors(req, NextResponse.json({ error: message }, { status: 502 }));
  }

  if (suggestions.length === 0) {
    await insertCopilotEvent({
      admin,
      event: {
        session_id: sessionId,
        kind: "reply",
        hostname,
        parent_event_id: promptEventId,
        payload: { text: "I couldn't find anything matching that on the current screen." },
      },
    });
    return withCopilotCors(
      req,
      NextResponse.json({
        ok: true,
        suggestions: [],
        reply: "I couldn't find anything matching that on the current screen.",
      }),
    );
  }

  const insertedEvents = await insertCopilotEvents({
    admin,
    events: suggestions.map((s) => ({
      session_id: sessionId,
      kind: "suggestion" as const,
      hostname: s.hostname ?? hostname,
      parent_event_id: promptEventId,
      payload: {
        client_id: s.client_id,
        summary: s.summary,
        snippet: s.snippet,
        kind: s.kind,
        confidence: s.confidence,
        source_label: s.source_label,
        link_url: s.link_url ?? null,
        from_prompt: true,
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
      promptEventId,
      suggestions: (insertedEvents.data ?? []).map((row, i) => ({
        ...suggestions[i],
        event_id: row.id,
      })),
    }),
  );
}
