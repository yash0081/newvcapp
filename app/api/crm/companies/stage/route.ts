import { NextResponse } from "next/server";
import { ensureCrmStages, normalizeStageKey } from "@/lib/crm/stages";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { deal_id?: string; crm_stage?: string } | null;
  const deal_id = typeof body?.deal_id === "string" ? body.deal_id.trim() : "";
  if (!deal_id) return NextResponse.json({ error: "deal_id is required" }, { status: 400 });
  const admin = createAdminClient();
  const stages = await ensureCrmStages(admin, user.id);
  const crm_stage = normalizeStageKey(body?.crm_stage, stages);

  const { data: existing, error: loadErr } = await admin
    .schema("deal_intel")
    .from("deal")
    .select("id, metadata")
    .eq("id", deal_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (loadErr) return NextResponse.json({ error: loadErr.message }, { status: 500 });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const meta = (existing.metadata && typeof existing.metadata === "object" ? (existing.metadata as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;

  const { error } = await admin
    .schema("deal_intel")
    .from("deal")
    .update({ metadata: { ...meta, crm_stage } })
    .eq("id", deal_id)
    .eq("user_id", user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
