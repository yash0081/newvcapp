"use client";

import { useMemo, useState } from "react";
import { stripModelPromptEcho, type StructuredAnalysis } from "@/lib/commentary";
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

/** Section titles from lib/commentary.ts (Analysis, Competitors:, Metrics, etc.) — not full sentences. */
function isSectionHeaderLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (t.startsWith("•") || t.startsWith("-")) return false;
  if (splitLabelValue(line)) return false;

  // "Competitors:" or "Metrics:" with nothing on the same line after ":"
  if (/^[^:\n]+:\s*$/.test(t)) return true;

  if (t.length > 88) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 10) return false;
  // Likely prose, not a header
  if (/\.\s+[A-Z]/.test(t) || (t.includes(".") && words.length > 5)) return false;

  const known =
    /^(Analysis|Customer|Evidence|Defensibility|Signal interpretation|Metrics|Context|Team evidence|Per-founder|Founder scores|Scores|Linchpin|Critical assumptions|Failure mode|Killer question|Conviction delta|Inferred context|Traction|Differentiation|Problem|Solution|Sources|Questions|Assumption|Market|Thesis)/i;
  if (known.test(t)) return true;

  // Short title-style lines (e.g. "Signal interpretation" already matched; catch "Key risks")
  if (words.length <= 6 && !t.includes(":") && !t.includes(",")) {
    const titleCaseish =
      /^([A-Z][a-zA-Z'-]*)(\s+[A-Z][a-zA-Z'-]*){0,5}$/.test(t) ||
      /^[A-Z][a-z]+(\s+[a-z]+){0,4}$/i.test(t);
    if (titleCaseish && words.length <= 5) return true;
  }
  return false;
}

/** Locate `Scores` block (matches commentary output; legacy `Thesis fit scores` supported). */
function findThesisScoresMarker(text: string): { idx: number; len: number } | null {
  const candidates = ["Scores\n", "Thesis fit scores\n"];
  let best: { idx: number; len: number } | null = null;
  for (const m of candidates) {
    const i = text.indexOf(m);
    if (i >= 0 && (!best || i < best.idx)) best = { idx: i, len: m.length };
  }
  return best;
}

/** Bold "Industry", "Stage", "Funding fit" headings; remainder of line stays normal weight. */
function ThesisScoreLine({ line }: { line: string }) {
  const sep = " — ";
  const i = line.indexOf(sep);
  if (i > 0) {
    const head = line.slice(0, i);
    const tail = line.slice(i + sep.length);
    return (
      <p className="leading-relaxed text-gray-700">
        <span className="font-semibold text-gray-900">{head}</span>
        {sep}
        {tail}
      </p>
    );
  }
  return <p className="leading-relaxed text-gray-700">{line}</p>;
}

/** Thesis: plain body text, then a muted "Scores" row + industry / stage / funding lines at the bottom. */
function ThesisFitDetailsContent({ text }: { text: string }) {
  const found = findThesisScoresMarker(text);
  const idx = found?.idx ?? -1;
  const markerLen = found?.len ?? 0;
  if (idx === -1) {
    return (
      <div className="space-y-1.5 text-sm text-gray-700 leading-relaxed">
        {text
          .trim()
          .split("\n")
          .filter((l) => l.length > 0)
          .map((line, j) => (
            <p key={j} className="leading-relaxed">
              {line}
            </p>
          ))}
      </div>
    );
  }
  const before = text.slice(0, idx).trim();
  const scoreLines = text.slice(idx + markerLen).trim();
  return (
    <>
      {before ? (
        <div className="space-y-1.5 text-sm text-gray-700 leading-relaxed mb-4">
          {before.split("\n").map((line, j) => (
            <p key={`b-${j}`} className="leading-relaxed">
              {line}
            </p>
          ))}
        </div>
      ) : null}
      <div className={before ? "pt-3 border-t border-gray-100" : ""}>
        <p className="text-xs font-medium text-gray-500 mb-2">Scores</p>
        <div className="space-y-1 text-sm text-gray-700">
          {scoreLines.split("\n").filter(Boolean).map((line, j) => (
            <ThesisScoreLine key={`s-${j}`} line={line} />
          ))}
        </div>
      </div>
    </>
  );
}

/** Render details: section headers bold; "Label: value" gets bold label; indented lines are sub-bullets. */
function DetailsContent({
  text,
  sectionKey,
}: {
  text: string;
  sectionKey?: keyof StructuredAnalysis;
}) {
  if (sectionKey === "thesisFit") {
    return <ThesisFitDetailsContent text={text} />;
  }

  const isAssumptionsOrQuestions =
    sectionKey === "assumptions" || sectionKey === "questions";
  const blocks = text.split(/\n\n+/).filter(Boolean);
  return (
    <div className="space-y-3 text-sm text-gray-600 leading-relaxed">
      {blocks.map((block, i) => {
        const lines = block.split("\n").filter((l) => l.trim().length > 0);
        return (
          <div key={i} className="space-y-1.5">
            {lines.map((line, j) => {
              const indent = line.match(/^(\s{2,})/);
              const trimmed = line.trim();
              const contentLine = indent ? line.trim() : line;

              if (indent) {
                return (
                  <p
                    key={j}
                    className="pl-3 ml-0.5 border-l border-gray-200 text-gray-700 text-[13px] leading-relaxed"
                  >
                    {trimmed}
                  </p>
                );
              }

              const parts = splitLabelValue(contentLine);
              if (parts) {
                return (
                  <p key={j} className="text-gray-700">
                    <span className="font-semibold text-gray-900">{parts.label}</span>{" "}
                    {parts.value}
                  </p>
                );
              }

              if (isSectionHeaderLine(contentLine)) {
                return (
                  <p
                    key={j}
                    className="font-semibold text-gray-900 pt-1.5 first:pt-0"
                  >
                    {trimmed}
                  </p>
                );
              }

              if (!isAssumptionsOrQuestions) {
                return (
                  <p key={j} className="text-gray-700 pt-0.5 leading-relaxed">
                    {contentLine}
                  </p>
                );
              }
              return (
                <p key={j} className="pt-0.5 leading-relaxed">
                  {contentLine}
                </p>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** Strip search-grounding index junk (e.g. `[1, 5, 6]`) and prompt echo; UI-only. */
function stripStructuredForDisplay(data: StructuredAnalysis): StructuredAnalysis {
  const sec = (s: { summary: string; details: string }) => ({
    summary: stripModelPromptEcho(s.summary),
    details: stripModelPromptEcho(s.details),
  });
  return {
    problem: sec(data.problem),
    solution: sec(data.solution),
    founderTeam: sec(data.founderTeam),
    traction: sec(data.traction),
    assumptions: sec(data.assumptions),
    thesisFit: sec(data.thesisFit),
    questions: sec(data.questions),
  };
}

export function AnalysisAccordion({ data }: { data: StructuredAnalysis }) {
  const [openSet, setOpenSet] = useState<Set<keyof StructuredAnalysis>>(new Set());
  const displayData = useMemo(() => stripStructuredForDisplay(data), [data]);

  return (
    <div className="space-y-1">
      {SECTION_CONFIG.map(({ key, label, icon: Icon }) => {
        const section = displayData[key];
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
