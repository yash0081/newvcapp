import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser, getDealForUser } from "@/lib/research/db";
import { getActiveSession } from "@/lib/copilot/db";

export async function GET(_req: Request, ctx: { params: Promise<{ dealId: string }> }) {
  const { dealId } = await ctx.params;
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: deal, error: dealErr } = await getDealForUser(dealId, user.id);
  if (dealErr) return NextResponse.json({ error: dealErr.message }, { status: 500 });
  if (!deal) return NextResponse.json({ error: "Deal not found" }, { status: 404 });

  const admin = createAdminClient();
  const session = await getActiveSession({ admin, dealId, userId: user.id });

  let recentEvents: unknown[] = [];
  if (session) {
    const ev = await admin
      .schema("deal_intel")
      .from("copilot_event")
      .select("id, session_id, kind, payload, hostname, parent_event_id, created_at")
      .eq("session_id", session.id)
      .order("created_at", { ascending: false })
      .limit(80);
    if (!ev.error) recentEvents = ev.data ?? [];
  }

  return NextResponse.json({ session, recentEvents });
}
