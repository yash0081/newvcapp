import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser, getWorkflowForUser } from "@/lib/research/db";
import { recordResearchPreferenceEvents } from "@/lib/research/preferences";

type StepPatch = {
  id?: string;
  position: number;
  website: string;
  task: string;
  status?: "todo" | "blocked" | "queued" | "running" | "done" | "failed";
  notes?: string | null;
  dependsOnStepIds?: string[];
  metadata?: Record<string, unknown>;
};

function isPreferenceSource(website: string): boolean {
  const s = website.trim().toLowerCase();
  return Boolean(s) && s !== "web" && s !== "broad-web" && s !== "general-web";
}

export async function PATCH(req: Request, ctx: { params: Promise<{ workflowId: string }> }) {
  const { workflowId } = await ctx.params;
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { expectedVersion?: number; steps?: StepPatch[] }
    | null;
  const expectedVersion = typeof body?.expectedVersion === "number" ? body.expectedVersion : null;
  const steps = Array.isArray(body?.steps) ? body.steps : null;
  if (expectedVersion == null || !steps) {
    return NextResponse.json({ error: "expectedVersion and steps are required" }, { status: 400 });
  }

  const { data: workflow, error: wfErr } = await getWorkflowForUser(workflowId, user.id);
  if (wfErr) return NextResponse.json({ error: wfErr.message }, { status: 500 });
  if (!workflow) return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
  if (workflow.version !== expectedVersion) {
    return NextResponse.json(
      { error: "Version conflict. Reload workflow and retry.", currentVersion: workflow.version },
      { status: 409 }
    );
  }

  const normalized = steps
    .filter((s) => typeof s.website === "string" && s.website.trim() && typeof s.task === "string" && s.task.trim())
    .sort((a, b) => a.position - b.position)
    .map((s, idx) => ({
      workflow_id: workflowId,
      position: idx,
      status: s.status ?? "todo",
      website: s.website.trim(),
      task: s.task.trim(),
      notes: s.notes ?? null,
      depends_on_step_ids: Array.isArray(s.dependsOnStepIds) ? s.dependsOnStepIds : [],
      metadata: s.metadata ?? {},
    }));

  const admin = createAdminClient();

  // Preference learning: detect step additions/removals (best-effort).
  const prevRes = await admin
    .schema("deal_intel")
    .from("deal_research_step")
    .select("website, task, metadata")
    .eq("workflow_id", workflowId);
  const prevSteps = (prevRes.data ?? []) as Array<{ website: string; task: string; metadata: Record<string, unknown> | null }>;
  const prevSet = new Set(prevSteps.map((s) => `${String(s.website || "").trim().toLowerCase()}||${String(s.task || "").trim()}`));
  const nextSet = new Set(normalized.map((s) => `${String(s.website || "").trim().toLowerCase()}||${String(s.task || "").trim()}`));
  const added = normalized.filter((s) => !prevSet.has(`${s.website.toLowerCase()}||${s.task}`));
  const removed = prevSteps.filter((s) => !nextSet.has(`${String(s.website || "").trim().toLowerCase()}||${String(s.task || "").trim()}`));

  if (workflow.deal_id) {
    const categoryFor = (meta: unknown) => {
      if (!meta || typeof meta !== "object") return "general";
      const m = meta as Record<string, unknown>;
      return typeof m.category === "string" ? m.category : "general";
    };
    const events = [
      ...added.filter((s) => isPreferenceSource(s.website)).map((s) => ({
        domain: s.website,
        category: categoryFor(s.metadata),
        deltaPreferenceScore: 0.08,
        deltaUsageCount: 1,
        reason: "User added/kept a research step in the plan.",
        task: s.task,
      })),
      ...removed.filter((s) => isPreferenceSource(s.website)).map((s) => ({
        domain: s.website,
        category: categoryFor(s.metadata),
        deltaPreferenceScore: -0.08,
        deltaUsageCount: 0,
        reason: "User removed a research step from the plan.",
        task: s.task,
      })),
    ];
    try {
      await recordResearchPreferenceEvents({
        admin,
        userId: user.id,
        dealId: String(workflow.deal_id),
        events,
      });
    } catch {
      // ignore preference learning failures
    }
  }

  const del = await admin.schema("deal_intel").from("deal_research_step").delete().eq("workflow_id", workflowId);
  if (del.error) return NextResponse.json({ error: del.error.message }, { status: 500 });

  const ins =
    normalized.length > 0
      ? await admin
          .schema("deal_intel")
          .from("deal_research_step")
          .insert(normalized)
          .select("id, workflow_id, position, status, website, task, notes, depends_on_step_ids, metadata, created_at, updated_at")
      : { data: [], error: null };
  if (ins.error) return NextResponse.json({ error: ins.error.message }, { status: 500 });

  const upd = await admin
    .schema("deal_intel")
    .from("deal_research_workflow")
    .update({
      version: workflow.version + 1,
      updated_at: new Date().toISOString(),
      status: "ready",
    })
    .eq("id", workflowId)
    .eq("user_id", user.id)
    .select("id, deal_id, user_id, title, status, version, metadata, created_at, updated_at")
    .single();
  if (upd.error) return NextResponse.json({ error: upd.error.message }, { status: 500 });

  return NextResponse.json({
    workflow: upd.data,
    steps: ins.data ?? [],
  });
}
