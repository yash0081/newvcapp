"use client";

import { CheckCircle2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type StepStatus = "pending" | "running" | "done";

export type AnalysisStep = {
  id: string;
  label: string;
  description: string;
  status: StepStatus;
};

export function AnalysisProgress({ steps }: { steps: AnalysisStep[] }) {
  if (!steps.length) return null;

  return (
    <div className="mt-3 rounded-2xl border border-gray-200 bg-white px-4 py-3">
      <p className="text-xs font-medium text-gray-700 mb-2">
        Analysis pipeline
      </p>
      <ol className="space-y-1.5">
        {steps.map((step) => (
          <li key={step.id} className="flex items-start gap-2 text-xs">
            <span className="mt-0.5">
              {step.status === "done" && (
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              )}
              {step.status === "running" && (
                <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />
              )}
              {step.status === "pending" && (
                <span className="h-4 w-4 rounded-full border border-gray-300 inline-block" />
              )}
            </span>
            <div className="flex-1 min-w-0">
              <div
                className={cn(
                  "font-medium",
                  step.status === "done"
                    ? "text-gray-800"
                    : step.status === "running"
                    ? "text-blue-700"
                    : "text-gray-500"
                )}
              >
                {step.label}
              </div>
              <p className="text-gray-500">
                {step.description}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

