import type { SupabaseClient } from "@supabase/supabase-js";

export type PipelineStepName =
  | "phase1_parsing"
  | "phase2_thesis"
  | "founder_signals"
  | "traction_signals"
  | "phase3c_problem"
  | "phase3d_solution"
  | "phase4_assumptions"
  | "summary_founder"
  | "summary_traction"
  | "summary_problem"
  | "summary_solution"
  | "summary_assumptions"
  | "questions_first_order"
  | "questions_structural";

export async function runAndStorePrompt<T>(opts: {
  admin: SupabaseClient;
  dealId: string;
  analysisId: string;
  stepName: PipelineStepName;
  modelName?: string | null;
  modelTier?: string | null;
  inputContext?: unknown;
  run: () => Promise<T>;
}): Promise<T> {
  const { admin, dealId, analysisId, stepName, modelName, modelTier, inputContext, run } = opts;

  try {
    const output = await run();

    await admin.from("deal_prompt_runs").insert({
      deal_id: dealId,
      analysis_id: analysisId,
      step_name: stepName,
      model_name: modelName ?? null,
      model_tier: modelTier ?? null,
      input_context: inputContext ?? null,
      output_json: output as unknown,
      error_message: null,
    });

    return output;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    await admin.from("deal_prompt_runs").insert({
      deal_id: dealId,
      analysis_id: analysisId,
      step_name: stepName,
      model_name: null,
      model_tier: null,
      input_context: inputContext ?? null,
      output_json: null,
      error_message: message,
    });

    throw err;
  }
}

