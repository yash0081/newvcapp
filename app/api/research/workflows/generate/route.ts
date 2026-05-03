import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser, getDealForUser } from "@/lib/research/db";
import { generateResearchPlan } from "@/lib/research/planner";
import { getRecentDealClaims } from "@/lib/copilot/db";
import { getUserSitePreferences, recordResearchPreferenceEvents } from "@/lib/research/preferences";
import { loadResearchInternalContext } from "@/lib/research/context";

function isPreferenceSource(website: string): boolean {
  const s = website.trim().toLowerCase();
  return Boolean(s) && s !== "web" && s !== "broad-web" && s !== "general-web";
}

export async function POST(req: Request) {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { dealId?: string; focus?: string; peerDealIds?: unknown; peerDealNames?: unknown } | null;
  const dealId = typeof body?.dealId === "string" ? body.dealId : "";
  const focus = typeof body?.focus === "string" ? body.focus.trim().slice(0, 1800) : "";
  const peerDealIds = Array.isArray(body?.peerDealIds)
    ? body.peerDealIds.filter((id): id is string => typeof id === "string" && id !== dealId).slice(0, 8)
    : [];
  const peerDealNames = Array.isArray(body?.peerDealNames)
    ? body.peerDealNames.filter((name): name is string => typeof name === "string").slice(0, 8)
    : [];
  if (!dealId) return NextResponse.json({ error: "dealId is required" }, { status: 400 });

  const { data: deal, error: dealErr } = await getDealForUser(dealId, user.id);
  if (dealErr) return NextResponse.json({ error: dealErr.message }, { status: 500 });
  if (!deal) return NextResponse.json({ error: "Deal not found" }, { status: 404 });

  const admin = createAdminClient();
  const meta = (deal.metadata && typeof deal.metadata === "object" ? deal.metadata : {}) as Record<string, unknown>;
  const companyName = typeof meta.company_name === "string" ? meta.company_name : "Company";
  const internalContext = await loadResearchInternalContext({
    admin,
    userId: user.id,
    dealId,
    query: focus || companyName,
    peerDealIds,
    mode: "planning",
  }).catch(() => "");
  const companyContext = JSON.stringify({ metadata: meta, internal_workspace_context: internalContext || null }, null, 2);

  const [sitePrefs, recentClaims] = await Promise.all([
    getUserSitePreferences({ admin, userId: user.id, limit: 80 }),
    getRecentDealClaims({ admin, dealId, userId: user.id, limit: 24 }),
  ]);

  const suggestion = await generateResearchPlan({
    companyName,
    companyContext,
    metadata: meta,
    preferences: sitePrefs.preferred.map((p) => ({ ...p, usage_count: p.usage_count })),
    dislikedPreferences: sitePrefs.disliked.map((p) => ({ ...p, usage_count: p.usage_count })),
    recentClaims,
    focus,
  });

  const existing = await admin
    .schema("deal_intel")
    .from("deal_research_workflow")
    .select("id, deal_id, user_id, title, status, version, metadata, created_at, updated_at")
    .eq("deal_id", dealId)
    .eq("user_id", user.id)
    .neq("status", "archived")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing.error) return NextResponse.json({ error: existing.error.message }, { status: 500 });

  if (existing.data) {
    const archive = await admin
      .schema("deal_intel")
      .from("deal_research_workflow")
      .update({
        status: "archived",
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.data.id)
      .eq("user_id", user.id);
    if (archive.error) return NextResponse.json({ error: archive.error.message }, { status: 500 });
  }

  const wfIns = await admin
    .schema("deal_intel")
    .from("deal_research_workflow")
    .insert({
      deal_id: dealId,
      user_id: user.id,
      title: `${companyName} research`,
      status: "ready",
      version: 1,
      metadata: {
        summary: suggestion.summary,
        focus: focus || null,
        peer_deal_ids: peerDealIds,
        peer_deal_names: peerDealNames,
        planning_intent: suggestion.intent ?? null,
        pruning_notes: suggestion.pruningNotes ?? [],
        follow_up_step_limit: suggestion.intent?.breadth === "broad" ? 2 : 1,
        initial_step_count: suggestion.steps.length,
        internal_context_used: Boolean(internalContext),
        generated_at: new Date().toISOString(),
        generated_by: "planner",
        archived_predecessor_id: existing.data?.id ?? null,
      },
    })
    .select("id, deal_id, user_id, title, status, version, metadata, created_at, updated_at")
    .single();
  if (wfIns.error) return NextResponse.json({ error: wfIns.error.message }, { status: 500 });
  const workflow = wfIns.data;

  if (!workflow) return NextResponse.json({ error: "Failed to create workflow" }, { status: 500 });

  const stepRows = suggestion.steps.map((s, i) => ({
    workflow_id: workflow.id,
    position: i,
    status: "todo",
    website: s.website,
    task: s.task,
    depends_on_step_ids: [],
    metadata: {
      category: s.category ?? "general",
      generated: true,
      source_constrained: isPreferenceSource(s.website),
      planning_intent_user_goal: suggestion.intent?.userGoal ?? (focus || null),
    },
  }));
  const stepIns = await admin
    .schema("deal_intel")
    .from("deal_research_step")
    .insert(stepRows)
    .select("id, workflow_id, position, status, website, task, notes, depends_on_step_ids, metadata, created_at, updated_at");
  if (stepIns.error) return NextResponse.json({ error: stepIns.error.message }, { status: 500 });

  try {
    await recordResearchPreferenceEvents({
      admin,
      userId: user.id,
      dealId,
      events: suggestion.steps
        .filter((s) => isPreferenceSource(s.website))
        .map((s) => ({
          domain: s.website,
          category: s.category ?? "general",
          deltaPreferenceScore: 0.02,
          deltaUsageCount: 0,
          reason: focus
            ? `Research planner selected this source for a focused plan: ${focus}`
            : "Research planner selected this source for an auto-generated plan.",
          task: s.task,
        })),
    });
  } catch {
    // ignore preference learning failures
  }

  return NextResponse.json({
    workflow,
    steps: stepIns.data ?? [],
  });
}
