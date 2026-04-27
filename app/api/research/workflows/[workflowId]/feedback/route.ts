import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser, getWorkflowForUser } from "@/lib/research/db";

export async function POST(req: Request, ctx: { params: Promise<{ workflowId: string }> }) {
  const { workflowId } = await ctx.params;
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | {
        action?: "accept_update" | "reject_update" | "manual_edit";
        rationale?: string;
        payload?: Record<string, unknown>;
      }
    | null;
  const action = body?.action;
  if (!action) return NextResponse.json({ error: "action is required" }, { status: 400 });

  const { data: workflow, error: wfErr } = await getWorkflowForUser(workflowId, user.id);
  if (wfErr) return NextResponse.json({ error: wfErr.message }, { status: 500 });
  if (!workflow) return NextResponse.json({ error: "Workflow not found" }, { status: 404 });

  const admin = createAdminClient();
  const ins = await admin
    .schema("deal_intel")
    .from("deal_research_feedback")
    .insert({
      workflow_id: workflowId,
      user_id: user.id,
      action,
      rationale: body?.rationale ?? null,
      payload: body?.payload ?? {},
    })
    .select("id, workflow_id, user_id, action, rationale, payload, created_at")
    .single();
  if (ins.error) return NextResponse.json({ error: ins.error.message }, { status: 500 });

  return NextResponse.json({ feedback: ins.data });
}

