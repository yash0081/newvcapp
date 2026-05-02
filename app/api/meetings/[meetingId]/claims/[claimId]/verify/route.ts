import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

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
  const dealId = meeting.data.deal_id == null ? "" : String(meeting.data.deal_id);
  return { user, admin, dealId };
}

export async function POST(_req: Request, ctx: { params: Promise<{ meetingId: string; claimId: string }> }) {
  const { meetingId, claimId } = await ctx.params;
  const host = await requireHost(meetingId);
  if ("error" in host) return NextResponse.json({ error: host.error }, { status: host.status });

  if (!host.dealId) return NextResponse.json({ error: "Meeting has no deal attached" }, { status: 400 });

  const claim = await host.admin
    .schema("deal_intel")
    .from("meeting_claim")
    .select("id")
    .eq("id", claimId)
    .eq("meeting_id", meetingId)
    .maybeSingle();
  if (claim.error) return NextResponse.json({ error: claim.error.message || "Failed to load claim" }, { status: 500 });
  if (!claim.data) return NextResponse.json({ error: "Claim not found" }, { status: 404 });

  const existing = await host.admin
    .schema("deal_intel")
    .from("meeting_claim_verification")
    .select("id")
    .eq("meeting_id", meetingId)
    .eq("claim_id", claimId)
    .maybeSingle();

  const nowIso = new Date().toISOString();
  if (!existing.data) {
    const ins = await host.admin.schema("deal_intel").from("meeting_claim_verification").insert({
      meeting_id: meetingId,
      claim_id: claimId,
      stage: "research_pending",
      requested_by_user_id: host.user.id,
      auto_evidence: [],
      research_citations: [],
      updated_at: nowIso,
    });
    if (ins.error) return NextResponse.json({ error: ins.error.message || "Failed to start verification" }, { status: 500 });
  } else {
    const upd = await host.admin
      .schema("deal_intel")
      .from("meeting_claim_verification")
      .update({
        stage: "research_pending",
        requested_by_user_id: host.user.id,
        updated_at: nowIso,
      })
      .eq("meeting_id", meetingId)
      .eq("claim_id", claimId);
    if (upd.error) return NextResponse.json({ error: upd.error.message || "Failed to start verification" }, { status: 500 });
  }

  try {
    await host.admin.rpc("deal_intel_enqueue_job", {
      p_job_type: "meeting_claim_research_verify",
      p_subject_kind: "meeting",
      p_subject_id: meetingId,
      p_payload: {
        meeting_id: meetingId,
        claim_id: claimId,
        user_id: host.user.id,
        deal_id: host.dealId,
      },
      p_priority: 80,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }

  const row = await host.admin
    .schema("deal_intel")
    .from("meeting_claim_verification")
    .select("*")
    .eq("meeting_id", meetingId)
    .eq("claim_id", claimId)
    .maybeSingle();

  return NextResponse.json({ verification: row.data ?? null });
}
