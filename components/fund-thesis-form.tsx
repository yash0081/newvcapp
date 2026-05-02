"use client";

import { useEffect, useState } from "react";

export function FundThesisForm() {
  const [thesis, setThesis] = useState("");
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  useEffect(() => {
    fetch("/api/fund-thesis")
      .then((r) => r.json())
      .then((d) => {
        if (typeof d.thesis_text === "string") setThesis(d.thesis_text);
      })
      .catch(() => {})
      .finally(() => setInitialLoading(false));
  }, []);

  async function handleSave() {
    setLoading(true);
    setSaved(false);
    try {
      const res = await fetch("/api/fund-thesis", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thesis_text: thesis }),
      });
      if (res.ok) setSaved(true);
    } finally {
      setLoading(false);
    }
  }

  if (initialLoading) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
        <p className="text-sm text-zinc-600">Loading fund thesis…</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 text-zinc-900">
      <div className="space-y-1">
        <label
          htmlFor="fund-thesis"
          className="block text-sm font-semibold text-zinc-900"
        >
          Fund thesis statement
        </label>
        <p className="text-xs text-zinc-600">
          This guides how the pipeline scores thesis fit, market focus, and check size alignment
          for every uploaded deck.
        </p>
      </div>
      <textarea
        id="fund-thesis"
        value={thesis}
        onChange={(e) => setThesis(e.target.value)}
        placeholder="e.g. We invest in pre-seed and seed B2B SaaS in North America, $500K–$2M checks, with a focus on vertical software and AI-native workflows."
        rows={5}
        className="crm-input min-h-32 leading-relaxed"
      />
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={loading}
          className="crm-button"
        >
          {loading ? "Saving…" : "Save thesis"}
        </button>
        {saved && (
          <span className="text-xs font-medium text-emerald-600">
            Saved.
          </span>
        )}
      </div>
    </div>
  );
}
