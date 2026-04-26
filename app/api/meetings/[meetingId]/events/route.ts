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

  const res = await admin
    .schema("deal_intel")
    .from("meeting_assistant_event")
    .select("id, kind, title, body, severity, created_at")
    .eq("meeting_id", meetingId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (res.error) return NextResponse.json({ error: res.error.message || "Failed to load events" }, { status: 500 });
  return NextResponse.json({ events: res.data ?? [] });
}

