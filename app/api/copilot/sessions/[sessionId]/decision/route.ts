import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/research/db";
import { recordResearchPreferenceEvents } from "@/lib/research/preferences";
import {
  appendAcceptedSnippet,
  getAutoSteeringNote,
  getSessionForUser,
  insertCopilotEvent,
  mergeResearchAgenda,
} from "@/lib/copilot/db";
import type { AcceptedSnippet } from "@/lib/copilot/types";
import { bumpVisitedYieldOnAgenda } from "@/lib/copilot/research-agenda";
import { copilotPreflight, withCopilotCors } from "@/lib/copilot/cors";
import {
  buildCopilotPreferenceTask,
  inferCopilotPreferenceCategory,
  normalizePreferenceDomain,
  normalizePreferenceUrl,
} from "@/lib/copilot/preference-signals";
import { suggestionRepeatKey } from "@/lib/copilot/repeat-key";
import { attributeRankingEvents } from "@/lib/copilot/recommender-weights";

const ACCEPT_DELTA = 0.10;
const REJECT_DELTA = -0.10;

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
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
        suggestionEventId?: string; 
        action?: "accept" | "reject"; 
        sourceUrl?: string;
        dwell_time?: number;
        scroll_depth?: number;
        interaction_history?: unknown;
      }
    | null;
  const suggestionEventId = asString(body?.suggestionEventId);
  const action = body?.action === "accept" || body?.action === "reject" ? body.action : null;
  const sourceUrl = normalizePreferenceUrl(asString(body?.sourceUrl));
  if (!suggestionEventId || !action) {
    return withCopilotCors(req, NextResponse.json({ error: "suggestionEventId and action are required" }, { status: 400 }));
  }

  const admin = createAdminClient();
  const session = await getSessionForUser({ admin, sessionId, userId: user.id });
  if (!session) return withCopilotCors(req, NextResponse.json({ error: "Session not found" }, { status: 404 }));
  if (session.status !== "active") {
    return withCopilotCors(req, NextResponse.json({ error: "Session is not active" }, { status: 409 }));
  }

  const sugRes = await admin
    .schema("deal_intel")
    .from("copilot_event")
    .select("id, session_id, kind, payload, hostname, parent_event_id, created_at")
    .eq("id", suggestionEventId)
    .eq("session_id", sessionId)
    .maybeSingle();
  if (sugRes.error) return withCopilotCors(req, NextResponse.json({ error: sugRes.error.message }, { status: 500 }));
  if (!sugRes.data || sugRes.data.kind !== "suggestion") {
    return withCopilotCors(req, NextResponse.json({ error: "Suggestion not found" }, { status: 404 }));
  }
  const suggestion = sugRes.data;
  const payload = (suggestion.payload ?? {}) as Record<string, unknown>;
  const summary = asString(payload.summary).slice(0, 200) || "research suggestion";
  const snippet = asString(payload.snippet);
  const sourceLabel = asString(payload.source_label) || (suggestion.hostname ?? "screen");
  const hostname = normalizePreferenceDomain(sourceUrl) ?? normalizePreferenceDomain(suggestion.hostname) ?? null;
  const focus = getAutoSteeringNote(session.metadata);
  const category = inferCopilotPreferenceCategory({
    summary,
    snippet,
    task: summary,
    focus,
    kind: asString(payload.kind),
  });

  if (action === "accept") {
    if (!snippet) {
      return withCopilotCors(req, NextResponse.json({ error: "Cannot accept an empty suggestion" }, { status: 400 }));
    }
    const acceptedSnippet: AcceptedSnippet = {
      text: snippet,
      source_label: sourceLabel,
      hostname: hostname,
      source_url: sourceUrl,
      accepted_at: new Date().toISOString(),
      suggestion_event_id: suggestion.id,
    };
    await Promise.all([
      appendAcceptedSnippet({ admin, session, snippet: acceptedSnippet, bumpAcceptCounters: true }),
      insertCopilotEvent({
        admin,
        event: {
          session_id: sessionId,
          kind: "accepted",
          hostname,
          parent_event_id: suggestion.id,
          payload: { 
            summary, 
            snippet, 
            source_label: sourceLabel, 
            source_url: sourceUrl,
            dwell_time: body?.dwell_time,
            scroll_depth: body?.scroll_depth,
            interaction_history: body?.interaction_history
          },
        },
      }),
      // Log recommender attribution for accept action
      hostname && sourceUrl ? attributeRankingEvents({
        admin,
        sessionId,
        userId: user.id,
        candidateHost: hostname,
        candidateUrl: sourceUrl,
        label: 1,
        labelKind: "accept_suggestion",
        sampleWeight: 1.0,
        windowMinutes: 30,
      }).catch(() => {}) : Promise.resolve(),
    ]);
    if (sourceUrl) {
      void mergeResearchAgenda({
        admin,
        sessionId,
        userId: user.id,
        transform: (a) => bumpVisitedYieldOnAgenda(a, { sourceUrls: [sourceUrl] }),
      }).catch(() => {});
    }
  } else {
    await Promise.all([
      insertCopilotEvent({
        admin,
        event: {
          session_id: sessionId,
          kind: "rejected",
          hostname,
          parent_event_id: suggestion.id,
          payload: { 
            summary, 
            source_label: sourceLabel, 
            source_url: sourceUrl,
            dwell_time: body?.dwell_time,
            scroll_depth: body?.scroll_depth,
            interaction_history: body?.interaction_history
          },
        },
      }),
      // Log recommender attribution for reject action
      hostname && sourceUrl ? attributeRankingEvents({
        admin,
        sessionId,
        userId: user.id,
        candidateHost: hostname,
        candidateUrl: sourceUrl,
        label: 0,
        labelKind: "reject_suggestion",
        sampleWeight: 1.0,
        windowMinutes: 30,
      }).catch(() => {}) : Promise.resolve(),
    ]);
    const key = suggestionRepeatKey(summary, (payload.snippet as string) || "", sourceUrl);
    void mergeResearchAgenda({
      admin,
      sessionId,
      userId: user.id,
      transform: (a) => {
        if (!a) return null;
        const declined = a.declined_hosts || [];
        if (hostname && !declined.includes(hostname)) {
          declined.push(hostname);
        }
        const rejected = a.rejected_suggestion_keys || [];
        if (!rejected.includes(key)) {
          rejected.push(key);
        }
        return { ...a, declined_hosts: declined, rejected_suggestion_keys: rejected };
      },
    }).catch(() => {});
  }

  // Preference learning (non-blocking — keep POST latency low).
  if (hostname) {
    void recordResearchPreferenceEvents({
      admin,
      userId: user.id,
      dealId: session.deal_id,
      events: [
        {
          domain: hostname,
          category,
          deltaPreferenceScore: action === "accept" ? ACCEPT_DELTA : REJECT_DELTA,
          deltaUsageCount: action === "accept" ? 1 : 0,
          reason: action === "accept" ? "Copilot snippet accepted by user." : "Copilot snippet rejected by user.",
          task: buildCopilotPreferenceTask({
            focus,
            summary,
            snippet,
          }),
        },
      ],
    }).catch(() => {});

    // Label attribution for recommender SGD (non-blocking).
    void attributeRankingEvents({
      admin,
      sessionId,
      userId: user.id,
      candidateHost: hostname,
      candidateUrl: sourceUrl || undefined,
      label: action === "accept" ? 1 : 0,
      labelKind: action === "accept" ? "accept_suggestion" : "reject_suggestion",
      windowMinutes: 30,
    }).catch(() => {});
  }

  return withCopilotCors(req, NextResponse.json({ ok: true, action }));
}
