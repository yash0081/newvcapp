import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { AccessToken } from "livekit-server-sdk";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function livekitEnv() {
  const url = process.env.LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!url || !apiKey || !apiSecret) {
    throw new Error("LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET must be set");
  }
  return { url, apiKey, apiSecret };
}

export async function POST(req: Request, ctx: { params: Promise<{ meetingId: string }> }) {
  const { meetingId } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { display_name?: string; guest_token?: string } | null;
  const displayName = typeof body?.display_name === "string" ? body.display_name.trim().slice(0, 60) : "";
  const guestToken = typeof body?.guest_token === "string" ? body.guest_token.trim() : "";

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const admin = createAdminClient();
  const { data: meeting, error: mErr } = await admin
    .schema("deal_intel")
    .from("meeting_session")
    .select("id, deal_id, host_user_id, livekit_room_name, metadata")
    .eq("id", meetingId)
    .maybeSingle();
  if (mErr) return NextResponse.json({ error: mErr.message || "Failed to load meeting" }, { status: 500 });
  if (!meeting) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const meta =
    meeting.metadata && typeof meeting.metadata === "object" ? (meeting.metadata as Record<string, unknown>) : ({} as Record<string, unknown>);

  const isHost = Boolean(user && user.id === meeting.host_user_id);
  const isGuest = !isHost;

  if (isGuest) {
    const expected = typeof meta.guest_token_sha256 === "string" ? meta.guest_token_sha256 : "";
    const got = guestToken ? sha256Hex(guestToken) : "";
    if (!expected || !got || got !== expected) {
      return NextResponse.json({ error: "Invalid guest token" }, { status: 401 });
    }
    if (!displayName) {
      return NextResponse.json({ error: "display_name is required" }, { status: 400 });
    }
  }

  // Host path: validate host still owns the deal.
  if (isHost) {
    const { data: deal, error: dErr } = await admin
      .schema("deal_intel")
      .from("deal")
      .select("id")
      .eq("id", meeting.deal_id)
      .eq("user_id", user!.id)
      .maybeSingle();
    if (dErr) return NextResponse.json({ error: dErr.message || "Failed to validate host access" }, { status: 500 });
    if (!deal) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const role = isHost ? "host" : "guest";
  const identity = isHost ? `host:${meeting.host_user_id}` : `guest:${meetingId}:${gotShort(guestToken)}`;
  const name = isHost ? "Host" : displayName;

  const { apiKey, apiSecret, url } = livekitEnv();
  const at = new AccessToken(apiKey, apiSecret, {
    identity,
    name,
  });
  at.addGrant({
    room: meeting.livekit_room_name,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
  });
  const token = await at.toJwt();

  // Best-effort participant record.
  await admin.schema("deal_intel").from("meeting_participant").insert({
    meeting_id: meetingId,
    role,
    display_name: name,
    livekit_identity: identity,
  });

  return NextResponse.json({
    meetingId,
    dealId: meeting.deal_id,
    roomName: meeting.livekit_room_name,
    livekitUrl: url,
    token,
    identity,
    role,
  });
}

function gotShort(token: string): string {
  // Don't leak full guest token into LiveKit identity.
  if (!token) return "anon";
  return token.replace(/[^a-z0-9]/gi, "").slice(0, 10) || "anon";
}

