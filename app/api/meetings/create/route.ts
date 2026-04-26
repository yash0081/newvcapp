import { NextResponse } from "next/server";
import { randomUUID, createHash } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { dealId?: string } | null;
  const dealId = typeof body?.dealId === "string" ? body.dealId : "";
  if (!dealId) return NextResponse.json({ error: "Missing dealId" }, { status: 400 });

  const admin = createAdminClient();

  const { data: deal, error: dealErr } = await admin
    .schema("deal_intel")
    .from("deal")
    .select("id")
    .eq("id", dealId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (dealErr) return NextResponse.json({ error: dealErr.message || "Failed to validate deal" }, { status: 500 });
  if (!deal) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const meetingId = randomUUID();
  const roomName = `deal_${dealId.slice(0, 8)}_${meetingId.slice(0, 8)}`;

  const guestToken = randomUUID();
  const guestTokenSha256 = sha256Hex(guestToken);

  const { error: insErr } = await admin.schema("deal_intel").from("meeting_session").insert({
    id: meetingId,
    deal_id: dealId,
    host_user_id: user.id,
    livekit_room_name: roomName,
    status: "created",
    metadata: {
      guest_token_sha256: guestTokenSha256,
      created_by: "crm",
    },
  });
  if (insErr) return NextResponse.json({ error: insErr.message || "Failed to create meeting" }, { status: 500 });

  const guestJoinUrl = `/meet/${meetingId}?guest=${encodeURIComponent(guestToken)}`;
  return NextResponse.json({ meetingId, dealId, roomName, guestJoinUrl });
}

