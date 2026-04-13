import type { ChatTask } from "@/lib/retrieval-orchestrator";

/**
 * Deterministic planner summary (plan B6) — avoids a second LLM round for routing.
 */
export function buildChatPlanSummary(args: {
  task: ChatTask;
  tabularDealCount: number | null;
  retrievedChunkCount: number;
}): string {
  const tab =
    args.tabularDealCount == null
      ? "tabular prefilter not applied"
      : `${args.tabularDealCount} deal(s) after stage/sector/decision/name match`;
  return `Task ${args.task}; ${tab}; hybrid FTS+vector retrieval → ${args.retrievedChunkCount} context chunk(s) for the answer.`;
}
