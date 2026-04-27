import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser, getWorkflowForUser } from "@/lib/research/db";
import { executeResearchStep } from "@/lib/research/executor";

function asCompanyName(meta: unknown): string {
  if (!meta || typeof meta !== "object") return "Company";
  const m = meta as Record<string, unknown>;
  return typeof m.company_name === "string" ? m.company_name : "Company";
}

export async function POST(_req: Request, ctx: { params: Promise<{ workflowId: string }> }) {
  const { workflowId } = await ctx.params;
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
    .order("position", { ascending: true });
  if (stepRes.error) return NextResponse.json({ error: stepRes.error.message }, { status: 500 });
  const steps = stepRes.data ?? [];
  const ready = steps.filter((s) => s.status === "todo" || s.status === "failed");
  if (!ready.length) return NextResponse.json({ ok: true, runs: [], message: "No ready steps to execute." });

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

  const runs: unknown[] = [];

  for (const step of ready.slice(0, 5)) {
    const result = await executeResearchStep({
      companyName,
      companyContext,
      website: step.website,
      task: step.task,
    });

    const run = await admin
      .schema("deal_intel")
      .from("deal_research_step_run")
      .insert({
        workflow_id: workflowId,
        step_id: step.id,
        run_status: "done",
        output_notes: result.notes,
        sources: result.sources,
        metadata: {
          suggestedStepUpdates: result.suggestedStepUpdates,
          website: step.website,
          task: step.task,
        },
      })
      .select("id, workflow_id, step_id, run_status, output_notes, sources, error_message, metadata, created_at")
      .single();
    if (run.error) return NextResponse.json({ error: run.error.message }, { status: 500 });
    runs.push(run.data);

    const stepUpdate = await admin
      .schema("deal_intel")
      .from("deal_research_step")
      .update({
        status: "done",
        notes: result.notes.slice(0, 5000),
      })
      .eq("id", step.id)
      .eq("workflow_id", workflowId);
    if (stepUpdate.error) return NextResponse.json({ error: stepUpdate.error.message }, { status: 500 });
  }

  const wfUpdate = await admin
    .schema("deal_intel")
    .from("deal_research_workflow")
    .update({
      status: "running",
      version: workflow.version + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", workflowId)
    .eq("user_id", user.id);
  if (wfUpdate.error) return NextResponse.json({ error: wfUpdate.error.message }, { status: 500 });

  return NextResponse.json({ ok: true, runs });
}

