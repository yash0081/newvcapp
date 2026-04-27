import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser, getWorkflowForUser } from "@/lib/research/db";
import { executeResearchStep } from "@/lib/research/executor";

function asCompanyName(meta: unknown): string {
  if (!meta || typeof meta !== "object") return "Company";
  const m = meta as Record<string, unknown>;
  return typeof m.company_name === "string" ? m.company_name : "Company";
}

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ workflowId: string; stepId: string }> }
) {
  const { workflowId, stepId } = await ctx.params;
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: workflow, error: wfErr } = await getWorkflowForUser(workflowId, user.id);
  if (wfErr) return NextResponse.json({ error: wfErr.message }, { status: 500 });
  if (!workflow) return NextResponse.json({ error: "Workflow not found" }, { status: 404 });

  const admin = createAdminClient();
  const stepRes = await admin
    .schema("deal_intel")
    .from("deal_research_step")
    .select("id, workflow_id, position, status, website, task, depends_on_step_ids")
    .eq("workflow_id", workflowId)
    .eq("id", stepId)
    .maybeSingle();
  if (stepRes.error) return NextResponse.json({ error: stepRes.error.message }, { status: 500 });
  if (!stepRes.data) return NextResponse.json({ error: "Step not found" }, { status: 404 });

  const dealRes = await admin
    .schema("deal_intel")
    .from("deal")
    .select("metadata")
    .eq("id", workflow.deal_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (dealRes.error) return NextResponse.json({ error: dealRes.error.message }, { status: 500 });

  const companyName = asCompanyName(dealRes.data?.metadata);
  const companyContext = JSON.stringify((dealRes.data?.metadata ?? {}) as Record<string, unknown>, null, 2);

  const result = await executeResearchStep({
    companyName,
    companyContext,
    website: stepRes.data.website,
    task: stepRes.data.task,
  });

  const run = await admin
    .schema("deal_intel")
    .from("deal_research_step_run")
    .insert({
      workflow_id: workflowId,
      step_id: stepId,
      run_status: "done",
      output_notes: result.notes,
      sources: result.sources,
      metadata: {
        suggestedStepUpdates: result.suggestedStepUpdates,
        website: stepRes.data.website,
        task: stepRes.data.task,
      },
    })
    .select("id, workflow_id, step_id, run_status, output_notes, sources, error_message, metadata, created_at")
    .single();
  if (run.error) return NextResponse.json({ error: run.error.message }, { status: 500 });

  const stepUpd = await admin
    .schema("deal_intel")
    .from("deal_research_step")
    .update({
      status: "done",
      notes: result.notes.slice(0, 5000),
      updated_at: new Date().toISOString(),
    })
    .eq("id", stepId)
    .eq("workflow_id", workflowId);
  if (stepUpd.error) return NextResponse.json({ error: stepUpd.error.message }, { status: 500 });

  return NextResponse.json({ ok: true, run: run.data });
}

