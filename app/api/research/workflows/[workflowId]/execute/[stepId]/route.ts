import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser, getWorkflowForUser } from "@/lib/research/db";
import { executeResearchStep } from "@/lib/research/executor";
import { ingestStepOutputForRun, recomputeWorkflowStatus } from "@/lib/research/run-helpers";

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

  const allStepsRes = await admin
    .schema("deal_intel")
    .from("deal_research_step")
    .select("id, status, depends_on_step_ids")
    .eq("workflow_id", workflowId);
  if (allStepsRes.error) return NextResponse.json({ error: allStepsRes.error.message }, { status: 500 });
  const allSteps = allStepsRes.data ?? [];
  const doneIds = new Set(allSteps.filter((s) => s.status === "done").map((s) => s.id as string));
  const stepIds = new Set(allSteps.map((s) => s.id as string));
  const deps = Array.isArray(stepRes.data.depends_on_step_ids) ? stepRes.data.depends_on_step_ids : [];
  const missing = deps.filter((d) => !stepIds.has(d) || !doneIds.has(d));
  if (missing.length) {
    return NextResponse.json(
      { error: "Complete dependency steps before running this one.", pendingDependencyIds: missing },
      { status: 409 }
    );
  }

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

  const runIns = await admin
    .schema("deal_intel")
    .from("deal_research_step_run")
    .insert({
      workflow_id: workflowId,
      step_id: stepId,
      run_status: "running",
      output_notes: null,
      sources: [],
      metadata: { website: stepRes.data.website, task: stepRes.data.task },
    })
    .select("id, workflow_id, step_id, run_status, output_notes, sources, error_message, metadata, created_at")
    .single();
  if (runIns.error || !runIns.data) {
    return NextResponse.json({ error: runIns.error?.message ?? "Failed to create run row" }, { status: 500 });
  }
  const runId = runIns.data.id as string;

  await admin
    .schema("deal_intel")
    .from("deal_research_step")
    .update({ status: "running", updated_at: new Date().toISOString() })
    .eq("id", stepId)
    .eq("workflow_id", workflowId);

  let runRow: typeof runIns.data = runIns.data;

  try {
    const result = await executeResearchStep({
      companyName,
      companyContext,
      website: stepRes.data.website,
      task: stepRes.data.task,
    });

    if (result.ok) {
      const ingestedDocumentIds = await ingestStepOutputForRun({
        admin,
        userId: user.id,
        dealId: String(workflow.deal_id),
        workflowId,
        stepId,
        runId,
        website: stepRes.data.website,
        task: stepRes.data.task,
        notes: result.notes,
        sources: result.sources,
      });

      const upd = await admin
        .schema("deal_intel")
        .from("deal_research_step_run")
        .update({
          run_status: "done",
          output_notes: result.notes,
          sources: result.sources,
          error_message: null,
          metadata: {
            suggestedStepUpdates: result.suggestedStepUpdates,
            website: stepRes.data.website,
            task: stepRes.data.task,
            ingestedDocumentIds,
          },
        })
        .eq("id", runId)
        .select("id, workflow_id, step_id, run_status, output_notes, sources, error_message, metadata, created_at")
        .single();
      if (upd.error) throw new Error(upd.error.message);
      runRow = upd.data;

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
      if (stepUpd.error) throw new Error(stepUpd.error.message);
    } else {
      const upd = await admin
        .schema("deal_intel")
        .from("deal_research_step_run")
        .update({
          run_status: "failed",
          output_notes: null,
          sources: [],
          error_message: result.errorMessage,
          metadata: { website: stepRes.data.website, task: stepRes.data.task },
        })
        .eq("id", runId)
        .select("id, workflow_id, step_id, run_status, output_notes, sources, error_message, metadata, created_at")
        .single();
      if (!upd.error && upd.data) runRow = upd.data;

      await admin
        .schema("deal_intel")
        .from("deal_research_step")
        .update({ status: "failed", updated_at: new Date().toISOString() })
        .eq("id", stepId)
        .eq("workflow_id", workflowId);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await admin
      .schema("deal_intel")
      .from("deal_research_step_run")
      .update({
        run_status: "failed",
        error_message: message,
        output_notes: null,
        sources: [],
      })
      .eq("id", runId);
    await admin
      .schema("deal_intel")
      .from("deal_research_step")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("id", stepId)
      .eq("workflow_id", workflowId);
    runRow = { ...runRow, run_status: "failed", error_message: message };
  }

  await recomputeWorkflowStatus({ admin, workflowId, userId: user.id });

  return NextResponse.json({ ok: true, run: runRow });
}
