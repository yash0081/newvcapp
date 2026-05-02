import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser, getWorkflowForUser } from "@/lib/research/db";
import { executeResearchStep } from "@/lib/research/executor";
import { mapWithConcurrency } from "@/lib/async/concurrency";
import { ingestStepOutputForRun, recomputeWorkflowStatus } from "@/lib/research/run-helpers";
import { recordResearchPreferenceEvents } from "@/lib/research/preferences";

function asCompanyName(meta: unknown): string {
  if (!meta || typeof meta !== "object") return "Company";
  const m = meta as Record<string, unknown>;
  return typeof m.company_name === "string" ? m.company_name : "Company";
}

type StepRow = {
  id: string;
  workflow_id: string;
  position: number;
  status: string;
  website: string;
  task: string;
  depends_on_step_ids: string[] | null;
  metadata?: Record<string, unknown> | null;
};

function categoryForStep(step: StepRow): string {
  const meta = step.metadata && typeof step.metadata === "object" ? step.metadata : {};
  return typeof meta.category === "string" && meta.category ? meta.category : "general";
}

function isPreferenceSource(website: string): boolean {
  const s = website.trim().toLowerCase();
  return Boolean(s) && s !== "web" && s !== "broad-web" && s !== "general-web";
}

function runnableSteps(steps: StepRow[], maxBatch: number): StepRow[] {
  const stepIds = new Set(steps.map((s) => s.id));
  const doneIds = new Set(steps.filter((s) => s.status === "done").map((s) => s.id));

  const depsOk = (s: StepRow) => {
    const deps = Array.isArray(s.depends_on_step_ids) ? s.depends_on_step_ids : [];
    return deps.every((d) => stepIds.has(d) && doneIds.has(d));
  };

  return steps
    .filter((s) => (s.status === "todo" || s.status === "failed") && depsOk(s))
    .sort((a, b) => a.position - b.position)
    .slice(0, maxBatch);
}

type AdminClient = ReturnType<typeof createAdminClient>;

async function runOneStep(args: {
  admin: AdminClient;
  userId: string;
  workflowId: string;
  dealId: string;
  step: StepRow;
  companyName: string;
  companyContext: string;
}) {
  const { admin, userId, workflowId, dealId, step, companyName, companyContext } = args;

  // Mark running.
  const runIns = await admin
    .schema("deal_intel")
    .from("deal_research_step_run")
    .insert({
      workflow_id: workflowId,
      step_id: step.id,
      run_status: "running",
      output_notes: null,
      sources: [],
      metadata: { website: step.website, task: step.task },
    })
    .select("id, workflow_id, step_id, run_status, output_notes, sources, error_message, metadata, created_at")
    .single();
  if (runIns.error || !runIns.data) {
    throw new Error(runIns.error?.message ?? "Failed to create run row");
  }
  const runId = runIns.data.id as string;

  await admin
    .schema("deal_intel")
    .from("deal_research_step")
    .update({ status: "running", updated_at: new Date().toISOString() })
    .eq("id", step.id)
    .eq("workflow_id", workflowId);

  let runRow: typeof runIns.data = runIns.data;

  try {
    const result = await executeResearchStep({
      companyName,
      companyContext,
      website: step.website,
      task: step.task,
    });

    if (result.ok) {
      const ingestedDocumentIds = await ingestStepOutputForRun({
        admin,
        userId,
        dealId,
        workflowId,
        stepId: step.id,
        runId,
        website: step.website,
        task: step.task,
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
            website: step.website,
            task: step.task,
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
        .eq("id", step.id)
        .eq("workflow_id", workflowId);
      if (stepUpd.error) throw new Error(stepUpd.error.message);

      if (isPreferenceSource(step.website)) {
        try {
          await recordResearchPreferenceEvents({
            admin,
            userId,
            dealId,
            events: [
              {
                domain: step.website,
                category: categoryForStep(step),
                deltaPreferenceScore: 0.1,
                deltaUsageCount: 1,
                reason: "Research planner step executed successfully.",
                task: step.task,
              },
            ],
          });
        } catch {
          // ignore preference learning failures
        }
      }
    } else {
      const upd = await admin
        .schema("deal_intel")
        .from("deal_research_step_run")
        .update({
          run_status: "failed",
          output_notes: null,
          sources: [],
          error_message: result.errorMessage,
          metadata: { website: step.website, task: step.task },
        })
        .eq("id", runId)
        .select("id, workflow_id, step_id, run_status, output_notes, sources, error_message, metadata, created_at")
        .single();
      if (!upd.error && upd.data) runRow = upd.data;

      await admin
        .schema("deal_intel")
        .from("deal_research_step")
        .update({ status: "failed", updated_at: new Date().toISOString() })
        .eq("id", step.id)
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
      .eq("id", step.id)
      .eq("workflow_id", workflowId);
    runRow = { ...runRow, run_status: "failed", error_message: message };
  }

  return runRow;
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
    .select("id, workflow_id, position, status, website, task, depends_on_step_ids, metadata")
    .eq("workflow_id", workflowId)
    .order("position", { ascending: true });
  if (stepRes.error) return NextResponse.json({ error: stepRes.error.message }, { status: 500 });
  const steps = (stepRes.data ?? []) as StepRow[];

  const maxBatch = Math.max(1, Math.min(20, Number(process.env.RESEARCH_EXECUTE_MAX_BATCH || 8)));
  const concurrency = Math.max(1, Math.min(8, Number(process.env.RESEARCH_EXECUTE_CONCURRENCY || 4)));

  const toRun = runnableSteps(steps, maxBatch);
  if (!toRun.length) return NextResponse.json({ ok: true, runs: [], message: "No ready steps to execute." });

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

  const runs = await mapWithConcurrency(toRun, concurrency, (step) =>
    runOneStep({
      admin,
      userId: user.id,
      workflowId,
      dealId: String(workflow.deal_id),
      step,
      companyName,
      companyContext,
    })
  );

  await recomputeWorkflowStatus({ admin, workflowId, userId: user.id });

  return NextResponse.json({ ok: true, runs });
}
