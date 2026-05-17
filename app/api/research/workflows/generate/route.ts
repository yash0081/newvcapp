import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser, getDealForUser } from "@/lib/research/db";
import { generateResearchPlan } from "@/lib/research/planner";
import { getRecentDealClaims } from "@/lib/copilot/db";
import { profileFollowUpLimit, profileMaxSteps, type ResearchProfile } from "@/lib/research/mode-router";
import { getUserSitePreferences, recordResearchPreferenceEvents } from "@/lib/research/preferences";
import { loadResearchInternalContext } from "@/lib/research/context";
import { buildPlannerFocus, buildPlannerGuidanceBlock } from "@/lib/research/public-output";

function parseResearchProfile(raw: unknown): ResearchProfile {
  if (raw === "fast" || raw === "standard" || raw === "deep") return raw;
  return "standard";
}

function isPreferenceSource(website: string): boolean {
  const s = website.trim().toLowerCase();
  return Boolean(s) && s !== "web" && s !== "broad-web" && s !== "general-web";
}

export async function POST(req: Request) {
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    dealId?: string;
    focus?: string;
    peerDealIds?: unknown;
    peerDealNames?: unknown;
    researchProfile?: unknown;
  } | null;
  const dealId = typeof body?.dealId === "string" ? body.dealId : "";
  if (!dealId) return NextResponse.json({ error: "dealId is required" }, { status: 400 });

  const userFocus = typeof body?.focus === "string" ? body.focus.trim().slice(0, 1800) : "";
  const researchProfile = parseResearchProfile(body?.researchProfile);
  let peerDealIds = Array.isArray(body?.peerDealIds)
    ? body.peerDealIds.filter((id): id is string => typeof id === "string" && id !== dealId).slice(0, 8)
    : [];
  let peerDealNames = Array.isArray(body?.peerDealNames)
    ? body.peerDealNames.filter((name): name is string => typeof name === "string").slice(0, 8)
    : [];
  const plannerFocus = buildPlannerFocus(
    userFocus,
    buildPlannerGuidanceBlock({
      message: userFocus,
      useCriteria: false,
      useSimilarCompanies: peerDealIds.length > 0,
    }),
  );

  const { data: deal, error: dealErr } = await getDealForUser(dealId, user.id);
  if (dealErr) return NextResponse.json({ error: dealErr.message }, { status: 500 });
  if (!deal) return NextResponse.json({ error: "Deal not found" }, { status: 404 });

  const admin = createAdminClient();
  const meta = (deal.metadata && typeof deal.metadata === "object" ? deal.metadata : {}) as Record<string, unknown>;
  const companyName = typeof meta.company_name === "string" ? meta.company_name : "Company";

  if (peerDealIds.length) {
    const peers = await admin
      .schema("deal_intel")
      .from("deal")
      .select("id, metadata")
      .eq("user_id", user.id)
      .in("id", peerDealIds);
    if (peers.error) return NextResponse.json({ error: peers.error.message }, { status: 500 });
    const peerRows = peers.data ?? [];
    const allowed = new Set(peerRows.map((peer) => String(peer.id)));
    peerDealIds = peerDealIds.filter((id) => allowed.has(id));
    peerDealNames = peerRows
      .filter((peer) => peerDealIds.includes(String(peer.id)))
      .map((peer) => {
        const peerMeta = peer.metadata && typeof peer.metadata === "object" ? (peer.metadata as Record<string, unknown>) : {};
        return typeof peerMeta.company_name === "string" && peerMeta.company_name.trim() ? peerMeta.company_name.trim() : "Peer company";
      });
  } else {
    peerDealNames = [];
  }

  const internalContext = await loadResearchInternalContext({
    admin,
    userId: user.id,
    dealId,
    query: userFocus || companyName,
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
    focus: plannerFocus,
    peerCompanyNames: peerDealNames,
    researchProfile,
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
        focus: userFocus || null,
        planner_focus: plannerFocus !== userFocus ? plannerFocus : null,
        peer_deal_ids: peerDealIds,
        peer_deal_names: peerDealNames,
        planning_intent: suggestion.intent ?? null,
        research_profile: researchProfile,
        max_steps_cap: profileMaxSteps(researchProfile),
        pruning_notes: suggestion.pruningNotes ?? [],
        follow_up_step_limit: profileFollowUpLimit(researchProfile),
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

  const maxSteps = profileMaxSteps(researchProfile);
  const planSteps = suggestion.steps.slice(0, maxSteps);
  const stepRows = planSteps.map((s, i) => ({
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
      planning_intent_user_goal: suggestion.intent?.userGoal ?? (userFocus || null),
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
          reason: userFocus
            ? `Research planner selected this source for a focused plan: ${userFocus}`
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
