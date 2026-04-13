"use client";

import { useState } from "react";
import Link from "next/link";
import { Building2, ChevronDown, ChevronRight } from "lucide-react";

import type { SimilarPeerForPrompt } from "@/lib/similar-deals";
import { cn } from "@/lib/utils";

function headerPreview(row: SimilarPeerForPrompt): string {
  const p = row.problem_one_liner?.trim();
  const s = row.solution_one_liner?.trim();
  if (p) return p;
  if (s) return s;
  return "Tap the chevron to expand.";
}

export function SimilarDealCard({ row }: { row: SimilarPeerForPrompt }) {
  const [open, setOpen] = useState(false);

  const hasBody =
    Boolean(row.problem_one_liner?.trim()) ||
    Boolean(row.solution_one_liner?.trim()) ||
    row.investors.length > 0;

  const decision = row.decision?.trim();

  return (
    <div
      className={cn(
        "rounded-lg border border-gray-200/80 bg-white transition-colors",
        open && "ring-1 ring-gray-200"
      )}
    >
      <div
        className={cn(
          "flex w-full items-center gap-3 px-4 py-3.5 text-left",
          "rounded-lg"
        )}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-gray-100 text-gray-600">
          <Building2 className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <Link href={`/home/deal/${row.deal_id}`} className="font-medium text-gray-900 hover:underline">
            {row.company_name}
          </Link>
          {decision ? (
            <p className="mt-0.5 text-[11px] uppercase tracking-wide text-gray-500">
              {decision}
            </p>
          ) : null}
          <p className="mt-0.5 text-sm text-gray-500 whitespace-pre-wrap line-clamp-2">
            {headerPreview(row)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground" title="Reciprocal rank fusion (higher = more similar)">
            RRF {row.rrf_score.toFixed(4)}
          </p>
        </div>
        {hasBody ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className={cn(
              "shrink-0 rounded-md p-1.5 text-gray-400",
              "hover:bg-gray-100 hover:text-gray-600",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-300 focus-visible:ring-offset-2"
            )}
            aria-expanded={open}
            aria-label={open ? "Collapse" : "Expand"}
          >
            {open ? <ChevronDown className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
          </button>
        ) : null}
      </div>

      {hasBody && open && (
        <div className="border-t border-gray-100 px-4 pb-4 pt-3">
          <div className="pl-11 space-y-3 text-sm">
            {row.problem_one_liner?.trim() && (
              <p className="text-muted-foreground whitespace-pre-wrap break-words">
                <span className="font-medium text-gray-700">Problem: </span>
                {row.problem_one_liner}
              </p>
            )}
            {row.solution_one_liner?.trim() && (
              <p className="text-muted-foreground whitespace-pre-wrap break-words">
                <span className="font-medium text-gray-700">Solution: </span>
                {row.solution_one_liner}
              </p>
            )}
            {row.investors.length > 0 && (
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-gray-700">Investors: </span>
                {row.investors.join(", ")}
              </p>
            )}
            {row.pass_reason?.trim() && (
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-gray-700">Pass reason: </span>
                {row.pass_reason}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
