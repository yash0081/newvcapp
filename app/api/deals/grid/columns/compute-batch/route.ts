import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  computePendingExpensiveFeatureValues,
  ensurePendingFeatureValue,
} from "@/lib/compute-expensive-feature-values";

/**
 * Run LLM fill for pending expensive inferred_llm columns (plan A5 backfill).
 * Optionally queue deals as pending first (visible rows).
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    featureId?: string;
    dealIds?: string[];
    maxDeals?: number;
    queueDealIds?: string[];
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const maxDeals = Math.min(40, Math.max(1, Number(body.maxDeals) || 15));
  const admin = createAdminClient();

  if (body.featureId && body.queueDealIds?.length) {
    const { data: def } = await admin
      .from("deal_feature_definitions")
      .select("id")
      .eq("user_id", user.id)
      .eq("id", body.featureId)
      .eq("compute_tier", "expensive")
      .eq("origin", "inferred_llm")
      .maybeSingle();
    if (!def) {
      return NextResponse.json({ error: "Feature not found or not expensive inferred" }, { status: 400 });
    }
    const { data: owned } = await admin
      .from("deals")
      .select("id")
      .eq("user_id", user.id)
      .in("id", body.queueDealIds.slice(0, 500));
    for (const r of owned ?? []) {
      await ensurePendingFeatureValue(admin, r.id as string, body.featureId);
    }
  }

  const model =
    process.env.GEMINI_MODEL_FLASH_SUMMARY ||
    process.env.GEMINI_MODEL_FLASH_LITE ||
    "gemini-2.5-flash-lite";

  const result = await computePendingExpensiveFeatureValues(admin, {
    userId: user.id,
    featureId: body.featureId,
    dealIds: body.dealIds,
    maxDeals,
    model,
  });

  return NextResponse.json(result);
}
