"use client";

import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  CircleDot,
  Database,
  FileText,
  Loader2,
  Play,
  Plus,
  Save,
  Search,
  Sparkles,
  Trash2,
  Workflow,
} from "lucide-react";
import { SelectBox } from "@/components/ui/select-box";
import { cn } from "@/lib/utils";
import type { CustomWorkflowDefinition, CustomWorkflowRunResult, CustomWorkflowStep } from "@/lib/custom-workflows";

type DealOption = { id: string; name: string };
type DocumentTypeOption = { id: string; name: string; output_format: string | null };

type Props = {
  initialWorkflows: CustomWorkflowDefinition[];
  deals: DealOption[];
  documentTypes: DocumentTypeOption[];
};

type StepKind = CustomWorkflowStep["type"];

const STEP_META: Record<StepKind, { label: string; icon: typeof Search; tone: string }> = {
  research: { label: "Research", icon: Search, tone: "bg-blue-50 text-blue-700 ring-blue-200" },
  document: { label: "Document", icon: FileText, tone: "bg-violet-50 text-violet-700 ring-violet-200" },
  record_update: { label: "Update", icon: Database, tone: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  checkpoint: { label: "Checkpoint", icon: CircleDot, tone: "bg-amber-50 text-amber-700 ring-amber-200" },
};

function id() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultStep(type: StepKind, documentTypes: DocumentTypeOption[]): CustomWorkflowStep {
  const stepId = id();
  if (type === "research") {
    return {
      id: stepId,
      type,
      title: "Research open questions",
      prompt: "Research the open diligence questions for this company.",
      mode: "plan",
      maxSteps: 4,
    };
  }
  if (type === "document") {
    return {
      id: stepId,
      type,
      title: "Create deliverable",
      prompt: "Create the requested document using saved company context and any research from prior steps.",
      typeId: documentTypes[0]?.id ?? null,
      skipResearch: true,
    };
  }
  if (type === "record_update") {
    return { id: stepId, type, title: "Save field", target: "workflow_note", value: "" };
  }
  return { id: stepId, type, title: "Review checkpoint", prompt: "Pause here for review before continuing." };
}

function starterWorkflow(documentTypes: DocumentTypeOption[]): Pick<CustomWorkflowDefinition, "id" | "name" | "description" | "trigger_hint" | "steps"> {
  return {
    id: "",
    name: "Diligence memo workflow",
    description: "Research the biggest diligence gaps, then create an IC-ready memo.",
    trigger_hint: "Use when I ask for a diligence memo, investment memo, or company diligence writeup.",
    steps: [
      {
        id: id(),
        type: "research",
        title: "Research gaps",
        prompt: "Research funding, leadership, traction, competitive positioning, and any obvious diligence gaps.",
        mode: "plan",
        maxSteps: 4,
      },
      {
        id: id(),
        type: "document",
        title: "Draft memo",
        prompt: "Draft a concise investment memo using saved context and the research results.",
        typeId: documentTypes[0]?.id ?? null,
        skipResearch: true,
      },
    ],
  };
}

function cloneWorkflow(workflow: Pick<CustomWorkflowDefinition, "id" | "name" | "description" | "trigger_hint" | "steps">) {
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    triggerHint: workflow.trigger_hint,
    steps: workflow.steps.map((step) => ({ ...step })),
  };
}

function stepSummary(step: CustomWorkflowStep): string {
  if (step.type === "research") return step.mode === "single" ? "One targeted lookup" : `Plan up to ${step.maxSteps ?? 4} searches`;
  if (step.type === "document") return step.typeId ? "Uses saved document type" : "Choose a doc type";
  if (step.type === "record_update") return step.target || "Pick a saved field";
  return "Manual review point";
}

export function WorkflowBuilder({ initialWorkflows, deals, documentTypes }: Props) {
  const initial = initialWorkflows[0] ? cloneWorkflow(initialWorkflows[0]) : cloneWorkflow(starterWorkflow(documentTypes));
  const [workflows, setWorkflows] = useState(initialWorkflows);
  const [selectedId, setSelectedId] = useState(initial.id);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [triggerHint, setTriggerHint] = useState(initial.triggerHint);
  const [steps, setSteps] = useState<CustomWorkflowStep[]>(initial.steps);
  const [selectedStepId, setSelectedStepId] = useState(initial.steps[0]?.id ?? "");
  const [dealId, setDealId] = useState(deals[0]?.id ?? "");
  const [runInput, setRunInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [runResult, setRunResult] = useState<CustomWorkflowRunResult | null>(null);

  const selectedStep = useMemo(() => steps.find((step) => step.id === selectedStepId) ?? steps[0] ?? null, [steps, selectedStepId]);
  const selectedDeal = deals.find((deal) => deal.id === dealId) ?? null;

  function loadWorkflow(workflow: CustomWorkflowDefinition) {
    const next = cloneWorkflow(workflow);
    setSelectedId(next.id);
    setName(next.name);
    setDescription(next.description);
    setTriggerHint(next.triggerHint);
    setSteps(next.steps);
    setSelectedStepId(next.steps[0]?.id ?? "");
    setRunResult(null);
    setStatus("");
  }

  function newWorkflow() {
    const next = cloneWorkflow(starterWorkflow(documentTypes));
    setSelectedId("");
    setName(next.name);
    setDescription(next.description);
    setTriggerHint(next.triggerHint);
    setSteps(next.steps);
    setSelectedStepId(next.steps[0]?.id ?? "");
    setRunResult(null);
    setStatus("");
  }

  function updateStep(stepId: string, patch: Partial<CustomWorkflowStep>) {
    setSteps((prev) => prev.map((step) => (step.id === stepId ? ({ ...step, ...patch } as CustomWorkflowStep) : step)));
  }

  function addStep(type: StepKind) {
    const step = defaultStep(type, documentTypes);
    setSteps((prev) => [...prev, step]);
    setSelectedStepId(step.id);
  }

  function moveStep(stepId: string, direction: -1 | 1) {
    setSteps((prev) => {
      const index = prev.findIndex((step) => step.id === stepId);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(index, 1);
      next.splice(nextIndex, 0, item!);
      return next;
    });
  }

  function removeStep(stepId: string) {
    setSteps((prev) => {
      const next = prev.filter((step) => step.id !== stepId);
      if (selectedStepId === stepId) setSelectedStepId(next[0]?.id ?? "");
      return next;
    });
  }

  async function saveWorkflow() {
    setSaving(true);
    setStatus("");
    try {
      const res = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selectedId || undefined, name, description, triggerHint, steps }),
      });
      const data = (await res.json().catch(() => ({}))) as { workflow?: CustomWorkflowDefinition; workflows?: CustomWorkflowDefinition[]; error?: string };
      if (!res.ok || !data.workflow) throw new Error(data.error || "Failed to save workflow");
      setSelectedId(data.workflow.id);
      setWorkflows(data.workflows ?? [data.workflow, ...workflows.filter((w) => w.id !== data.workflow!.id)]);
      setStatus("Workflow saved. Chat can now route to it when the request matches.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Failed to save workflow");
    } finally {
      setSaving(false);
    }
  }

  async function runWorkflow() {
    if (!selectedId) {
      setStatus("Save this workflow before running it.");
      return;
    }
    setRunning(true);
    setStatus("");
    setRunResult(null);
    try {
      const res = await fetch(`/api/workflows/${selectedId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealId: dealId || null, input: runInput }),
      });
      const data = (await res.json().catch(() => ({}))) as { result?: CustomWorkflowRunResult; error?: string };
      if (!res.ok || !data.result) throw new Error(data.error || "Workflow failed");
      setRunResult(data.result);
      setStatus(`Ran ${name}${selectedDeal ? ` for ${selectedDeal.name}` : ""}.`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Workflow failed");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-[28px] border border-zinc-200 bg-white shadow-sm">
        <div className="flex flex-col gap-5 border-b border-zinc-100 px-5 py-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1 text-xs font-medium text-zinc-600">
              <Workflow className="h-3.5 w-3.5" />
              Reusable workflows
            </div>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-950">Build repeatable diligence playbooks</h1>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-zinc-500">
              Chain research, document generation, record updates, and checkpoints into a saved workflow. Chat can run these automatically when a request matches the workflow trigger.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={newWorkflow}
              className="inline-flex h-10 items-center gap-2 rounded-full border border-zinc-200 bg-white px-4 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
            >
              <Plus className="h-4 w-4" />
              New workflow
            </button>
            <button
              type="button"
              onClick={saveWorkflow}
              disabled={saving || !name.trim() || steps.length === 0}
              className="inline-flex h-10 items-center gap-2 rounded-full bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save
            </button>
          </div>
        </div>

        <div className="grid min-h-[680px] grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)_360px]">
          <aside className="border-b border-zinc-100 bg-zinc-50/60 p-4 lg:border-b-0 lg:border-r">
            <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Saved workflows</div>
            <div className="space-y-2">
              {workflows.map((workflow) => (
                <button
                  key={workflow.id}
                  type="button"
                  onClick={() => loadWorkflow(workflow)}
                  className={cn(
                    "w-full rounded-2xl border px-3 py-3 text-left transition-colors",
                    workflow.id === selectedId
                      ? "border-zinc-900 bg-white shadow-sm"
                      : "border-transparent bg-white/70 hover:border-zinc-200 hover:bg-white",
                  )}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-sm font-semibold text-zinc-950">{workflow.name}</span>
                    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-500">{workflow.steps.length}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-500">{workflow.description || workflow.trigger_hint || "No description yet."}</p>
                </button>
              ))}
              {!workflows.length ? (
                <div className="rounded-2xl border border-dashed border-zinc-200 bg-white px-3 py-6 text-center text-xs text-zinc-500">
                  Save your first workflow and it will appear here.
                </div>
              ) : null}
            </div>
          </aside>

          <main className="min-w-0 bg-white p-5">
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <label className="block">
                <span className="text-xs font-medium text-zinc-600">Workflow name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1 h-11 w-full rounded-2xl border border-zinc-200 bg-white px-3 text-sm outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-900/10"
                  placeholder="e.g. IC memo workflow"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-zinc-600">Chat trigger</span>
                <input
                  value={triggerHint}
                  onChange={(e) => setTriggerHint(e.target.value)}
                  className="mt-1 h-11 w-full rounded-2xl border border-zinc-200 bg-white px-3 text-sm outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-900/10"
                  placeholder="When should chat use this?"
                />
              </label>
              <label className="block md:col-span-2">
                <span className="text-xs font-medium text-zinc-600">Description</span>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="mt-1 min-h-[74px] w-full resize-none rounded-2xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-900/10"
                  placeholder="What this workflow does and what output it should create."
                />
              </label>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-2">
              {(["research", "document", "record_update", "checkpoint"] as StepKind[]).map((type) => {
                const meta = STEP_META[type];
                const Icon = meta.icon;
                return (
                  <button
                    key={type}
                    type="button"
                    onClick={() => addStep(type)}
                    className="inline-flex h-9 items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                  >
                    <Icon className="h-3.5 w-3.5" />
                    Add {meta.label}
                  </button>
                );
              })}
            </div>

            <div className="mt-5 rounded-[24px] border border-zinc-200 bg-zinc-50/60 p-4">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-zinc-950">Workflow canvas</p>
                  <p className="text-xs text-zinc-500">Steps run top to bottom. Chat passes the user request into every step.</p>
                </div>
                <Sparkles className="h-4 w-4 text-zinc-400" />
              </div>
              <div className="space-y-3">
                {steps.map((step, index) => {
                  const meta = STEP_META[step.type];
                  const Icon = meta.icon;
                  const active = selectedStep?.id === step.id;
                  return (
                    <div key={step.id} className="relative">
                      {index > 0 ? <div className="absolute -top-3 left-8 h-3 w-px bg-zinc-200" /> : null}
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => setSelectedStepId(step.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setSelectedStepId(step.id);
                          }
                        }}
                        className={cn(
                          "flex w-full cursor-pointer items-center gap-3 rounded-[22px] border bg-white p-3 text-left shadow-sm outline-none transition-colors",
                          active ? "border-zinc-900 ring-4 ring-zinc-900/5" : "border-zinc-200 hover:border-zinc-300",
                        )}
                      >
                        <span className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ring-1", meta.tone)}>
                          <Icon className="h-5 w-5" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Step {index + 1}</span>
                            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-500">{meta.label}</span>
                          </span>
                          <span className="mt-1 block truncate text-sm font-semibold text-zinc-950">{step.title}</span>
                          <span className="mt-0.5 block truncate text-xs text-zinc-500">{stepSummary(step)}</span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              moveStep(step.id, -1);
                            }}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900"
                          >
                            <ArrowUp className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              moveStep(step.id, 1);
                            }}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900"
                          >
                            <ArrowDown className="h-4 w-4" />
                          </button>
                        </span>
                      </div>
                    </div>
                  );
                })}
                {!steps.length ? (
                  <div className="rounded-[22px] border border-dashed border-zinc-200 bg-white px-4 py-12 text-center text-sm text-zinc-500">
                    Add a step to begin building the workflow.
                  </div>
                ) : null}
              </div>
            </div>
          </main>

          <aside className="border-t border-zinc-100 bg-zinc-50/70 p-4 lg:border-l lg:border-t-0">
            <div className="rounded-[24px] border border-zinc-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-zinc-950">Step settings</p>
                  <p className="text-xs text-zinc-500">Configure the selected node.</p>
                </div>
                {selectedStep ? (
                  <button
                    type="button"
                    onClick={() => removeStep(selectedStep.id)}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full text-zinc-400 hover:bg-red-50 hover:text-red-600"
                    title="Delete step"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                ) : null}
              </div>

              {selectedStep ? (
                <div className="mt-4 space-y-3">
                  <label className="block">
                    <span className="text-xs font-medium text-zinc-600">Step title</span>
                    <input
                      value={selectedStep.title}
                      onChange={(e) => updateStep(selectedStep.id, { title: e.target.value })}
                      className="mt-1 h-10 w-full rounded-2xl border border-zinc-200 px-3 text-sm outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-900/10"
                    />
                  </label>

                  {selectedStep.type === "research" ? (
                    <>
                      <label className="block">
                        <span className="text-xs font-medium text-zinc-600">Research focus</span>
                        <textarea
                          value={selectedStep.prompt}
                          onChange={(e) => updateStep(selectedStep.id, { prompt: e.target.value })}
                          className="mt-1 min-h-[110px] w-full resize-none rounded-2xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-900/10"
                        />
                      </label>
                      <div className="grid grid-cols-[1fr_90px] gap-2">
                        <label className="block">
                          <span className="text-xs font-medium text-zinc-600">Mode</span>
                          <SelectBox value={selectedStep.mode ?? "plan"} onChange={(e) => updateStep(selectedStep.id, { mode: e.target.value as "plan" | "single" })} wrapperClassName="mt-1">
                            <option value="plan">Plan research</option>
                            <option value="single">Single lookup</option>
                          </SelectBox>
                        </label>
                        <label className="block">
                          <span className="text-xs font-medium text-zinc-600">Max</span>
                          <input
                            type="number"
                            min={1}
                            max={8}
                            value={selectedStep.maxSteps ?? 4}
                            onChange={(e) => updateStep(selectedStep.id, { maxSteps: Number(e.target.value) || 4 })}
                            className="mt-1 h-10 w-full rounded-2xl border border-zinc-200 px-3 text-sm outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-900/10"
                          />
                        </label>
                      </div>
                    </>
                  ) : null}

                  {selectedStep.type === "document" ? (
                    <>
                      <label className="block">
                        <span className="text-xs font-medium text-zinc-600">Document type</span>
                        <SelectBox value={selectedStep.typeId ?? ""} onChange={(e) => updateStep(selectedStep.id, { typeId: e.target.value || null })} wrapperClassName="mt-1">
                          <option value="">Choose document type</option>
                          {documentTypes.map((type) => (
                            <option key={type.id} value={type.id}>
                              {type.name}{type.output_format ? ` (${type.output_format.toLowerCase() === "docx" ? "Word document" : type.output_format.toLowerCase() === "text" ? "Plain text" : "PDF"})` : ""}
                            </option>
                          ))}
                        </SelectBox>
                      </label>
                      <label className="block">
                        <span className="text-xs font-medium text-zinc-600">Generation prompt</span>
                        <textarea
                          value={selectedStep.prompt}
                          onChange={(e) => updateStep(selectedStep.id, { prompt: e.target.value })}
                          className="mt-1 min-h-[120px] w-full resize-none rounded-2xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-900/10"
                        />
                      </label>
                    </>
                  ) : null}

                  {selectedStep.type === "record_update" ? (
                    <>
                      <label className="block">
                        <span className="text-xs font-medium text-zinc-600">Metadata field</span>
                        <input
                          value={selectedStep.target}
                          onChange={(e) => updateStep(selectedStep.id, { target: e.target.value })}
                          className="mt-1 h-10 w-full rounded-2xl border border-zinc-200 px-3 text-sm outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-900/10"
                          placeholder="e.g. diligence_status"
                        />
                      </label>
                      <label className="block">
                        <span className="text-xs font-medium text-zinc-600">Value</span>
                        <textarea
                          value={selectedStep.value}
                          onChange={(e) => updateStep(selectedStep.id, { value: e.target.value })}
                          className="mt-1 min-h-[100px] w-full resize-none rounded-2xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-900/10"
                        />
                      </label>
                    </>
                  ) : null}

                  {selectedStep.type === "checkpoint" ? (
                    <label className="block">
                      <span className="text-xs font-medium text-zinc-600">Checkpoint note</span>
                      <textarea
                        value={selectedStep.prompt}
                        onChange={(e) => updateStep(selectedStep.id, { prompt: e.target.value })}
                        className="mt-1 min-h-[120px] w-full resize-none rounded-2xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-900/10"
                      />
                    </label>
                  ) : null}
                </div>
              ) : (
                <div className="mt-4 rounded-2xl bg-zinc-50 px-3 py-8 text-center text-xs text-zinc-500">Select a workflow step to edit it.</div>
              )}
            </div>

            <div className="mt-4 rounded-[24px] border border-zinc-200 bg-white p-4 shadow-sm">
              <div className="flex items-center gap-2">
                <Play className="h-4 w-4 text-zinc-500" />
                <p className="text-sm font-semibold text-zinc-950">Run workflow</p>
              </div>
              <div className="mt-4 space-y-3">
                <SelectBox value={dealId} onChange={(e) => setDealId(e.target.value)}>
                  <option value="">No company</option>
                  {deals.map((deal) => (
                    <option key={deal.id} value={deal.id}>
                      {deal.name}
                    </option>
                  ))}
                </SelectBox>
                <textarea
                  value={runInput}
                  onChange={(e) => setRunInput(e.target.value)}
                  className="min-h-[92px] w-full resize-none rounded-2xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-900/10"
                  placeholder="Optional instructions for this run"
                />
                <button
                  type="button"
                  onClick={runWorkflow}
                  disabled={running || !selectedId}
                  className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-full bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                  Run saved workflow
                </button>
              </div>
              {status ? <p className="mt-3 text-xs leading-5 text-zinc-500">{status}</p> : null}
              {runResult ? (
                <div className="mt-4 space-y-2 border-t border-zinc-100 pt-4">
                  <div className="flex items-center gap-2 text-xs font-semibold text-zinc-950">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    Steps completed
                  </div>
                  {runResult.stepResults.map((step, index) => (
                    <div key={`${step.title}-${index}`} className="rounded-2xl bg-zinc-50 px-3 py-2 text-xs">
                      <div className="font-medium text-zinc-900">{index + 1}. {step.title}</div>
                      <div className="mt-1 line-clamp-3 text-zinc-500">{step.detail}</div>
                    </div>
                  ))}
                  {runResult.artifacts.length ? (
                    <div className="flex flex-col gap-2 pt-1">
                      {runResult.artifacts.map((artifact, index) =>
                        artifact.href ? (
                          <a key={`${artifact.label}-${index}`} href={artifact.href} className="text-xs font-medium text-blue-700 hover:underline">
                            {artifact.label}
                          </a>
                        ) : (
                          <span key={`${artifact.label}-${index}`} className="text-xs text-zinc-500">{artifact.label}</span>
                        ),
                      )}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
}
