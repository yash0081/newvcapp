import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/research/db";
import {
  getSessionForUser,
  markSessionAbandoned,
  markSessionFinalized,
} from "@/lib/copilot/db";
import type { AcceptedSnippet } from "@/lib/copilot/types";
import { copilotPreflight, withCopilotCors } from "@/lib/copilot/cors";

export async function OPTIONS(req: Request) {
  return copilotPreflight(req);
}

/**
 * Lightweight session end: durable snippets already live on copilot_session.
 * Enqueues a terminal copilot_session_sync job (document + facts); marks session ended immediately.
 */
export async function POST(req: Request, ctx: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await ctx.params;
  const user = await getAuthedUser();
  if (!user) return withCopilotCors(req, NextResponse.json({ error: "Unauthorized" }, { status: 401 }));

  const admin = createAdminClient();
  const session = await getSessionForUser({ admin, sessionId, userId: user.id });
  if (!session) return withCopilotCors(req, NextResponse.json({ error: "Session not found" }, { status: 404 }));
  if (session.status !== "active") {
    return withCopilotCors(req, NextResponse.json({ error: "Session is not active" }, { status: 409 }));
  }

  const snippets = (Array.isArray((session.metadata as { acceptedSnippets?: unknown } | null)?.acceptedSnippets)
    ? (session.metadata as { acceptedSnippets: AcceptedSnippet[] }).acceptedSnippets
    : []) as AcceptedSnippet[];

  if (snippets.length === 0) {
    await markSessionAbandoned({ admin, sessionId });
    return withCopilotCors(req, NextResponse.json({ ok: true, ended: "abandoned" as const }));
  }

  const { error: enqErr } = await admin.rpc("deal_intel_enqueue_job", {
    p_job_type: "copilot_session_sync",
    p_subject_kind: "copilot_session",
    p_subject_id: sessionId,
    p_payload: { terminal: true, user_id: user.id },
    p_priority: 200,
  });
  if (enqErr) {
    return withCopilotCors(req, NextResponse.json({ error: enqErr.message }, { status: 500 }));
  }

  await markSessionFinalized({ admin, sessionId, documentId: null });
  return withCopilotCors(req, NextResponse.json({ ok: true, ended: "finalized_pending_sync" as const }));
}
