import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser, getDealForUser } from "@/lib/research/db";

export async function GET(_req: Request, ctx: { params: Promise<{ dealId: string }> }) {
  const { dealId } = await ctx.params;
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: deal, error: dealErr } = await getDealForUser(dealId, user.id);
  if (dealErr) return NextResponse.json({ error: dealErr.message }, { status: 500 });
  if (!deal) return NextResponse.json({ error: "Deal not found" }, { status: 404 });

  const admin = createAdminClient();
  const wfRes = await admin
    .schema("deal_intel")
    .from("deal_research_workflow")
    .select("id, deal_id, user_id, title, status, version, metadata, created_at, updated_at")
    .eq("deal_id", dealId)
    .eq("user_id", user.id)
    .neq("status", "archived")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (wfRes.error) return NextResponse.json({ error: wfRes.error.message }, { status: 500 });
  if (!wfRes.data) return NextResponse.json({ workflow: null, steps: [], runs: [] });

  const workflow = wfRes.data;

  const [stepRes, runRes] = await Promise.all([
    admin
      .schema("deal_intel")
      .from("deal_research_step")
      .select("id, workflow_id, position, status, website, task, notes, depends_on_step_ids, metadata, created_at, updated_at")
      .eq("workflow_id", workflow.id)
      .order("position", { ascending: true }),
    admin
      .schema("deal_intel")
      .from("deal_research_step_run")
      .select("id, workflow_id, step_id, run_status, output_notes, sources, error_message, metadata, created_at")
      .eq("workflow_id", workflow.id)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);
  if (stepRes.error) return NextResponse.json({ error: stepRes.error.message }, { status: 500 });
  if (runRes.error) return NextResponse.json({ error: runRes.error.message }, { status: 500 });

  return NextResponse.json({
    workflow,
    steps: stepRes.data ?? [],
    runs: runRes.data ?? [],
  });
}

