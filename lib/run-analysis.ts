import type { SupabaseClient } from "@supabase/supabase-js";
import { runDealSourcingPipeline, type PromptOutputStepName } from "@/lib/deal-sourcing-pipeline";
import { persistDealAnalysis } from "@/lib/persist-deal";

export type PipelineStepId =
  | "parse"
  | "thesis"
  | "founder"
  | "traction"
  | "problem"
  | "solution"
  | "assumptions_questions";

const PLACEHOLDER_NAME = "Analyzing…";

/** Create one analysis run (deal + analysis + status) so we have an ID to track progress; pipeline runs in background and updates status when each prompt returns. */
export async function createAnalysisShell(opts: {
  admin: SupabaseClient;
  userId: string;
  pdfUrl?: string | null;
}): Promise<{
  dealId: string;
  analysisId: string;
  updateStatus: (step: PipelineStepId) => Promise<void>;
}> {
  const { admin, userId, pdfUrl } = opts;

  const { data: dealRow, error: dealError } = await admin
    .from("deals")
    .insert({
      user_id: userId,
      company_name: PLACEHOLDER_NAME,
      website: null,
      sector: null,
      stage: null,
      business_model: null,
      geography: null,
      deck_url: pdfUrl ?? null,
    })
    .select("id")
    .single();

  if (dealError || !dealRow) {
    throw dealError ?? new Error("Failed to create deal");
  }

  const dealId = dealRow.id as string;

  const { data: analysisRow, error: analysisError } = await admin
    .from("deal_analyses")
    .insert({
      deal_id: dealId,
      pipeline_version: 2,
    })
    .select("id")
    .single();

  if (analysisError || !analysisRow) {
    throw analysisError ?? new Error("Failed to create deal_analyses row");
  }

  const analysisId = analysisRow.id as string;

  await admin.from("analysis_status").insert({
    analysis_id: analysisId,
    status: "running",
    current_step: null,
  });

  const updateStatus = async (step: PipelineStepId) => {
    await admin
      .from("analysis_status")
      .update({
        current_step: step,
        status: "running",
        updated_at: new Date().toISOString(),
      })
      .eq("analysis_id", analysisId);
  };

  return { dealId, analysisId, updateStatus };
}

/** Run the pipeline and persist into the same deal/analysis. Calls updateStatus(step) after each prompt returns so the UI can show that step green. */
export async function runPipelineAndPersist(opts: {
  admin: SupabaseClient;
  userId: string;
  dealId: string;
  analysisId: string;
  pdfBuffer: Buffer;
  pdfUrl?: string | null;
  fundThesisStatement: string | null;
  updateStatus: (step: PipelineStepId) => Promise<void>;
}): Promise<void> {
  const { admin, userId, dealId, analysisId, pdfBuffer, pdfUrl, fundThesisStatement, updateStatus } = opts;

  try {
    const persistPromptOutput = async (stepName: PromptOutputStepName, output: unknown) => {
      await admin.from("deal_prompt_runs").insert({
        deal_id: dealId,
        analysis_id: analysisId,
        step_name: stepName,
        model_name: null,
        model_tier: null,
        input_context: null,
        output_json: output,
        error_message: null,
      });
    };

    const result = await runDealSourcingPipeline(
      pdfBuffer,
      fundThesisStatement,
      updateStatus,
      persistPromptOutput
    );

    await persistDealAnalysis({
      admin,
      userId,
      pdfUrl: pdfUrl ?? null,
      result,
      existingDealId: dealId,
      existingAnalysisId: analysisId,
    });

    await admin
      .from("analysis_status")
      .update({
        status: "succeeded",
        updated_at: new Date().toISOString(),
      })
      .eq("analysis_id", analysisId);
  } catch (err) {
    console.error("Background analysis failed:", err);
    await admin
      .from("analysis_status")
      .update({
        status: "failed",
        updated_at: new Date().toISOString(),
      })
      .eq("analysis_id", analysisId);
    throw err;
  }
}

