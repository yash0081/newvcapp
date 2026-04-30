import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(_req: Request, ctx: { params: Promise<{ meetingId: string }> }) {
  const { meetingId } = await ctx.params;
  const u = new URL(_req.url);
  const mode = u.searchParams.get("mode")?.trim().toLowerCase();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const meeting = await admin
    .schema("deal_intel")
    .from("meeting_session")
    .select("id, host_user_id")
    .eq("id", meetingId)
    .maybeSingle();
  if (meeting.error) return NextResponse.json({ error: meeting.error.message || "Failed to load meeting" }, { status: 500 });
  if (!meeting.data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (meeting.data.host_user_id !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const transcript = await admin
    .schema("deal_intel")
    .from("meeting_transcript_segment")
    .select("id, segment_key, text, speaker, revision, is_final, created_at")
    .eq("meeting_id", meetingId)
    .order("created_at", { ascending: false })
    .limit(120);
  if (transcript.error) return NextResponse.json({ error: transcript.error.message || "Failed to load transcript" }, { status: 500 });

  const rows = (transcript.data ?? []) as Array<{
    id: string;
    segment_key: string;
    text: string;
    speaker: string | null;
    revision: number;
    is_final: boolean;
    created_at: string;
  }>;
  if (mode !== "latest") {
    return NextResponse.json({ segments: rows });
  }
  const byKey = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const prev = byKey.get(r.segment_key);
    if (!prev || r.revision > prev.revision) byKey.set(r.segment_key, r);
  }
  const latest = Array.from(byKey.values()).sort((a, b) => b.created_at.localeCompare(a.created_at));
  return NextResponse.json({ segments: latest });
}

