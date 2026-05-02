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
    <div className="space-y-4">
      <div className="space-y-1">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-sm font-semibold text-zinc-950">Investment criteria documents</h2>
          <button
            type="button"
            onClick={() => void load()}
            disabled={listLoading}
            className="text-xs font-medium text-zinc-600 underline-offset-2 hover:underline disabled:opacity-50"
          >
            {listLoading ? "Loading…" : "Refresh list"}
          </button>
        </div>
        <p className="text-xs text-zinc-500 leading-relaxed">
          PDFs you add here are parsed into rules and applied in the deal pipeline (problem, solution,
          and founder steps).
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <label className="inline-flex h-9 max-w-full cursor-pointer items-center rounded-xl border border-dashed border-zinc-300 bg-white px-3 text-sm text-zinc-700 transition-colors hover:border-zinc-400">
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
            className="crm-button"
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {loading ? "Processing…" : "Upload and extract"}
          </button>
        </div>

        {feedback && (
          <p
            className={cn(
              "rounded-xl border px-3 py-2 text-xs",
              feedback.type === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-800"
            )}
            role="status"
          >
            {feedback.text}
          </p>
        )}
      </form>

      <div className="grid gap-2 border-t border-zinc-200 pt-3 text-xs text-zinc-600 md:grid-cols-3">
        <p>
          Problem rules: <span className="font-semibold text-zinc-900">{counts.problem}</span>
        </p>
        <p>
          Solution rules: <span className="font-semibold text-zinc-900">{counts.solution}</span>
        </p>
        <p>
          Founder rules: <span className="font-semibold text-zinc-900">{counts.founder}</span>
        </p>
        {contextUpdatedAt && (
          <p className="text-zinc-500 md:col-span-3">
            Context last updated: {new Date(contextUpdatedAt).toLocaleString()}
          </p>
        )}
      </div>

      {loadError && <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">{loadError}</p>}

      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Uploaded documents</p>
        {listLoading ? (
          <p className="py-2 text-xs text-zinc-500">Loading…</p>
        ) : !docs.length ? (
          <p className="rounded-xl border border-dashed border-zinc-200 bg-zinc-50 px-3 py-4 text-center text-xs text-zinc-500">None yet.</p>
        ) : (
          <ul className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
            {docs.map((d) => (
              <li key={d.id} className="border-b border-zinc-100 px-3 py-2.5 text-sm last:border-b-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="max-w-[min(100%,16rem)] truncate text-zinc-950">
                    {d.original_filename || d.id.slice(0, 8) + "…"}
                  </span>
                  <span className="rounded-xl border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[11px] capitalize text-zinc-600">{d.status}</span>
                </div>
                {d.created_at && (
                  <p className="mt-0.5 text-xs text-zinc-400">
                    {new Date(d.created_at).toLocaleString()}
                  </p>
                )}
                {d.error_message && (
                  <p className="mt-1 text-xs text-rose-700">{d.error_message}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
