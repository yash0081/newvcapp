"use client";

import { useMemo, useState } from "react";
import { Check, GripVertical, Loader2, Play, Plus, Search, Sparkles, Trash2 } from "lucide-react";
import { stripMarkdownText } from "@/lib/plain-text";

type Workflow = {
  id: string;
  title: string;
  status: string;
  version: number;
  metadata: Record<string, unknown> | null;
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

function statusClass(status: string): string {
  switch (status) {
    case "running":
      return "text-zinc-700 bg-zinc-100";
    case "failed":
      return "text-rose-700 bg-rose-50";
    case "done":
      return "text-emerald-700 bg-emerald-50";
    case "queued":
      return "text-amber-700 bg-amber-50";
    case "blocked":
      return "text-zinc-500 bg-zinc-50";
    default:
      return "text-zinc-600 bg-zinc-50";
  }
}

type SuggestedUpdate = {
  reason: string;
  website: string;
  task: string;
};

function suggestionKey(s: SuggestedUpdate): string {
  return `${s.website}||${s.task}||${s.reason}`;
}

function getSuggestedUpdates(runs: Run[]): SuggestedUpdate[] {
  const out: SuggestedUpdate[] = [];
  for (const r of runs) {
    const meta = (r.metadata && typeof r.metadata === "object" ? r.metadata : {}) as Record<string, unknown>;
    const arr = Array.isArray(meta.suggestedStepUpdates) ? meta.suggestedStepUpdates : [];
    for (const item of arr) {
      const x = item as Record<string, unknown>;
      if (typeof x.reason === "string" && typeof x.website === "string" && typeof x.task === "string") {
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
  initialSteps: Step[];
  initialRuns: Run[];
}) {
  const [workflow, setWorkflow] = useState<Workflow | null>(props.initialWorkflow);
  const [steps, setSteps] = useState<Step[]>(props.initialSteps);
  const [runs, setRuns] = useState<Run[]>(props.initialRuns);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dismissedSuggestionKeys, setDismissedSuggestionKeys] = useState<Record<string, "accepted" | "rejected">>({});
  const [dirty, setDirty] = useState(false);
  const [focus, setFocus] = useState(
    typeof props.initialWorkflow?.metadata?.focus === "string" ? props.initialWorkflow.metadata.focus : ""
  );

  const suggestions = useMemo(() => {
    const all = getSuggestedUpdates(runs);
    return all.filter((s) => !dismissedSuggestionKeys[suggestionKey(s)]);
  }, [runs, dismissedSuggestionKeys]);
  const stepStats = useMemo(() => {
    const running = steps.filter((step) => step.status === "running" || step.status === "queued").length;
    const done = steps.filter((step) => step.status === "done").length;
    const failed = steps.filter((step) => step.status === "failed").length;
    return { running, done, failed, remaining: Math.max(0, steps.length - running - done - failed) };
  }, [steps]);

  async function refresh(): Promise<{ steps: Step[] } | null> {
    const res = await fetch(`/api/research/workflows/by-deal/${props.dealId}`);
    const json = (await res.json().catch(() => null)) as
      | { workflow?: Workflow | null; steps?: Step[]; runs?: Run[]; error?: string }
      | null;
    if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
    const nextSteps = (json?.steps ?? []) as Step[];
    setWorkflow((json?.workflow ?? null) as Workflow | null);
    setSteps(nextSteps);
    setRuns((json?.runs ?? []) as Run[]);
    return { steps: nextSteps };
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
        body: JSON.stringify({ dealId: props.dealId, focus: focus.trim() || undefined }),
      });
      const json = (await res.json().catch(() => null)) as
        | { workflow?: Workflow; steps?: Step[]; error?: string }
        | null;
      if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
      setWorkflow((json?.workflow ?? null) as Workflow | null);
      setSteps((json?.steps ?? []) as Step[]);
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

  return (
    <div className="space-y-5">
      <div className="crm-panel overflow-hidden">
        <div className="flex flex-col gap-4 border-b border-zinc-200 bg-white px-5 py-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-zinc-200 bg-zinc-50">
              <Search className="h-4 w-4 text-zinc-700" />
            </div>
            <div>
              <p className="crm-kicker">Research planner</p>
              <h2 className="mt-1 text-lg font-semibold tracking-tight text-zinc-950">{props.companyName}</h2>
              <p className="text-sm text-zinc-500">Build focused tasks, run them, and fold in evidence as the plan changes.</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="crm-button-secondary" onClick={generate} disabled={busy} type="button">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              Generate plan
            </button>
            <button className="crm-button-secondary" onClick={addStep} disabled={busy || !workflow} type="button">
              <Plus className="h-4 w-4" />
              Add step
            </button>
            <button className="crm-button-secondary" onClick={saveSteps} disabled={busy || !workflow} type="button">
              <Check className="h-4 w-4" />
              {dirty ? "Save edits" : "Saved"}
            </button>
            <button className="crm-button" onClick={runAll} disabled={busy || !workflow || !steps.length} type="button">
              <Play className="h-4 w-4" />
              Run ready
            </button>
          </div>
        </div>
        <div className="grid gap-4 bg-zinc-50/70 px-5 py-4 lg:grid-cols-[1fr_360px]">
          <label className="grid gap-1">
            <span className="text-xs font-medium text-zinc-600">Research focus</span>
            <textarea
              id="research-focus"
              className="crm-input min-h-20 resize-y"
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              placeholder="Verify enterprise traction, founder background, competitor positioning..."
              disabled={busy}
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl border border-zinc-200 bg-white px-3 py-2">
              <p className="text-[11px] font-medium text-zinc-500">Workflow</p>
              <p className="mt-1 text-sm font-semibold text-zinc-950">{workflow?.status ?? "Not generated"}</p>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-white px-3 py-2">
              <p className="text-[11px] font-medium text-zinc-500">Done</p>
              <p className="mt-1 text-sm font-semibold text-zinc-950">{stepStats.done} of {steps.length}</p>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-white px-3 py-2">
              <p className="text-[11px] font-medium text-zinc-500">Running</p>
              <p className="mt-1 text-sm font-semibold text-zinc-950">{stepStats.running}</p>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-white px-3 py-2">
              <p className="text-[11px] font-medium text-zinc-500">Needs action</p>
              <p className="mt-1 text-sm font-semibold text-zinc-950">{stepStats.remaining + stepStats.failed}</p>
            </div>
          </div>
        </div>
        {message ? <p className="mx-5 mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{message}</p> : null}
        {error ? <p className="mx-5 mb-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p> : null}
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-2">
          {steps.length ? (
            steps.map((step) => (
              <div
                key={step.id}
                draggable
                onDragStart={() => setDragId(step.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => onDrop(step.id)}
                className="rounded-2xl border border-zinc-200 bg-white p-3 shadow-sm"
              >
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div className="flex min-w-0 items-center gap-2">
                    <GripVertical className="h-4 w-4 shrink-0 text-zinc-300" />
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 text-xs font-semibold text-zinc-700">
                      {step.position + 1}
                    </span>
                    <span className={`inline-flex items-center rounded-xl px-2 py-0.5 text-[11px] font-medium ${statusClass(step.status)}`}>
                      {step.status}
                    </span>
                    <span className="truncate text-xs font-medium text-zinc-500">{step.website || "web"}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      className="crm-button-secondary"
                      onClick={() => runStep(step.id)}
                      disabled={busy || !workflow || step.status === "running"}
                      type="button"
                    >
                      <Play className="h-4 w-4" />
                      {step.status === "failed" ? "Retry" : step.status === "running" ? "Running" : "Run"}
                    </button>
                    <button className="crm-button-secondary" onClick={() => removeStep(step.id)} disabled={busy} type="button">
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </button>
                  </div>
                </div>
                <div className="mt-3 grid gap-2">
                  <label className="grid gap-1">
                    <span className="text-xs font-medium text-zinc-500">Source hint</span>
                    <input
                      className="crm-input"
                      value={step.website}
                      onChange={(e) => updateStep(step.id, { website: e.target.value })}
                      placeholder="web, or a specific source when required"
                    />
                  </label>
                  <textarea
                    className="crm-input min-h-16"
                    value={step.task}
                    onChange={(e) => updateStep(step.id, { task: e.target.value })}
                  />
                </div>
                {step.notes ? (
                  <p className="mt-3 whitespace-pre-wrap rounded-xl border border-zinc-200 bg-zinc-50 p-2 text-xs text-zinc-600">{stripMarkdownText(step.notes)}</p>
                ) : null}
              </div>
            ))
          ) : (
            <div className="crm-panel border-dashed p-10 text-center text-sm text-zinc-500">
              No steps yet. Generate a plan to start.
            </div>
          )}
        </div>

        <div className="space-y-3">
          <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-zinc-950">Suggested updates</p>
              <span className="rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[11px] font-medium text-zinc-500">{suggestions.length}</span>
            </div>
            {!suggestions.length ? (
              <p className="mt-2 text-xs leading-relaxed text-zinc-500">Run steps to get adaptive updates when the agent finds a useful follow-up.</p>
            ) : (
              <div className="mt-3 space-y-2">
                {suggestions.slice(0, 5).map((s, idx) => (
                  <div key={`${s.website}_${idx}`} className="rounded-xl border border-zinc-200 bg-zinc-50 p-3">
                    <p className="text-xs text-zinc-700">{stripMarkdownText(s.reason)}</p>
                    <p className="mt-1 text-xs text-zinc-500">{stripMarkdownText(`${s.website} / ${s.task}`)}</p>
                    <div className="mt-2 flex gap-2">
                      <button className="crm-button-secondary" onClick={() => acceptSuggestions([s])} disabled={busy} type="button">
                        Accept
                      </button>
                      <button className="crm-button-secondary" onClick={() => rejectSuggestions([s])} disabled={busy} type="button">
                        Reject
                      </button>
                    </div>
                  </div>
                ))}
                <div className="flex gap-2">
                  <button className="crm-button-secondary" onClick={() => acceptSuggestions(suggestions.slice(0, 5))} disabled={busy} type="button">
                    Accept all
                  </button>
                  <button className="crm-button-secondary" onClick={() => rejectSuggestions(suggestions.slice(0, 5))} disabled={busy} type="button">
                    Reject all
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-zinc-950">Evidence</p>
              <span className="rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[11px] font-medium text-zinc-500">{runs.length}</span>
            </div>
            {!runs.length ? (
              <p className="mt-2 text-xs leading-relaxed text-zinc-500">Completed research runs and sources appear here.</p>
            ) : (
              <div className="mt-3 max-h-96 space-y-2 overflow-auto">
                {runs.map((r) => (
                  <div key={r.id} className="rounded-xl border border-zinc-200 bg-white p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] text-zinc-500">{new Date(r.created_at).toLocaleString()}</p>
                      <span className={`inline-flex items-center rounded-xl px-2 py-0.5 text-[10px] font-medium ${statusClass(r.run_status)}`}>
                        {r.run_status}
                      </span>
                    </div>
                    {r.run_status === "failed" ? (
                      <p className="mt-2 whitespace-pre-wrap text-xs text-rose-700">{stripMarkdownText(r.error_message || "Run failed without an error message.")}</p>
                    ) : r.run_status === "running" ? (
                      <p className="mt-2 text-xs italic text-zinc-500">Running...</p>
                    ) : (
                      <p className="mt-2 whitespace-pre-wrap text-xs text-zinc-700">{stripMarkdownText(r.output_notes || "No notes")}</p>
                    )}
                    {r.run_status !== "failed" && Array.isArray(r.sources) && r.sources.length ? (
                      <div className="mt-2 space-y-1">
                        {r.sources.slice(0, 4).map((s, i) => (
                          <a key={`${r.id}_${i}`} href={s.url} target="_blank" rel="noreferrer" className="block break-all text-xs text-blue-700 hover:underline">
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
  );
}
