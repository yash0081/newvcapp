"use client";

import { useMemo, useState } from "react";

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

  const suggestions = useMemo(() => {
    const all = getSuggestedUpdates(runs);
    return all.filter((s) => !dismissedSuggestionKeys[suggestionKey(s)]);
  }, [runs, dismissedSuggestionKeys]);

  async function refresh() {
    const res = await fetch(`/api/research/workflows/by-deal/${props.dealId}`);
    const json = (await res.json().catch(() => null)) as
      | { workflow?: Workflow | null; steps?: Step[]; runs?: Run[]; error?: string }
      | null;
    if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
    setWorkflow((json?.workflow ?? null) as Workflow | null);
    setSteps((json?.steps ?? []) as Step[]);
    setRuns((json?.runs ?? []) as Run[]);
  }

  async function generate() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/research/workflows/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealId: props.dealId }),
      });
      const json = (await res.json().catch(() => null)) as
        | { workflow?: Workflow; steps?: Step[]; error?: string }
        | null;
      if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
      setWorkflow((json?.workflow ?? null) as Workflow | null);
      setSteps((json?.steps ?? []) as Step[]);
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
        website: "company-website",
        task: "Add a concrete research task.",
        notes: null,
        depends_on_step_ids: [],
        metadata: { category: "general", manual: true },
      },
    ]);
  }

  function removeStep(id: string) {
    setSteps((prev) => prev.filter((s) => s.id !== id).map((s, i) => ({ ...s, position: i })));
  }

  function updateStep(id: string, patch: Partial<Step>) {
    setSteps((prev) =>
      prev.map((s) => (s.id === id ? { ...s, ...patch } : s)).map((s, i) => ({ ...s, position: i }))
    );
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
      const res = await fetch(`/api/research/workflows/${workflow.id}/execute`, {
        method: "POST",
      });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
      await refresh();
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
      const res = await fetch(`/api/research/workflows/${workflow.id}/execute/${stepId}`, {
        method: "POST",
      });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
      await refresh();
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
    <div className="space-y-4">
      <div className="rounded-2xl border border-zinc-200 bg-white p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold text-zinc-900">{props.companyName} research planner</h2>
            <p className="text-xs text-zinc-500">Generate, drag, edit, and execute web research steps.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="crm-button-secondary" onClick={generate} disabled={busy} type="button">
              {busy ? "Working…" : "Generate plan"}
            </button>
            <button className="crm-button-secondary" onClick={addStep} disabled={busy || !workflow} type="button">
              Add step
            </button>
            <button className="crm-button-secondary" onClick={saveSteps} disabled={busy || !workflow} type="button">
              Save edits
            </button>
            <button className="crm-button" onClick={runAll} disabled={busy || !workflow || !steps.length} type="button">
              Run ready steps
            </button>
          </div>
        </div>
        {workflow ? (
          <p className="text-xs text-zinc-500">
            Status: {workflow.status} · Version: {workflow.version}
          </p>
        ) : (
          <p className="text-sm text-zinc-500">No workflow yet. Click Generate plan.</p>
        )}
        {message ? <p className="text-sm text-emerald-700">{message}</p> : null}
        {error ? <p className="text-sm text-rose-700">{error}</p> : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="space-y-3">
          {steps.length ? (
            steps.map((step) => (
              <div
                key={step.id}
                draggable
                onDragStart={() => setDragId(step.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => onDrop(step.id)}
                className="rounded-2xl border border-zinc-200 bg-white p-4 space-y-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-zinc-500">Step {step.position + 1} · {step.status}</p>
                  <div className="flex items-center gap-2">
                    <button className="crm-button-secondary" onClick={() => runStep(step.id)} disabled={busy || !workflow} type="button">
                      Run
                    </button>
                    <button className="crm-button-secondary" onClick={() => removeStep(step.id)} disabled={busy} type="button">
                      Delete
                    </button>
                  </div>
                </div>
                <div className="grid gap-2">
                  <input
                    className="crm-input"
                    value={step.website}
                    onChange={(e) => updateStep(step.id, { website: e.target.value })}
                    placeholder="website domain"
                  />
                  <textarea
                    className="crm-input min-h-20"
                    value={step.task}
                    onChange={(e) => updateStep(step.id, { task: e.target.value })}
                  />
                </div>
                {step.notes ? (
                  <p className="text-xs text-zinc-600 whitespace-pre-wrap">{step.notes}</p>
                ) : null}
              </div>
            ))
          ) : (
            <p className="text-sm text-zinc-500 rounded-2xl border border-dashed border-zinc-200 bg-white p-8 text-center">
              No steps yet.
            </p>
          )}
        </div>

        <div className="space-y-3">
          <div className="rounded-2xl border border-zinc-200 bg-white p-4 space-y-2">
            <p className="text-sm font-medium text-zinc-900">Suggested plan updates</p>
            {!suggestions.length ? (
              <p className="text-xs text-zinc-500">No suggestions yet. Run steps to get adaptive updates.</p>
            ) : (
              <div className="space-y-2">
                {suggestions.slice(0, 5).map((s, idx) => (
                  <div key={`${s.website}_${idx}`} className="rounded-xl border border-zinc-200 p-2 bg-zinc-50">
                    <p className="text-xs text-zinc-700">{s.reason}</p>
                    <p className="text-xs text-zinc-500 mt-1">{s.website} — {s.task}</p>
                    <div className="mt-2 flex gap-2">
                      <button
                        className="crm-button-secondary"
                        onClick={() => acceptSuggestions([s])}
                        disabled={busy}
                        type="button"
                      >
                        Accept
                      </button>
                      <button
                        className="crm-button-secondary"
                        onClick={() => rejectSuggestions([s])}
                        disabled={busy}
                        type="button"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ))}
                <div className="flex gap-2">
                  <button
                    className="crm-button-secondary"
                    onClick={() => acceptSuggestions(suggestions.slice(0, 5))}
                    disabled={busy}
                    type="button"
                  >
                    Accept all
                  </button>
                  <button
                    className="crm-button-secondary"
                    onClick={() => rejectSuggestions(suggestions.slice(0, 5))}
                    disabled={busy}
                    type="button"
                  >
                    Reject all
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-zinc-200 bg-white p-4 space-y-2">
            <p className="text-sm font-medium text-zinc-900">Evidence</p>
            {!runs.length ? (
              <p className="text-xs text-zinc-500">No step runs yet.</p>
            ) : (
              <div className="space-y-2 max-h-96 overflow-auto">
                {runs.map((r) => (
                  <div key={r.id} className="rounded-xl border border-zinc-200 p-2">
                    <p className="text-[11px] text-zinc-500">{new Date(r.created_at).toLocaleString()}</p>
                    <p className="text-xs text-zinc-700 whitespace-pre-wrap mt-1">{r.output_notes || "No notes"}</p>
                    {Array.isArray(r.sources) && r.sources.length ? (
                      <div className="mt-2 space-y-1">
                        {r.sources.slice(0, 4).map((s, i) => (
                          <a
                            key={`${r.id}_${i}`}
                            href={s.url}
                            target="_blank"
                            rel="noreferrer"
                            className="block text-xs text-blue-700 underline break-all"
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
  );
}

