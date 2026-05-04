import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/research/db";
import { listCustomWorkflowRuns } from "@/lib/custom-workflows";

export async function GET(req: Request) {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? 40);
  const runs = await listCustomWorkflowRuns(createAdminClient(), user.id, Number.isFinite(limit) ? limit : 40);
  return NextResponse.json({ runs });
}
