import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type Stage = "screened" | "in_process" | "invested" | "passed";

function asStage(v: unknown): Stage {
  const s = typeof v === "string" ? v : "";
  if (s === "screened" || s === "in_process" || s === "invested" || s === "passed") return s;
  return "screened";
}

export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { company_name?: string; website?: string | null; crm_stage?: Stage } | null;
  const company_name = typeof body?.company_name === "string" ? body.company_name.trim() : "";
  const websiteRaw = typeof body?.website === "string" ? body.website.trim() : "";
  const website = websiteRaw ? websiteRaw : null;
  const crm_stage = asStage(body?.crm_stage);
  if (!company_name) return NextResponse.json({ error: "company_name is required" }, { status: 400 });

  const { data, error } = await supabase
    .schema("deal_intel")
    .from("deal")
    .insert({ user_id: user.id, metadata: { company_name, website, crm_stage, source: "crm" } })
    .select("id")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ id: data?.id });
}

