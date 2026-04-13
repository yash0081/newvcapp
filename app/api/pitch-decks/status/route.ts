import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const STEP_ORDER = [
  "parse",
  "thesis",
  "founder",
  "traction",
  "problem",
  "solution",
  "assumptions_questions",
  "summaries",
] as const;

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const analysisId = url.searchParams.get("analysisId");

  if (!analysisId) {
    return NextResponse.json({ error: "Missing analysisId" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: statusRow, error: statusError } = await supabase
    .from("analysis_status")
    .select("status, current_step, analysis_id")
    .eq("analysis_id", analysisId)
    .maybeSingle();

  if (statusError || !statusRow) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { data: analysisRow } = await supabase
    .from("deal_analyses")
    .select("deal_id")
    .eq("id", analysisId)
    .maybeSingle();

  const dealId = (analysisRow as { deal_id?: string } | null)?.deal_id ?? null;

  return NextResponse.json({
    status: (statusRow as { status: string }).status,
    currentStep: ((statusRow as { current_step: string | null }).current_step) ?? null,
    steps: STEP_ORDER,
    dealId,
  });
}

