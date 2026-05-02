import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadMeetingClaimTextsForDisplay } from "@/lib/live-assistant/meeting-claim-display";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export async function GET(req: Request, ctx: { params: Promise<{ meetingId: string }> }) {
  const { meetingId } = await ctx.params;
  const url = new URL(req.url);
  const guestToken = url.searchParams.get("guest")?.trim() || "";

  const admin = createAdminClient();
  const { data: meeting, error: mErr } = await admin
    .schema("deal_intel")
    .from("meeting_session")
    .select("id, host_user_id, metadata")
    .eq("id", meetingId)
    .maybeSingle();
  if (mErr) return NextResponse.json({ error: mErr.message || "Failed to load meeting" }, { status: 500 });
  if (!meeting) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const isHost = Boolean(user && user.id === meeting.host_user_id);

  if (!isHost) {
    const meta =
      meeting.metadata && typeof meeting.metadata === "object"
        ? (meeting.metadata as Record<string, unknown>)
        : ({} as Record<string, unknown>);
    const expected = typeof meta.guest_token_sha256 === "string" ? meta.guest_token_sha256 : "";
    const got = guestToken ? sha256Hex(guestToken) : "";
    if (!expected || !got || got !== expected) {
      return NextResponse.json({ error: "Invalid guest token" }, { status: 401 });
    }
  }

  const vRes = await admin
    .schema("deal_intel")
    .from("meeting_claim_verification")
    .select(
      "id, meeting_id, claim_id, stage, auto_verdict, auto_summary, auto_evidence, research_verdict, research_summary, research_citations, requested_by_user_id, created_at, updated_at",
    )
    .eq("meeting_id", meetingId)
    .order("updated_at", { ascending: false })
    .limit(80);

  if (vRes.error) return NextResponse.json({ error: vRes.error.message || "Failed to load verifications" }, { status: 500 });

  const rows = (vRes.data ?? []) as Array<{ claim_id: string } & Record<string, unknown>>;
  const claimIds = [...new Set(rows.map((r) => String(r.claim_id)))];
  const claimById =
    claimIds.length > 0 ? await loadMeetingClaimTextsForDisplay(admin, meetingId, claimIds) : new Map<string, string>();

  const verifications = rows.map((r) => ({
    ...r,
    claim_text: claimById.get(String(r.claim_id)) ?? "",
  }));

  return NextResponse.json({ verifications });
}
