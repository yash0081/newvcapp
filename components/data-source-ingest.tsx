"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const MIN_TEXT_CHARS = 50;

type Mode = "pdf" | "text";

export function DataSourceIngest() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("pdf");
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const textOk = text.trim().length >= MIN_TEXT_CHARS;

  async function submitPdf(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!file) {
      setError("Choose a PDF first.");
      return;
    }
    setLoading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/ingestion/phase1-placeholder", {
        method: "POST",
        body: formData,
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        dealId?: string;
        analysisId?: string;
      };
      if (!res.ok) {
        setError(data.error || "Ingest failed.");
        return;
      }
      if (data.dealId) {
        router.push(`/home/deal-intel/${data.dealId}`);
        return;
      }
      setError("Unexpected response.");
    } catch (err) {
      console.error(err);
      setError("Request failed.");
    } finally {
      setLoading(false);
    }
  }

  async function submitText(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const t = text.trim();
    if (t.length < MIN_TEXT_CHARS) {
      setError(`Paste at least ${MIN_TEXT_CHARS} characters.`);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/ingestion/phase1-placeholder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: t }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        dealId?: string;
      };
      if (!res.ok) {
        setError(data.error || "Ingest failed.");
        return;
      }
      if (data.dealId) {
        router.push(`/home/deal-intel/${data.dealId}`);
        return;
      }
      setError("Unexpected response.");
    } catch (err) {
      console.error(err);
      setError("Request failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            setMode("pdf");
            setError(null);
          }}
          className={cn(
            "rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
            mode === "pdf"
              ? "bg-zinc-900 text-white"
              : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200"
          )}
        >
          PDF
        </button>
        <button
          type="button"
          onClick={() => {
            setMode("text");
            setError(null);
          }}
          className={cn(
            "rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
            mode === "text"
              ? "bg-zinc-900 text-white"
              : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200"
          )}
        >
          Text
        </button>
      </div>

      {mode === "pdf" ? (
        <form onSubmit={submitPdf} className="flex flex-col gap-3 sm:flex-row sm:items-end sm:flex-wrap">
          <label className="inline-flex items-center justify-center rounded-xl border border-dashed border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:border-zinc-400 hover:bg-zinc-50 cursor-pointer transition-colors max-w-full">
            <span className="truncate">{file ? file.name : "Choose PDF…"}</span>
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
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-800 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {loading ? "Ingesting…" : "Ingest PDF"}
          </button>
        </form>
      ) : (
        <form onSubmit={submitText} className="space-y-3">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={`Paste memo, notes, or exported text (${MIN_TEXT_CHARS}+ characters).`}
            rows={8}
            className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600/50"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
            <span>
              {text.trim().length} / {MIN_TEXT_CHARS}+ characters
            </span>
            <button
              type="submit"
              disabled={loading || !textOk}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-800 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {loading ? "Ingesting…" : "Ingest text"}
            </button>
          </div>
        </form>
      )}

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-2xl px-3 py-2">{error}</p>
      )}
    </div>
  );
}
