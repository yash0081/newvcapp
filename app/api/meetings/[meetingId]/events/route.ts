import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export async function GET(req: Request, ctx: { params: Promise<{ meetingId: string }> }) {
  const { meetingId } = await ctx.params;
  const url = new URL(req.url);
  const guestToken = url.searchParams.get("guest")?.trim() || "";
  const lane = url.searchParams.get("lane")?.trim().toLowerCase();
  const severity = url.searchParams.get("severity")?.trim().toLowerCase();

  const admin = createAdminClient();
  const { data: meeting, error: mErr } = await admin
    .schema("deal_intel")
    .from("meeting_session")
    .select("id, host_user_id, metadata")
    .eq("id", meetingId)
    .maybeSingle();
  if (mErr) return NextResponse.json({ error: mErr.message || "Failed to load meeting" }, { status: 500 });
  if (!meeting) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Host path: must be signed in and be the meeting host.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const isHost = Boolean(user && user.id === meeting.host_user_id);

  if (!isHost) {
    // Guest path: validate magic token (no login).
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

  let q = admin
    .schema("deal_intel")
    .from("meeting_assistant_event")
    .select("id, kind, title, body, severity, created_at, source_map")
    .eq("meeting_id", meetingId)
    .order("created_at", { ascending: false });
  if (severity && ["low", "med", "high"].includes(severity)) {
    q = q.eq("severity", severity);
  }
  if (lane && ["attention", "context", "memo"].includes(lane)) {
    q = q.contains("source_map", { lane });
  }
  // Pull more than the UI renders so deep/reasoned cards don't get pushed out by fast-lane spam.
  const res = await q.limit(200);

  if (res.error) return NextResponse.json({ error: res.error.message || "Failed to load events" }, { status: 500 });

  const events = (res.data ?? []).filter((e) => {
    const sm = (e as { source_map?: unknown }).source_map;
    if (sm && typeof sm === "object" && (sm as Record<string, unknown>).ui_suppressed === true) return false;
    return true;
  });

  // Resolve supersession state for the cards we're about to render. When a guest later
  // corrects a number ("$20B" → "$215B"), the matcher writes `superseded_by_claim_id` on
  // the original claim. The UI uses this to render an "Updated to: <new claim text>"
  // footer on the original contradiction/claim_verification card so the user sees the
  // correction inline rather than as a separate fresh card minutes later.
  const claimIds = new Set<string>();
  for (const e of events) {
    const sm = (e as { source_map?: unknown }).source_map;
    if (sm && typeof sm === "object") {
      const v = (sm as Record<string, unknown>).meeting_claim_id;
      if (typeof v === "string" && v) claimIds.add(v);
    }
  }
  const supersessions: Record<string, { superseded_by_claim_id: string; superseded_at: string | null; new_claim_text: string | null }> = {};
  if (claimIds.size) {
    const supRes = await admin
      .schema("deal_intel")
      .from("meeting_claim")
      .select("id, superseded_by_claim_id, superseded_at")
      .in("id", [...claimIds])
      .not("superseded_by_claim_id", "is", null);
    const rows = (supRes.data ?? []) as Array<{
      id: string;
      superseded_by_claim_id: string | null;
      superseded_at: string | null;
    }>;
    if (rows.length) {
      const newClaimIds = [...new Set(rows.map((r) => r.superseded_by_claim_id).filter(Boolean) as string[])];
      const newClaimTexts = new Map<string, string>();
      if (newClaimIds.length) {
        const tRes = await admin
          .schema("deal_intel")
          .from("meeting_claim")
          .select("id, text")
          .in("id", newClaimIds);
        for (const r of (tRes.data ?? []) as Array<{ id: string; text: string }>) {
          newClaimTexts.set(String(r.id), String(r.text ?? "").slice(0, 600));
        }
      }
      for (const r of rows) {
        if (!r.superseded_by_claim_id) continue;
        supersessions[String(r.id)] = {
          superseded_by_claim_id: String(r.superseded_by_claim_id),
          superseded_at: r.superseded_at ? String(r.superseded_at) : null,
          new_claim_text: newClaimTexts.get(String(r.superseded_by_claim_id)) ?? null,
        };
      }
    }
  }

  return NextResponse.json({ events, supersessions });
}

