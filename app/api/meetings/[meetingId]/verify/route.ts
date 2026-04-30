import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ingestTextAsDocument } from "@/lib/research/document-ingest";

type VerifyDecision = "accepted" | "rejected";

async function requireHost(meetingId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized", status: 401 as const };

  const admin = createAdminClient();
  const meeting = await admin
    .schema("deal_intel")
    .from("meeting_session")
    .select("id, host_user_id, deal_id")
    .eq("id", meetingId)
    .maybeSingle();
  if (meeting.error) return { error: meeting.error.message || "Failed to load meeting", status: 500 as const };
  if (!meeting.data) return { error: "Not found", status: 404 as const };
  if (meeting.data.host_user_id !== user.id) return { error: "Forbidden", status: 403 as const };
  return { user, admin, meeting: meeting.data as { id: string; deal_id: string } };
}

export async function POST(req: Request, ctx: { params: Promise<{ meetingId: string }> }) {
  const { meetingId } = await ctx.params;
  const host = await requireHost(meetingId);
  if ("error" in host) return NextResponse.json({ error: host.error }, { status: host.status });

  const body = (await req.json().catch(() => null)) as
    | { decision?: VerifyDecision; query?: string; url?: string; notes?: string; event_id?: string }
    | null;
  const decision = body?.decision === "accepted" ? "accepted" : body?.decision === "rejected" ? "rejected" : null;
  if (!decision) return NextResponse.json({ error: "Missing decision" }, { status: 400 });

  const query = String(body?.query ?? "").trim().slice(0, 500);
  const url = String(body?.url ?? "").trim().slice(0, 800);
  const notes = String(body?.notes ?? "").trim().slice(0, 6000);
  const eventId = body?.event_id ? String(body.event_id) : null;

  if (decision === "accepted") {
    const docText = [
      "# External verification (accepted)",
      query ? `Query: ${query}` : null,
      url ? `URL: ${url}` : null,
      notes ? `\nNotes:\n${notes}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    await ingestTextAsDocument({
      admin: host.admin as unknown as Parameters<typeof ingestTextAsDocument>[0]["admin"],
      userId: host.user.id,
      dealId: String(host.meeting.deal_id),
      text: docText,
      sourceKind: "web",
      docType: "meeting_external_verification",
      originalFilename: `Meeting verification — ${query || "external claim"}`.slice(0, 180),
      mimeType: "text/markdown",
      storageBucket: "web",
      storagePathPrefix: `web/${host.user.id}`,
      folderPath: "Web research",
      routingReason: "meeting_external_verification",
      pageMetadata: {
        kind: "meeting_external_verification",
        meeting_id: meetingId,
        query,
        url,
        event_id: eventId,
      },
      fastEmbedLimit: 6,
      maxChunks: 64,
    });
  }

  await host.admin.schema("deal_intel").from("user_rule").insert({
    id: randomUUID(),
    user_id: host.user.id,
    rule_type: decision === "accepted" ? "live_assistant_external_verify_accepted" : "live_assistant_external_verify_rejected",
    value_jsonb: {
      meeting_id: meetingId,
      event_id: eventId,
      query,
      url: url || null,
      notes: notes ? notes.slice(0, 1200) : null,
      decided_at: new Date().toISOString(),
    },
    confidence: 0.75,
    recency_weight: 1.0,
    is_explicit: true,
  });

  return NextResponse.json({ ok: true });
}

