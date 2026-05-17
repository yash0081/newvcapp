import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/research/db";
import { mergeResearchAgenda } from "@/lib/copilot/db";
import { getSessionForUser } from "@/lib/copilot/db";
import { copilotPreflight, withCopilotCors } from "@/lib/copilot/cors";

export async function OPTIONS(req: Request) {
  return copilotPreflight(req);
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await ctx.params;
  const user = await getAuthedUser();
  if (!user) {
    return withCopilotCors(req, NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
  }

  let body: { enabled?: boolean } | null = null;
  try {
    body = await req.json();
  } catch {
    return withCopilotCors(req, NextResponse.json({ error: "Invalid JSON" }, { status: 400 }));
  }

  const enabled = !!body?.enabled;
  const admin = createAdminClient();
  
  // Update session metadata directly to toggle deep research mode.
  const { data: session, error: getErr } = await admin
    .schema("deal_intel")
    .from("copilot_session")
    .select("metadata")
    .eq("id", sessionId)
    .eq("user_id", user.id)
    .single();

  if (getErr || !session) {
    return withCopilotCors(req, NextResponse.json({ ok: false, error: "Session not found" }, { status: 404 }));
  }

  const meta = (session.metadata as Record<string, any>) || {};
  const updatedMeta = {
    ...meta,
    is_deep_research: enabled
  };

  const { error: updErr } = await admin
    .schema("deal_intel")
    .from("copilot_session")
    .update({ metadata: updatedMeta })
    .eq("id", sessionId)
    .eq("user_id", user.id);

  if (updErr) {
    return withCopilotCors(req, NextResponse.json({ ok: false, error: updErr.message }, { status: 500 }));
  }

  const updatedSession = await getSessionForUser({ admin, sessionId, userId: user.id });

  return withCopilotCors(req, NextResponse.json({ ok: true, session: updatedSession }));
}
