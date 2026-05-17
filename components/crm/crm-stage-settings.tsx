"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

type Stage = {
  id: string;
  key: string;
  label: string;
  position: number;
  is_default: boolean;
  is_system: boolean;
};

async function requestJson(url: string, init: RequestInit) {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export function CrmStageSettings({ initialStages }: { initialStages: Stage[] }) {
  const [stages, setStages] = useState(initialStages);
  const [newLabel, setNewLabel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function addStage() {
    if (!newLabel.trim()) return;
    setBusy("new");
    setError(null);
    try {
      const data = (await requestJson("/api/crm/stages", {
        method: "POST",
        body: JSON.stringify({ label: newLabel.trim() }),
      })) as { stage?: Stage };
      if (data.stage) setStages((prev) => [...prev, data.stage!].sort((a, b) => a.position - b.position));
      setNewLabel("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function renameStage(stage: Stage) {
    setBusy(stage.id);
    setError(null);
    try {
      const data = (await requestJson("/api/crm/stages", {
        method: "PATCH",
        body: JSON.stringify({ id: stage.id, label: stage.label, position: stage.position }),
      })) as { stage?: Stage };
      if (data.stage) setStages((prev) => prev.map((item) => (item.id === data.stage!.id ? data.stage! : item)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function deleteStage(stage: Stage) {
    setBusy(stage.id);
    setError(null);
    try {
      await requestJson("/api/crm/stages", { method: "DELETE", body: JSON.stringify({ id: stage.id }) });
      setStages((prev) => prev.filter((item) => item.id !== stage.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function moveStage(stage: Stage, direction: -1 | 1) {
    const ordered = [...stages].sort((a, b) => a.position - b.position);
    const index = ordered.findIndex((item) => item.id === stage.id);
    const swap = ordered[index + direction];
    if (!swap) return;
    const next = ordered.map((item) => {
      if (item.id === stage.id) return { ...item, position: swap.position };
      if (item.id === swap.id) return { ...item, position: stage.position };
      return item;
    }).sort((a, b) => a.position - b.position);
    setStages(next);
    setBusy(stage.id);
    setError(null);
    try {
      await Promise.all([
        requestJson("/api/crm/stages", { method: "PATCH", body: JSON.stringify({ id: stage.id, position: swap.position }) }),
        requestJson("/api/crm/stages", { method: "PATCH", body: JSON.stringify({ id: swap.id, position: stage.position }) }),
      ]);
    } catch (e) {
      setStages(ordered);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-zinc-950">Settings</h1>
          <p className="mt-1 text-sm text-zinc-500">Manage the CRM stages used on the Companies page.</p>
        </div>
        <div className="flex gap-2">
          <input
            className="crm-input h-10 w-56"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="New stage"
          />
          <button className="crm-button h-10 px-3" type="button" onClick={addStage} disabled={busy === "new" || !newLabel.trim()}>
            {busy === "new" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Add
          </button>
        </div>
      </div>

      {error ? <p className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p> : null}

      <div className="mt-5 divide-y divide-zinc-100 rounded-2xl border border-zinc-200">
        {[...stages].sort((a, b) => a.position - b.position).map((stage, index, ordered) => (
          <div key={stage.id} className="grid gap-3 p-3 sm:grid-cols-[1fr_110px_auto] sm:items-center">
            <input
              className="crm-input h-10"
              value={stage.label}
              onChange={(e) => setStages((prev) => prev.map((item) => (item.id === stage.id ? { ...item, label: e.target.value } : item)))}
            />
            <div className="text-xs text-zinc-500">
              <span className="font-medium text-zinc-700">Position {index + 1}</span>
              {stage.is_default ? <span className="ml-2 rounded-full bg-zinc-100 px-2 py-0.5">Default</span> : null}
            </div>
            <div className="flex justify-end gap-2">
              <button
                className="crm-button-secondary h-9 px-2"
                type="button"
                onClick={() => moveStage(stage, -1)}
                disabled={busy === stage.id || index === 0}
                title="Move up"
              >
                <ArrowUp className="h-4 w-4" />
              </button>
              <button
                className="crm-button-secondary h-9 px-2"
                type="button"
                onClick={() => moveStage(stage, 1)}
                disabled={busy === stage.id || index === ordered.length - 1}
                title="Move down"
              >
                <ArrowDown className="h-4 w-4" />
              </button>
              <button
                className="crm-button-secondary h-9 px-2"
                type="button"
                onClick={() => renameStage(stage)}
                disabled={busy === stage.id}
              >
                {busy === stage.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              </button>
              <button
                className={cn("crm-button-secondary h-9 px-2 text-rose-700 hover:bg-rose-50", stage.is_default && "opacity-40")}
                type="button"
                onClick={() => deleteStage(stage)}
                disabled={busy === stage.id || stage.is_default}
                title={stage.is_default ? "Default stage cannot be deleted" : "Delete stage"}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
