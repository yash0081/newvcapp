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
      <div className="rounded-lg border border-gray-200 bg-gray-50/50 p-4">
        <p className="text-sm text-gray-500">Loading fund thesis…</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50/50 p-4 space-y-3">
      <div>
        <label htmlFor="fund-thesis" className="block text-sm font-medium text-gray-700 mb-1">
          Fund thesis statement
        </label>
        <p className="text-xs text-gray-500 mb-2">
          Used to score how well each pitch deck aligns with your fund’s focus (sector, stage, geography, check size).
        </p>
        <textarea
          id="fund-thesis"
          value={thesis}
          onChange={(e) => setThesis(e.target.value)}
          placeholder="e.g. We invest in pre-seed and seed B2B SaaS in North America, $500K–$2M checks, with a focus on vertical software and AI-native workflows."
          rows={4}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm placeholder:text-gray-400 focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-500"
        />
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={loading}
          className="px-3 py-1.5 rounded-md border border-gray-300 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          {loading ? "Saving…" : "Save thesis"}
        </button>
        {saved && (
          <span className="text-sm text-green-600">Saved.</span>
        )}
      </div>
    </div>
  );
}
