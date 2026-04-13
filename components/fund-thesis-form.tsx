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
      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        <p className="text-sm text-zinc-600">Loading fund thesis…</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm space-y-4 text-zinc-900">
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
        className="w-full rounded-lg border border-zinc-200 px-3.5 py-2.5 text-sm leading-relaxed text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900/15 bg-white"
      />
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={loading}
          className="inline-flex items-center rounded-lg bg-gray-900 px-3.5 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-black disabled:opacity-50"
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
