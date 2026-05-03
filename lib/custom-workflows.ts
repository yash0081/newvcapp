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

export type CustomWorkflowRunResult = {
  runId: string;
  summary: string;
  artifacts: CustomWorkflowArtifact[];
  stepResults: Array<{ title: string; type: string; status: "done" | "skipped" | "failed"; detail: string }>;
};

type DealRow = { id: string; metadata: Record<string, unknown> | null };

function safeRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
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

export async function loadCustomWorkflowDefinition(admin: SupabaseClient, userId: string, workflowId: string) {
  const res = await admin
    .schema("deal_intel")
    .from("custom_workflow_definition")
    .select("id, user_id, name, description, trigger_hint, steps, metadata, created_at, updated_at")
    .eq("id", workflowId)
    .eq("user_id", userId)
    .maybeSingle();
  if (res.error) throw res.error;
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
  if (res.error) throw res.error;
  return (res.data as DealRow | null) ?? null;
}

async function runResearchWorkflowStep(args: {
  admin: SupabaseClient;
  userId: string;
  deal: DealRow | null;
  step: Extract<CustomWorkflowStep, { type: "research" }>;
  input: string;
}): Promise<{ detail: string; artifact?: CustomWorkflowArtifact }> {
  if (!args.deal) return { detail: "Skipped because this step needs a company." };
  const dealId = args.deal.id;
  const meta = safeRecord(args.deal.metadata);
  const name = companyName(args.deal);
  const focus = [args.step.prompt, args.input].filter(Boolean).join("\n").trim();
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
  const tasks =
    args.step.mode === "single"
      ? [{ website: "web", task: focus || args.step.title, category: "general" }]
      : (await (async () => {
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
          return plan.steps.slice(0, args.step.maxSteps ?? 4);
        })());

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
  if (wf.error || !wf.data) throw wf.error ?? new Error("Failed to create research workflow");
  const workflowId = String(wf.data.id);

  const stepRows = tasks.map((task, i) => ({
    workflow_id: workflowId,
    position: i,
    status: "running",
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
  if (inserted.error) throw inserted.error;

  const notes: string[] = [];
  for (const researchStep of (inserted.data ?? []) as Array<{ id: string; website: string; task: string }>) {
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
    if (runIns.error || !runIns.data) throw runIns.error ?? new Error("Failed to create research run");
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
  if (ins.error || !ins.data) throw ins.error ?? new Error("Failed to save generated document");
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
  if (res.error) throw res.error;
  return { detail: `Updated ${args.step.target}.`, artifact: { kind: "record_update" as const, label: `Updated ${args.step.target}`, detail: args.step.value } };
}

export async function runCustomWorkflow(args: {
  admin: SupabaseClient;
  userId: string;
  workflow: CustomWorkflowDefinition;
  dealId: string | null;
  input: string;
}): Promise<CustomWorkflowRunResult> {
  const deal = await loadDeal(args.admin, args.userId, args.dealId);
  const runIns = await args.admin
    .schema("deal_intel")
    .from("custom_workflow_run")
    .insert({ workflow_id: args.workflow.id, user_id: args.userId, deal_id: deal?.id ?? null, status: "running", input: args.input })
    .select("id")
    .single();
  if (runIns.error || !runIns.data) throw runIns.error ?? new Error("Failed to create workflow run");
  const runId = String(runIns.data.id);
  const stepResults: CustomWorkflowRunResult["stepResults"] = [];
  const artifacts: CustomWorkflowArtifact[] = [];

  try {
    for (const step of args.workflow.steps) {
      if (step.type === "research") {
        const result = await runResearchWorkflowStep({ admin: args.admin, userId: args.userId, deal, step, input: args.input });
        stepResults.push({ title: step.title, type: step.type, status: "done", detail: result.detail });
        if (result.artifact) artifacts.push(result.artifact);
      } else if (step.type === "document") {
        const result = await runDocumentStep({ admin: args.admin, userId: args.userId, deal, step, input: args.input });
        stepResults.push({ title: step.title, type: step.type, status: result.artifact ? "done" : "skipped", detail: result.detail });
        if (result.artifact) artifacts.push(result.artifact);
      } else if (step.type === "record_update") {
        const result = await runRecordUpdateStep({ admin: args.admin, userId: args.userId, deal, step });
        stepResults.push({ title: step.title, type: step.type, status: "done", detail: result.detail });
        if (result.artifact) artifacts.push(result.artifact);
      } else {
        const detail = step.prompt || "Manual checkpoint.";
        stepResults.push({ title: step.title, type: step.type, status: "skipped", detail });
        artifacts.push({ kind: "checkpoint", label: step.title, detail });
      }
    }
    const summary = stepResults.map((s, i) => `${i + 1}. ${s.title}: ${s.detail}`).join("\n").slice(0, 4000);
    await args.admin.schema("deal_intel").from("custom_workflow_run").update({
      status: "done",
      summary,
      step_results: stepResults,
      artifacts,
    }).eq("id", runId).eq("user_id", args.userId);
    return { runId, summary, artifacts, stepResults };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await args.admin.schema("deal_intel").from("custom_workflow_run").update({
      status: "failed",
      error_message: message,
      step_results: stepResults,
      artifacts,
    }).eq("id", runId).eq("user_id", args.userId);
    throw e;
  }
}
