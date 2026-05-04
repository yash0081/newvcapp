import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/research/db";
import { listCustomWorkflowDefinitions } from "@/lib/custom-workflows";

export async function DELETE(_req: Request, ctx: { params: Promise<{ workflowId: string }> }) {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { workflowId } = await ctx.params;
  const admin = createAdminClient();
  const res = await admin
    .schema("deal_intel")
    .from("custom_workflow_definition")
    .delete()
    .eq("id", workflowId)
    .eq("user_id", user.id);
  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
  const workflows = await listCustomWorkflowDefinitions(admin, user.id);
  return NextResponse.json({ workflows });
}
