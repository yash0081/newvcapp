import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/research/db";
import { cleanWorkflowSteps, listCustomWorkflowDefinitions } from "@/lib/custom-workflows";

export async function GET() {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workflows = await listCustomWorkflowDefinitions(createAdminClient(), user.id);
  return NextResponse.json({ workflows });
}

export async function POST(req: Request) {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as
    | { id?: string; name?: string; description?: string; triggerHint?: string; steps?: unknown }
    | null;
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 140) : "";
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  const steps = cleanWorkflowSteps(body?.steps);
  const row = {
    name,
    description: typeof body?.description === "string" ? body.description.trim().slice(0, 2000) : "",
    trigger_hint: typeof body?.triggerHint === "string" ? body.triggerHint.trim().slice(0, 1000) : "",
    steps,
  };
  const admin = createAdminClient();
  const existingId = typeof body?.id === "string" && body.id.trim() ? body.id.trim() : null;
  const res = existingId
    ? await admin
        .schema("deal_intel")
        .from("custom_workflow_definition")
        .update(row)
        .eq("id", existingId)
        .eq("user_id", user.id)
        .select("id")
        .single()
    : await admin
        .schema("deal_intel")
        .from("custom_workflow_definition")
        .insert({ ...row, user_id: user.id, metadata: {} })
        .select("id")
        .single();
  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
  const workflows = await listCustomWorkflowDefinitions(admin, user.id);
  const workflow = workflows.find((item) => item.id === String(res.data.id)) ?? null;
  return NextResponse.json({ id: res.data.id, workflow, workflows });
}
