import type { SupabaseClient } from "@supabase/supabase-js";
import { generateDocumentContent, loadDocumentType, preflightDocument } from "@/lib/document-generation/generator";
import { getRecentDealClaims } from "@/lib/copilot/db";
import { executeResearchStep } from "@/lib/research/executor";
import { generateResearchPlan } from "@/lib/research/planner";
import { getUserSitePreferences, recordResearchPreferenceEvents } from "@/lib/research/preferences";
import { ingestStepOutputForRun, recomputeWorkflowStatus } from "@/lib/research/run-helpers";
import { loadResearchInternalContext } from "@/lib/research/context";
import { stripMarkdownText } from "@/lib/plain-text";

export type CustomWorkflowStep =
  | {
      id: string;
      type: "research";
      title: string;
      prompt: string;
      mode?: "plan" | "single";
      maxSteps?: number;
    }
  | {
      id: string;
      type: "document";
      title: string;
      prompt: string;
      typeId?: string | null;
      skipResearch?: boolean;
    }
  | {
      id: string;
      type: "record_update";
      title: string;
      target: string;
      value: string;
    }
  | {
      id: string;
      type: "checkpoint";
      title: string;
      prompt: string;
    };

export type CustomWorkflowDefinition = {
  id: string;
  user_id: string;
  name: string;
  description: string;
  trigger_hint: string;
  steps: CustomWorkflowStep[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type CustomWorkflowArtifact = {
  kind: "research" | "document" | "record_update" | "checkpoint";
  label: string;
  href?: string;
  detail?: string;
};

export type CustomWorkflowRunStatus = "running" | "done" | "failed";
export type CustomWorkflowStepRunStatus = "queued" | "running" | "done" | "skipped" | "failed";
export type CustomWorkflowRunStepResult = {
  stepId?: string;
  title: string;
  type: CustomWorkflowStep["type"] | string;
  status: CustomWorkflowStepRunStatus;
  detail: string;
  index?: number;
  total?: number;
  substepIndex?: number;
  substepTotal?: number;
  substepTask?: string;
};

export type CustomWorkflowRunResult = {
  runId: string;
  summary: string;
  artifacts: CustomWorkflowArtifact[];
  stepResults: CustomWorkflowRunStepResult[];
};

export type CustomWorkflowRunRecord = {
  id: string;
  workflowId: string | null;
  workflowName: string | null;
  dealId: string | null;
  dealName: string | null;
  status: CustomWorkflowRunStatus;
  input: string;
  summary: string;
  stepResults: CustomWorkflowRunStepResult[];
  artifacts: CustomWorkflowArtifact[];
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CustomWorkflowStepProgressEvent = {
  runId: string;
  stepId: string;
  index: number;
  total: number;
  detail: string;
  substepIndex?: number;
  substepTotal?: number;
  substepTask?: string;
  substepStatus?: "planning" | "running" | "done" | "failed";
};

export type CustomWorkflowRunProgress = {
  onRunStart?: (event: { runId: string }) => void | Promise<void>;
  onStepStart?: (event: {
    runId: string;
    stepId: string;
    index: number;
    total: number;
    title: string;
    stepType: CustomWorkflowStep["type"];
  }) => void | Promise<void>;
  onStepComplete?: (event: {
    runId: string;
    stepId: string;
    index: number;
    total: number;
    status: "done" | "skipped" | "failed";
    detail: string;
    artifact?: CustomWorkflowArtifact;
  }) => void | Promise<void>;
  onStepProgress?: (event: CustomWorkflowStepProgressEvent) => void | Promise<void>;
};

type DealRow = { id: string; metadata: Record<string, unknown> | null };

function safeRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export function formatUnknownError(error: unknown, fallback = "Unknown error"): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const parts = [record.message, record.details, record.hint, record.code]
      .map((part) => (typeof part === "string" || typeof part === "number" ? String(part).trim() : ""))
      .filter(Boolean);
    if (parts.length) return parts.join(" ");
    try {
      const json = JSON.stringify(error);
      if (json && json !== "{}") return json.slice(0, 1000);
    } catch {
      // Fall through to fallback.
    }
  }
  return fallback;
}

function throwDbError(error: unknown, fallback: string): never {
  throw new Error(formatUnknownError(error, fallback));
}

function companyName(deal: DealRow | null): string {
  const meta = safeRecord(deal?.metadata);
  return typeof meta.company_name === "string" && meta.company_name.trim() ? meta.company_name.trim() : "Company";
}

function cleanStep(raw: unknown, index: number): CustomWorkflowStep | null {
  const o = safeRecord(raw);
  const type = String(o.type ?? "");
  const title = typeof o.title === "string" && o.title.trim() ? o.title.trim().slice(0, 120) : `Step ${index + 1}`;
  const id = typeof o.id === "string" && o.id.trim() ? o.id.trim().slice(0, 80) : `step-${index + 1}`;
  if (type === "research") {
    return {
      id,
      type,
      title,
      prompt: typeof o.prompt === "string" ? o.prompt.trim().slice(0, 1000) : "",
      mode: o.mode === "single" ? "single" : "plan",
      maxSteps: Math.max(1, Math.min(8, Number(o.maxSteps ?? 4) || 4)),
    };
  }
  if (type === "document") {
    return {
      id,
      type,
      title,
      prompt: typeof o.prompt === "string" ? o.prompt.trim().slice(0, 2000) : "",
      typeId: typeof o.typeId === "string" && o.typeId.trim() ? o.typeId.trim() : null,
      skipResearch: o.skipResearch !== false,
    };
  }
  if (type === "record_update") {
    return {
      id,
      type,
      title,
      target: typeof o.target === "string" ? o.target.trim().slice(0, 160) : "",
      value: typeof o.value === "string" ? o.value.trim().slice(0, 1200) : "",
    };
  }
  if (type === "checkpoint") {
    return {
      id,
      type,
      title,
      prompt: typeof o.prompt === "string" ? o.prompt.trim().slice(0, 1000) : "",
    };
  }
  return null;
}

export function cleanWorkflowSteps(raw: unknown): CustomWorkflowStep[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(cleanStep).filter((s): s is CustomWorkflowStep => Boolean(s)).slice(0, 12);
}

function rowToDefinition(row: Record<string, unknown>): CustomWorkflowDefinition {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    trigger_hint: String(row.trigger_hint ?? ""),
    steps: cleanWorkflowSteps(row.steps),
    metadata: safeRecord(row.metadata),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

function cleanArtifact(raw: unknown): CustomWorkflowArtifact | null {
  const o = safeRecord(raw);
  const kind = String(o.kind ?? "");
  if (!["research", "document", "record_update", "checkpoint"].includes(kind)) return null;
  const label = typeof o.label === "string" && o.label.trim() ? o.label.trim() : "Workflow artifact";
  return {
    kind: kind as CustomWorkflowArtifact["kind"],
    label,
    href: typeof o.href === "string" && o.href.trim() ? o.href.trim() : undefined,
    detail: typeof o.detail === "string" && o.detail.trim() ? o.detail.trim() : undefined,
  };
}

function cleanArtifacts(raw: unknown): CustomWorkflowArtifact[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(cleanArtifact).filter((artifact): artifact is CustomWorkflowArtifact => Boolean(artifact)).slice(0, 40);
}

function cleanRunStepResult(raw: unknown, index: number): CustomWorkflowRunStepResult | null {
  const o = safeRecord(raw);
  const title = typeof o.title === "string" && o.title.trim() ? o.title.trim() : `Step ${index + 1}`;
  const type = typeof o.type === "string" && o.type.trim() ? o.type.trim() : "checkpoint";
  const statusRaw = String(o.status ?? "queued");
  const status: CustomWorkflowStepRunStatus = ["queued", "running", "done", "skipped", "failed"].includes(statusRaw)
    ? (statusRaw as CustomWorkflowStepRunStatus)
    : "queued";
  return {
    stepId: typeof o.stepId === "string" && o.stepId.trim() ? o.stepId.trim() : undefined,
    title,
    type,
    status,
    detail: typeof o.detail === "string" ? o.detail : "",
    index: Number.isFinite(Number(o.index)) ? Number(o.index) : index,
    total: Number.isFinite(Number(o.total)) ? Number(o.total) : undefined,
    substepIndex: Number.isFinite(Number(o.substepIndex)) ? Number(o.substepIndex) : undefined,
    substepTotal: Number.isFinite(Number(o.substepTotal)) ? Number(o.substepTotal) : undefined,
    substepTask: typeof o.substepTask === "string" && o.substepTask.trim() ? o.substepTask.trim() : undefined,
  };
}

function cleanRunStepResults(raw: unknown): CustomWorkflowRunStepResult[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(cleanRunStepResult).filter((step): step is CustomWorkflowRunStepResult => Boolean(step)).slice(0, 30);
}

function initialRunStepResults(workflow: CustomWorkflowDefinition): CustomWorkflowRunStepResult[] {
  return workflow.steps.map((step, index) => ({
    stepId: step.id,
    title: step.title,
    type: step.type,
    status: "queued",
    detail: "Queued",
    index,
    total: workflow.steps.length,
  }));
}

function dealNameFromMetadata(metadata: unknown): string | null {
  const meta = safeRecord(metadata);
  return typeof meta.company_name === "string" && meta.company_name.trim() ? meta.company_name.trim() : null;
}

function rowToRunRecord(
  row: Record<string, unknown>,
  workflowNames: Map<string, string> = new Map(),
  dealNames: Map<string, string> = new Map(),
): CustomWorkflowRunRecord {
  const workflowId = typeof row.workflow_id === "string" && row.workflow_id.trim() ? row.workflow_id.trim() : null;
  const dealId = typeof row.deal_id === "string" && row.deal_id.trim() ? row.deal_id.trim() : null;
  const statusRaw = String(row.status ?? "running");
  const status: CustomWorkflowRunStatus = statusRaw === "done" || statusRaw === "failed" ? statusRaw : "running";
  return {
    id: String(row.id),
    workflowId,
    workflowName: workflowId ? workflowNames.get(workflowId) ?? null : null,
    dealId,
    dealName: dealId ? dealNames.get(dealId) ?? null : null,
    status,
    input: String(row.input ?? ""),
    summary: String(row.summary ?? ""),
    stepResults: cleanRunStepResults(row.step_results),
    artifacts: cleanArtifacts(row.artifacts),
    errorMessage: typeof row.error_message === "string" && row.error_message.trim() ? row.error_message.trim() : null,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

export async function listCustomWorkflowDefinitions(admin: SupabaseClient, userId: string): Promise<CustomWorkflowDefinition[]> {
  const res = await admin
    .schema("deal_intel")
    .from("custom_workflow_definition")
    .select("id, user_id, name, description, trigger_hint, steps, metadata, created_at, updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(80);
  if (res.error) return [];
  return ((res.data ?? []) as Record<string, unknown>[]).map(rowToDefinition);
}

export async function listCustomWorkflowRuns(admin: SupabaseClient, userId: string, limit = 40): Promise<CustomWorkflowRunRecord[]> {
  const runsRes = await admin
    .schema("deal_intel")
    .from("custom_workflow_run")
    .select("id, workflow_id, user_id, deal_id, status, input, summary, step_results, artifacts, error_message, created_at, updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(Math.max(1, Math.min(100, limit)));
  if (runsRes.error) return [];
  const rows = (runsRes.data ?? []) as Record<string, unknown>[];
  const workflowIds = Array.from(new Set(rows.map((row) => (typeof row.workflow_id === "string" ? row.workflow_id : "")).filter(Boolean)));
  const dealIds = Array.from(new Set(rows.map((row) => (typeof row.deal_id === "string" ? row.deal_id : "")).filter(Boolean)));

  const [workflowRes, dealRes] = await Promise.all([
    workflowIds.length
      ? admin
          .schema("deal_intel")
          .from("custom_workflow_definition")
          .select("id, name")
          .eq("user_id", userId)
          .in("id", workflowIds)
      : Promise.resolve({ data: [], error: null }),
    dealIds.length
      ? admin
          .schema("deal_intel")
          .from("deal")
          .select("id, metadata")
          .eq("user_id", userId)
          .in("id", dealIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const workflowNames = new Map<string, string>();
  if (!workflowRes.error) {
    for (const row of (workflowRes.data ?? []) as Array<{ id: string; name: string }>) {
      workflowNames.set(String(row.id), String(row.name || "Untitled workflow"));
    }
  }

  const dealNames = new Map<string, string>();
  if (!dealRes.error) {
    for (const row of (dealRes.data ?? []) as Array<{ id: string; metadata: Record<string, unknown> | null }>) {
      const name = dealNameFromMetadata(row.metadata);
      if (name) dealNames.set(String(row.id), name);
    }
  }

  return rows.map((row) => rowToRunRecord(row, workflowNames, dealNames));
}

export async function loadCustomWorkflowDefinition(admin: SupabaseClient, userId: string, workflowId: string) {
  const res = await admin
    .schema("deal_intel")
    .from("custom_workflow_definition")
    .select("id, user_id, name, description, trigger_hint, steps, metadata, created_at, updated_at")
    .eq("id", workflowId)
    .eq("user_id", userId)
    .maybeSingle();
  if (res.error) throwDbError(res.error, "Failed to load workflow");
  return res.data ? rowToDefinition(res.data as Record<string, unknown>) : null;
}

async function loadDeal(admin: SupabaseClient, userId: string, dealId: string | null): Promise<DealRow | null> {
  if (!dealId) return null;
  const res = await admin
    .schema("deal_intel")
    .from("deal")
    .select("id, metadata")
    .eq("id", dealId)
    .eq("user_id", userId)
    .maybeSingle();
  if (res.error) throwDbError(res.error, "Failed to load company");
  return (res.data as DealRow | null) ?? null;
}

export async function createCustomWorkflowRun(args: {
  admin: SupabaseClient;
  userId: string;
  workflow: CustomWorkflowDefinition;
  dealId: string | null;
  input: string;
}): Promise<CustomWorkflowRunRecord> {
  const deal = await loadDeal(args.admin, args.userId, args.dealId);
  const initialSteps = initialRunStepResults(args.workflow);
  const ins = await args.admin
    .schema("deal_intel")
    .from("custom_workflow_run")
    .insert({
      workflow_id: args.workflow.id,
      user_id: args.userId,
      deal_id: deal?.id ?? null,
      status: "running",
      input: args.input,
      summary: initialSteps.length ? "Queued workflow run." : "No steps configured.",
      step_results: initialSteps,
      artifacts: [],
      error_message: null,
    })
    .select("id, workflow_id, user_id, deal_id, status, input, summary, step_results, artifacts, error_message, created_at, updated_at")
    .single();
  if (ins.error || !ins.data) throwDbError(ins.error, "Failed to create workflow run");
  const workflowNames = new Map([[args.workflow.id, args.workflow.name]]);
  const dealNames = new Map<string, string>();
  if (deal) {
    const name = companyName(deal);
    if (name !== "Company") dealNames.set(deal.id, name);
  }
  return rowToRunRecord(ins.data as Record<string, unknown>, workflowNames, dealNames);
}

export async function loadCustomWorkflowRun(admin: SupabaseClient, userId: string, runId: string): Promise<CustomWorkflowRunRecord | null> {
  const res = await admin
    .schema("deal_intel")
    .from("custom_workflow_run")
    .select("id, workflow_id, user_id, deal_id, status, input, summary, step_results, artifacts, error_message, created_at, updated_at")
    .eq("id", runId)
    .eq("user_id", userId)
    .maybeSingle();
  if (res.error) throwDbError(res.error, "Failed to load workflow run");
  if (!res.data) return null;
  return rowToRunRecord(res.data as Record<string, unknown>);
}

async function runResearchWorkflowStep(args: {
  admin: SupabaseClient;
  userId: string;
  deal: DealRow | null;
  step: Extract<CustomWorkflowStep, { type: "research" }>;
  input: string;
  runId: string;
  stepIndex: number;
  totalSteps: number;
  progress?: CustomWorkflowRunProgress;
}): Promise<{ detail: string; artifact?: CustomWorkflowArtifact }> {
  if (!args.deal) return { detail: "Skipped because this step needs a company." };
  const dealId = args.deal.id;
  const meta = safeRecord(args.deal.metadata);
  const name = companyName(args.deal);
  const focus = [args.step.prompt, args.input].filter(Boolean).join("\n").trim();
  const emitResearchProgress = async (event: Omit<CustomWorkflowStepProgressEvent, "runId" | "stepId" | "index" | "total">) => {
    try {
      await args.progress?.onStepProgress?.({
        runId: args.runId,
        stepId: args.step.id,
        index: args.stepIndex,
        total: args.totalSteps,
        ...event,
      });
    } catch {
      // Progress callbacks should never fail the underlying workflow.
    }
  };
  await emitResearchProgress({
    detail: "Planning research tasks from the workflow prompt and company context...",
    substepStatus: "planning",
  });
  const planningContext = await loadResearchInternalContext({
    admin: args.admin,
    userId: args.userId,
    dealId,
    query: focus || args.step.title,
    mode: "planning",
  }).catch(() => "");
  const companyContext = JSON.stringify(
    {
      metadata: meta,
      internal_workspace_context: planningContext || null,
    },
    null,
    2
  );
  const planNotes: string[] = [];
  let tasks: Array<{ website: string; task: string; category?: string }> = [];
  try {
    const [sitePrefs, recentClaims] = await Promise.all([
      getUserSitePreferences({ admin: args.admin, userId: args.userId, limit: 80 }),
      getRecentDealClaims({ admin: args.admin, dealId, userId: args.userId, limit: 24 }),
    ]);
    const plan = await generateResearchPlan({
      companyName: name,
      companyContext,
      metadata: meta,
      preferences: sitePrefs.preferred.map((p) => ({ ...p, usage_count: p.usage_count })),
      dislikedPreferences: sitePrefs.disliked.map((p) => ({ ...p, usage_count: p.usage_count })),
      recentClaims,
      focus,
    });
    tasks = plan.steps
      .map((task) => ({
        website: task.website || "web",
        task: task.task,
        category: task.category ?? "general",
      }))
      .filter((task) => task.task.trim())
      .slice(0, 6);
  } catch (e) {
    const message = formatUnknownError(e, "Research planner failed");
    planNotes.push(`Research planner could not create a full plan, so the workflow ran a targeted fallback search. Planner error: ${message}`);
  }

  if (!tasks.length) {
    tasks = [{ website: "web", task: focus || args.step.title, category: "general" }];
  }
  await emitResearchProgress({
    detail: `Generated ${tasks.length} research substep${tasks.length === 1 ? "" : "s"}.`,
    substepTotal: tasks.length,
    substepStatus: "planning",
  });

  const existing = await args.admin
    .schema("deal_intel")
    .from("deal_research_workflow")
    .select("id")
    .eq("deal_id", dealId)
    .eq("user_id", args.userId)
    .neq("status", "archived")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing.error) throwDbError(existing.error, "Failed to check existing research workflow");
  if (existing.data?.id) {
    const archive = await args.admin
      .schema("deal_intel")
      .from("deal_research_workflow")
      .update({
        status: "archived",
        updated_at: new Date().toISOString(),
      })
      .eq("id", String(existing.data.id))
      .eq("user_id", args.userId);
    if (archive.error) throwDbError(archive.error, "Failed to archive existing research workflow");
  }

  const wf = await args.admin
    .schema("deal_intel")
    .from("deal_research_workflow")
    .insert({
      deal_id: dealId,
      user_id: args.userId,
      title: `${name} workflow research`,
      status: "running",
      version: 1,
      metadata: { summary: focus, generated_by: "custom_workflow", workflow_step_id: args.step.id },
    })
    .select("id")
    .single();
  if (wf.error || !wf.data) throwDbError(wf.error, "Failed to create research workflow");
  const workflowId = String(wf.data.id);

  const stepRows = tasks.map((task, i) => ({
    workflow_id: workflowId,
    position: i,
    status: "todo",
    website: task.website || "web",
    task: task.task,
    depends_on_step_ids: [],
    metadata: { category: task.category ?? "general", generated_by: "custom_workflow" },
  }));
  const inserted = await args.admin
    .schema("deal_intel")
    .from("deal_research_step")
    .insert(stepRows)
    .select("id, website, task, metadata");
  if (inserted.error) throwDbError(inserted.error, "Failed to create research steps");

  const notes: string[] = [...planNotes];
  for (const [researchIndex, researchStep] of ((inserted.data ?? []) as Array<{ id: string; website: string; task: string }>).entries()) {
    const substepIndex = researchIndex + 1;
    await emitResearchProgress({
      detail: `Researching ${substepIndex} of ${tasks.length}: ${researchStep.task}`,
      substepIndex,
      substepTotal: tasks.length,
      substepTask: researchStep.task,
      substepStatus: "running",
    });
    await args.admin
      .schema("deal_intel")
      .from("deal_research_step")
      .update({ status: "running", updated_at: new Date().toISOString() })
      .eq("id", researchStep.id)
      .eq("workflow_id", workflowId);
    const runIns = await args.admin
      .schema("deal_intel")
      .from("deal_research_step_run")
      .insert({
        workflow_id: workflowId,
        step_id: researchStep.id,
        run_status: "running",
        sources: [],
        metadata: { website: researchStep.website, task: researchStep.task },
      })
      .select("id")
      .single();
    if (runIns.error || !runIns.data) throwDbError(runIns.error, "Failed to create research run");
    const runId = String(runIns.data.id);
    const internalContext = await loadResearchInternalContext({
      admin: args.admin,
      userId: args.userId,
      dealId,
      query: researchStep.task,
      mode: "execution",
    }).catch(() => "");
    const result = await executeResearchStep({
      companyName: name,
      companyContext,
      website: researchStep.website,
      task: researchStep.task,
      internalContext,
    });
    if (result.ok) {
      const cleanNotes = stripMarkdownText(result.notes);
      const docs = await ingestStepOutputForRun({
        admin: args.admin,
        userId: args.userId,
        dealId,
        workflowId,
        stepId: researchStep.id,
        runId,
        website: researchStep.website,
        task: researchStep.task,
        notes: cleanNotes,
        sources: result.sources,
      });
      await args.admin.schema("deal_intel").from("deal_research_step_run").update({
        run_status: "done",
        output_notes: cleanNotes,
        sources: result.sources,
        metadata: { website: researchStep.website, task: researchStep.task, ingestedDocumentIds: docs, internalContextUsed: Boolean(internalContext) },
      }).eq("id", runId);
      await args.admin.schema("deal_intel").from("deal_research_step").update({ status: "done", notes: cleanNotes.slice(0, 5000) }).eq("id", researchStep.id);
      notes.push(`${researchStep.task}: ${cleanNotes.replace(/\s+/g, " ").slice(0, 280)}`);
      await emitResearchProgress({
        detail: `Finished ${substepIndex} of ${tasks.length}: ${researchStep.task}`,
        substepIndex,
        substepTotal: tasks.length,
        substepTask: researchStep.task,
        substepStatus: "done",
      });
      if (researchStep.website && researchStep.website !== "web") {
        await recordResearchPreferenceEvents({
          admin: args.admin,
          userId: args.userId,
          dealId,
          events: [{ domain: researchStep.website, category: "workflow", deltaPreferenceScore: 0.05, deltaUsageCount: 1, reason: "Custom workflow research step executed.", task: researchStep.task }],
        }).catch(() => null);
      }
    } else {
      await args.admin.schema("deal_intel").from("deal_research_step_run").update({
        run_status: "failed",
        error_message: result.errorMessage,
        sources: [],
      }).eq("id", runId);
      await args.admin.schema("deal_intel").from("deal_research_step").update({ status: "failed" }).eq("id", researchStep.id);
      notes.push(`${researchStep.task}: failed (${result.errorMessage})`);
      await emitResearchProgress({
        detail: `Failed ${substepIndex} of ${tasks.length}: ${researchStep.task} (${result.errorMessage})`,
        substepIndex,
        substepTotal: tasks.length,
        substepTask: researchStep.task,
        substepStatus: "failed",
      });
    }
  }
  await recomputeWorkflowStatus({ admin: args.admin, workflowId, userId: args.userId });
  return {
    detail: notes.join("\n").slice(0, 1600) || "Research workflow ran.",
    artifact: { kind: "research", label: "Open research results", href: `/home/deal-intel/${dealId}/research`, detail: `${tasks.length} step${tasks.length === 1 ? "" : "s"}` },
  };
}

async function runDocumentStep(args: {
  admin: SupabaseClient;
  userId: string;
  deal: DealRow | null;
  step: Extract<CustomWorkflowStep, { type: "document" }>;
  input: string;
}): Promise<{ detail: string; artifact?: CustomWorkflowArtifact }> {
  if (!args.step.typeId) return { detail: "Skipped because no document type is selected." };
  const type = await loadDocumentType(args.admin, args.userId, args.step.typeId);
  if (!type) return { detail: "Skipped because the saved document type could not be found." };
  const prompt = [args.step.prompt, args.input].filter(Boolean).join("\n").trim();
  const preflight = await preflightDocument({ admin: args.admin, userId: args.userId, dealId: args.deal?.id ?? null, type, prompt });
  const generated = await generateDocumentContent({ admin: args.admin, userId: args.userId, dealId: args.deal?.id ?? null, type, prompt, preflight });
  const ins = await args.admin
    .schema("deal_intel")
    .from("generated_document_draft")
    .insert({
      user_id: args.userId,
      deal_id: args.deal?.id ?? null,
      type_id: type.id,
      title: generated.title,
      prompt,
      content: generated.content,
      status: "ready",
      missing_info: preflight.missingInfo,
      research_steps: preflight.researchSteps,
      metadata: { output_format: type.output_format, generated_by: "custom_workflow", preflight_rationale: preflight.rationale },
    })
    .select("id, title")
    .single();
  if (ins.error || !ins.data) throwDbError(ins.error, "Failed to save generated document");
  return {
    detail: `Generated "${String(ins.data.title)}".`,
    artifact: { kind: "document", label: `Open ${String(ins.data.title)}`, href: `/home/generated-documents/${String(ins.data.id)}` },
  };
}

async function runRecordUpdateStep(args: {
  admin: SupabaseClient;
  userId: string;
  deal: DealRow | null;
  step: Extract<CustomWorkflowStep, { type: "record_update" }>;
}) {
  if (!args.deal) return { detail: "Skipped because this step needs a company." };
  const meta = safeRecord(args.deal.metadata);
  meta[args.step.target] = args.step.value;
  const res = await args.admin.schema("deal_intel").from("deal").update({ metadata: meta }).eq("id", args.deal.id).eq("user_id", args.userId);
  if (res.error) throwDbError(res.error, "Failed to update record");
  return { detail: `Updated ${args.step.target}.`, artifact: { kind: "record_update" as const, label: `Updated ${args.step.target}`, detail: args.step.value } };
}

export async function runCustomWorkflow(args: {
  admin: SupabaseClient;
  userId: string;
  workflow: CustomWorkflowDefinition;
  dealId: string | null;
  input: string;
  runId?: string;
  progress?: CustomWorkflowRunProgress;
}): Promise<CustomWorkflowRunResult> {
  const deal = await loadDeal(args.admin, args.userId, args.dealId);
  let persistedRunId = args.runId ?? "";
  const stepResults: CustomWorkflowRunStepResult[] = initialRunStepResults(args.workflow);
  const artifacts: CustomWorkflowArtifact[] = [];

  if (!persistedRunId) {
    const run = await createCustomWorkflowRun({
      admin: args.admin,
      userId: args.userId,
      workflow: args.workflow,
      dealId: args.dealId,
      input: args.input,
    });
    persistedRunId = run.id;
  }
  const runId = persistedRunId || `transient-${Date.now()}`;

  async function persistRun(patch: {
    status?: CustomWorkflowRunStatus;
    summary?: string;
    errorMessage?: string | null;
  } = {}) {
    if (!persistedRunId) return;
    const update: Record<string, unknown> = {
      step_results: stepResults,
      artifacts,
    };
    if (patch.status) update.status = patch.status;
    if (patch.summary !== undefined) update.summary = patch.summary;
    if (patch.errorMessage !== undefined) update.error_message = patch.errorMessage;
    const res = await args.admin
      .schema("deal_intel")
      .from("custom_workflow_run")
      .update(update)
      .eq("id", persistedRunId)
      .eq("user_id", args.userId);
    if (res.error) throwDbError(res.error, "Failed to update workflow run");
  }

  const emit = async (fn: (() => void | Promise<void>) | undefined) => {
    try {
      await fn?.();
    } catch {
      // Progress callbacks are best-effort; do not fail the workflow run.
    }
  };

  try {
    await persistRun({ status: "running", summary: "Starting workflow...", errorMessage: null });
    await emit(() => args.progress?.onRunStart?.({ runId }));

    for (const [index, step] of args.workflow.steps.entries()) {
      stepResults[index] = {
        stepId: step.id,
        title: step.title,
        type: step.type,
        status: "running",
        detail: "Working on this step...",
        index,
        total: args.workflow.steps.length,
      };
      await persistRun({ status: "running", summary: `Running step ${index + 1} of ${args.workflow.steps.length}: ${step.title}` });
      await emit(() =>
        args.progress?.onStepStart?.({
          runId,
          stepId: step.id,
          index,
          total: args.workflow.steps.length,
          title: step.title,
          stepType: step.type,
        }),
      );

      const progressBridge: CustomWorkflowRunProgress = {
        onStepProgress: async (event) => {
          stepResults[index] = {
            ...(stepResults[index] ?? {
              stepId: step.id,
              title: step.title,
              type: step.type,
              index,
              total: args.workflow.steps.length,
            }),
            status: event.substepStatus === "failed" ? "failed" : "running",
            detail: event.detail,
            substepIndex: event.substepIndex,
            substepTotal: event.substepTotal,
            substepTask: event.substepTask,
          };
          await persistRun({
            status: "running",
            summary:
              event.substepIndex && event.substepTotal
                ? `Step ${index + 1} of ${args.workflow.steps.length}: research ${event.substepIndex} of ${event.substepTotal} - ${event.substepTask || event.detail}`
                : `Step ${index + 1} of ${args.workflow.steps.length}: ${event.detail}`,
          });
          await emit(() => args.progress?.onStepProgress?.(event));
        },
      };

      let stepResult: CustomWorkflowRunStepResult;
      let stepArtifact: CustomWorkflowArtifact | undefined;
      try {
        if (step.type === "research") {
          const result = await runResearchWorkflowStep({
            admin: args.admin,
            userId: args.userId,
            deal,
            step,
            input: args.input,
            runId,
            stepIndex: index,
            totalSteps: args.workflow.steps.length,
            progress: progressBridge,
          });
          stepResult = { stepId: step.id, title: step.title, type: step.type, status: "done", detail: result.detail, index, total: args.workflow.steps.length };
          stepArtifact = result.artifact;
        } else if (step.type === "document") {
          const result = await runDocumentStep({ admin: args.admin, userId: args.userId, deal, step, input: args.input });
          stepResult = { stepId: step.id, title: step.title, type: step.type, status: result.artifact ? "done" : "skipped", detail: result.detail, index, total: args.workflow.steps.length };
          stepArtifact = result.artifact;
        } else if (step.type === "record_update") {
          const result = await runRecordUpdateStep({ admin: args.admin, userId: args.userId, deal, step });
          stepResult = { stepId: step.id, title: step.title, type: step.type, status: "done", detail: result.detail, index, total: args.workflow.steps.length };
          stepArtifact = result.artifact;
        } else {
          const detail = step.prompt || "Manual checkpoint.";
          stepResult = { stepId: step.id, title: step.title, type: step.type, status: "skipped", detail, index, total: args.workflow.steps.length };
          stepArtifact = { kind: "checkpoint", label: step.title, detail };
        }
      } catch (e) {
        const message = formatUnknownError(e, "This step failed.");
        stepResult = {
          stepId: step.id,
          title: step.title,
          type: step.type,
          status: "failed",
          detail: message || "This step failed.",
          index,
          total: args.workflow.steps.length,
        };
      }
      stepResults[index] = stepResult;
      if (stepArtifact) artifacts.push(stepArtifact);
      await persistRun({ status: "running", summary: `Finished step ${index + 1} of ${args.workflow.steps.length}: ${step.title}` });
      await emit(() =>
        args.progress?.onStepComplete?.({
          runId,
          stepId: step.id,
          index,
          total: args.workflow.steps.length,
          status: stepResult.status === "running" || stepResult.status === "queued" ? "failed" : stepResult.status,
          detail: stepResult.detail,
          artifact: stepArtifact,
        }),
      );
    }

    if (!stepResults.length) {
      stepResults.push({
        title: "No steps configured",
        type: "workflow",
        status: "skipped",
        detail: "Add at least one step before running this workflow.",
      });
    }

    const summary = stepResults.map((s, i) => `${i + 1}. ${s.title}: ${s.detail}`).join("\n").slice(0, 4000);
    const doneOrSkipped = stepResults.some((s) => s.status === "done" || s.status === "skipped");
    const runStatus: CustomWorkflowRunStatus = stepResults.some((s) => s.status === "failed") && !doneOrSkipped ? "failed" : "done";
    await persistRun({
      status: runStatus,
      summary,
      errorMessage: runStatus === "failed" ? summary.slice(0, 1200) : null,
    });

    return { runId, summary, artifacts, stepResults };
  } catch (e) {
    const message = formatUnknownError(e, "Workflow run failed");
    await persistRun({
      status: "failed",
      summary: message,
      errorMessage: message,
    }).catch(() => null);
    throw e;
  }
}
