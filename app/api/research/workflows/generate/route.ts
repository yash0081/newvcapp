import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser, getDealForUser } from "@/lib/research/db";
import { generateResearchPlan } from "@/lib/research/planner";

export async function POST(req: Request) {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { dealId?: string } | null;
  const dealId = typeof body?.dealId === "string" ? body.dealId : "";
  if (!dealId) return NextResponse.json({ error: "dealId is required" }, { status: 400 });

  const { data: deal, error: dealErr } = await getDealForUser(dealId, user.id);
  if (dealErr) return NextResponse.json({ error: dealErr.message }, { status: 500 });
  if (!deal) return NextResponse.json({ error: "Deal not found" }, { status: 404 });

  const admin = createAdminClient();
  const meta = (deal.metadata && typeof deal.metadata === "object" ? deal.metadata : {}) as Record<string, unknown>;
  const companyName = typeof meta.company_name === "string" ? meta.company_name : "Company";
  const companyContext = JSON.stringify(meta, null, 2);

  const prefRes = await admin
    .schema("deal_intel")
    .from("user_research_site_preference")
    .select("domain, category, preference_score, success_rate, usage_count")
    .eq("user_id", user.id)
    .order("usage_count", { ascending: false })
    .limit(30);
  const preferences = (prefRes.data ?? []) as Array<{
    domain: string;
    category: string;
    preference_score: number;
    success_rate: number;
    usage_count: number;
  }>;

  const suggestion = await generateResearchPlan({
    companyName,
    companyContext,
    preferences,
  });

  const existing = await admin
    .schema("deal_intel")
    .from("deal_research_workflow")
    .select("id, deal_id, user_id, title, status, version, metadata, created_at, updated_at")
    .eq("deal_id", dealId)
    .eq("user_id", user.id)
    .neq("status", "archived")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing.error) return NextResponse.json({ error: existing.error.message }, { status: 500 });

  let workflow:
    | {
        id: string;
        deal_id: string;
        user_id: string;
        title: string;
        status: string;
        version: number;
        metadata: Record<string, unknown> | null;
        created_at: string;
        updated_at: string;
      }
    | null = null;

  if (existing.data) {
    const upd = await admin
      .schema("deal_intel")
      .from("deal_research_workflow")
      .update({
        title: `${companyName} research`,
        status: "ready",
        version: (existing.data.version ?? 1) + 1,
        metadata: {
          summary: suggestion.summary,
          generated_at: new Date().toISOString(),
          generated_by: "planner",
        },
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.data.id)
      .eq("user_id", user.id)
      .select("id, deal_id, user_id, title, status, version, metadata, created_at, updated_at")
      .single();
    if (upd.error) return NextResponse.json({ error: upd.error.message }, { status: 500 });
    workflow = upd.data;
  } else {
    const ins = await admin
      .schema("deal_intel")
      .from("deal_research_workflow")
      .insert({
        deal_id: dealId,
        user_id: user.id,
        title: `${companyName} research`,
        status: "ready",
        metadata: {
          summary: suggestion.summary,
          generated_at: new Date().toISOString(),
          generated_by: "planner",
        },
      })
      .select("id, deal_id, user_id, title, status, version, metadata, created_at, updated_at")
      .single();
    if (ins.error) return NextResponse.json({ error: ins.error.message }, { status: 500 });
    workflow = ins.data;
  }

  if (!workflow) return NextResponse.json({ error: "Failed to create workflow" }, { status: 500 });

  const del = await admin
    .schema("deal_intel")
    .from("deal_research_step")
    .delete()
    .eq("workflow_id", workflow.id);
  if (del.error) return NextResponse.json({ error: del.error.message }, { status: 500 });

  const stepRows = suggestion.steps.map((s, i) => ({
    workflow_id: workflow.id,
    position: i,
    status: "todo",
    website: s.website,
    task: s.task,
    depends_on_step_ids: [],
    metadata: {
      category: s.category ?? "general",
      generated: true,
    },
  }));
  const ins = await admin
    .schema("deal_intel")
    .from("deal_research_step")
    .insert(stepRows)
    .select("id, workflow_id, position, status, website, task, notes, depends_on_step_ids, metadata, created_at, updated_at");
  if (ins.error) return NextResponse.json({ error: ins.error.message }, { status: 500 });

  return NextResponse.json({
    workflow,
    steps: ins.data ?? [],
  });
}

