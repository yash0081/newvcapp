import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser, getDealForUser } from "@/lib/research/db";
import { getActiveSession, markSessionsAbandonedForDeal } from "@/lib/copilot/db";

export async function POST(req: Request) {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { dealId?: string; tabHint?: string } | null;
  const dealId = typeof body?.dealId === "string" ? body.dealId : "";
  if (!dealId) return NextResponse.json({ error: "dealId is required" }, { status: 400 });

  const { data: deal, error: dealErr } = await getDealForUser(dealId, user.id);
  if (dealErr) return NextResponse.json({ error: dealErr.message }, { status: 500 });
  if (!deal) return NextResponse.json({ error: "Deal not found" }, { status: 404 });

  const admin = createAdminClient();

  await markSessionsAbandonedForDeal({ admin, dealId, userId: user.id });

  const ins = await admin
    .schema("deal_intel")
    .from("copilot_session")
    .insert({
      deal_id: dealId,
      user_id: user.id,
      status: "active",
      metadata: {
        acceptedSnippets: [],
        tab_hint: typeof body?.tabHint === "string" ? body.tabHint.slice(0, 240) : null,
      },
    })
    .select("id, deal_id, user_id, status, started_at, ended_at, finalized_document_id, metadata")
    .single();
  if (ins.error) return NextResponse.json({ error: ins.error.message }, { status: 500 });

  return NextResponse.json({ session: ins.data });
}

export async function GET(req: Request) {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const dealId = url.searchParams.get("dealId") ?? "";
  if (!dealId) return NextResponse.json({ error: "dealId is required" }, { status: 400 });

  const { data: deal, error: dealErr } = await getDealForUser(dealId, user.id);
  if (dealErr) return NextResponse.json({ error: dealErr.message }, { status: 500 });
  if (!deal) return NextResponse.json({ error: "Deal not found" }, { status: 404 });

  const admin = createAdminClient();
  const session = await getActiveSession({ admin, dealId, userId: user.id });
  return NextResponse.json({ session });
}
