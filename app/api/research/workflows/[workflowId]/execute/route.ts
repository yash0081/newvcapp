import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser, getWorkflowForUser } from "@/lib/research/db";
import { executeResearchStep } from "@/lib/research/executor";
import { mapWithConcurrency } from "@/lib/async/concurrency";
import { ingestWebSourceAsDocument } from "@/lib/research/web-ingest";

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
};

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

  const executed = await mapWithConcurrency(toRun, concurrency, async (step) => {
    const result = await executeResearchStep({
      companyName,
      companyContext,
      website: step.website,
      task: step.task,
    });
    return { step, result };
  });

  const runs: unknown[] = [];

  for (const { step, result } of executed) {
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

    // Persist the first cited URL into `deal_intel.document_*` (fast path). Keeps UX snappy.
    const ingested: string[] = [];
    const first = Array.isArray(result.sources) ? result.sources[0] : null;
    if (first?.url) {
      try {
        const doc = await ingestWebSourceAsDocument({
          admin,
          userId: user.id,
          dealId: String(workflow.deal_id),
          sourceUrl: first.url,
          title: first.title,
          workflowId,
          stepId: step.id,
          timeoutMs: 6000,
        });
        if (doc?.documentId) ingested.push(doc.documentId);
      } catch {
        // ignore
      }
    }
    if (ingested.length) {
      await admin
        .schema("deal_intel")
        .from("deal_research_step_run")
        .update({
          metadata: {
            ...(run.data?.metadata && typeof run.data.metadata === "object" ? run.data.metadata : {}),
            ingestedDocumentIds: ingested,
          },
        })
        .eq("id", run.data.id);
    }

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
