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

  const body = (await req.json().catch(() => null)) as { deal_id?: string; crm_stage?: Stage } | null;
  const deal_id = typeof body?.deal_id === "string" ? body.deal_id.trim() : "";
  const crm_stage = asStage(body?.crm_stage);
  if (!deal_id) return NextResponse.json({ error: "deal_id is required" }, { status: 400 });

  const { data: existing, error: loadErr } = await supabase
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

  const { error } = await supabase
    .schema("deal_intel")
    .from("deal")
    .update({ metadata: { ...meta, crm_stage } })
    .eq("id", deal_id)
    .eq("user_id", user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

