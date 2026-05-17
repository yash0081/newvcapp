"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, GripVertical, Loader2, Play, Plus, Search, Sparkles, Trash2, History, X } from "lucide-react";
import { stripMarkdownText } from "@/lib/plain-text";
import { cn } from "@/lib/utils";

type Workflow = {
  id: string;
  title: string;
  status: string;
  version: number;
  metadata: Record<string, unknown> | null;
  created_at?: string;
  updated_at?: string;
};

type Step = {
  id: string;
  workflow_id: string;
  position: number;
  status: "todo" | "blocked" | "queued" | "running" | "done" | "failed";
  website: string;
  task: string;
  notes: string | null;
  depends_on_step_ids: string[];
  metadata: Record<string, unknown> | null;
};

type Run = {
  id: string;
  step_id: string;
  run_status: string;
  output_notes: string | null;
  sources: Array<{ url: string; title?: string; snippet?: string }> | null;
  error_message?: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};


type SuggestedUpdate = {
  reason: string;
  website: string;
  task: string;
};

function suggestionKey(s: SuggestedUpdate): string {
  return `${s.website}||${s.task}||${s.reason}`;
}

function getSuggestedUpdates(runs: Run[], knownCompanyNames: string[] = []): SuggestedUpdate[] {
  const out: SuggestedUpdate[] = [];
  const normalizedNames = new Set(knownCompanyNames.map((n) => n.trim().toLowerCase()));

  for (const r of runs) {
    const meta = (r.metadata && typeof r.metadata === "object" ? r.metadata : {}) as Record<string, unknown>;
    const arr = Array.isArray(meta.suggestedStepUpdates) ? meta.suggestedStepUpdates : [];
    for (const item of arr) {
      const x = item as Record<string, unknown>;
      if (typeof x.reason === "string" && typeof x.website === "string" && typeof x.task === "string") {
        const rawWeb = x.website.trim().toLowerCase();
        // Skip obvious company names
        if (rawWeb !== "web" && rawWeb !== "company-website") {
          if (rawWeb.includes(" ") && !rawWeb.includes(".")) continue;
          if (normalizedNames.has(rawWeb)) continue;
          if (knownCompanyNames.some(n => rawWeb.includes(n.trim().toLowerCase()))) continue;
        }

        out.push({
          reason: x.reason,
          website: x.website,
          task: x.task,
        });
      }
    }
  }
  return out;
}

export function ResearchPlanner(props: {
  dealId: string;
  companyName: string;
  initialWorkflow: Workflow | null;
  initialWorkflows?: Workflow[];
  initialSteps: Step[];
  initialRuns: Run[];
  knownCompanyNames?: string[];
}) {
  const [workflow, setWorkflow] = useState<Workflow | null>(props.initialWorkflow);
  const [workflows, setWorkflows] = useState<Workflow[]>(props.initialWorkflows ?? (props.initialWorkflow ? [props.initialWorkflow] : []));
  const [steps, setSteps] = useState<Step[]>(props.initialSteps);
  const [runs, setRuns] = useState<Run[]>(props.initialRuns);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dismissedSuggestionKeys, setDismissedSuggestionKeys] = useState<Record<string, "accepted" | "rejected">>({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [dirty, setDirty] = useState(false);
  const [focus, setFocus] = useState(
    typeof props.initialWorkflow?.metadata?.focus === "string" ? props.initialWorkflow.metadata.focus : ""
  );

  useEffect(() => {
    setHistoryOpen(false);
    setHistoryQuery("");
  }, [props.dealId]);

  function resetPlannerToNew() {
    setWorkflow(null);
    setSteps([]);
    setRuns([]);
    setFocus("");
    setDirty(false);
  }

  const suggestions = useMemo(() => {
    const all = getSuggestedUpdates(runs, props.knownCompanyNames);
    return all.filter((s) => !dismissedSuggestionKeys[suggestionKey(s)]);
  }, [runs, dismissedSuggestionKeys, props.knownCompanyNames]);
  const stepStats = useMemo(() => {
    const running = steps.filter((step) => step.status === "running" || step.status === "queued").length;
    const done = steps.filter((step) => step.status === "done").length;
    const failed = steps.filter((step) => step.status === "failed").length;
    return { running, done, failed, remaining: Math.max(0, steps.length - running - done - failed) };
  }, [steps]);

  async function refresh(workflowId?: string): Promise<{ steps: Step[] } | null> {
    const res = await fetch(`/api/research/workflows/by-deal/${props.dealId}${workflowId ? `?workflowId=${workflowId}` : ""}`);
    const json = (await res.json().catch(() => null)) as
      | { workflow?: Workflow | null; workflows?: Workflow[]; steps?: Step[]; runs?: Run[]; error?: string }
      | null;
    if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
    const nextSteps = (json?.steps ?? []) as Step[];
    setWorkflow((json?.workflow ?? null) as Workflow | null);
    setWorkflows((json?.workflows ?? []) as Workflow[]);
    setSteps(nextSteps);
    setRuns((json?.runs ?? []) as Run[]);
    return { steps: nextSteps };
  }

  async function openWorkflow(id: string) {
    setBusy(true);
    setError(null);
    try {
      await refresh(id);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function pollUntilSettled(maxTicks = 6, intervalMs = 1500) {
    for (let i = 0; i < maxTicks; i++) {
      await new Promise((r) => setTimeout(r, intervalMs));
      let snapshot: { steps: Step[] } | null = null;
      try {
        snapshot = await refresh();
      } catch {
        return;
      }
      const stillRunning = (snapshot?.steps ?? []).some(
        (s) => s.status === "running" || s.status === "queued"
      );
      if (!stillRunning) return;
    }
  }

  async function generate() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/research/workflows/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          dealId: props.dealId, 
          focus: focus.trim() || undefined,
          peerDealNames: props.knownCompanyNames,
        }),
      });
      const json = (await res.json().catch(() => null)) as
        | { workflow?: Workflow; steps?: Step[]; error?: string }
        | null;
      if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
      setWorkflow((json?.workflow ?? null) as Workflow | null);
      setSteps((json?.steps ?? []) as Step[]);
      await refresh(json?.workflow?.id);
      setDirty(false);
      setMessage("Research plan generated.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function addStep() {
    const tempId = `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    setSteps((prev) => [
      ...prev,
      {
        id: tempId,
        workflow_id: workflow?.id || "",
        position: prev.length,
        status: "todo",
        website: "web",
        task: "Add a concrete research task.",
        notes: null,
        depends_on_step_ids: [],
        metadata: { category: "general", manual: true },
      },
    ]);
    setDirty(true);
  }

  function removeStep(id: string) {
    setSteps((prev) => prev.filter((s) => s.id !== id).map((s, i) => ({ ...s, position: i })));
    setDirty(true);
  }

  function updateStep(id: string, patch: Partial<Step>) {
    setSteps((prev) =>
      prev.map((s) => (s.id === id ? { ...s, ...patch } : s)).map((s, i) => ({ ...s, position: i }))
    );
    setDirty(true);
  }

  function onDrop(targetId: string) {
    if (!dragId || dragId === targetId) return;
    setSteps((prev) => {
      const from = prev.findIndex((s) => s.id === dragId);
      const to = prev.findIndex((s) => s.id === targetId);
      if (from < 0 || to < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next.map((s, i) => ({ ...s, position: i }));
    });
    setDirty(true);
  }

  async function saveSteps() {
    if (!workflow) {
      setError("Generate a workflow first.");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/research/workflows/${workflow.id}/steps`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedVersion: workflow.version,
          steps: steps.map((s, i) => ({
            id: s.id.startsWith("tmp_") ? undefined : s.id,
            position: i,
            website: s.website,
            task: s.task,
            status: s.status,
            notes: s.notes,
            dependsOnStepIds: s.depends_on_step_ids,
            metadata: s.metadata ?? {},
          })),
        }),
      });
      const json = (await res.json().catch(() => null)) as
        | { workflow?: Workflow; steps?: Step[]; error?: string; currentVersion?: number }
        | null;
      if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
      setWorkflow((json?.workflow ?? null) as Workflow | null);
      setSteps((json?.steps ?? []) as Step[]);
      setDirty(false);
      setMessage("Workflow saved.");
      await fetch(`/api/research/workflows/${workflow.id}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "manual_edit",
          rationale: "User edited workflow steps",
          payload: { stepCount: steps.length },
        }),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runAll() {
    if (!workflow) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (dirty) {
        // Ensure newly added/edited steps exist in DB before execution.
        await saveSteps();
      }
      const res = await fetch(`/api/research/workflows/${workflow.id}/execute`, {
        method: "POST",
      });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
      const snapshot = await refresh();
      const stillRunning = (snapshot?.steps ?? []).some(
        (s) => s.status === "running" || s.status === "queued"
      );
      if (stillRunning) await pollUntilSettled();
      setMessage("Executed ready steps.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runStep(stepId: string) {
    if (!workflow) return;
    setBusy(true);
    setError(null);
    try {
      if (dirty) {
        await saveSteps();
      }
      const res = await fetch(`/api/research/workflows/${workflow.id}/execute/${stepId}`, {
        method: "POST",
      });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
      const snapshot = await refresh();
      const stillRunning = (snapshot?.steps ?? []).some(
        (s) => s.status === "running" || s.status === "queued"
      );
      if (stillRunning) await pollUntilSettled();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function acceptSuggestions(selected: SuggestedUpdate[]) {
    if (!workflow || !selected.length) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    const accepted = selected;
    const patchSteps = [
      ...steps.map((s, i) => ({
        id: s.id.startsWith("tmp_") ? undefined : s.id,
        position: i,
        website: s.website,
        task: s.task,
        status: s.status,
        notes: s.notes,
        dependsOnStepIds: s.depends_on_step_ids,
        metadata: s.metadata ?? {},
      })),
      ...accepted.map((s, j) => ({
        position: steps.length + j,
        website: s.website,
        task: s.task,
        status: "todo" as const,
        notes: null as string | null,
        dependsOnStepIds: [] as string[],
        metadata: { category: "general", suggested_reason: s.reason },
      })),
    ];
    try {
      const res = await fetch(`/api/research/workflows/${workflow.id}/steps`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedVersion: workflow.version,
          steps: patchSteps.map((p, i) => ({ ...p, position: i })),
        }),
      });
      const json = (await res.json().catch(() => null)) as
        | { workflow?: Workflow; steps?: Step[]; error?: string; currentVersion?: number }
        | null;
      if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
      setWorkflow((json?.workflow ?? null) as Workflow | null);
      setSteps((json?.steps ?? []) as Step[]);
      await fetch(`/api/research/workflows/${workflow.id}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "accept_update",
          rationale: "Accepted suggested plan updates from execution.",
          payload: { accepted },
        }),
      });
      setDismissedSuggestionKeys((prev) => {
        const next = { ...prev };
        for (const s of accepted) next[suggestionKey(s)] = "accepted";
        return next;
      });
      setMessage("Suggested steps added and saved to the workflow.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function rejectSuggestions(selected: SuggestedUpdate[]) {
    if (!workflow || !selected.length) return;
    await fetch(`/api/research/workflows/${workflow.id}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "reject_update",
        rationale: "Suggestions were not relevant.",
        payload: { rejected: selected },
      }),
    });
    setDismissedSuggestionKeys((prev) => {
      const next = { ...prev };
      for (const s of selected) next[suggestionKey(s)] = "rejected";
      return next;
    });
    setMessage("Recorded feedback: suggestions rejected.");
  }

  const filteredWorkflows = workflows.filter(w => !historyQuery || (w.title || "").toLowerCase().includes(historyQuery.toLowerCase()) || (typeof w.metadata?.focus === "string" && w.metadata.focus.toLowerCase().includes(historyQuery.toLowerCase())));

  return (
    <div className="flex h-full w-full flex-col bg-white relative overflow-hidden select-none font-sans">
      {/* Main Adaptive Planner Workspace */}
      <div className="flex-1 overflow-y-auto bg-zinc-50/10 p-4 md:p-6 min-h-0">
        <div className="max-w-5xl mx-auto space-y-6">
        {/* Planner Header Dashboard */}
        <div className="rounded-2xl border border-zinc-200 bg-white shadow-sm overflow-hidden">
          <div className="flex flex-col gap-4 border-b border-zinc-150 bg-white px-6 py-5 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 shadow-inner">
                <Search className="h-4.5 w-4.5 text-zinc-800 animate-pulse" />
              </div>
              <div>
                <h2 className="text-sm font-extrabold uppercase tracking-wider text-zinc-950">{props.companyName} Research</h2>
                <p className="text-xs text-zinc-500 font-medium leading-relaxed">Build focused tasks, execute web searches, and verify evidence automatically.</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 items-center">
              <button
                type="button"
                onClick={resetPlannerToNew}
                className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 active:scale-95 transition-all shadow-sm"
                title="Start a new research session"
              >
                <Plus className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setHistoryOpen(true)}
                className="inline-flex h-9 items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 text-xs font-bold uppercase tracking-wider text-zinc-700 hover:bg-zinc-50 active:scale-95 transition-all shadow-sm"
              >
                <History className="h-3.5 w-3.5 text-zinc-500" />
                <span>History</span>
              </button>
              <button
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl border border-zinc-200 bg-white px-4 text-xs font-bold uppercase tracking-wider text-zinc-700 hover:bg-zinc-50 hover:text-zinc-950 active:scale-95 transition-all shadow-sm"
                onClick={generate}
                disabled={busy}
                type="button"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                Generate plan
              </button>
              <button
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl border border-zinc-200 bg-white px-4 text-xs font-bold uppercase tracking-wider text-zinc-700 hover:bg-zinc-50 hover:text-zinc-950 active:scale-95 transition-all shadow-sm"
                onClick={addStep}
                disabled={busy || !workflow}
                type="button"
              >
                <Plus className="h-3.5 w-3.5" />
                Add step
              </button>
              <button
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl border border-zinc-200 bg-white px-4 text-xs font-bold uppercase tracking-wider text-zinc-700 hover:bg-zinc-50 hover:text-zinc-950 active:scale-95 transition-all shadow-sm"
                onClick={saveSteps}
                disabled={busy || !workflow}
                type="button"
              >
                <Check className="h-3.5 w-3.5" />
                {dirty ? "Save edits" : "Saved"}
              </button>
              <button
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl bg-zinc-950 px-4 text-xs font-bold uppercase tracking-wider text-white hover:bg-zinc-900 active:scale-95 transition-all shadow-md shadow-zinc-950/10"
                onClick={runAll}
                disabled={busy || !workflow || !steps.length}
                type="button"
              >
                <Play className="h-3.5 w-3.5" />
                Run ready
              </button>
            </div>
          </div>

          <div className="grid gap-5 bg-zinc-50/30 px-6 py-5 lg:grid-cols-[1fr_360px] border-b border-zinc-200">
            <label className="grid gap-1.5">
              <span className="text-[10px] font-extrabold uppercase tracking-wider text-zinc-455">Research Focus Description</span>
              <textarea
                id="research-focus"
                className="w-full rounded-xl border border-zinc-200 bg-white px-3.5 py-2.5 text-xs text-zinc-800 outline-none placeholder:text-zinc-450 focus:border-zinc-400 focus:ring-0 min-h-20 resize-y font-medium leading-relaxed shadow-sm"
                value={focus}
                onChange={(e) => setFocus(e.target.value)}
                placeholder="Verify enterprise market traction, detailed competitive moat, core founder technology thesis..."
                disabled={busy}
              />
            </label>
            <div className="grid grid-cols-2 gap-2.5">
              <div className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 shadow-sm flex flex-col justify-center">
                <p className="text-[9px] font-extrabold uppercase tracking-wider text-zinc-400">Workflow Status</p>
                <p className="mt-1 text-xs font-bold text-zinc-950 uppercase tracking-wide">{workflow?.status ?? "Not generated"}</p>
              </div>
              <div className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 shadow-sm flex flex-col justify-center">
                <p className="text-[9px] font-extrabold uppercase tracking-wider text-zinc-400">Completed Steps</p>
                <p className="mt-1 text-xs font-bold text-zinc-950">{stepStats.done} of {steps.length}</p>
              </div>
              <div className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 shadow-sm flex flex-col justify-center">
                <p className="text-[9px] font-extrabold uppercase tracking-wider text-zinc-400">Active Running</p>
                <p className="mt-1 text-xs font-bold text-zinc-950">{stepStats.running}</p>
              </div>
              <div className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 shadow-sm flex flex-col justify-center">
                <p className="text-[9px] font-extrabold uppercase tracking-wider text-zinc-400">Pending Actions</p>
                <p className="mt-1 text-xs font-bold text-zinc-950">{stepStats.remaining + stepStats.failed}</p>
              </div>
            </div>
          </div>
          {message && (
            <div className="mx-6 my-4 rounded-xl border border-zinc-950/10 bg-zinc-50 px-4 py-3 text-xs text-zinc-900 font-bold uppercase tracking-wide">
              {message}
            </div>
          )}
          {error && (
            <div className="mx-6 my-4 rounded-xl border border-rose-250 bg-rose-50 px-4 py-3 text-xs text-rose-800 font-semibold">
              {error}
            </div>
          )}
        </div>

        {/* Steps and Evidence Workspace */}
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          {/* Draggable Steps List */}
          <div className="space-y-4">
            {steps.length ? (
              steps.map((step) => (
                <div
                  key={step.id}
                  draggable
                  onDragStart={() => setDragId(step.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => onDrop(step.id)}
                  className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm transition-all hover:border-zinc-300 relative group"
                >
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="cursor-grab text-zinc-300 hover:text-zinc-650 transition-colors p-1 active:cursor-grabbing">
                        <GripVertical className="h-4 w-4 shrink-0" />
                      </div>
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 text-[10px] font-extrabold text-zinc-800">
                        {step.position + 1}
                      </span>
                      <span className={`inline-flex items-center px-2.5 py-1 rounded-lg text-[9px] font-extrabold uppercase tracking-wider border ${
                        step.status === "done"
                          ? "border-zinc-950 bg-zinc-950 text-white"
                          : step.status === "failed"
                          ? "border-rose-300 bg-rose-50 text-rose-800"
                          : step.status === "running"
                          ? "border-zinc-500 bg-zinc-100 text-zinc-800 animate-pulse"
                          : "border-zinc-200 bg-zinc-50 text-zinc-600"
                      }`}>
                        {step.status}
                      </span>
                      <span className="truncate text-[10px] font-bold uppercase tracking-wider text-zinc-400 font-sans">{step.website || "web"}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        className="inline-flex h-8 items-center gap-1 rounded-xl border border-zinc-200 bg-white px-3 text-[10px] font-bold uppercase tracking-wider text-zinc-850 hover:bg-zinc-50 hover:text-zinc-950 active:scale-95 transition-all shadow-sm"
                        onClick={() => runStep(step.id)}
                        disabled={busy || !workflow || step.status === "running"}
                        type="button"
                      >
                        <Play className="h-3 w-3" />
                        {step.status === "failed" ? "Retry" : step.status === "running" ? "Running" : "Run"}
                      </button>
                      <button
                        className="inline-flex h-8 items-center gap-1 rounded-xl border border-zinc-200 bg-white px-3 text-[10px] font-bold uppercase tracking-wider text-zinc-500 hover:border-zinc-950 hover:bg-zinc-50 active:scale-95 transition-all"
                        onClick={() => removeStep(step.id)}
                        disabled={busy}
                        type="button"
                      >
                        <Trash2 className="h-3 w-3" />
                        Delete
                      </button>
                    </div>
                  </div>
                  <div className="mt-4 grid gap-3">
                    <label className="grid gap-1">
                      <span className="text-[9px] font-extrabold uppercase tracking-wider text-zinc-400">Target URL / Source Hint</span>
                      <input
                        className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-800 outline-none focus:border-zinc-400 transition-all font-medium shadow-inner"
                        value={step.website}
                        onChange={(e) => updateStep(step.id, { website: e.target.value })}
                        placeholder="web, or specific database domain..."
                      />
                    </label>
                    <label className="grid gap-1">
                      <span className="text-[9px] font-extrabold uppercase tracking-wider text-zinc-400">Research Task Objective</span>
                      <textarea
                        className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-800 outline-none focus:border-zinc-400 transition-all min-h-16 resize-y font-medium leading-relaxed shadow-inner"
                        value={step.task}
                        onChange={(e) => updateStep(step.id, { task: e.target.value })}
                      />
                    </label>
                  </div>
                  {step.notes && (
                    <div className="mt-4 rounded-xl border-l-[3px] border-zinc-950 bg-zinc-50 p-4 text-xs text-zinc-650 leading-relaxed font-medium">
                      {stripMarkdownText(step.notes)}
                    </div>
                  )}
                </div>
              ))
            ) : (
              <div className="rounded-2xl border border-dashed border-zinc-250 bg-zinc-50/50 p-12 text-center text-xs text-zinc-400 font-bold uppercase tracking-widest">
                No steps yet. Click Generate Plan to start.
              </div>
            )}
          </div>

          {/* Suggested Updates & Evidence Sidebar */}
          <div className="space-y-4">
            {/* Suggested Plan Updates */}
            <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between gap-2 border-b border-zinc-100 pb-3">
                <p className="text-[10px] font-extrabold uppercase tracking-widest text-zinc-950">Suggested Updates</p>
                <span className="border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[10px] font-extrabold text-zinc-850 rounded-lg">
                  {suggestions.length}
                </span>
              </div>
              {!suggestions.length ? (
                <p className="mt-3 text-xs leading-relaxed text-zinc-500 font-medium">
                  Adaptive plan modifications will appear here in real-time as runs finish.
                </p>
              ) : (
                <div className="mt-4 space-y-3 font-sans">
                  {suggestions.slice(0, 5).map((s, idx) => (
                    <div key={`${s.website}_${idx}`} className="rounded-xl border border-zinc-200 bg-zinc-50/30 p-3.5 space-y-2">
                      <p className="text-xs text-zinc-850 leading-relaxed font-medium">{stripMarkdownText(s.reason)}</p>
                      <p className="text-[9px] font-extrabold text-zinc-400 uppercase tracking-widest leading-relaxed">
                        {stripMarkdownText(`${s.website} / ${s.task}`)}
                      </p>
                      <div className="flex gap-2 pt-1">
                        <button
                          className="inline-flex h-7 items-center justify-center rounded-lg border border-zinc-200 bg-white px-3 text-[10px] font-bold uppercase tracking-wider text-zinc-850 hover:bg-zinc-50 active:scale-95 transition-all"
                          onClick={() => acceptSuggestions([s])}
                          disabled={busy}
                          type="button"
                        >
                          Accept
                        </button>
                        <button
                          className="inline-flex h-7 items-center justify-center rounded-lg border border-zinc-200 bg-white px-3 text-[10px] font-bold uppercase tracking-wider text-zinc-500 hover:bg-zinc-50 active:scale-95 transition-all"
                          onClick={() => rejectSuggestions([s])}
                          disabled={busy}
                          type="button"
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  ))}
                  <div className="flex gap-2 pt-2 border-t border-zinc-100">
                    <button
                      className="inline-flex h-8 items-center justify-center rounded-xl border border-zinc-200 bg-white px-3 text-[10px] font-bold uppercase tracking-wider text-zinc-850 hover:bg-zinc-50 active:scale-95 transition-all flex-1"
                      onClick={() => acceptSuggestions(suggestions.slice(0, 5))}
                      disabled={busy}
                      type="button"
                    >
                      Accept All
                    </button>
                    <button
                      className="inline-flex h-8 items-center justify-center rounded-xl border border-zinc-200 bg-white px-3 text-[10px] font-bold uppercase tracking-wider text-zinc-500 hover:bg-zinc-50 active:scale-95 transition-all flex-1"
                      onClick={() => rejectSuggestions(suggestions.slice(0, 5))}
                      disabled={busy}
                      type="button"
                    >
                      Reject All
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Evidence & Sources Log */}
            <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between gap-2 border-b border-zinc-100 pb-3">
                <p className="text-[10px] font-extrabold uppercase tracking-widest text-zinc-950">Evidence Logs</p>
                <span className="border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[10px] font-extrabold text-zinc-850 rounded-lg">
                  {runs.length}
                </span>
              </div>
              {!runs.length ? (
                <p className="mt-3 text-xs leading-relaxed text-zinc-500 font-medium">
                  Completed research runs and source links will populate here.
                </p>
              ) : (
                <div className="mt-4 max-h-96 space-y-3 overflow-auto pr-1">
                  {runs.map((r) => (
                    <div key={r.id} className="rounded-xl border border-zinc-200 bg-white p-3 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[9px] font-extrabold text-zinc-400 uppercase tracking-widest">
                          {new Date(r.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                        </p>
                        <span className={`px-1.5 py-0.5 rounded text-[8px] font-extrabold uppercase tracking-widest border ${
                          r.run_status === "failed"
                            ? "border-rose-250 bg-rose-50 text-rose-800"
                            : r.run_status === "running"
                            ? "border-zinc-450 bg-zinc-100 text-zinc-800 animate-pulse"
                            : "border-zinc-950 bg-zinc-950 text-white"
                        }`}>
                          {r.run_status}
                        </span>
                      </div>
                      {r.run_status === "failed" ? (
                        <p className="whitespace-pre-wrap text-xs text-rose-800 font-semibold leading-relaxed">
                          {stripMarkdownText(r.error_message || "Run failed without output.")}
                        </p>
                      ) : r.run_status === "running" ? (
                        <p className="text-xs italic text-zinc-400 font-medium">Running search operation...</p>
                      ) : (
                        <p className="whitespace-pre-wrap text-xs text-zinc-700 font-medium leading-relaxed">
                          {stripMarkdownText(r.output_notes || "No notes captured.")}
                        </p>
                      )}
                      {r.run_status !== "failed" && Array.isArray(r.sources) && r.sources.length ? (
                        <div className="mt-2 space-y-1.5 pt-2 border-t border-zinc-100">
                          {r.sources.slice(0, 4).map((s, i) => (
                            <a
                              key={`${r.id}_${i}`}
                              href={s.url}
                              target="_blank"
                              rel="noreferrer"
                              className="block break-all text-[10px] font-semibold text-zinc-500 hover:text-zinc-950 hover:underline leading-relaxed font-sans"
                            >
                              {s.title || s.url}
                            </a>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>

      {/* Centered Research History Modal (Identical to Chat Tab) */}
      {historyOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/20 backdrop-blur-md p-4 transition-all duration-300">
          <div className="w-full max-w-2xl bg-white rounded-3xl border border-zinc-200/80 shadow-[0_24px_64px_rgba(0,0,0,0.12)] flex flex-col max-h-[85vh] overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-100">
              <div className="flex items-center gap-2">
                <History className="w-4 h-4 text-zinc-500" />
                <h2 className="text-sm font-bold text-zinc-950 tracking-tight">Research History</h2>
              </div>
              <button
                type="button"
                onClick={() => setHistoryOpen(false)}
                className="flex h-8 w-8 items-center justify-center rounded-xl hover:bg-zinc-100 text-zinc-500 hover:text-zinc-950 transition-all"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 border-b border-zinc-100 bg-zinc-50/50">
              <div className="relative">
                <Search className="absolute left-3.5 top-2.5 w-4 h-4 text-zinc-400" />
                <input
                  type="text"
                  className="w-full bg-white border border-zinc-200 rounded-xl pl-10 pr-4 py-2 text-xs outline-none placeholder:text-zinc-400 focus:border-zinc-400 focus:ring-4 focus:ring-zinc-900/5 transition-all"
                  placeholder="Search previous research plans..."
                  value={historyQuery}
                  onChange={(e) => setHistoryQuery(e.target.value)}
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
              {filteredWorkflows.length > 0 ? (
                filteredWorkflows.map((item) => {
                  const active = item.id === workflow?.id;
                  const focusText = typeof item.metadata?.focus === "string" && item.metadata.focus ? item.metadata.focus : item.title;
                  return (
                    <div
                      key={item.id}
                      className={cn(
                        "group flex w-full items-start gap-3 rounded-2xl border px-4 py-3.5 text-left transition-all cursor-pointer active:scale-[0.99]",
                        active
                          ? "bg-zinc-950 border-zinc-950 text-white shadow-md shadow-zinc-950/10"
                          : "bg-white border-zinc-200/60 hover:border-zinc-300 hover:bg-zinc-50"
                      )}
                      onClick={() => {
                        openWorkflow(item.id);
                        setHistoryOpen(false);
                      }}
                    >
                      <Search className={cn("mt-0.5 h-4 w-4 shrink-0", active ? "text-white" : "text-zinc-400")} />
                      <div className="min-w-0 flex-1">
                        <span className={cn("block truncate text-xs font-bold uppercase tracking-wider", active ? "text-white" : "text-zinc-950")}>
                          {focusText}
                        </span>
                        <span className={cn("mt-1 block truncate text-[11px] font-medium leading-relaxed", active ? "text-zinc-300" : "text-zinc-500")}>
                          Status: {item.status} · {item.updated_at ? new Date(item.updated_at).toLocaleString() : "saved"}
                        </span>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="text-center py-12 text-zinc-400 text-xs font-medium">No plans found.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
