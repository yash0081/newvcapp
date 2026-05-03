import type { SupabaseClient } from "@supabase/supabase-js";
import { vertexRunWithText } from "@/lib/vertex";
import { recordDealFeatureProvenance } from "@/lib/deal-feature-provenance";

async function briefDealContext(admin: SupabaseClient, dealId: string): Promise<string> {
  const { data: deal } = await admin
    .from("deals")
    .select("company_name, stage, sector")
    .eq("id", dealId)
    .maybeSingle();
  const header = [
    deal?.company_name ? `Company: ${deal.company_name}` : "",
    deal?.stage ? `Stage: ${deal.stage}` : "",
    deal?.sector ? `Sector: ${deal.sector}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const { data: nodes } = await admin
    .from("deal_context_nodes")
    .select("node_type, raw_text")
    .eq("deal_id", dealId)
    .order("depth", { ascending: true })
    .limit(24);

  const body = (nodes ?? [])
    .map((n) => {
      const txt = typeof n.raw_text === "string" ? n.raw_text.trim() : "";
      if (!txt) return "";
      return `[${n.node_type}] ${txt.slice(0, 600)}`;
    })
    .filter(Boolean)
    .join("\n\n");

  return `${header}\n\n${body}`.slice(0, 12_000);
}

function parseLlmJsonValue(raw: string, dataType: string): unknown {
  const t = raw.trim();
  let obj: { value?: unknown };
  try {
    obj = JSON.parse(t) as { value?: unknown };
  } catch {
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("no_json");
    obj = JSON.parse(m[0]) as { value?: unknown };
  }
  if (!("value" in obj)) throw new Error("no_value_key");
  const v = obj.value;
  if (dataType === "number" && typeof v === "string") return Number(v);
  return v;
}

export type ComputeExpensiveResult = { processed: number; errors: number };

/**
 * Fills pending expensive inferred_llm feature values using column prompt + deal context nodes.
 */
export async function computePendingExpensiveFeatureValues(
  admin: SupabaseClient,
  opts: {
    userId: string;
    featureId?: string;
    dealIds?: string[];
    maxDeals: number;
    model: string;
  }
): Promise<ComputeExpensiveResult> {
  let defQuery = admin
    .from("deal_feature_definitions")
    .select("id, data_type, formula_or_prompt_ref")
    .eq("user_id", opts.userId)
    .eq("compute_tier", "expensive")
    .eq("origin", "inferred_llm");

  if (opts.featureId) defQuery = defQuery.eq("id", opts.featureId);

  const { data: defs, error: defErr } = await defQuery;
  if (defErr || !defs?.length) return { processed: 0, errors: 0 };

  const featureIds = defs.map((d) => d.id as string);
  const defById = new Map(defs.map((d) => [d.id as string, d]));

  let vq = admin
    .from("deal_feature_values")
    .select("id, deal_id, feature_id")
    .eq("status", "pending")
    .in("feature_id", featureIds)
    .limit(opts.maxDeals);

  if (opts.dealIds?.length) vq = vq.in("deal_id", opts.dealIds.slice(0, 500));

  const { data: rows, error: rowErr } = await vq;
  if (rowErr || !rows?.length) return { processed: 0, errors: 0 };

  let processed = 0;
  let errors = 0;

  for (const row of rows) {
    const featureId = row.feature_id as string;
    const def = defById.get(featureId) as
      | { id: string; data_type: string; formula_or_prompt_ref: string | null }
      | undefined;
    if (!def) continue;

    const promptRef = def.formula_or_prompt_ref?.trim();
    if (!promptRef) {
      errors++;
      continue;
    }

    const dealId = row.deal_id as string;
    const brief = await briefDealContext(admin, dealId);

    const userPrompt = `Column extraction task.
Instruction: ${promptRef}
Data type for "value" field: ${def.data_type}

Deal context:
${brief}

Respond with a single JSON object only, no formatting fences: {"value": ...}`;

    try {
      const raw = await vertexRunWithText(opts.model, userPrompt, false);
      const value = parseLlmJsonValue(raw, def.data_type);
      await admin
        .from("deal_feature_values")
        .update({
          value_jsonb: value as object,
          status: "done",
          error_message: null,
          computed_at: new Date().toISOString(),
          cache_key: `llm:${featureId}:${dealId}`,
        })
        .eq("id", row.id as string);

      await recordDealFeatureProvenance(admin, {
        feature_id: featureId,
        deal_id: dealId,
        note: "expensive_inferred_llm_batch",
      });
      processed++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await admin
        .from("deal_feature_values")
        .update({
          status: "error",
          error_message: msg.slice(0, 500),
          computed_at: new Date().toISOString(),
        })
        .eq("id", row.id as string);
      errors++;
    }
  }

  return { processed, errors };
}

/**
 * Ensure a value row exists (pending) for expensive inferred columns so batch/cron can pick it up.
 * Does not downgrade rows already marked done.
 */
export async function ensurePendingFeatureValue(
  admin: SupabaseClient,
  dealId: string,
  featureId: string
): Promise<void> {
  const { data: ex } = await admin
    .from("deal_feature_values")
    .select("id, status")
    .eq("deal_id", dealId)
    .eq("feature_id", featureId)
    .maybeSingle();

  if (!ex) {
    await admin.from("deal_feature_values").insert({
      deal_id: dealId,
      feature_id: featureId,
      status: "pending",
      computed_at: new Date().toISOString(),
    });
    return;
  }
  if (ex.status === "error") {
    await admin
      .from("deal_feature_values")
      .update({ status: "pending", error_message: null, computed_at: new Date().toISOString() })
      .eq("id", ex.id as string);
  }
}
