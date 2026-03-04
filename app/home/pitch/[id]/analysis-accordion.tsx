"use client";

import { useState } from "react";
import type { StructuredAnalysis } from "@/lib/commentary";
import { ChevronDown, ChevronRight, Lightbulb, Users, TrendingUp, Target, Puzzle, Scale } from "lucide-react";
import { cn } from "@/lib/utils";

const SECTION_CONFIG: { key: keyof StructuredAnalysis; label: string; icon: React.ElementType }[] = [
  { key: "problem", label: "Problem", icon: Target },
  { key: "solution", label: "Solution", icon: Lightbulb },
  { key: "founderTeam", label: "Founder / team", icon: Users },
  { key: "traction", label: "Traction", icon: TrendingUp },
  { key: "assumptions", label: "Assumptions", icon: Puzzle },
  { key: "thesisFit", label: "Thesis fit", icon: Scale },
];

export function AnalysisAccordion({ data }: { data: StructuredAnalysis }) {
  const [openSet, setOpenSet] = useState<Set<keyof StructuredAnalysis>>(new Set());

  return (
    <div className="space-y-1">
      {SECTION_CONFIG.map(({ key, label, icon: Icon }) => {
        const section = data[key];
        if (!section || (!section.summary && !section.details)) return null;
        const isOpen = openSet.has(key);
        const hasDetails = section.details && section.details.trim().length > 0;

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
                <p className="mt-0.5 line-clamp-2 text-sm text-gray-500">
                  {section.summary === "No summary." ? "—" : section.summary}
                </p>
              </span>
              {hasDetails && (
                <span className="shrink-0 text-gray-400">
                  {isOpen ? <ChevronDown className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
                </span>
              )}
            </button>
            {hasDetails && isOpen && (
              <div className="border-t border-gray-100 px-4 pb-4 pt-2">
                <div className="pl-11 text-sm text-gray-600 whitespace-pre-wrap leading-relaxed">
                  {section.details}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
