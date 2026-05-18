"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  CircleDot,
  Database,
  FileText,
  GripVertical,
  Loader2,
  Play,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Workflow,
} from "lucide-react";
import { SelectBox } from "@/components/ui/select-box";
import { documentOutputFormatLabel } from "@/lib/document-generation/output-format-label";
import { cn } from "@/lib/utils";
import type { CustomWorkflowDefinition, CustomWorkflowRunRecord, CustomWorkflowRunResult, CustomWorkflowStep } from "@/lib/custom-workflows";

type DealOption = { id: string; name: string };
type DocumentTypeOption = { id: string; name: string; output_format: string | null };

type Props = {
  initialWorkflows: CustomWorkflowDefinition[];
  initialRuns: CustomWorkflowRunRecord[];
  deals: DealOption[];
  documentTypes: DocumentTypeOption[];
};

type StepKind = CustomWorkflowStep["type"];
type SavePayload = { name: string; description: string; steps: CustomWorkflowStep[] };
type RunStepStatus = "queued" | "running" | "done" | "skipped" | "failed";
type RunStepState = {
  id: string;
  title: string;
  stepType: CustomWorkflowStep["type"];
  summary: string;
  status: RunStepStatus;
  detail?: string;
};
type WorkflowRunResponse = { run?: CustomWorkflowRunRecord; error?: string };

const STEP_META: Record<StepKind, { label: string; icon: typeof Search; tone: string }> = {
  research: { label: "Research", icon: Search, tone: "bg-blue-50 text-blue-700 ring-blue-200" },
  document: { label: "Document", icon: FileText, tone: "bg-violet-50 text-violet-700 ring-violet-200" },
  record_update: { label: "Update", icon: Database, tone: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  checkpoint: { label: "Checkpoint", icon: CircleDot, tone: "bg-amber-50 text-amber-700 ring-amber-200" },
};
const ADDABLE_STEP_TYPES: StepKind[] = ["research", "document", "checkpoint"];

function id() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isLocalId(workflowId: string) {
  return workflowId.startsWith("local-");
}

function makeDefinition(args: {
  id: string;
  name: string;
  description?: string;
  steps?: CustomWorkflowStep[];
}): CustomWorkflowDefinition {
  const now = new Date().toISOString();
  return {
    id: args.id,
    user_id: "",
    name: args.name,
    description: args.description ?? "",
    trigger_hint: "",
    steps: args.steps ?? [],
    metadata: {},
    created_at: now,
    updated_at: now,
  };
}

function untitledName(workflows: CustomWorkflowDefinition[]) {
  const base = "Untitled workflow";
  const names = new Set(workflows.map((workflow) => workflow.name.trim().toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base} ${i}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now()}`;
}

function defaultStep(type: StepKind, documentTypes: DocumentTypeOption[]): CustomWorkflowStep {
  const stepId = id();
  if (type === "research") {
    return {
      id: stepId,
      type,
      title: "Run research plan",
      prompt: "Generate and run a research plan for the open diligence questions on this company.",
      mode: "plan",
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

function cloneWorkflow(workflow: CustomWorkflowDefinition) {
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    steps: workflow.steps.map((step) => ({ ...step })),
  };
}

function payloadSnapshot(payload: SavePayload) {
  return JSON.stringify(payload);
}

function stepSummary(step: CustomWorkflowStep): string {
  if (step.type === "research") return "Generates and runs a research plan";
  if (step.type === "document") return step.typeId ? "Uses saved document type" : "Choose a doc type";
  if (step.type === "record_update") return step.target || "Pick a saved field";
  return "Manual review point";
}

function resultTone(status: RunStepStatus) {
  if (status === "done") return "border-emerald-200 bg-emerald-50 text-emerald-900";
  if (status === "failed") return "border-red-200 bg-red-50 text-red-900";
  if (status === "running") return "border-blue-200 bg-blue-50 text-blue-900";
  return "border-zinc-200 bg-zinc-50 text-zinc-700";
}

function runStepTone(status: RunStepStatus, active: boolean, running: boolean) {
  if (active) return "scale-100 border-white bg-white text-zinc-950 opacity-100 shadow-2xl shadow-black/30 blur-0";
  if (status === "done") return running ? "scale-95 border-emerald-300/40 bg-emerald-300/10 text-emerald-100 opacity-55 blur-[0.3px]" : "border-emerald-200 bg-emerald-50 text-emerald-950";
  if (status === "failed") return running ? "scale-95 border-red-300/40 bg-red-300/10 text-red-100 opacity-65 blur-[0.3px]" : "border-red-200 bg-red-50 text-red-950";
  if (status === "skipped") return running ? "scale-95 border-zinc-500/40 bg-white/5 text-zinc-300 opacity-45 blur-[0.3px]" : "border-zinc-200 bg-zinc-50 text-zinc-700";
  return running ? "scale-95 border-white/10 bg-white/5 text-zinc-300 opacity-40 blur-[0.5px]" : "border-zinc-200 bg-white text-zinc-800";
}

function runStepStatusLabel(status: RunStepStatus) {
  if (status === "running") return "Running";
  if (status === "done") return "Done";
  if (status === "failed") return "Failed";
  if (status === "skipped") return "Skipped";
  return "Queued";
}

function runStatusLabel(status: CustomWorkflowRunRecord["status"]) {
  if (status === "running") return "Running";
  if (status === "failed") return "Failed";
  return "Done";
}

function runStatusTone(status: CustomWorkflowRunRecord["status"]) {
  if (status === "running") return "bg-blue-50 text-blue-700 ring-blue-200";
  if (status === "failed") return "bg-red-50 text-red-700 ring-red-200";
  return "bg-emerald-50 text-emerald-700 ring-emerald-200";
}

function runToStepStates(run: CustomWorkflowRunRecord | null): RunStepState[] {
  if (!run) return [];
  return run.stepResults.map((step, index) => ({
    id: step.stepId ?? `${run.id}-${index}`,
    title: step.title,
    stepType: (["research", "document", "record_update", "checkpoint"].includes(String(step.type)) ? step.type : "checkpoint") as CustomWorkflowStep["type"],
    summary: step.detail || "Queued",
    status: step.status,
    detail: step.detail,
  }));
}

export function WorkflowBuilder({ initialWorkflows, initialRuns, deals, documentTypes }: Props) {
  const first = initialWorkflows[0] ? cloneWorkflow(initialWorkflows[0]) : null;
  const [workflows, setWorkflows] = useState(initialWorkflows);
  const [selectedId, setSelectedId] = useState(first?.id ?? "");
  const [name, setName] = useState(first?.name ?? "");
  const [description, setDescription] = useState(first?.description ?? "");
  const [steps, setSteps] = useState<CustomWorkflowStep[]>(first?.steps ?? []);
  const [selectedStepId, setSelectedStepId] = useState(first?.steps[0]?.id ?? "");
  const [dealId, setDealId] = useState(deals[0]?.id ?? "");
  const [runInput, setRunInput] = useState("");
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [savingState, setSavingState] = useState(first ? "Saved" : "No workflow selected");
  const [startingRun, setStartingRun] = useState(false);
  const [runStatus, setRunStatus] = useState("");
  const [runs, setRuns] = useState(initialRuns);
  const [selectedRunId, setSelectedRunId] = useState(initialRuns[0]?.id ?? "");
  const [draggingStepId, setDraggingStepId] = useState<string | null>(null);
  const [dragOverStepId, setDragOverStepId] = useState<string | null>(null);

  const initialPayload = first
    ? { name: first.name, description: first.description, steps: first.steps }
    : { name: "", description: "", steps: [] };
  const lastSavedSnapshotRef = useRef(payloadSnapshot(initialPayload));
  const editorRef = useRef({ selectedId, name, description, steps });
  const runStepRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const selectedStep = useMemo(() => steps.find((step) => step.id === selectedStepId) ?? steps[0] ?? null, [steps, selectedStepId]);
  const selectedDeal = deals.find((deal) => deal.id === dealId) ?? null;
  const selectedIsLocal = Boolean(selectedId && isLocalId(selectedId));
  const selectedRun = useMemo(() => runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null, [runs, selectedRunId]);
  const runSteps = useMemo(() => runToStepStates(selectedRun), [selectedRun]);
  const activeRunStepId = useMemo(() => runSteps.find((step) => step.status === "running")?.id ?? null, [runSteps]);
  const runResult = useMemo<CustomWorkflowRunResult | null>(() => {
    if (!selectedRun || selectedRun.status === "running") return null;
    return {
      runId: selectedRun.id,
      summary: selectedRun.summary,
      artifacts: selectedRun.artifacts,
      stepResults: selectedRun.stepResults,
    };
  }, [selectedRun]);
  const activeRuns = useMemo(() => runs.filter((run) => run.status === "running"), [runs]);
  const runningByWorkflowId = useMemo(() => {
    const counts = new Map<string, number>();
    for (const run of activeRuns) {
      if (!run.workflowId) continue;
      counts.set(run.workflowId, (counts.get(run.workflowId) ?? 0) + 1);
    }
    return counts;
  }, [activeRuns]);

  useEffect(() => {
    if (!activeRunStepId) return;
    const timer = window.setTimeout(() => {
      runStepRefs.current[activeRunStepId]?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [activeRunStepId]);

  const currentPayload = useCallback(
    (values?: Partial<SavePayload>): SavePayload => ({
      name: (values?.name ?? name).trim() || "Untitled workflow",
      description: (values?.description ?? description).trim().slice(0, 2000),
      steps: values?.steps ?? steps,
    }),
    [description, name, steps],
  );

  const selectWorkflow = useCallback((workflow: CustomWorkflowDefinition | null) => {
    if (!workflow) {
      setSelectedId("");
      setName("");
      setDescription("");
      setSteps([]);
      setSelectedStepId("");
      setRunStatus("");
      setSavingState("No workflow selected");
      lastSavedSnapshotRef.current = payloadSnapshot({ name: "", description: "", steps: [] });
      return;
    }
    const next = cloneWorkflow(workflow);
    setSelectedId(next.id);
    setName(next.name);
    setDescription(next.description);
    setSteps(next.steps);
    setSelectedStepId(next.steps[0]?.id ?? "");
    setRunStatus("");
    setSavingState("Saved");
    lastSavedSnapshotRef.current = payloadSnapshot({ name: next.name, description: next.description, steps: next.steps });
  }, []);

  const persistWorkflow = useCallback(async (workflowId: string | null, payload: SavePayload) => {
    const res = await fetch("/api/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: workflowId && !isLocalId(workflowId) ? workflowId : undefined,
        name: payload.name,
        description: payload.description,
        triggerHint: "",
        steps: payload.steps,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      workflow?: CustomWorkflowDefinition;
      workflows?: CustomWorkflowDefinition[];
      error?: string;
    };
    if (!res.ok || !data.workflow) throw new Error(data.error || "Failed to save workflow");
    setWorkflows(data.workflows ?? []);
    return data.workflow;
  }, []);

  useEffect(() => {
    editorRef.current = { selectedId, name, description, steps };
    if (!selectedId) return;
    setWorkflows((prev) =>
      prev.map((workflow) =>
        workflow.id === selectedId
          ? {
              ...workflow,
              name: name.trim() || "Untitled workflow",
              description,
              trigger_hint: "",
              steps,
            }
          : workflow,
      ),
    );
  }, [description, name, selectedId, steps]);

  useEffect(() => {
    if (!selectedId || selectedIsLocal) return;
    const payload = currentPayload();
    const snapshot = payloadSnapshot(payload);
    if (snapshot === lastSavedSnapshotRef.current) return;
    setSavingState("Saving...");
    const timer = window.setTimeout(async () => {
      try {
        await persistWorkflow(selectedId, payload);
        lastSavedSnapshotRef.current = snapshot;
        setSavingState("Saved");
      } catch (e) {
        setSavingState(e instanceof Error ? e.message : "Autosave failed");
      }
    }, 750);
    return () => window.clearTimeout(timer);
  }, [currentPayload, persistWorkflow, selectedId, selectedIsLocal]);

  async function newWorkflow() {
    const localId = `local-${id()}`;
    const payload = { name: untitledName(workflows), description: "", steps: [] };
    const localWorkflow = makeDefinition({ id: localId, ...payload });
    setCreating(true);
    setWorkflows((prev) => [localWorkflow, ...prev]);
    selectWorkflow(localWorkflow);
    setSavingState("Creating...");
    try {
      const saved = await persistWorkflow(null, payload);
      const current = editorRef.current;
      setWorkflows((prev) => prev.map((workflow) => (workflow.id === localId ? { ...saved, ...workflow, id: saved.id } : workflow)));
      if (current.selectedId === localId) {
        setSelectedId(saved.id);
        lastSavedSnapshotRef.current = payloadSnapshot(payload);
        setSavingState("Saved");
      }
    } catch (e) {
      setWorkflows((prev) => prev.filter((workflow) => workflow.id !== localId));
      selectWorkflow(workflows[0] ?? null);
      setSavingState(e instanceof Error ? e.message : "Failed to create workflow");
    } finally {
      setCreating(false);
    }
  }

  async function deleteWorkflow(workflowId: string) {
    if (!workflowId || deletingId) return;
    setDeletingId(workflowId);
    setRunStatus("");
    const wasSelected = workflowId === selectedId;
    const optimistic = workflows.filter((workflow) => workflow.id !== workflowId);
    setWorkflows(optimistic);
    if (wasSelected) selectWorkflow(optimistic[0] ?? null);
    try {
      if (!isLocalId(workflowId)) {
        const res = await fetch(`/api/workflows/${workflowId}`, { method: "DELETE" });
        const data = (await res.json().catch(() => ({}))) as { workflows?: CustomWorkflowDefinition[]; error?: string };
        if (!res.ok) throw new Error(data.error || "Failed to delete workflow");
        const next = data.workflows ?? optimistic;
        setWorkflows(next);
        if (wasSelected) selectWorkflow(next[0] ?? null);
      }
    } catch (e) {
      setSavingState(e instanceof Error ? e.message : "Failed to delete workflow");
      setWorkflows(workflows);
      if (wasSelected) {
        const restored = workflows.find((workflow) => workflow.id === workflowId) ?? workflows[0] ?? null;
        selectWorkflow(restored);
      }
    } finally {
      setDeletingId(null);
    }
  }

  function updateStep(stepId: string, patch: Partial<CustomWorkflowStep>) {
    setSteps((prev) => prev.map((step) => (step.id === stepId ? ({ ...step, ...patch } as CustomWorkflowStep) : step)));
  }

  function addStep(type: StepKind) {
    const step = defaultStep(type, documentTypes);
    setSteps((prev) => [...prev, step]);
    setSelectedStepId(step.id);
  }

  function reorderDraggedStep(targetStepId: string) {
    if (!draggingStepId || draggingStepId === targetStepId) return;
    setSteps((prev) => {
      const fromIndex = prev.findIndex((step) => step.id === draggingStepId);
      const toIndex = prev.findIndex((step) => step.id === targetStepId);
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return prev;
      const next = [...prev];
      const [item] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, item!);
      return next;
    });
    setDragOverStepId(null);
    setDraggingStepId(null);
  }

  function removeStep(stepId: string) {
    setSteps((prev) => {
      const next = prev.filter((step) => step.id !== stepId);
      if (selectedStepId === stepId) setSelectedStepId(next[0]?.id ?? "");
      return next;
    });
  }

  async function flushSaveIfNeeded() {
    if (!selectedId || selectedIsLocal) throw new Error("Wait for the workflow to finish creating.");
    const payload = currentPayload();
    const snapshot = payloadSnapshot(payload);
    if (snapshot === lastSavedSnapshotRef.current) return;
    setSavingState("Saving...");
    await persistWorkflow(selectedId, payload);
    lastSavedSnapshotRef.current = snapshot;
    setSavingState("Saved");
  }

  const refreshRuns = useCallback(async () => {
    const res = await fetch("/api/workflows/runs?limit=50", { cache: "no-store" });
    const data = (await res.json().catch(() => ({}))) as { runs?: CustomWorkflowRunRecord[]; error?: string };
    if (!res.ok) throw new Error(data.error || "Failed to refresh workflow runs");
    const next = data.runs ?? [];
    setRuns(next);
    setSelectedRunId((current) => (current && next.some((run) => run.id === current) ? current : next[0]?.id ?? ""));
  }, []);

  useEffect(() => {
    const hasRunning = runs.some((run) => run.status === "running");
    if (!hasRunning) return;
    const timer = window.setInterval(() => {
      void refreshRuns().catch(() => null);
    }, 2200);
    return () => window.clearInterval(timer);
  }, [refreshRuns, runs]);

  async function runWorkflow() {
    if (!selectedId || selectedIsLocal) {
      setRunStatus("Wait for this workflow to finish creating.");
      return;
    }
    if (!steps.length) {
      setRunStatus("Add at least one step before running this workflow.");
      return;
    }
    setStartingRun(true);
    setRunStatus("Starting workflow run...");
    try {
      await flushSaveIfNeeded();
      const res = await fetch(`/api/workflows/${selectedId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealId: dealId || null, input: runInput }),
      });
      const data = (await res.json().catch(() => ({}))) as WorkflowRunResponse;
      if (!res.ok || !data.run) throw new Error(data.error || "Workflow failed");
      setRuns((prev) => [data.run!, ...prev.filter((run) => run.id !== data.run!.id)]);
      setSelectedRunId(data.run.id);
      setRunStatus(`Started ${name || "workflow"}${selectedDeal ? ` for ${selectedDeal.name}` : ""}. You can leave this page and it will keep running.`);
      void refreshRuns().catch(() => null);
    } catch (e) {
      setRunStatus(e instanceof Error ? e.message : "Workflow failed");
    } finally {
      setStartingRun(false);
    }
  }

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-[28px] border border-zinc-200 bg-white shadow-sm">
        <div className="flex flex-col gap-5 border-b border-zinc-100 px-5 py-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1 text-xs font-medium text-zinc-600">
              <Workflow className="h-3.5 w-3.5" />
              Workflow builder
            </div>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-950">Build repeatable diligence playbooks</h1>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-zinc-500">
              Chain research, document generation, and checkpoints into reusable workflows. Chat can decide when a saved workflow fits based on its name, description, and steps.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-600">{savingState}</span>
            {selectedId ? (
              <button
                type="button"
                onClick={() => void deleteWorkflow(selectedId)}
                disabled={Boolean(deletingId)}
                className="inline-flex h-10 items-center gap-2 rounded-full border border-zinc-200 bg-white px-4 text-sm font-medium text-zinc-700 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {deletingId === selectedId ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Delete
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void newWorkflow()}
              disabled={creating}
              className="inline-flex h-10 items-center gap-2 rounded-full bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              New workflow
            </button>
          </div>
        </div>

        <div className="grid min-h-[620px] grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)]">
          <aside className="border-b border-zinc-100 bg-zinc-50/70 p-4 lg:border-b-0 lg:border-r">
            <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Workflows</div>
            <div className="space-y-2">
              {workflows.map((workflow) => {
                const active = workflow.id === selectedId;
                const runningCount = runningByWorkflowId.get(workflow.id) ?? 0;
                return (
                  <div
                    key={workflow.id}
                    className={cn(
                      "flex items-start gap-2 rounded-2xl border bg-white/80 p-2 transition-colors",
                      active ? "border-zinc-900 shadow-sm" : "border-transparent hover:border-zinc-200",
                    )}
                  >
                    <button type="button" onClick={() => selectWorkflow(workflow)} className="min-w-0 flex-1 px-1 py-1 text-left">
                      <div className="flex items-center justify-between gap-3">
                        <span className="truncate text-sm font-semibold text-zinc-950">{workflow.name || "Untitled workflow"}</span>
                        <span className="flex shrink-0 items-center gap-1">
                          {runningCount ? <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700">{runningCount} running</span> : null}
                          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-500">{workflow.steps.length}</span>
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-500">{workflow.description || "No description yet."}</p>
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteWorkflow(workflow.id)}
                      disabled={Boolean(deletingId)}
                      className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                      title="Delete workflow"
                    >
                      {deletingId === workflow.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                );
              })}
              {!workflows.length ? (
                <div className="rounded-2xl border border-dashed border-zinc-200 bg-white px-3 py-6 text-center text-xs text-zinc-500">
                  Click New workflow to create your first reusable playbook.
                </div>
              ) : null}
            </div>
          </aside>

          <main className="min-w-0 bg-white p-5">
            {!selectedId ? (
              <div className="flex min-h-[420px] flex-col items-center justify-center rounded-[24px] border border-dashed border-zinc-200 bg-zinc-50 px-6 text-center">
                <Sparkles className="h-6 w-6 text-zinc-400" />
                <p className="mt-3 text-sm font-semibold text-zinc-950">No workflow selected</p>
                <p className="mt-1 max-w-sm text-sm leading-6 text-zinc-500">Create a workflow to start defining reusable research and document steps.</p>
                <button
                  type="button"
                  onClick={() => void newWorkflow()}
                  className="mt-5 inline-flex h-10 items-center gap-2 rounded-full bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-800"
                >
                  <Plus className="h-4 w-4" />
                  New workflow
                </button>
              </div>
            ) : (
              <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
                <div className="min-w-0">
                  <div className="grid gap-3">
                    <label className="block">
                      <span className="text-xs font-medium text-zinc-600">Workflow name</span>
                      <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="mt-1 h-11 w-full rounded-2xl border border-zinc-200 bg-white px-3 text-sm outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-900/10"
                        placeholder="Untitled workflow"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs font-medium text-zinc-600">Description</span>
                      <textarea
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        className="mt-1 min-h-[76px] w-full resize-none rounded-2xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-900/10"
                        placeholder="What this workflow should do and what output it should create."
                      />
                    </label>
                  </div>

                  <div className="mt-5 flex flex-wrap items-center gap-2">
                    {ADDABLE_STEP_TYPES.map((type) => {
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
                        <p className="text-xs text-zinc-500">Steps run top to bottom. The user request is available to every step.</p>
                      </div>
                      <Sparkles className="h-4 w-4 text-zinc-400" />
                    </div>
                    <div className="space-y-3">
                      {steps.map((step, index) => {
                        const meta = STEP_META[step.type];
                        const Icon = meta.icon;
                        const active = selectedStep?.id === step.id;
                        const dragging = draggingStepId === step.id;
                        const over = dragOverStepId === step.id && draggingStepId !== step.id;
                        return (
                          <div
                            key={step.id}
                            className="relative"
                            onDragOver={(e) => {
                              e.preventDefault();
                              setDragOverStepId(step.id);
                            }}
                            onDragLeave={() => setDragOverStepId((current) => (current === step.id ? null : current))}
                            onDrop={(e) => {
                              e.preventDefault();
                              reorderDraggedStep(step.id);
                            }}
                          >
                            {index > 0 ? <div className="absolute -top-3 left-8 h-3 w-px bg-zinc-200" /> : null}
                            <div
                              role="button"
                              tabIndex={0}
                              draggable
                              onDragStart={(e) => {
                                setDraggingStepId(step.id);
                                e.dataTransfer.effectAllowed = "move";
                                e.dataTransfer.setData("text/plain", step.id);
                              }}
                              onDragEnd={() => {
                                setDraggingStepId(null);
                                setDragOverStepId(null);
                              }}
                              onClick={() => setSelectedStepId(step.id)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  setSelectedStepId(step.id);
                                }
                              }}
                              className={cn(
                                "flex w-full cursor-grab items-center gap-3 rounded-[22px] border bg-white p-3 text-left shadow-sm outline-none transition-all active:cursor-grabbing",
                                active ? "border-zinc-900 ring-4 ring-zinc-900/5" : "border-zinc-200 hover:border-zinc-300",
                                dragging ? "scale-[0.98] opacity-50" : "",
                                over ? "translate-y-1 border-blue-300 ring-4 ring-blue-500/10" : "",
                              )}
                            >
                              <span className="flex h-10 w-5 shrink-0 items-center justify-center text-zinc-300">
                                <GripVertical className="h-4 w-4" />
                              </span>
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
                                    removeStep(step.id);
                                  }}
                                  className="inline-flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 hover:bg-red-50 hover:text-red-600"
                                  title="Delete step"
                                >
                                  <Trash2 className="h-4 w-4" />
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
                </div>

                <aside className="rounded-[24px] border border-zinc-200 bg-zinc-50/70 p-4">
                  <div className="rounded-[22px] border border-zinc-200 bg-white p-4 shadow-sm">
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
                              <span className="text-xs font-medium text-zinc-600">Research prompt</span>
                              <textarea
                                value={selectedStep.prompt}
                                onChange={(e) => updateStep(selectedStep.id, { prompt: e.target.value, mode: "plan" })}
                                className="mt-1 min-h-[110px] w-full resize-none rounded-2xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-900/10"
                              />
                            </label>
                            <div className="rounded-2xl border border-blue-100 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-800">
                              This step generates a research plan from the prompt, runs the plan, and saves the findings as research context for later steps.
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
                                    {type.name}{type.output_format ? ` (${documentOutputFormatLabel(type.output_format)})` : ""}
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
                </aside>
              </div>
            )}
          </main>
        </div>
      </section>

      <section className="rounded-[28px] border border-zinc-200 bg-zinc-950 p-5 text-white shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/10 px-3 py-1 text-xs font-medium text-zinc-200">
              <Play className="h-3.5 w-3.5" />
              Run console
            </div>
            <h2 className="mt-3 text-xl font-semibold tracking-tight">{name || "Select a workflow"}</h2>
            <p className="mt-1 text-sm leading-6 text-zinc-400">Run the selected workflow against a company with optional instructions. This area is separate from workflow definition.</p>
          </div>
          <button
            type="button"
            onClick={runWorkflow}
            disabled={startingRun || !selectedId || selectedIsLocal || !steps.length}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-white px-5 text-sm font-semibold text-zinc-950 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {startingRun ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Start run
          </button>
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
          <div className="space-y-3">
            <label className="block">
              <span className="text-xs font-medium text-zinc-300">Company</span>
              <SelectBox value={dealId} onChange={(e) => setDealId(e.target.value)} wrapperClassName="mt-1 bg-white text-zinc-950">
                <option value="">No company</option>
                {deals.map((deal) => (
                  <option key={deal.id} value={deal.id}>
                    {deal.name}
                  </option>
                ))}
              </SelectBox>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-zinc-300">Run instructions</span>
              <textarea
                value={runInput}
                onChange={(e) => setRunInput(e.target.value)}
                className="mt-1 min-h-[104px] w-full resize-none rounded-2xl border border-white/10 bg-white px-3 py-2 text-sm text-zinc-950 outline-none focus:border-white focus:ring-2 focus:ring-white/20"
                placeholder="Optional instructions for this run"
              />
            </label>
            {runStatus ? <p className="text-xs leading-5 text-zinc-300">{runStatus}</p> : null}

            <div className="rounded-[24px] border border-white/10 bg-white/5 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-zinc-300">Runs</div>
                <button
                  type="button"
                  onClick={() => void refreshRuns().catch((e) => setRunStatus(e instanceof Error ? e.message : "Failed to refresh runs"))}
                  className="rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-zinc-200 hover:bg-white/15"
                >
                  Refresh
                </button>
              </div>
              {activeRuns.length ? (
                <div className="mt-2 rounded-2xl bg-blue-500/10 px-3 py-2 text-xs font-medium text-blue-100">
                  {activeRuns.length} running now. You can leave this page; progress is saved to the run history.
                </div>
              ) : null}
              <div className="mt-3 max-h-[360px] space-y-2 overflow-y-auto pr-1">
                {runs.map((run) => {
                  const active = run.id === selectedRun?.id;
                  return (
                    <button
                      type="button"
                      key={run.id}
                      onClick={() => setSelectedRunId(run.id)}
                      className={cn(
                        "w-full rounded-2xl border p-3 text-left transition-colors",
                        active ? "border-white bg-white text-zinc-950" : "border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10",
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold">{run.workflowName || "Deleted workflow"}</span>
                          <span className={cn("mt-0.5 block truncate text-xs", active ? "text-zinc-500" : "text-zinc-400")}>
                            {run.dealName || "No company"} · {new Date(run.updatedAt || run.createdAt).toLocaleString()}
                          </span>
                        </span>
                        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1", runStatusTone(run.status))}>
                          {runStatusLabel(run.status)}
                        </span>
                      </div>
                      <p className={cn("mt-2 line-clamp-2 text-xs leading-5", active ? "text-zinc-600" : "text-zinc-300")}>
                        {run.summary || "Queued workflow run."}
                      </p>
                    </button>
                  );
                })}
                {!runs.length ? (
                  <div className="rounded-2xl border border-dashed border-white/15 px-3 py-6 text-center text-xs text-zinc-400">
                    No workflow runs yet.
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <div className="rounded-[24px] border border-white/10 bg-white p-4 text-zinc-950">
            {runSteps.length ? (
              <div>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-zinc-950">{selectedRun?.workflowName || "Workflow run"}</div>
                    <div className="mt-0.5 text-xs text-zinc-500">{selectedRun?.dealName || "No company selected"}</div>
                  </div>
                  <div className={cn("rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1", selectedRun ? runStatusTone(selectedRun.status) : "bg-zinc-100 text-zinc-500 ring-zinc-200")}>
                    {selectedRun ? runStatusLabel(selectedRun.status) : "No run"}
                  </div>
                </div>
                <div className="max-h-[324px] overflow-y-auto rounded-[24px] border border-zinc-900 bg-zinc-950 p-3">
                  <div className="space-y-3 py-14">
                    {runSteps.map((step, index) => {
                      const meta = STEP_META[step.stepType];
                      const Icon = meta.icon;
                      const active = step.id === activeRunStepId;
                      const StatusIcon =
                        step.status === "running"
                          ? Loader2
                          : step.status === "done"
                            ? CheckCircle2
                            : step.status === "failed"
                              ? AlertCircle
                              : CircleDot;
                      return (
                        <div
                          key={step.id}
                          ref={(node) => {
                            runStepRefs.current[step.id] = node;
                          }}
                          className={cn(
                            "mx-auto flex w-[92%] origin-center items-center gap-3 rounded-[22px] border p-3 text-left transition-all duration-500 ease-out",
                            active ? "w-full" : "",
                            runStepTone(step.status, active, selectedRun?.status === "running"),
                          )}
                        >
                          <span className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ring-1", active ? "bg-zinc-100 text-zinc-950 ring-zinc-200" : meta.tone)}>
                            <Icon className="h-5 w-5" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2">
                              <span className={cn("text-[11px] font-semibold uppercase tracking-wide", active ? "text-zinc-500" : "text-current opacity-60")}>
                                Step {index + 1}
                              </span>
                              <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", active ? "bg-zinc-100 text-zinc-700" : "bg-white/10 text-current")}>
                                {meta.label}
                              </span>
                            </span>
                            <span className="mt-1 block truncate text-sm font-semibold">{step.title}</span>
                            <span className={cn("mt-0.5 block text-xs leading-5", active ? "line-clamp-2 text-zinc-500" : "truncate opacity-70")}>
                              {step.detail || step.summary}
                            </span>
                          </span>
                          <span className={cn("inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-semibold", active ? "bg-zinc-950 text-white" : "bg-white/10 text-current")}>
                            <StatusIcon className={cn("h-3.5 w-3.5", step.status === "running" ? "animate-spin" : "")} />
                            {runStepStatusLabel(step.status)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            ) : null}

            {!runResult && !runSteps.length ? (
              <div className="flex min-h-[168px] flex-col items-center justify-center rounded-2xl bg-zinc-50 px-4 text-center">
                <CheckCircle2 className="h-5 w-5 text-zinc-400" />
                <p className="mt-2 text-sm font-semibold text-zinc-900">Select or start a run</p>
                <p className="mt-1 text-xs leading-5 text-zinc-500">Active and completed workflow runs appear in the run list.</p>
              </div>
            ) : null}

            {runResult ? (
              <div className={cn("space-y-3", runSteps.length ? "mt-4 border-t border-zinc-100 pt-4" : "")}>
                <div className="flex items-center gap-2 text-sm font-semibold text-zinc-950">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  Run results
                </div>
                {runResult.stepResults.map((step, index) => (
                  <div key={`${step.title}-${index}`} className={cn("rounded-2xl border px-3 py-2 text-xs", resultTone(step.status))}>
                    <div className="font-semibold">{index + 1}. {step.title}</div>
                    <div className="mt-1 line-clamp-4 opacity-80">{step.detail}</div>
                  </div>
                ))}
                {runResult.artifacts.length ? (
                  <div className="flex flex-col gap-2 border-t border-zinc-100 pt-3">
                    {runResult.artifacts.map((artifact, index) =>
                      artifact.href ? (
                        <a key={`${artifact.label}-${index}`} href={artifact.href} className="text-xs font-semibold text-blue-700 hover:underline">
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
        </div>
      </section>
    </div>
  );
}
