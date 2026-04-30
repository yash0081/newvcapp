import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/research/db";
import { getSessionForUser, setAutoSteeringNote } from "@/lib/copilot/db";
import { copilotPreflight, withCopilotCors } from "@/lib/copilot/cors";

export async function OPTIONS(req: Request) {
  return copilotPreflight(req);
}

export async function POST(req: Request, ctx: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await ctx.params;
  const user = await getAuthedUser();
  if (!user) return withCopilotCors(req, NextResponse.json({ error: "Unauthorized" }, { status: 401 }));

  const body = (await req.json().catch(() => null)) as { note?: unknown } | null;
  const note = typeof body?.note === "string" ? body.note : "";

  const admin = createAdminClient();
  const session = await getSessionForUser({ admin, sessionId, userId: user.id });
  if (!session) return withCopilotCors(req, NextResponse.json({ error: "Session not found" }, { status: 404 }));
  if (session.status !== "active") {
    return withCopilotCors(req, NextResponse.json({ error: "Session is not active" }, { status: 409 }));
  }

  await setAutoSteeringNote({ admin, sessionId: session.id, userId: user.id, note });

  const refreshed = await getSessionForUser({ admin, sessionId: session.id, userId: user.id });
  return withCopilotCors(req, NextResponse.json({ ok: true, session: refreshed }));
}
