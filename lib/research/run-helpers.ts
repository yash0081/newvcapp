import type { SupabaseClient } from "@supabase/supabase-js";
import { ingestWebSourceAsDocument } from "@/lib/research/web-ingest";
import type { ResearchSource } from "@/lib/research/types";

const MULTI_INGEST_LIMIT = Math.max(1, Math.min(5, Number(process.env.RESEARCH_INGEST_PER_RUN_LIMIT || 3)));
const MULTI_INGEST_BUDGET_MS = Math.max(2000, Math.min(20000, Number(process.env.RESEARCH_INGEST_BUDGET_MS || 9000)));
const PER_SOURCE_TIMEOUT_MS = Math.max(1000, Math.min(15000, Number(process.env.RESEARCH_INGEST_PER_SOURCE_TIMEOUT_MS || 5000)));

function uniqueByHostname(sources: ResearchSource[]): ResearchSource[] {
  const seen = new Set<string>();
  const out: ResearchSource[] = [];
  for (const s of sources) {
    if (!s?.url) continue;
    let host = "";
    try {
      host = new URL(s.url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push(s);
  }
  return out;
}

export async function ingestSourcesForRun(args: {
  admin: SupabaseClient;
  userId: string;
  dealId: string;
  workflowId: string;
  stepId: string;
  sources: ResearchSource[];
}): Promise<string[]> {
  const candidates = uniqueByHostname(args.sources).slice(0, MULTI_INGEST_LIMIT);
  if (candidates.length === 0) return [];

  const ingested: string[] = [];
  const startedAt = Date.now();
  for (const s of candidates) {
    if (Date.now() - startedAt > MULTI_INGEST_BUDGET_MS) break;
    try {
      const doc = await ingestWebSourceAsDocument({
        admin: args.admin,
        userId: args.userId,
        dealId: args.dealId,
        sourceUrl: s.url,
        title: s.title,
        workflowId: args.workflowId,
        stepId: args.stepId,
        timeoutMs: PER_SOURCE_TIMEOUT_MS,
      });
      if (doc?.documentId) ingested.push(doc.documentId);
    } catch {
      // best-effort; skip failures
    }
  }
  return ingested;
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
