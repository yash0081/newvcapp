"use client";

import { useState } from "react";

type Props = {
  dealId: string;
  initial: { crm_notes: string | null; crm_stage: string | null; crm_next_step: string | null };
};

export function DealCrmForm({ dealId, initial }: Props) {
  const [notes, setNotes] = useState(initial.crm_notes ?? "");
  const [stage, setStage] = useState(initial.crm_stage ?? "");
  const [next, setNext] = useState(initial.crm_next_step ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch(`/api/deals/${dealId}/crm`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          crm_notes: notes || null,
          crm_stage: stage || null,
          crm_next_step: next || null,
        }),
      });
      if (res.ok) setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border border-zinc-200/90 bg-white p-5 shadow-sm space-y-4">
      <h3 className="text-sm font-semibold text-zinc-900">Deal CRM</h3>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-xs font-medium text-zinc-700">
          Stage
          <input
            value={stage}
            onChange={(e) => setStage(e.target.value)}
            className="mt-1 w-full h-10 rounded-2xl border border-zinc-200 bg-white px-4 text-sm text-zinc-900 shadow-inner focus:border-zinc-300 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
            placeholder="e.g. First meeting"
          />
        </label>
        <label className="text-xs font-medium text-zinc-700">
          Next step
          <input
            value={next}
            onChange={(e) => setNext(e.target.value)}
            className="mt-1 w-full h-10 rounded-2xl border border-zinc-200 bg-white px-4 text-sm text-zinc-900 shadow-inner focus:border-zinc-300 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
            placeholder="e.g. Send follow-up questions"
          />
        </label>
      </div>
      <label className="text-xs font-medium text-zinc-700 block">
        Notes
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          className="mt-1 w-full rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 shadow-inner focus:border-zinc-300 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
        />
      </label>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex items-center justify-center h-10 rounded-full border border-zinc-300 bg-white px-4 text-sm font-medium text-zinc-900 shadow-sm hover:bg-zinc-50 disabled:opacity-50 transition-colors"
        >
          {saving ? "Saving…" : "Save CRM"}
        </button>
        {saved && <span className="text-xs text-emerald-600">Saved.</span>}
      </div>
    </div>
  );
}
