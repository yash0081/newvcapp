import type { SupabaseClient } from "@supabase/supabase-js";

export async function recordDealFeatureProvenance(
  admin: SupabaseClient,
  row: {
    feature_id: string;
    deal_id: string;
    node_id?: string | null;
    prompt_run_id?: string | null;
    note: string;
  }
): Promise<void> {
  const { error } = await admin.from("deal_feature_provenance").insert({
    feature_id: row.feature_id,
    deal_id: row.deal_id,
    node_id: row.node_id ?? null,
    prompt_run_id: row.prompt_run_id ?? null,
    note: row.note,
  });
  if (error) console.warn("recordDealFeatureProvenance:", error.message);
}
