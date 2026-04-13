import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Markdown corpus deals (Invested Companies_.md seed) never ran the PDF scorer, so `deal_scores`
 * is empty and the spreadsheet shows "—". Insert clearly labeled placeholder dimensions so tabular
 * indexing aligns with the plan; replace by re-running the full pipeline on a real deck when ready.
 */
export async function upsertMarkdownCorpusPlaceholderScoresIfMissing(
  admin: SupabaseClient,
  dealId: string,
  analysisId: string,
  opts: { decision: string | null; source: string | null }
): Promise<void> {
  if (opts.source !== "invested-companies-md") return;

  const { count, error: cErr } = await admin
    .from("deal_scores")
    .select("id", { count: "exact", head: true })
    .eq("analysis_id", analysisId);
  if (cErr || (count ?? 0) > 0) return;

  const dec = (opts.decision ?? "").toLowerCase();
  const base =
    dec === "passed" || dec === "reject" ? 4.2 : dec === "invested" ? 6.8 : 5.5;
  const dims = ["thesis_fit", "founder", "traction", "problem", "solution"] as const;
  const rows = dims.map((dimension, i) => {
    const raw = Math.min(10, Math.max(0, base + (i - 2) * 0.12));
    return {
      deal_id: dealId,
      analysis_id: analysisId,
      dimension,
      raw_score: raw,
      weighted_score: raw,
      rubric_weight: 1,
      scoring_stage: "corpus_markdown_placeholder",
    };
  });

  const { error } = await admin.from("deal_scores").insert(rows);
  if (error) {
    console.warn("upsertMarkdownCorpusPlaceholderScoresIfMissing:", error.message);
  }
}
