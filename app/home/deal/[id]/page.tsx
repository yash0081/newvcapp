import { createClient } from "@/lib/supabase/server";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AnalysisAccordion } from "@/app/home/pitch/[id]/analysis-accordion";
import {
  aggregateCommentaryStructured,
  type CommentaryInputs,
  type StructuredAnalysis,
} from "@/lib/commentary";

type DealPageParams = {
  params: Promise<{ id: string }>;
};

/** Prefer full pipeline JSON from `deal_analyses.raw_output` so in-depth matches agent schemas (founder/traction/solution). */
function buildStructuredFromDeal(args: {
  problem: any | null;
  solution: any | null;
  traction: any | null;
  assumptions: any[];
  questions: any[];
  rawOutput: Record<string, unknown> | null;
}): StructuredAnalysis {
  const { problem, solution, traction, assumptions, questions, rawOutput } = args;

  if (rawOutput && typeof rawOutput === "object" && rawOutput.parsing_json != null) {
    const input: CommentaryInputs = {
      parsing_json: rawOutput.parsing_json as Record<string, unknown>,
      thesis_fit_json: rawOutput.thesis_fit_json as Record<string, unknown> | undefined,
      founder_signal_json: rawOutput.founder_signal_json as Record<string, unknown> | undefined,
      traction_signal_json: rawOutput.traction_signal_json as Record<string, unknown> | undefined,
      problem_quality_3c_json: rawOutput.problem_quality_3c_json as Record<string, unknown> | undefined,
      solution_defensibility_json: rawOutput.solution_defensibility_json as Record<string, unknown> | undefined,
      core_assumption_json: rawOutput.core_assumption_json as Record<string, unknown> | undefined,
      pipeline_summaries: rawOutput.pipeline_summaries as CommentaryInputs["pipeline_summaries"],
      questions_first_order_json: rawOutput.questions_first_order_json as Record<string, unknown> | undefined,
      questions_structural_json: rawOutput.questions_structural_json as Record<string, unknown> | undefined,
    };
    const structured = aggregateCommentaryStructured(input);
    const questionsFromDb = questions
      .map((q) => (q.question_text as string | null) ?? "")
      .filter((q) => q && q.trim().length > 0)
      .join("\n\n");
    if (!structured.questions.details?.trim() && questionsFromDb) {
      return {
        ...structured,
        questions: {
          summary: "Questions to ask the founder.",
          details: questionsFromDb,
        },
      };
    }
    return structured;
  }

  const joinDefined = (parts: (string | null | undefined)[]) =>
    parts.filter((p) => p && String(p).trim().length > 0).join("\n\n");

  const ps = rawOutput?.pipeline_summaries as
    | {
        founder?: string;
        traction?: string;
        problem?: string;
        solution?: string;
        assumptions?: string;
      }
    | undefined;

  const problemSummary =
    (typeof ps?.problem === "string" && ps.problem.trim() ? ps.problem : null) ??
    (problem?.problem_statement as string | null) ??
    (problem?.root_cause_depth as string | null) ??
    null;
  const problemDetails = joinDefined([
    problem?.problem_statement && `Problem (from deck): ${problem.problem_statement}`,
    problem?.root_cause_depth && `Root cause depth: ${problem.root_cause_depth}`,
    problem?.economic_gravity && `Economic gravity: ${problem.economic_gravity}`,
    problem?.structural_urgency && `Structural urgency: ${problem.structural_urgency}`,
    problem?.persona_clarity && `Persona clarity: ${problem.persona_clarity}`,
    problem?.economic_buyer_persona && `Economic buyer: ${problem.economic_buyer_persona}`,
    problem?.budget_priority_validation && `Budget priority: ${problem.budget_priority_validation}`,
  ]);

  const solutionSummary =
    (typeof ps?.solution === "string" && ps.solution.trim() ? ps.solution : null) ??
    (solution?.solution_summary as string | null) ??
    (solution?.moat_type as string | null) ??
    null;
  const solutionDetails = joinDefined([
    solution?.solution_summary && `Solution: ${solution.solution_summary}`,
    solution?.product_type && `Product type: ${solution.product_type}`,
    solution?.moat_type && `Moat type: ${solution.moat_type}`,
    solution?.replication_difficulty && `Replication difficulty: ${solution.replication_difficulty}`,
    solution?.compounding_potential && `Compounding: ${solution.compounding_potential}`,
    solution?.technical_moat_evidence && `Technical moat: ${solution.technical_moat_evidence}`,
  ]);

  const tractionSummary =
    (typeof ps?.traction === "string" && ps.traction.trim() ? ps.traction : null) ??
    (traction?.inferred_stage as string | null) ??
    (traction?.benchmark_context as string | null) ??
    null;
  const tractionDetails = joinDefined([
    traction?.inferred_stage && `Inferred stage: ${traction.inferred_stage}`,
    traction?.benchmark_context && `Benchmark context: ${traction.benchmark_context}`,
    traction?.signal_completeness && `Signal completeness: ${traction.signal_completeness}`,
  ]);

  const assumptionsText = assumptions
    .map((a) => {
      const lines: string[] = [];
      if (a.assumption_text) lines.push(`Assumption: ${a.assumption_text}`);
      if (a.must_be_true) lines.push(`Must be true: ${a.must_be_true}`);
      if (a.inversion) lines.push(`Inversion: ${a.inversion}`);
      if (a.why_fragile) lines.push(`Why fragile: ${a.why_fragile}`);
      if (a.failure_mode) lines.push(`Failure mode: ${a.failure_mode}`);
      return lines.join("\n");
    })
    .filter(Boolean)
    .join("\n\n");

  const questionsText = questions
    .map((q) => (q.question_text as string | null) ?? "")
    .filter((q) => q && q.trim().length > 0)
    .join("\n\n");

  return {
    problem: {
      summary: problemSummary ?? "No summary.",
      details: problemDetails || "",
    },
    solution: {
      summary: solutionSummary ?? "No summary.",
      details: solutionDetails || "",
    },
    founderTeam: {
      summary:
        (typeof ps?.founder === "string" && ps.founder.trim() ? ps.founder : null) ??
        (rawOutput?.founder_signal_json &&
        typeof rawOutput.founder_signal_json === "object" &&
        "summary_text" in (rawOutput.founder_signal_json as object) &&
        typeof (rawOutput.founder_signal_json as { summary_text?: string }).summary_text === "string"
          ? (rawOutput.founder_signal_json as { summary_text: string }).summary_text
          : null) ??
        "No summary.",
      details: "",
    },
    traction: {
      summary: tractionSummary ?? "No summary.",
      details: tractionDetails || "",
    },
    assumptions: {
      summary:
        (typeof ps?.assumptions === "string" && ps.assumptions.trim()
          ? ps.assumptions
          : assumptionsText
            ? "Key assumptions and fragility notes."
            : "No summary."),
      details: assumptionsText || "",
    },
    thesisFit: {
      summary: (() => {
        const tf = rawOutput?.thesis_fit_json as
          | { overall_thesis_alignment_reasoning?: unknown }
          | undefined;
        const r = tf?.overall_thesis_alignment_reasoning;
        return typeof r === "string" && r.trim() ? r : "No summary.";
      })(),
      details: "",
    },
    questions: {
      summary: questionsText ? "Questions to ask the founder." : "No summary.",
      details: questionsText || "",
    },
  };
}

export default async function DealPage({ params }: DealPageParams) {
  const { id: dealId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/");

  const { data: deal, error: dealError } = await supabase
    .from("deals")
    .select(
      "id, company_name, website, created_at, deal_scores(dimension, raw_score), deal_problem(*), deal_solution(*), deal_traction(*), deal_assumptions(*), deal_questions(*), deal_analyses(raw_output, run_at)"
    )
    .eq("id", dealId)
    .maybeSingle();

  if (dealError || !deal) {
    notFound();
  }

  const scores = (deal.deal_scores as any[]) ?? [];
  const normalizeScore = (v: unknown) => {
    if (typeof v !== "number" || Number.isNaN(v)) return null;
    return Math.max(0, Math.min(10, v));
  };
  const getScore = (dim: string) =>
    normalizeScore(scores.find((s) => s.dimension === dim)?.raw_score ?? null);

  const composite =
    (getScore("thesis_fit") ?? 0) +
    (getScore("founder") ?? 0) +
    (getScore("traction") ?? 0) +
    (getScore("problem") ?? 0) +
    (getScore("solution") ?? 0);
  const compositeScore = composite ? composite / 5 : 0;

  const problemRow = Array.isArray(deal.deal_problem)
    ? deal.deal_problem[0]
    : deal.deal_problem;
  const solutionRow = Array.isArray(deal.deal_solution)
    ? deal.deal_solution[0]
    : deal.deal_solution;
  const tractionRow = Array.isArray(deal.deal_traction)
    ? deal.deal_traction[0]
    : deal.deal_traction;
  const assumptionsRows = Array.isArray(deal.deal_assumptions)
    ? deal.deal_assumptions
    : [];
  const questionsRows = Array.isArray(deal.deal_questions)
    ? deal.deal_questions
    : [];
  const analyses = Array.isArray((deal as any).deal_analyses) ? (deal as any).deal_analyses : [];
  const rawOutput = analyses.length ? analyses[analyses.length - 1]?.raw_output ?? null : null;

  const structured = buildStructuredFromDeal({
    problem: problemRow,
    solution: solutionRow,
    traction: tractionRow,
    assumptions: assumptionsRows,
    questions: questionsRows,
    rawOutput: rawOutput as Record<string, unknown> | null,
  });

  async function handleDelete() {
    "use server";
    const admin = await createClient();
    await admin.from("deals").delete().eq("id", dealId);
    redirect("/home");
  }

  return (
    <main className="min-h-screen bg-gray-50/50 flex flex-col">
      <div className="border-b border-gray-200 bg-white p-4 flex justify-between items-center">
        <Link
          href="/home"
          className="text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors"
        >
          ← Back to home
        </Link>
      </div>

      <div className="flex-1 p-6 max-w-3xl mx-auto w-full space-y-6">
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between gap-2">
              <CardTitle className="text-lg font-semibold pr-2 text-gray-900">
                {deal.company_name || "(Untitled deal)"}
              </CardTitle>
              <div className="flex items-center gap-2 shrink-0">
                <Badge variant="secondary" className="font-medium">
                  {compositeScore.toFixed(1)}
                </Badge>
                <form action={handleDelete}>
                  <button
                    type="submit"
                    className="text-xs text-red-600 hover:text-red-800 underline underline-offset-2"
                  >
                    Delete analysis
                  </button>
                </form>
              </div>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              {deal.website && (
                <>
                  Website:{" "}
                  <span className="underline decoration-dotted">
                    {deal.website}
                  </span>
                  {" · "}
                </>
              )}
              Created{" "}
              {deal.created_at
                ? new Date(deal.created_at).toLocaleString()
                : "—"}
            </p>
          </CardHeader>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold text-gray-900">
              Analysis
            </CardTitle>
            <p className="text-sm text-muted-foreground mt-0.5">
              Expand a section to see details, evidence, and scores.
            </p>
          </CardHeader>
          <CardContent className="pt-0">
            <AnalysisAccordion data={structured} />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

