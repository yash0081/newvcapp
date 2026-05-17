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

  const body = (await req.json().catch(() => null)) as { company_name?: string; website?: string | null; crm_stage?: string } | null;
  const company_name = typeof body?.company_name === "string" ? body.company_name.trim() : "";
  const websiteRaw = typeof body?.website === "string" ? body.website.trim() : "";
  const website = websiteRaw ? websiteRaw : null;
  const admin = createAdminClient();
  const stages = await ensureCrmStages(admin, user.id);
  const crm_stage = normalizeStageKey(body?.crm_stage, stages);
  if (!company_name) return NextResponse.json({ error: "company_name is required" }, { status: 400 });

  const { data, error } = await admin
    .schema("deal_intel")
    .from("deal")
    .insert({ user_id: user.id, metadata: { company_name, website, crm_stage, source: "crm" } })
    .select("id")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ id: data?.id });
}
