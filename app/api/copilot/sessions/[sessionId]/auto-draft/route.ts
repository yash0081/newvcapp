import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/research/db";
import {
  appendAutoDraftSnippet,
  editAutoDraftSnippet,
  getAutoDraft,
  getSessionForUser,
  mergeResearchAgenda,
  promoteAutoDraftToAccepted,
  removeAutoDraftSnippet,
  setAutoDraftStatus,
} from "@/lib/copilot/db";
import { bumpVisitedYieldOnAgenda } from "@/lib/copilot/research-agenda";
import { copilotPreflight, withCopilotCors } from "@/lib/copilot/cors";

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
    if (!id) return withCopilotCors(req, NextResponse.json({ error: "id is required" }, { status: 400 }));
    await removeAutoDraftSnippet({ admin, session, id });
  } else if (op === "discard") {
    await setAutoDraftStatus({ admin, session, status: "discarded" });
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
  } else {
    return withCopilotCors(req, NextResponse.json({ error: "Unsupported op" }, { status: 400 }));
  }

  const refreshed = await getSessionForUser({ admin, sessionId, userId: user.id });
  return withCopilotCors(req, NextResponse.json({ ok: true, draft: getAutoDraft(refreshed?.metadata) }));
}
