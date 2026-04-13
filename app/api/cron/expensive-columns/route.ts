import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { computePendingExpensiveFeatureValues } from "@/lib/compute-expensive-feature-values";

/**
 * Vercel Cron / external scheduler: process pending expensive feature values across all users.
 * Secured with CRON_SECRET header (or query) matching env.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  const hdr = request.headers.get("authorization");
  const q = request.nextUrl.searchParams.get("secret");
  const ok =
    hdr === `Bearer ${secret}` || hdr === secret || q === secret;
  if (!ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const maxPerUser = Math.min(25, Math.max(1, Number(request.nextUrl.searchParams.get("max")) || 8));

  const { data: users, error } = await admin
    .from("deal_feature_definitions")
    .select("user_id")
    .eq("compute_tier", "expensive")
    .eq("origin", "inferred_llm");
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const userIds = [...new Set((users ?? []).map((u) => u.user_id as string))];
  const model =
    process.env.GEMINI_MODEL_FLASH_SUMMARY ||
    process.env.GEMINI_MODEL_FLASH_LITE ||
    "gemini-2.5-flash-lite";

  let processed = 0;
  let errors = 0;
  for (const userId of userIds) {
    const r = await computePendingExpensiveFeatureValues(admin, {
      userId,
      maxDeals: maxPerUser,
      model,
    });
    processed += r.processed;
    errors += r.errors;
  }

  return NextResponse.json({ users: userIds.length, processed, errors });
}
