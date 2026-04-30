import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

type NoteRow = {
  id: string;
  section: string;
  text: string;
  t_ms: number;
  importance_score: number;
  source_claim_ids: string[];
  parent_bullet_id: string | null;
  created_at: string;
  updated_at: string;
};

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

  const res = await admin
    .schema("deal_intel")
    .from("meeting_note_bullet")
    .select("id, section, text, t_ms, importance_score, source_claim_ids, parent_bullet_id, created_at, updated_at")
    .eq("meeting_id", meetingId)
    .order("importance_score", { ascending: false })
    .order("t_ms", { ascending: false })
    .limit(300);

  if (res.error) return NextResponse.json({ error: res.error.message || "Failed to load notes" }, { status: 500 });
  const rows = (res.data ?? []) as NoteRow[];

  const bySection: Record<string, { bullets: NoteRow[]; subbullets: Record<string, NoteRow[]> }> = {};
  for (const r of rows) {
    const sec = String(r.section || "other");
    if (!bySection[sec]) bySection[sec] = { bullets: [], subbullets: {} };
    if (!r.parent_bullet_id) bySection[sec]!.bullets.push(r);
    else {
      const pid = String(r.parent_bullet_id);
      const sb = bySection[sec]!.subbullets[pid] ?? [];
      sb.push(r);
      bySection[sec]!.subbullets[pid] = sb;
    }
  }

  // Sort within section chronologically (timestamp), but keep overall section ordering stable on server.
  for (const sec of Object.keys(bySection)) {
    bySection[sec]!.bullets.sort((a, b) => (b.t_ms ?? 0) - (a.t_ms ?? 0));
    for (const pid of Object.keys(bySection[sec]!.subbullets)) {
      bySection[sec]!.subbullets[pid]!.sort((a, b) => (b.t_ms ?? 0) - (a.t_ms ?? 0));
    }
  }

  return NextResponse.json({ sections: bySection });
}

