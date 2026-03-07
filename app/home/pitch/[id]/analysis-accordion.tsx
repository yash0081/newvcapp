"use client";

import { useState } from "react";
import type { StructuredAnalysis } from "@/lib/commentary";
import { ChevronDown, ChevronRight, Lightbulb, Users, TrendingUp, Target, Puzzle, Scale, HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";

const SECTION_CONFIG: { key: keyof StructuredAnalysis; label: string; icon: React.ElementType }[] = [
  { key: "problem", label: "Problem", icon: Target },
  { key: "solution", label: "Solution", icon: Lightbulb },
  { key: "founderTeam", label: "Founder / team", icon: Users },
  { key: "traction", label: "Traction", icon: TrendingUp },
  { key: "assumptions", label: "Assumptions", icon: Puzzle },
  { key: "thesisFit", label: "Thesis fit", icon: Scale },
   { key: "questions", label: "Questions to ask", icon: HelpCircle },
];

/** Match "Label: " or "Label; " or "Label;" for bold prefix; ensures a space before the value. */
function splitLabelValue(line: string): { label: string; value: string } | null {
  const colonSpace = line.indexOf(": ");
  const semiSpace = line.indexOf("; ");
  const semiOnly = line.indexOf(";");
  let cut = -1;
  let labelEnd = 0;
  if (colonSpace > 0) {
    cut = colonSpace + 2;
    labelEnd = colonSpace + 1;
  } else if (semiSpace > 0) {
    cut = semiSpace + 2;
    labelEnd = semiSpace + 1;
  } else if (semiOnly > 0) {
    cut = semiOnly + 1;
    labelEnd = semiOnly + 1;
  }
  if (cut <= 0) return null;
  return {
    label: line.slice(0, labelEnd),
    value: line.slice(cut).trimStart(),
  };
}

/** Render details text with labels (text before ": " or "; ") bolded; always a space between label and value. */
function DetailsContent({
  text,
  sectionKey,
}: {
  text: string;
  sectionKey?: keyof StructuredAnalysis;
}) {
  const isAssumptionsOrQuestions =
    sectionKey === "assumptions" || sectionKey === "questions";
  const blocks = text.split(/\n\n+/).filter(Boolean);
  return (
    <div className="space-y-3 text-sm text-gray-600 leading-relaxed">
      {blocks.map((block, i) => {
        const lines = block.split("\n").filter(Boolean);
        return (
          <div key={i} className="space-y-1">
            {lines.map((line, j) => {
              const parts = splitLabelValue(line);
              if (parts) {
                return (
                  <p key={j}>
                    <span className="font-semibold text-gray-800">{parts.label}</span>{" "}
                    {parts.value}
                  </p>
                );
              }
              // Standalone line: bold only in problem/solution/founder/traction/thesis; assumptions/questions show as normal prose
              if (!isAssumptionsOrQuestions) {
                return (
                  <p key={j} className="font-semibold text-gray-800 pt-0.5">
                    {line}
                  </p>
                );
              }
              return (
                <p key={j} className="pt-0.5">
                  {line}
                </p>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

export function AnalysisAccordion({ data }: { data: StructuredAnalysis }) {
  const [openSet, setOpenSet] = useState<Set<keyof StructuredAnalysis>>(new Set());

  return (
    <div className="space-y-1">
      {SECTION_CONFIG.map(({ key, label, icon: Icon }) => {
        const section = data[key];
        if (!section || (!section.summary && !section.details)) return null;
        const isOpen = openSet.has(key);
        const hasDetails = section.details && section.details.trim().length > 0;
        const hasSummary = section.summary && section.summary !== "No summary.";

        return (
          <div
            key={key}
            className={cn(
              "rounded-lg border border-gray-200/80 bg-white transition-colors",
              isOpen && "ring-1 ring-gray-200"
            )}
          >
            <button
              type="button"
              onClick={() => {
                setOpenSet((prev) => {
                  const next = new Set(prev);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                });
              }}
              className={cn(
                "flex w-full items-center gap-3 px-4 py-3.5 text-left",
                "hover:bg-gray-50/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-300 focus-visible:ring-offset-2",
                "rounded-lg transition-colors"
              )}
              aria-expanded={isOpen}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-gray-100 text-gray-600">
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="font-medium text-gray-900">{label}</span>
                <p className="mt-0.5 text-sm text-gray-500 whitespace-pre-wrap">
                  {hasSummary ? section.summary : "—"}
                </p>
              </span>
              {hasDetails && (
                <span className="shrink-0 text-gray-400">
                  {isOpen ? <ChevronDown className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
                </span>
              )}
            </button>
            {hasDetails && isOpen && (
              <div className="border-t border-gray-100 px-4 pb-4 pt-3">
                <div className="pl-11">
                  <p className="font-medium text-gray-800 mb-2 text-sm">In-depth analysis</p>
                  <DetailsContent text={section.details} sectionKey={key} />
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
