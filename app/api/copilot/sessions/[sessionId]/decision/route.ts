import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/research/db";
import { recordResearchPreferenceEvents } from "@/lib/research/preferences";
import {
  appendAcceptedSnippet,
  getSessionForUser,
  insertCopilotEvent,
} from "@/lib/copilot/db";
import type { AcceptedSnippet } from "@/lib/copilot/types";
import { copilotPreflight, withCopilotCors } from "@/lib/copilot/cors";

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
    | { suggestionEventId?: string; action?: "accept" | "reject" }
    | null;
  const suggestionEventId = asString(body?.suggestionEventId);
  const action = body?.action === "accept" || body?.action === "reject" ? body.action : null;
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
  const hostname = (suggestion.hostname || asString(payload.source_label) || "").toLowerCase() || null;

  if (action === "accept") {
    if (!snippet) {
      return withCopilotCors(req, NextResponse.json({ error: "Cannot accept an empty suggestion" }, { status: 400 }));
    }
    const acceptedSnippet: AcceptedSnippet = {
      text: snippet,
      source_label: sourceLabel,
      hostname: hostname,
      source_url: null,
      accepted_at: new Date().toISOString(),
      suggestion_event_id: suggestion.id,
    };
    await appendAcceptedSnippet({ admin, session, snippet: acceptedSnippet });
    await insertCopilotEvent({
      admin,
      event: {
        session_id: sessionId,
        kind: "accepted",
        hostname,
        parent_event_id: suggestion.id,
        payload: { summary, snippet, source_label: sourceLabel },
      },
    });
  } else {
    await insertCopilotEvent({
      admin,
      event: {
        session_id: sessionId,
        kind: "rejected",
        hostname,
        parent_event_id: suggestion.id,
        payload: { summary, source_label: sourceLabel },
      },
    });
  }

  // Preference learning: nudge research site preference for the source domain.
  if (hostname) {
    try {
      await recordResearchPreferenceEvents({
        admin,
        userId: user.id,
        dealId: session.deal_id,
        events: [
          {
            domain: hostname,
            category: "general",
            deltaPreferenceScore: action === "accept" ? ACCEPT_DELTA : REJECT_DELTA,
            deltaUsageCount: action === "accept" ? 1 : 0,
            reason: action === "accept" ? "Copilot snippet accepted by user." : "Copilot snippet rejected by user.",
            task: summary,
          },
        ],
      });
    } catch {
      // best-effort
    }
  }

  return withCopilotCors(req, NextResponse.json({ ok: true, action }));
}
