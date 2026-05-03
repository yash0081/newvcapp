import { NextResponse } from "next/server";
import { parseJsonFromResponseOrNull } from "@/lib/gemini";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser, getWorkflowForUser } from "@/lib/research/db";
import { executeResearchStep } from "@/lib/research/executor";
import { getResearchModel } from "@/lib/research/research-model-env";
import { ingestStepOutputForRun, recomputeWorkflowStatus } from "@/lib/research/run-helpers";
import { recordResearchPreferenceEvents } from "@/lib/research/preferences";
import { loadResearchInternalContext } from "@/lib/research/context";
import { stripMarkdownText } from "@/lib/plain-text";
import { vertexRunWithTextMulti } from "@/lib/vertex";

function asCompanyName(meta: unknown): string {
  if (!meta || typeof meta !== "object") return "Company";
  const m = meta as Record<string, unknown>;
  return typeof m.company_name === "string" ? m.company_name : "Company";
}

function categoryForMeta(meta: unknown): string {
  if (!meta || typeof meta !== "object") return "general";
  const m = meta as Record<string, unknown>;
  return typeof m.category === "string" && m.category ? m.category : "general";
}

function isPreferenceSource(website: string): boolean {
  const s = website.trim().toLowerCase();
  return Boolean(s) && s !== "web" && s !== "broad-web" && s !== "general-web";
}

function normalizeTaskKey(task: string): string {
  return task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(research|find|verify|check|current|evidence|source|sources|company)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

type FollowUpUpdate = { reason: string; website: string; task: string };

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function cleanFollowUpUpdates(raw: unknown): FollowUpUpdate[] {
  if (!Array.isArray(raw)) return [];
  const out: FollowUpUpdate[] = [];
  for (const item of raw) {
    const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const reason = typeof record.reason === "string" ? stripMarkdownText(record.reason).trim().slice(0, 500) : "";
    const websiteRaw = typeof record.website === "string" ? record.website.trim().slice(0, 300) : "";
    const task = typeof record.task === "string" ? stripMarkdownText(record.task).trim().slice(0, 1000) : "";
    if (!reason || !task) continue;
    out.push({
      reason,
      website: websiteRaw || "web",
      task,
    });
    if (out.length >= 2) break;
  }
  return out;
}

const FOLLOW_UP_STOPWORDS = new Set([
  "about",
  "against",
  "available",
  "company",
  "current",
  "evidence",
  "from",
  "research",
  "search",
  "source",
  "sources",
  "startup",
  "that",
  "this",
  "using",
  "verify",
  "with",
]);

function meaningfulTokens(text: string): Set<string> {
  return new Set(
    stripMarkdownText(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 4 && !FOLLOW_UP_STOPWORDS.has(token))
      .slice(0, 80),
  );
}

function hasFocusOverlap(candidate: FollowUpUpdate, focus: string, parentTask: string): boolean {
  const scopeTokens = meaningfulTokens(`${focus} ${parentTask}`);
  if (!scopeTokens.size) return true;
  const candidateTokens = meaningfulTokens(`${candidate.reason} ${candidate.task}`);
  for (const token of candidateTokens) {
    if (scopeTokens.has(token)) return true;
  }
  return false;
}

function hasNoveltyCue(candidate: FollowUpUpdate): boolean {
  return /\b(new|newly|changed|after finding|after identifying|contradict|contradiction|conflict|discrepancy|missing|not found|unresolved|unclear|uncertain|gap|failed|inaccessible|requires validation|needs validation)\b/i.test(
    `${candidate.reason} ${candidate.task}`,
  );
}

async function reviewFollowUpsForScope(args: {
  candidates: FollowUpUpdate[];
  workflowFocus: string;
  planningIntent: unknown;
  parentTask: string;
  parentNotes: string;
  existingTasks: string[];
  stepCategory: string;
  maxFollowUps: number;
}): Promise<FollowUpUpdate[]> {
  const maxFollowUps = clampInt(args.maxFollowUps, 0, 2);
  if (!maxFollowUps || !args.candidates.length) return [];

  const deduped: FollowUpUpdate[] = [];
  const seen = new Set(args.existingTasks.map(normalizeTaskKey).filter(Boolean));
  for (const candidate of args.candidates) {
    const key = normalizeTaskKey(candidate.task);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }
  if (!deduped.length) return [];

  const prompt = `You are the lightweight semantic pruning gate for research follow-up steps.

The research executor may suggest extra work after a step finishes. Most suggestions should be rejected. Keep a follow-up only if it is necessary to answer the original workflow focus and the completed step revealed new evidence, a contradiction, a missing source, or a specific unresolved gap.

Return strict JSON only:
{
  "updates": [
    { "reason": "plain text reason", "website": "web or source hint", "task": "plain text task" }
  ]
}

Rules:
- Keyword and regex checks are only cheap hints. Make the final decision semantically from the workflow focus, planning intent, parent task, and parent notes.
- Do not expand into full-company diligence or adjacent schema coverage.
- Reject duplicate searches unless the task clearly states what changed and the new angle.
- Reject product, founder, market, or technology comparisons for peer companies that are only present for a matrix, benchmark, or common-investor question.
- Keep at most the requested max follow-ups. Prefer zero.
- The kept task must be narrower than the parent task and must explain the new angle.
- Use plain text only inside JSON strings.`;

  try {
    const raw = await vertexRunWithTextMulti(
      getResearchModel("flash_lite"),
      prompt,
      [
        { label: "Workflow focus", value: args.workflowFocus || "No explicit focus." },
        { label: "Planning intent from the planner", value: args.planningIntent ?? null },
        { label: "Completed parent task", value: args.parentTask },
        { label: "Parent step category", value: args.stepCategory },
        { label: "Parent notes", value: args.parentNotes.slice(0, 5000) },
        {
          label: "Candidate follow-ups with cheap precheck hints",
          value: deduped.map((candidate) => ({
            ...candidate,
            overlaps_prompt_or_parent_task: hasFocusOverlap(candidate, args.workflowFocus, args.parentTask),
            states_new_information_or_gap: hasNoveltyCue(candidate),
          })),
        },
        { label: "Existing workflow tasks", value: args.existingTasks.slice(0, 20) },
        { label: "Maximum follow-ups allowed", value: maxFollowUps },
      ],
      false,
    );
    const parsed = parseJsonFromResponseOrNull(raw) as { updates?: unknown } | null;
    const approved = cleanFollowUpUpdates(parsed?.updates).filter((candidate) =>
      hasFocusOverlap(candidate, args.workflowFocus, args.parentTask),
    );
    return approved.slice(0, maxFollowUps);
  } catch {
    return deduped
      .filter((candidate) => hasNoveltyCue(candidate) && hasFocusOverlap(candidate, args.workflowFocus, args.parentTask))
      .slice(0, maxFollowUps);
  }
}

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ workflowId: string; stepId: string }> }
) {
  const { workflowId, stepId } = await ctx.params;
  const user = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: workflow, error: wfErr } = await getWorkflowForUser(workflowId, user.id);
  if (wfErr) return NextResponse.json({ error: wfErr.message }, { status: 500 });
  if (!workflow) return NextResponse.json({ error: "Workflow not found" }, { status: 404 });

  const admin = createAdminClient();
  const stepRes = await admin
    .schema("deal_intel")
    .from("deal_research_step")
    .select("id, workflow_id, position, status, website, task, depends_on_step_ids, metadata")
    .eq("workflow_id", workflowId)
    .eq("id", stepId)
    .maybeSingle();
  if (stepRes.error) return NextResponse.json({ error: stepRes.error.message }, { status: 500 });
  if (!stepRes.data) return NextResponse.json({ error: "Step not found" }, { status: 404 });
  const stepCategory = categoryForMeta(stepRes.data.metadata);

  const allStepsRes = await admin
    .schema("deal_intel")
    .from("deal_research_step")
    .select("id, position, status, website, task, depends_on_step_ids, metadata")
    .eq("workflow_id", workflowId);
  if (allStepsRes.error) return NextResponse.json({ error: allStepsRes.error.message }, { status: 500 });
  const allSteps = allStepsRes.data ?? [];
  const doneIds = new Set(allSteps.filter((s) => s.status === "done").map((s) => s.id as string));
  const stepIds = new Set(allSteps.map((s) => s.id as string));
  const deps = Array.isArray(stepRes.data.depends_on_step_ids) ? stepRes.data.depends_on_step_ids : [];
  const missing = deps.filter((d) => !stepIds.has(d) || !doneIds.has(d));
  if (missing.length) {
    return NextResponse.json(
      { error: "Complete dependency steps before running this one.", pendingDependencyIds: missing },
      { status: 409 }
    );
  }

  const dealRes = await admin
    .schema("deal_intel")
    .from("deal")
    .select("metadata")
    .eq("id", workflow.deal_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (dealRes.error) return NextResponse.json({ error: dealRes.error.message }, { status: 500 });

  const companyName = asCompanyName(dealRes.data?.metadata);
  const companyContext = JSON.stringify((dealRes.data?.metadata ?? {}) as Record<string, unknown>, null, 2);
  const workflowMeta = workflow.metadata && typeof workflow.metadata === "object" ? (workflow.metadata as Record<string, unknown>) : {};
  const workflowFocus = typeof workflowMeta.focus === "string" ? workflowMeta.focus : "";
  const planningIntent = workflowMeta.planning_intent ?? null;
  const peerDealIds = Array.isArray(workflowMeta.peer_deal_ids)
    ? workflowMeta.peer_deal_ids.filter((id): id is string => typeof id === "string").slice(0, 8)
    : [];
  const internalContext = await loadResearchInternalContext({
    admin,
    userId: user.id,
    dealId: String(workflow.deal_id),
    query: `${stepRes.data.task}\n${workflowFocus}`,
    peerDealIds,
    mode: "execution",
  }).catch(() => "");

  const runIns = await admin
    .schema("deal_intel")
    .from("deal_research_step_run")
    .insert({
      workflow_id: workflowId,
      step_id: stepId,
      run_status: "running",
      output_notes: null,
      sources: [],
      metadata: { website: stepRes.data.website, task: stepRes.data.task },
    })
    .select("id, workflow_id, step_id, run_status, output_notes, sources, error_message, metadata, created_at")
    .single();
  if (runIns.error || !runIns.data) {
    return NextResponse.json({ error: runIns.error?.message ?? "Failed to create run row" }, { status: 500 });
  }
  const runId = runIns.data.id as string;

  await admin
    .schema("deal_intel")
    .from("deal_research_step")
    .update({ status: "running", updated_at: new Date().toISOString() })
    .eq("id", stepId)
    .eq("workflow_id", workflowId);

  let runRow: typeof runIns.data = runIns.data;
  let createdFollowUpSteps: Array<{ id: string; task: string; website: string; status: string }> = [];

  try {
    const result = await executeResearchStep({
      companyName,
      companyContext,
      website: stepRes.data.website,
      task: stepRes.data.task,
      internalContext,
    });

    if (result.ok) {
      const cleanNotes = stripMarkdownText(result.notes);
      const ingestedDocumentIds = await ingestStepOutputForRun({
        admin,
        userId: user.id,
        dealId: String(workflow.deal_id),
        workflowId,
        stepId,
        runId,
        website: stepRes.data.website,
        task: stepRes.data.task,
        notes: cleanNotes,
        sources: result.sources,
      });

      const upd = await admin
        .schema("deal_intel")
        .from("deal_research_step_run")
        .update({
          run_status: "done",
          output_notes: cleanNotes,
          sources: result.sources,
          error_message: null,
          metadata: {
            suggestedStepUpdates: result.suggestedStepUpdates,
            website: stepRes.data.website,
            task: stepRes.data.task,
            ingestedDocumentIds,
            internalContextUsed: Boolean(internalContext),
          },
        })
        .eq("id", runId)
        .select("id, workflow_id, step_id, run_status, output_notes, sources, error_message, metadata, created_at")
        .single();
      if (upd.error) throw new Error(upd.error.message);
      runRow = upd.data;

      const stepUpd = await admin
        .schema("deal_intel")
        .from("deal_research_step")
        .update({
          status: "done",
          notes: cleanNotes.slice(0, 5000),
          updated_at: new Date().toISOString(),
        })
        .eq("id", stepId)
        .eq("workflow_id", workflowId);
      if (stepUpd.error) throw new Error(stepUpd.error.message);

      const requestedFollowUpLimit = clampInt(Number(workflowMeta.follow_up_step_limit ?? 1), 0, 2);
      const existingFollowUpCount = Number(workflowMeta.follow_up_step_count ?? 0);
      const followUpRoom = Math.max(0, requestedFollowUpLimit - existingFollowUpCount);
      const followUps = await reviewFollowUpsForScope({
        candidates: cleanFollowUpUpdates(result.suggestedStepUpdates),
        workflowFocus,
        planningIntent,
        parentTask: stepRes.data.task,
        parentNotes: cleanNotes,
        existingTasks: (allStepsRes.data ?? []).map((step) => (typeof step.task === "string" ? step.task : "")).filter(Boolean),
        stepCategory,
        maxFollowUps: followUpRoom,
      });
      if (followUps.length) {
        const existingKeys = new Set(
          (allStepsRes.data ?? [])
            .map((step) => normalizeTaskKey(typeof step.task === "string" ? step.task : ""))
            .filter(Boolean),
        );
        const maxPosition = Math.max(
          stepRes.data.position ?? 0,
          ...(allStepsRes.data ?? []).map((step) => Number(step.position ?? 0)),
        );
        const rows = followUps
          .filter((item) => {
            const key = normalizeTaskKey(item.task);
            if (!key || existingKeys.has(key)) return false;
            existingKeys.add(key);
            return true;
          })
          .slice(0, followUpRoom)
          .map((item, index) => ({
            workflow_id: workflowId,
            position: maxPosition + index + 1,
            status: "todo",
            website: item.website || "web",
            task: item.task,
            depends_on_step_ids: [stepId],
            metadata: {
              category: stepCategory,
              generated: true,
              source_constrained: isPreferenceSource(item.website),
              follow_up: true,
              follow_up_reason: item.reason,
              parent_step_id: stepId,
            },
          }));
        if (rows.length) {
          const ins = await admin
            .schema("deal_intel")
            .from("deal_research_step")
            .insert(rows)
            .select("id, status, website, task");
          if (ins.error) throw new Error(ins.error.message);
          createdFollowUpSteps = ((ins.data ?? []) as Array<{ id: string; status: string; website: string; task: string }>).map((step) => ({
            id: step.id,
            status: step.status,
            website: step.website,
            task: step.task,
          }));
          await admin
            .schema("deal_intel")
            .from("deal_research_workflow")
            .update({
              metadata: {
                ...workflowMeta,
                follow_up_step_count: existingFollowUpCount + createdFollowUpSteps.length,
              },
              updated_at: new Date().toISOString(),
            })
            .eq("id", workflowId)
            .eq("user_id", user.id);
        }
      }

      if (isPreferenceSource(stepRes.data.website)) {
        try {
          await recordResearchPreferenceEvents({
            admin,
            userId: user.id,
            dealId: String(workflow.deal_id),
            events: [
              {
                domain: stepRes.data.website,
                category: categoryForMeta(stepRes.data.metadata),
                deltaPreferenceScore: 0.1,
                deltaUsageCount: 1,
                reason: "Research planner step executed successfully.",
                task: stepRes.data.task,
              },
            ],
          });
        } catch {
          // ignore preference learning failures
        }
      }
    } else {
      const upd = await admin
        .schema("deal_intel")
        .from("deal_research_step_run")
        .update({
          run_status: "failed",
          output_notes: null,
          sources: [],
          error_message: result.errorMessage,
          metadata: { website: stepRes.data.website, task: stepRes.data.task },
        })
        .eq("id", runId)
        .select("id, workflow_id, step_id, run_status, output_notes, sources, error_message, metadata, created_at")
        .single();
      if (!upd.error && upd.data) runRow = upd.data;

      await admin
        .schema("deal_intel")
        .from("deal_research_step")
        .update({ status: "failed", updated_at: new Date().toISOString() })
        .eq("id", stepId)
        .eq("workflow_id", workflowId);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await admin
      .schema("deal_intel")
      .from("deal_research_step_run")
      .update({
        run_status: "failed",
        error_message: message,
        output_notes: null,
        sources: [],
      })
      .eq("id", runId);
    await admin
      .schema("deal_intel")
      .from("deal_research_step")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("id", stepId)
      .eq("workflow_id", workflowId);
    runRow = { ...runRow, run_status: "failed", error_message: message };
  }

  await recomputeWorkflowStatus({ admin, workflowId, userId: user.id });

  return NextResponse.json({ ok: true, run: runRow, createdFollowUpSteps });
}
