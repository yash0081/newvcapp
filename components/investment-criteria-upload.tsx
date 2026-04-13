"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type DocRow = {
  id: string;
  original_filename: string | null;
  status: string;
  error_message: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type Aggregated = {
  problem?: unknown[];
  solution?: unknown[];
  founder?: unknown[];
} | null;

export function InvestmentCriteriaUpload() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [aggregated, setAggregated] = useState<Aggregated>(null);
  const [contextUpdatedAt, setContextUpdatedAt] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    setListLoading(true);
    try {
      const res = await fetch("/api/investment-rules");
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setLoadError((data as { error?: string }).error || "Failed to load");
        return;
      }
      const data = (await res.json()) as {
        documents: DocRow[];
        aggregatedBySection: Aggregated;
        contextUpdatedAt: string | null;
      };
      setDocs(data.documents ?? []);
      setAggregated(data.aggregatedBySection ?? null);
      setContextUpdatedAt(data.contextUpdatedAt ?? null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function pickFile(f: File | undefined) {
    if (!f) return;
    if (f.type === "application/pdf") {
      setFile(f);
      setFeedback(null);
    } else {
      setFeedback({ type: "err", text: "Please choose a PDF file." });
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setFeedback({ type: "err", text: "Choose a PDF to upload." });
      return;
    }
    setLoading(true);
    setFeedback(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/investment-rules/upload", {
        method: "POST",
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFeedback({
          type: "err",
          text: (data as { error?: string }).error || "Upload failed.",
        });
        return;
      }
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      await load();
      const rulesInserted = (data as { rulesInserted?: number }).rulesInserted;
      setFeedback({
        type: "ok",
        text:
          typeof rulesInserted === "number"
            ? `Saved ${rulesInserted} rule${rulesInserted === 1 ? "" : "s"} from this document.`
            : "Document processed.",
      });
    } catch (err) {
      console.error(err);
      setFeedback({ type: "err", text: "Something went wrong. Try again." });
    } finally {
      setLoading(false);
    }
  }

  const counts = aggregated
    ? {
        problem: Array.isArray(aggregated.problem) ? aggregated.problem.length : 0,
        solution: Array.isArray(aggregated.solution) ? aggregated.solution.length : 0,
        founder: Array.isArray(aggregated.founder) ? aggregated.founder.length : 0,
      }
    : { problem: 0, solution: 0, founder: 0 };

  return (
    <div className="rounded-xl border border-gray-200 bg-white/70 p-4 shadow-sm space-y-4">
      <div className="space-y-1">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-sm font-semibold text-gray-800">Investment criteria documents</h2>
          <button
            type="button"
            onClick={() => void load()}
            disabled={listLoading}
            className="text-xs text-gray-600 underline-offset-2 hover:underline disabled:opacity-50"
          >
            {listLoading ? "Loading…" : "Refresh list"}
          </button>
        </div>
        <p className="text-xs text-gray-500 leading-relaxed">
          PDFs you add here are parsed into rules and applied in the deal pipeline (problem, solution,
          and founder steps).
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <label className="inline-flex min-h-[40px] max-w-full items-center rounded-lg border border-dashed border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:border-gray-400 cursor-pointer transition-colors">
            <span className="truncate">{file ? file.name : "Choose PDF…"}</span>
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={(e) => pickFile(e.target.files?.[0])}
            />
          </label>
          <button
            type="submit"
            disabled={loading || !file}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-black disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {loading ? "Processing…" : "Upload and extract"}
          </button>
        </div>

        {feedback && (
          <p
            className={cn(
              "text-xs",
              feedback.type === "ok" ? "text-gray-700" : "text-red-700"
            )}
            role="status"
          >
            {feedback.text}
          </p>
        )}
      </form>

      <div className="border-t border-gray-200 pt-3 space-y-1 text-xs text-gray-600">
        <p>
          Rules in use — Problem: {counts.problem}, Solution: {counts.solution}, Founder:{" "}
          {counts.founder}
        </p>
        {contextUpdatedAt && (
          <p className="text-gray-500">
            Context last updated: {new Date(contextUpdatedAt).toLocaleString()}
          </p>
        )}
      </div>

      {loadError && <p className="text-xs text-red-700">{loadError}</p>}

      <div>
        <p className="text-xs font-medium text-gray-700 mb-2">Uploaded documents</p>
        {listLoading ? (
          <p className="text-xs text-gray-500 py-2">Loading…</p>
        ) : !docs.length ? (
          <p className="text-xs text-gray-500">None yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100 border border-gray-100 rounded-lg overflow-hidden bg-white">
            {docs.map((d) => (
              <li key={d.id} className="px-3 py-2.5 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-gray-900 truncate max-w-[min(100%,16rem)]">
                    {d.original_filename || d.id.slice(0, 8) + "…"}
                  </span>
                  <span className="text-xs text-gray-500 capitalize">{d.status}</span>
                </div>
                {d.created_at && (
                  <p className="text-xs text-gray-400 mt-0.5">
                    {new Date(d.created_at).toLocaleString()}
                  </p>
                )}
                {d.error_message && (
                  <p className="text-xs text-red-700 mt-1">{d.error_message}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
