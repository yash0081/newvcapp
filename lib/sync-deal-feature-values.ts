import type { SupabaseClient } from "@supabase/supabase-js";
import type { DealSourcingResult } from "@/lib/deal-sourcing-pipeline";
import { recordDealFeatureProvenance } from "@/lib/deal-feature-provenance";

type ScoreKey = {
  key: string;
  label: string;
  value: number | null | undefined;
};

/**
 * Tabular grid: upsert pipeline scores into deal_feature_definitions + deal_feature_values (plan A5).
 */
export async function syncPipelineScoresToFeatureGrid(
  admin: SupabaseClient,
  userId: string,
  dealId: string,
  result: DealSourcingResult
): Promise<void> {
  const scores: ScoreKey[] = [
    { key: "pipeline_score_thesis_fit", label: "Thesis fit (pipeline)", value: result.thesis_fit_score },
    { key: "pipeline_score_founder", label: "Founder (pipeline)", value: result.founder_signal_score },
    { key: "pipeline_score_traction", label: "Traction (pipeline)", value: result.traction_signal_score },
    { key: "pipeline_score_problem", label: "Problem (pipeline)", value: result.problem_quality_score },
    { key: "pipeline_score_solution", label: "Solution (pipeline)", value: result.solution_defensibility_score },
  ];

  for (const s of scores) {
    if (s.value == null || Number.isNaN(Number(s.value))) continue;

    let featureId: string | null = null;
    const { data: existing } = await admin
      .from("deal_feature_definitions")
      .select("id")
      .eq("user_id", userId)
      .eq("key", s.key)
      .maybeSingle();

    if (existing?.id) {
      featureId = existing.id as string;
    } else {
      const { data: ins, error } = await admin
        .from("deal_feature_definitions")
        .insert({
          user_id: userId,
          key: s.key,
          label: s.label,
          data_type: "number",
          origin: "pipeline",
          compute_tier: "cheap",
        })
        .select("id")
        .single();
      if (error || !ins) {
        console.warn("syncPipelineScoresToFeatureGrid: def insert", s.key, error);
        continue;
      }
      featureId = ins.id as string;
    }

    const { error: vErr } = await admin.from("deal_feature_values").upsert(
      {
        deal_id: dealId,
        feature_id: featureId,
        value_jsonb: Number(s.value),
        status: "done",
        cache_key: `pipeline:${dealId}:${s.key}`,
        computed_at: new Date().toISOString(),
      },
      { onConflict: "deal_id,feature_id" }
    );
    if (vErr) {
      console.warn("syncPipelineScoresToFeatureGrid: value", s.key, vErr);
      continue;
    }
    await recordDealFeatureProvenance(admin, {
      feature_id: featureId,
      deal_id: dealId,
      note: `pipeline_score:${s.key}`,
    });
  }
}
