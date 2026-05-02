import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/research/db";
import { loadCustomWorkflowDefinition, runCustomWorkflow } from "@/lib/custom-workflows";

export async function POST(req: Request, ctx: { params: Promise<{ workflowId: string }> }) {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { workflowId } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { dealId?: string | null; input?: string } | null;
  const dealId = typeof body?.dealId === "string" && body.dealId.trim() ? body.dealId.trim() : null;
  const input = typeof body?.input === "string" ? body.input.trim().slice(0, 4000) : "";
  const admin = createAdminClient();
  const workflow = await loadCustomWorkflowDefinition(admin, user.id, workflowId);
  if (!workflow) return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
  try {
    const result = await runCustomWorkflow({ admin, userId: user.id, workflow, dealId, input });
    return NextResponse.json({ result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Workflow run failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
