import type { SupabaseClient } from "@supabase/supabase-js";
import type { ResearchSource } from "@/lib/research/types";
import { ingestResearchStepOutputAsDocument } from "@/lib/research/step-output-ingest";

export async function ingestStepOutputForRun(args: {
  admin: SupabaseClient;
  userId: string;
  dealId: string;
  workflowId: string;
  stepId: string;
  runId: string;
  website: string;
  task: string;
  notes: string;
  sources: ResearchSource[];
}): Promise<string[]> {
  try {
    const doc = await ingestResearchStepOutputAsDocument({
      admin: args.admin,
      userId: args.userId,
      dealId: args.dealId,
      workflowId: args.workflowId,
      stepId: args.stepId,
      runId: args.runId,
      website: args.website,
      task: args.task,
      notes: args.notes,
      sources: args.sources,
    });
    return doc?.documentId ? [doc.documentId] : [];
  } catch {
    return [];
  }
}

export async function recomputeWorkflowStatus(args: {
  admin: SupabaseClient;
  workflowId: string;
  userId: string;
}): Promise<"draft" | "ready" | "running" | "done" | "archived"> {
  const stepsRes = await args.admin
    .schema("deal_intel")
    .from("deal_research_step")
    .select("status")
    .eq("workflow_id", args.workflowId);
  const rows = ((stepsRes.data ?? []) as Array<{ status: string }>);
  const anyRunning = rows.some((s) => s.status === "running" || s.status === "queued");
  const allDone = rows.length > 0 && rows.every((s) => s.status === "done");
  const status: "ready" | "running" | "done" = anyRunning ? "running" : allDone ? "done" : "ready";

  await args.admin
    .schema("deal_intel")
    .from("deal_research_workflow")
    .update({
      status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.workflowId)
    .eq("user_id", args.userId);

  return status;
}
