"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function PitchDeckUpload() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      alert("Please choose a PDF file first.");
      return;
    }
    setLoading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/pitch-decks/upload", {
        method: "POST",
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || "Failed to analyze pitch deck.");
        return;
      }
      if (data.dealId) {
        router.push(`/home/deal/${data.dealId}`);
      } else {
        alert("Analysis completed, but deal ID was missing.");
      }
    } catch (err) {
      console.error(err);
      alert("Failed to upload pitch deck.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-2xl border border-gray-200 bg-gradient-to-br from-white to-gray-50/70 px-5 py-4 shadow-sm flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="space-y-1.5 flex-1 min-w-0">
        <h2 className="text-base sm:text-lg font-semibold text-gray-900">
          Analyze a new pitch deck
        </h2>
        <p className="text-xs sm:text-sm text-gray-600">
          Drop in a PDF and we&apos;ll run the full multi-agent pipeline (problem, solution, team,
          traction, assumptions, questions).
        </p>
        {loading && <p className="mt-2 text-xs text-blue-700">Running full analysis, this may take a minute...</p>}
      </div>

      <div className="flex flex-col sm:flex-row gap-2 sm:items-center sm:shrink-0">
        <label className="inline-flex items-center justify-center rounded-xl border border-dashed border-gray-300 bg-white px-3 py-2 text-xs sm:text-sm font-medium text-gray-700 hover:border-gray-400 hover:bg-gray-50 cursor-pointer transition-colors">
          <span className="truncate max-w-[140px] sm:max-w-[180px]">
            {file ? file.name : "Choose PDF…"}
          </span>
          <input
            type="file"
            accept="application/pdf"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="hidden"
          />
        </label>
        <button
          type="submit"
          disabled={loading || !file}
          className="inline-flex items-center justify-center rounded-xl bg-gray-900 px-3.5 py-2 text-xs sm:text-sm font-semibold text-white shadow-sm hover:bg-black disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? "Running analysis…" : "Run analysis"}
        </button>
      </div>
    </form>
  );
}


