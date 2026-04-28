import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/research/db";
import {
  getSessionForUser,
  insertCopilotEvent,
  markSessionFinalized,
} from "@/lib/copilot/db";
import { finalizeCopilotSessionToDocument } from "@/lib/copilot/finalize";

function asCompanyName(meta: unknown): string {
  if (!meta || typeof meta !== "object") return "Company";
  const m = meta as Record<string, unknown>;
  return typeof m.company_name === "string" ? m.company_name : "Company";
}

export async function POST(_req: Request, ctx: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await ctx.params;
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const session = await getSessionForUser({ admin, sessionId, userId: user.id });
  if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  if (session.status !== "active") {
    return NextResponse.json({ error: "Session is not active" }, { status: 409 });
  }

  const dealRes = await admin
    .schema("deal_intel")
    .from("deal")
    .select("metadata")
    .eq("id", session.deal_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (dealRes.error) return NextResponse.json({ error: dealRes.error.message }, { status: 500 });
  const companyName = asCompanyName(dealRes.data?.metadata);

  let documentId: string | null = null;
  try {
    const result = await finalizeCopilotSessionToDocument({
      admin,
      session,
      companyName,
    });
    documentId = result.documentId;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await insertCopilotEvent({
      admin,
      event: {
        session_id: sessionId,
        kind: "error",
        payload: { stage: "finalize", message },
      },
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }

  await markSessionFinalized({ admin, sessionId, documentId });
  await insertCopilotEvent({
    admin,
    event: {
      session_id: sessionId,
      kind: "reply",
      payload: {
        text: documentId
          ? "Saved your accepted snippets as a deal document and queued embeddings."
          : "No accepted snippets to save; session ended.",
        document_id: documentId,
      },
    },
  });

  return NextResponse.json({ ok: true, documentId });
}
