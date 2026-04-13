"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AnalysisProgress, type AnalysisStep } from "@/components/analysis-progress";
import {
  PIPELINE_STEP_META,
  type DealSourcingPipelineStep,
} from "@/lib/deal-sourcing-types";

function initialSteps(firstRunning: boolean): AnalysisStep[] {
  return PIPELINE_STEP_META.map((m, i) => ({
    id: m.id,
    label: m.label,
    description: m.description,
    status: (firstRunning && i === 0 ? "running" : "pending") as AnalysisStep["status"],
  }));
}

export function PitchDeckUpload() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [steps, setSteps] = useState<AnalysisStep[]>(() => initialSteps(false));

  const stepIndexMap = useMemo(() => {
    const m = new Map<DealSourcingPipelineStep, number>();
    PIPELINE_STEP_META.forEach((s, i) => m.set(s.id, i));
    return m;
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      alert("Please choose a PDF file first.");
      return;
    }
    setLoading(true);
    setSteps(initialSteps(true));
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/pitch-decks/upload", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert((data as { error?: string }).error || "Failed to analyze pitch deck.");
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        alert("Streaming response not supported in this browser.");
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";

      /** Step event = that stage just finished; show next as in-flight until the following event. */
      const applyStepProgress = (stepId: DealSourcingPipelineStep) => {
        const idx = stepIndexMap.get(stepId);
        if (idx === undefined) return;
        setSteps((prev) =>
          prev.map((s, i) => {
            if (i < idx) return { ...s, status: "done" as const };
            if (i === idx) return { ...s, status: "done" as const };
            if (i === idx + 1) return { ...s, status: "running" as const };
            return { ...s, status: "pending" as const };
          })
        );
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let msg: { type?: string; step?: DealSourcingPipelineStep; dealId?: string; message?: string };
          try {
            msg = JSON.parse(trimmed) as typeof msg;
          } catch {
            continue;
          }
          if (msg.type === "step" && msg.step) {
            applyStepProgress(msg.step);
          }
          if (msg.type === "done" && msg.dealId) {
            router.push(`/home/deal/${msg.dealId}`);
            return;
          }
          if (msg.type === "error") {
            alert(msg.message || "Analysis failed.");
            return;
          }
        }
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
        <h2 className="text-base sm:text-lg font-semibold text-zinc-900">
          Run PDF pipeline
        </h2>
        <p className="text-xs sm:text-sm text-zinc-600">
          Upload a deck for the scored multi-agent pass (parse → thesis & traction in parallel → problem →
          solution → founders → assumptions). For open Q&amp;A across deals, use the Assistant.
        </p>
        {loading && (
          <>
            <p className="mt-2 text-xs text-blue-700">Running full analysis, this may take a minute…</p>
            <AnalysisProgress steps={steps} />
          </>
        )}
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
