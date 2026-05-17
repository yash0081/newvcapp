import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/research/db";
import {
  appendAutoDraftSnippet,
  editAutoDraftSnippet,
  getAutoDraft,
  getAutoSteeringNote,
  getSessionForUser,
  mergeResearchAgenda,
  promoteAutoDraftToAccepted,
  removeAutoDraftSnippet,
  setAutoDraftStatus,
} from "@/lib/copilot/db";
import { bumpVisitedYieldOnAgenda } from "@/lib/copilot/research-agenda";
import { copilotPreflight, withCopilotCors } from "@/lib/copilot/cors";
import {
  buildCopilotPreferenceTask,
  inferCopilotPreferenceCategory,
  normalizePreferenceDomain,
} from "@/lib/copilot/preference-signals";
import { recordResearchPreferenceEvents } from "@/lib/research/preferences";
import { attributeRankingEvents } from "@/lib/copilot/recommender-weights";

export async function OPTIONS(req: Request) {
  return copilotPreflight(req);
}

export async function GET(req: Request, ctx: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await ctx.params;
  const user = await getAuthedUser();
  if (!user) return withCopilotCors(req, NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
  const admin = createAdminClient();
  const session = await getSessionForUser({ admin, sessionId, userId: user.id });
  if (!session) return withCopilotCors(req, NextResponse.json({ error: "Session not found" }, { status: 404 }));
  return withCopilotCors(req, NextResponse.json({ ok: true, draft: getAutoDraft(session.metadata) }));
}

function preferenceEventForSnippet(args: {
  session: { deal_id: string; metadata: unknown };
  snippet: {
    text?: string;
    source_label?: string;
    hostname?: string | null;
    source_url?: string | null;
    kind?: string | null;
  };
  deltaPreferenceScore: number;
  deltaUsageCount: number;
  reason: string;
}) {
  const domain = normalizePreferenceDomain(args.snippet.source_url) ?? normalizePreferenceDomain(args.snippet.hostname);
  if (!domain) return null;
  const focus = getAutoSteeringNote(args.session.metadata);
  return {
    domain,
    category: inferCopilotPreferenceCategory({
      focus,
      snippet: args.snippet.text,
      summary: args.snippet.source_label,
      kind: args.snippet.kind,
    }),
    deltaPreferenceScore: args.deltaPreferenceScore,
    deltaUsageCount: args.deltaUsageCount,
    reason: args.reason,
    task: buildCopilotPreferenceTask({
      focus,
      summary: args.snippet.source_label,
      snippet: args.snippet.text,
    }),
  };
}

export async function POST(req: Request, ctx: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await ctx.params;
  const user = await getAuthedUser();
  if (!user) return withCopilotCors(req, NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
  const body = (await req.json().catch(() => null)) as
    | {
        op?: "append" | "edit" | "remove" | "approve" | "discard";
        snippet?: {
          id?: string;
          text?: string;
          source_label?: string;
          hostname?: string | null;
          source_url?: string | null;
          accepted_at?: string;
          suggestion_event_id?: string | null;
          confidence?: number | null;
          kind?: string | null;
          from_suggestion_event_id?: string | null;
        };
        id?: string;
        text?: string;
        snippetIds?: string[];
      }
    | null;
  const op = body?.op;
  if (!op) return withCopilotCors(req, NextResponse.json({ error: "op is required" }, { status: 400 }));
  const admin = createAdminClient();
  const session = await getSessionForUser({ admin, sessionId, userId: user.id });
  if (!session) return withCopilotCors(req, NextResponse.json({ error: "Session not found" }, { status: 404 }));
  if (session.status !== "active") {
    return withCopilotCors(req, NextResponse.json({ error: "Session is not active" }, { status: 409 }));
  }

  if (op === "append") {
    const sn = body?.snippet;
    const text = typeof sn?.text === "string" ? sn.text.trim() : "";
    if (!text) return withCopilotCors(req, NextResponse.json({ error: "snippet.text is required" }, { status: 400 }));
    const sourceUrl = typeof sn?.source_url === "string" ? sn.source_url : null;
    await appendAutoDraftSnippet({
      admin,
      session,
      snippet: {
        id: typeof sn?.id === "string" && sn.id ? sn.id : randomUUID(),
        text: text.slice(0, 1200),
        source_label: typeof sn?.source_label === "string" && sn.source_label ? sn.source_label : "screen",
        hostname: typeof sn?.hostname === "string" ? sn.hostname : null,
        source_url: sourceUrl,
        accepted_at: typeof sn?.accepted_at === "string" ? sn.accepted_at : new Date().toISOString(),
        suggestion_event_id: typeof sn?.suggestion_event_id === "string" ? sn.suggestion_event_id : null,
        confidence: typeof sn?.confidence === "number" ? sn.confidence : null,
        kind: typeof sn?.kind === "string" ? sn.kind : null,
        from_suggestion_event_id:
          typeof sn?.from_suggestion_event_id === "string" ? sn.from_suggestion_event_id : null,
      },
    });
    if (sourceUrl) {
      await mergeResearchAgenda({
        admin,
        sessionId,
        userId: user.id,
        transform: (a) => bumpVisitedYieldOnAgenda(a, { sourceUrls: [sourceUrl] }),
      });
    }
  } else if (op === "edit") {
    const id = typeof body?.id === "string" ? body.id : "";
    const text = typeof body?.text === "string" ? body.text : "";
    if (!id || !text.trim()) {
      return withCopilotCors(req, NextResponse.json({ error: "id and text are required" }, { status: 400 }));
    }
    await editAutoDraftSnippet({ admin, session, id, text });
  } else if (op === "remove") {
    const id = typeof body?.id === "string" ? body.id : "";
    if (!id) {
      return withCopilotCors(req, NextResponse.json({ error: "id is required" }, { status: 400 }));
    }
    const draft = getAutoDraft(session.metadata);
    const removed = draft.snippets.find((s) => s.id === id);
    await removeAutoDraftSnippet({ admin, session, id });
    const event = removed
      ? preferenceEventForSnippet({
          session,
          snippet: removed,
          deltaPreferenceScore: -0.08,
          deltaUsageCount: 0,
          reason: "User removed an auto-saved copilot draft snippet.",
        })
      : null;
    if (event) {
      void recordResearchPreferenceEvents({ admin, userId: user.id, dealId: session.deal_id, events: [event] }).catch(() => {});
    }
    // Label attribution for recommender SGD (non-blocking).
    if (removed?.hostname) {
      void attributeRankingEvents({
        admin,
        sessionId,
        userId: user.id,
        candidateHost: removed.hostname,
        candidateUrl: removed.source_url || undefined,
        label: 0,
        labelKind: "reject_suggestion",
        windowMinutes: 30,
      }).catch(() => {});
    }
  } else if (op === "discard") {
    const draft = getAutoDraft(session.metadata);
    await setAutoDraftStatus({ admin, session, status: "discarded" });
    const events = draft.snippets
      .map((snippet) =>
        preferenceEventForSnippet({
          session,
          snippet,
          deltaPreferenceScore: -0.05,
          deltaUsageCount: 0,
          reason: "User discarded an auto-saved copilot draft.",
        }),
      )
      .filter((event): event is NonNullable<typeof event> => Boolean(event));
    if (events.length) {
      void recordResearchPreferenceEvents({ admin, userId: user.id, dealId: session.deal_id, events }).catch(() => {});
    }
    // Label attribution for recommender SGD (non-blocking, bulk mode for all hosts).
    const uniqueHosts = new Set(draft.snippets.map((s) => s.hostname).filter((h): h is string => Boolean(h)));
    for (const host of uniqueHosts) {
      void attributeRankingEvents({
        admin,
        sessionId,
        userId: user.id,
        candidateHost: host,
        label: 0,
        labelKind: "reject_suggestion",
        windowMinutes: 30,
        bulk: true,
      }).catch(() => {});
    }
  } else if (op === "approve") {
    const result = await promoteAutoDraftToAccepted({
      admin,
      session,
      snippetIds: Array.isArray(body?.snippetIds) ? body.snippetIds : undefined,
    });
    const promotedUrls = result.promoted.map((p) => p.source_url ?? "").filter(Boolean);
    if (promotedUrls.length) {
      await mergeResearchAgenda({
        admin,
        sessionId,
        userId: user.id,
        transform: (a) => bumpVisitedYieldOnAgenda(a, { sourceUrls: promotedUrls }),
      });
    }
    const events = result.promoted
      .map((snippet) =>
        preferenceEventForSnippet({
          session,
          snippet,
          deltaPreferenceScore: 0.10,
          deltaUsageCount: 1,
          reason: "User approved an auto-saved copilot draft snippet.",
        }),
      )
      .filter((event): event is NonNullable<typeof event> => Boolean(event));
    if (events.length) {
      void recordResearchPreferenceEvents({ admin, userId: user.id, dealId: session.deal_id, events }).catch(() => {});
    }
    // Label attribution for recommender SGD (non-blocking).
    for (const snippet of result.promoted) {
      if (snippet.hostname) {
        void attributeRankingEvents({
          admin,
          sessionId,
          userId: user.id,
          candidateHost: snippet.hostname,
          candidateUrl: snippet.source_url || undefined,
          label: 1,
          labelKind: "accept_draft",
          windowMinutes: 30,
        }).catch(() => {});
      }
    }
  } else {
    return withCopilotCors(req, NextResponse.json({ error: "Unsupported op" }, { status: 400 }));
  }

  const refreshed = await getSessionForUser({ admin, sessionId, userId: user.id });
  return withCopilotCors(req, NextResponse.json({ ok: true, draft: getAutoDraft(refreshed?.metadata) }));
}
