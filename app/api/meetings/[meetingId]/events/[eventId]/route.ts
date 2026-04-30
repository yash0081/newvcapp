import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { randomUUID } from "node:crypto";

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
    .select("id, host_user_id")
    .eq("id", meetingId)
    .maybeSingle();
  if (meeting.error) return { error: meeting.error.message || "Failed to load meeting", status: 500 as const };
  if (!meeting.data) return { error: "Not found", status: 404 as const };
  if (meeting.data.host_user_id !== user.id) return { error: "Forbidden", status: 403 as const };
  return { user, admin };
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ meetingId: string; eventId: string }> }) {
  const { meetingId, eventId } = await ctx.params;
  const host = await requireHost(meetingId);
  if ("error" in host) return NextResponse.json({ error: host.error }, { status: host.status });

  // Load the event to log a preference signal.
  const ev = await host.admin
    .schema("deal_intel")
    .from("meeting_assistant_event")
    .select("id, kind, severity, title, body, source_map")
    .eq("id", eventId)
    .eq("meeting_id", meetingId)
    .maybeSingle();
  if (ev.error) return NextResponse.json({ error: ev.error.message || "Failed to load event" }, { status: 500 });
  if (!ev.data) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const del = await host.admin
    .schema("deal_intel")
    .from("meeting_assistant_event")
    .delete()
    .eq("id", eventId)
    .eq("meeting_id", meetingId);
  if (del.error) return NextResponse.json({ error: del.error.message || "Failed to delete event" }, { status: 500 });

  // If this was a contradiction, also soft-dismiss the persisted meeting_contradiction row (if present).
  const sm = (ev.data.source_map && typeof ev.data.source_map === "object" ? (ev.data.source_map as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;
  const dedupeKey = typeof sm.dedupe_key === "string" ? sm.dedupe_key : null;
  if (ev.data.kind === "contradiction" && dedupeKey) {
    await host.admin
      .schema("deal_intel")
      .from("meeting_contradiction")
      .update({ dismissed_at: new Date().toISOString(), dismissed_by: host.user.id })
      .eq("meeting_id", meetingId)
      .eq("dedupe_key", dedupeKey);
  }

  // Preference signal: user dismissed this card. Store as a user_rule row.
  await host.admin.schema("deal_intel").from("user_rule").insert({
    id: randomUUID(),
    user_id: host.user.id,
    rule_type: ev.data.kind === "contradiction" ? "live_assistant_contradiction_dismissed" : "live_assistant_card_dismissed",
    value_jsonb: {
      meeting_id: meetingId,
      event_id: eventId,
      kind: ev.data.kind,
      severity: ev.data.severity,
      title: ev.data.title,
      body: ev.data.body?.slice?.(0, 800) ?? null,
      source_map: ev.data.source_map ?? {},
      dismissed_at: new Date().toISOString(),
    },
    confidence: 0.65,
    recency_weight: 1.0,
    is_explicit: true,
  });

  return NextResponse.json({ ok: true });
}

