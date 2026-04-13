import type { SupabaseClient } from "@supabase/supabase-js";
import {
  runDealSourcingPipeline,
  type DealSourcingResult,
  type PromptOutputStepName,
  type PromptRunInputContext,
} from "@/lib/deal-sourcing-pipeline";
import type { DealSourcingPipelineStep } from "@/lib/deal-sourcing-types";
import { persistDealAnalysis } from "@/lib/persist-deal";
import { afterPersistIndexDealEmbedding } from "@/lib/similar-deals";

export type { DealSourcingPipelineStep };
export { PIPELINE_STEP_META } from "@/lib/deal-sourcing-types";

/** @deprecated Use DealSourcingPipelineStep */
export type PipelineStepId = DealSourcingPipelineStep;

export type NdjsonProgressEvent =
  | { type: "step"; step: DealSourcingPipelineStep }
  | { type: "done"; dealId: string; analysisId: string }
  | { type: "error"; message: string };

/**
 * Run pipeline and persist deal + analysis once at the end (no placeholder / shell rows).
 * Intermediate prompt outputs are buffered and written to `deal_prompt_runs` after IDs exist.
 */
export async function runPipelineAndPersist(opts: {
  admin: SupabaseClient;
  userId: string;
  pdfBuffer: Buffer;
  pdfUrl?: string | null;
  fundThesisStatement: string | null;
  onStep?: (step: DealSourcingPipelineStep) => void | Promise<void>;
}): Promise<{ dealId: string; analysisId: string; result: DealSourcingResult }> {
  const { admin, userId, pdfBuffer, pdfUrl, fundThesisStatement, onStep } = opts;

  const promptOutputs: {
    stepName: PromptOutputStepName;
    output: unknown;
    inputContext?: PromptRunInputContext | null;
  }[] = [];

  const persistPromptOutput = async (
    stepName: PromptOutputStepName,
    output: unknown,
    inputContext?: PromptRunInputContext | null
  ) => {
    promptOutputs.push({ stepName, output, inputContext: inputContext ?? null });
  };

  const result = await runDealSourcingPipeline(
    pdfBuffer,
    fundThesisStatement,
    onStep,
    persistPromptOutput,
    { admin, userId, excludeDealId: null }
  );

  const persisted = await persistDealAnalysis({
    admin,
    userId,
    pdfUrl: pdfUrl ?? null,
    result,
  });

  if (!persisted) {
    throw new Error("Failed to persist analysis");
  }

  const { dealId, analysisId } = persisted;

  try {
    await afterPersistIndexDealEmbedding(admin, dealId);
  } catch (e) {
    console.warn("deal embedding index after persist:", e);
  }

  const insertPromptRun = async (args: {
    step_name: string;
    output_json: unknown;
    input_context?: Record<string, unknown> | null;
  }) => {
    const { error } = await admin.from("deal_prompt_runs").insert({
      deal_id: dealId,
      analysis_id: analysisId,
      step_name: args.step_name,
      model_name: null,
      model_tier: null,
      input_context: args.input_context ?? null,
      output_json: args.output_json,
      error_message: null,
    });
    if (error) {
      console.error("deal_prompt_runs insert failed:", args.step_name, error);
    }
  };

  for (const row of promptOutputs) {
    // Prompts V2-2: Founder A is one JSON per founder; Founder B is one collective JSON.
    // Expand into separate deal_prompt_runs rows (full bundle still lives in raw_output + deal_pipeline_json_founder_signals).
    if (row.stepName === "founder_signals") {
      const bundle = row.output as {
        per_founder?: unknown[];
        collective?: unknown;
      } | null;
      const per = Array.isArray(bundle?.per_founder) ? bundle.per_founder : [];
      for (let i = 0; i < per.length; i++) {
        const item = per[i] as Record<string, unknown>;
        const founderName =
          typeof item.founder_name === "string" && item.founder_name.trim()
            ? item.founder_name.trim()
            : `founder_${i}`;
        await insertPromptRun({
          step_name: "founder_signal_a",
          output_json: item,
          input_context: { founder_index: i, founder_name: founderName },
        });
      }
      if (bundle?.collective != null && typeof bundle.collective === "object") {
        await insertPromptRun({
          step_name: "founder_signal_b",
          output_json: bundle.collective,
        });
      }
      // Full `{ per_founder, collective }` is still in deal_analyses.raw_output and deal_pipeline_json_founder_signals
      continue;
    }

    await insertPromptRun({
      step_name: row.stepName,
      output_json: row.output,
      input_context: (row.inputContext as Record<string, unknown> | null | undefined) ?? null,
    });
  }

  return { dealId, analysisId, result };
}
