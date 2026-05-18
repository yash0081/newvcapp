import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ensureCrmStages, normalizeStageKey } from "@/lib/crm/stages";
import { createClient } from "@/lib/supabase/server";

function safeMeta(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const [stages, dealsRes] = await Promise.all([
    ensureCrmStages(admin, user.id),
    admin
      .schema("deal_intel")
      .from("deal")
      .select("id, metadata, updated_at")
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false, nullsFirst: false }),
  ]);

  if (dealsRes.error) {
    return NextResponse.json({ error: dealsRes.error.message }, { status: 500 });
  }

  const companies = (dealsRes.data ?? []).map((deal) => {
    const meta = safeMeta(deal.metadata);
    const name =
      typeof meta.company_name === "string" && meta.company_name.trim()
        ? meta.company_name.trim()
        : "Untitled company";
    const stageKey = normalizeStageKey(meta.crm_stage, stages);
    const stageLabel = stages.find((stage) => stage.key === stageKey)?.label ?? "Screened";
    return {
      id: deal.id,
      name,
      stageLabel,
    };
  });

  return NextResponse.json({ companies });
}
