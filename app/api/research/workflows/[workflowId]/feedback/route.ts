import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser, getWorkflowForUser } from "@/lib/research/db";
import { recordResearchPreferenceEvents } from "@/lib/research/preferences";

function isPreferenceSource(website: string): boolean {
  const s = website.trim().toLowerCase();
  return Boolean(s) && s !== "web" && s !== "broad-web" && s !== "general-web";
}

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

  // Best-effort preference updates from explicit accept/reject actions.
  // Payload shape is controlled by UI: { accepted?: SuggestedUpdate[], rejected?: SuggestedUpdate[] }
  try {
    const payload = (body?.payload && typeof body.payload === "object" ? body.payload : {}) as Record<string, unknown>;
    const accepted = Array.isArray(payload.accepted) ? (payload.accepted as Array<Record<string, unknown>>) : [];
    const rejected = Array.isArray(payload.rejected) ? (payload.rejected as Array<Record<string, unknown>>) : [];
    const mk = (x: Record<string, unknown>, sign: 1 | -1) => ({
      domain: typeof x.website === "string" ? x.website : "",
      category: "general",
      deltaPreferenceScore: sign * 0.12,
      deltaUsageCount: sign === 1 ? 1 : 0,
      reason: sign === 1 ? "User accepted a suggested research step." : "User rejected a suggested research step.",
      task: typeof x.task === "string" ? x.task : "",
    });

    const events = [...accepted.map((x) => mk(x, 1)), ...rejected.map((x) => mk(x, -1))]
      .filter((e) => e.domain && e.task && isPreferenceSource(e.domain));
    if (events.length) {
      await recordResearchPreferenceEvents({
        admin,
        userId: user.id,
        dealId: String(workflow.deal_id),
        events,
      });
    }
  } catch {
    // ignore
  }

  return NextResponse.json({ feedback: ins.data });
}
