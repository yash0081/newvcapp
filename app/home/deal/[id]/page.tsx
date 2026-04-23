import { createClient } from "@/lib/supabase/server";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AnalysisAccordion } from "@/app/home/pitch/[id]/analysis-accordion";
import { aggregateCommentaryStructured, type CommentaryInputs, type StructuredAnalysis } from "@/lib/commentary";
import { SIMILAR_PEERS_TOP_K, type SimilarPeerForPrompt } from "@/lib/similar-deals";
import { SimilarDealCard } from "@/components/similar-deal-card";
import { fetchCommonInvestorsForDeal, type CommonInvestorRow } from "@/lib/common-investors";
import { DealCrmForm } from "@/components/deal-crm-form";
import { DealMemoButton } from "@/components/deal-memo-button";
import { snippetPartsFromMarkdownRawOutput } from "@/lib/markdown-corpus-snippets";

type DealPageParams = {
  params: Promise<{ id: string }>;
};

function formatPerFounderFromSignal(rawOutput: Record<string, unknown> | null): string {
  const f3 = rawOutput?.founder_signal_json;
  if (!f3 || typeof f3 !== "object") return "";
  const per = (f3 as { per_founder?: unknown }).per_founder;
  if (!Array.isArray(per) || per.length === 0) return "";
  return per
    .map((p: unknown, i: number) => {
      if (!p || typeof p !== "object") return "";
      const r = p as Record<string, unknown>;
      const name =
        (typeof r.founder_name === "string" && r.founder_name.trim() ? r.founder_name.trim() : null) ??
        (typeof r.name === "string" && r.name.trim() ? r.name.trim() : null) ??
        `Founder ${i + 1}`;
      const role = typeof r.role === "string" && r.role.trim() ? r.role.trim() : "";
      const background =
        (typeof r.background === "string" && r.background.trim() ? r.background.trim() : "") ||
        (typeof r.background_summary === "string" && r.background_summary.trim()
          ? r.background_summary.trim()
          : "");
      const bits = [name];
      if (role) bits.push(`Role: ${role}`);
      if (background) bits.push(`Background: ${background}`);
      return bits.join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

/** Prefer full pipeline JSON from `deal_analyses.raw_output` so in-depth matches agent schemas (founder/traction/solution). */
function buildStructuredFromDeal(args: {
  problem: Record<string, unknown> | null;
  solution: Record<string, unknown> | null;
  traction: Record<string, unknown> | null;
  assumptions: Record<string, unknown>[];
  questions: Record<string, unknown>[];
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
      .map((row) => (row.question_text as string | null) ?? "")
      .filter((line) => line && line.trim().length > 0)
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
    const founderExtra = formatPerFounderFromSignal(rawOutput);
    if (founderExtra && !structured.founderTeam.details?.trim()) {
      return {
        ...structured,
        founderTeam: {
          ...structured.founderTeam,
          details: founderExtra,
        },
      };
    }
    return structured;
  }

  const joinDefined = (parts: Array<string | null | undefined | false>) =>
    parts
      .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      .join("\n\n");

  const mdSnippets =
    rawOutput && typeof rawOutput === "object" && rawOutput.parsing_json == null
      ? snippetPartsFromMarkdownRawOutput(rawOutput as Record<string, unknown>)
      : { problem: null, solution: null, traction: null, team: null };

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
    mdSnippets.problem ??
    null;
  const problemDetails = joinDefined([
    problem?.problem_statement != null && String(problem.problem_statement).trim()
      ? `Problem (from deck): ${String(problem.problem_statement)}`
      : null,
    problem?.root_cause_depth != null && String(problem.root_cause_depth).trim()
      ? `Root cause depth: ${String(problem.root_cause_depth)}`
      : null,
    problem?.economic_gravity != null && String(problem.economic_gravity).trim()
      ? `Economic gravity: ${String(problem.economic_gravity)}`
      : null,
    problem?.structural_urgency != null && String(problem.structural_urgency).trim()
      ? `Structural urgency: ${String(problem.structural_urgency)}`
      : null,
    problem?.persona_clarity != null && String(problem.persona_clarity).trim()
      ? `Persona clarity: ${String(problem.persona_clarity)}`
      : null,
    problem?.economic_buyer_persona != null && String(problem.economic_buyer_persona).trim()
      ? `Economic buyer: ${String(problem.economic_buyer_persona)}`
      : null,
    problem?.budget_priority_validation != null && String(problem.budget_priority_validation).trim()
      ? `Budget priority: ${String(problem.budget_priority_validation)}`
      : null,
  ]);

  const solutionSummary =
    (typeof ps?.solution === "string" && ps.solution.trim() ? ps.solution : null) ??
    (solution?.solution_summary as string | null) ??
    (solution?.moat_type as string | null) ??
    mdSnippets.solution ??
    null;
  const solutionDetails = joinDefined([
    solution?.solution_summary != null && String(solution.solution_summary).trim()
      ? `Solution: ${String(solution.solution_summary)}`
      : null,
    solution?.product_type != null && String(solution.product_type).trim()
      ? `Product type: ${String(solution.product_type)}`
      : null,
    solution?.moat_type != null && String(solution.moat_type).trim() ? `Moat type: ${String(solution.moat_type)}` : null,
    solution?.replication_difficulty != null && String(solution.replication_difficulty).trim()
      ? `Replication difficulty: ${String(solution.replication_difficulty)}`
      : null,
    solution?.compounding_potential != null && String(solution.compounding_potential).trim()
      ? `Compounding: ${String(solution.compounding_potential)}`
      : null,
    solution?.technical_moat_evidence != null && String(solution.technical_moat_evidence).trim()
      ? `Technical moat: ${String(solution.technical_moat_evidence)}`
      : null,
  ]);

  const tractionSummary =
    (typeof ps?.traction === "string" && ps.traction.trim() ? ps.traction : null) ??
    (traction?.inferred_stage as string | null) ??
    (traction?.benchmark_context as string | null) ??
    mdSnippets.traction ??
    null;
  const investorLine =
    Array.isArray(traction?.investor_list) && traction.investor_list.length > 0
      ? `Investors: ${traction.investor_list
          .map((v: unknown) =>
            typeof v === "string"
              ? v
              : v && typeof v === "object" && "name" in (v as Record<string, unknown>)
                ? String((v as Record<string, unknown>).name ?? "")
                : ""
          )
          .filter(Boolean)
          .join(", ")}`
      : null;

  const tractionDetails = joinDefined([
    traction?.inferred_stage != null && String(traction.inferred_stage).trim()
      ? `Inferred stage: ${String(traction.inferred_stage)}`
      : null,
    traction?.reported_arr != null && String(traction.reported_arr).trim()
      ? `Reported ARR: ${String(traction.reported_arr)}`
      : null,
    traction?.reported_revenue_growth_rate != null && String(traction.reported_revenue_growth_rate).trim()
      ? `Revenue growth rate: ${String(traction.reported_revenue_growth_rate)}`
      : null,
    investorLine,
    traction?.benchmark_context != null && String(traction.benchmark_context).trim()
      ? `Benchmark context: ${String(traction.benchmark_context)}`
      : null,
    traction?.signal_completeness != null && String(traction.signal_completeness).trim()
      ? `Signal completeness: ${String(traction.signal_completeness)}`
      : null,
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
    .map((row) => (row.question_text as string | null) ?? "")
    .filter((line) => line && line.trim().length > 0)
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
        mdSnippets.team ??
        "No summary.",
      details: formatPerFounderFromSignal(rawOutput),
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
      details: joinDefined([assumptionsText || undefined]),
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
      "id, company_name, website, created_at, source, decision, crm_notes, crm_stage, crm_next_step, deal_scores(dimension, raw_score, scoring_stage), deal_problem(*), deal_solution(*), deal_traction(*), deal_assumptions(*), deal_questions(*), deal_analyses(id, raw_output, similar_peers_json, run_at)"
    )
    .eq("id", dealId)
    .maybeSingle();

  if (dealError || !deal) {
    notFound();
  }

  const scores = (Array.isArray(deal.deal_scores) ? deal.deal_scores : []) as Array<{
    dimension?: string;
    raw_score?: unknown;
  }>;
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

  const analysesField = (deal as { deal_analyses?: unknown }).deal_analyses;
  const analysesRaw = Array.isArray(analysesField) ? analysesField : [];
  const analysesSorted = [...analysesRaw].sort((a: { run_at?: string | null }, b: { run_at?: string | null }) => {
    const ta = a.run_at ? new Date(a.run_at).getTime() : 0;
    const tb = b.run_at ? new Date(b.run_at).getTime() : 0;
    return tb - ta;
  });
  const latestAnalysis = analysesSorted[0] ?? null;
  const latestAnalysisId = latestAnalysis?.id as string | undefined;

  function pickRowsForLatestAnalysis<T extends { analysis_id?: string }>(
    rows: T | T[] | null | undefined
  ): T | null {
    const arr = Array.isArray(rows) ? rows : rows ? [rows] : [];
    if (!arr.length) return null;
    if (!latestAnalysisId) return arr[0] ?? null;
    return arr.find((r) => r.analysis_id === latestAnalysisId) ?? arr[0] ?? null;
  }

  const problemRow = pickRowsForLatestAnalysis(
    deal.deal_problem as { analysis_id?: string } | { analysis_id?: string }[] | null | undefined
  );
  const solutionRow = pickRowsForLatestAnalysis(
    deal.deal_solution as { analysis_id?: string } | { analysis_id?: string }[] | null | undefined
  );
  const tractionRow = pickRowsForLatestAnalysis(
    deal.deal_traction as { analysis_id?: string } | { analysis_id?: string }[] | null | undefined
  );
  const assumptionsRowsRaw = Array.isArray(deal.deal_assumptions) ? deal.deal_assumptions : [];
  let assumptionsRows = latestAnalysisId
    ? (assumptionsRowsRaw as { analysis_id?: string }[]).filter((a) => a.analysis_id === latestAnalysisId)
    : assumptionsRowsRaw;
  if (latestAnalysisId && assumptionsRows.length === 0 && assumptionsRowsRaw.length > 0) {
    assumptionsRows = assumptionsRowsRaw;
  }
  const questionsRowsRaw = Array.isArray(deal.deal_questions) ? deal.deal_questions : [];
  let questionsRows = latestAnalysisId
    ? (questionsRowsRaw as { analysis_id?: string }[]).filter((q) => q.analysis_id === latestAnalysisId)
    : questionsRowsRaw;
  if (latestAnalysisId && questionsRows.length === 0 && questionsRowsRaw.length > 0) {
    questionsRows = questionsRowsRaw;
  }
  const rawOutput = latestAnalysis?.raw_output ?? null;

  const structured = buildStructuredFromDeal({
    problem: (problemRow as Record<string, unknown> | null) ?? null,
    solution: (solutionRow as Record<string, unknown> | null) ?? null,
    traction: (tractionRow as Record<string, unknown> | null) ?? null,
    assumptions: (assumptionsRows as Record<string, unknown>[]) ?? [],
    questions: (questionsRows as Record<string, unknown>[]) ?? [],
    rawOutput: rawOutput as Record<string, unknown> | null,
  });

  const similarDeals: SimilarPeerForPrompt[] =
    (latestAnalysis?.similar_peers_json as SimilarPeerForPrompt[] | null) ??
    ((rawOutput as { similar_peers_context?: SimilarPeerForPrompt[] } | null)?.similar_peers_context ??
      []);

  const commonInvestors: CommonInvestorRow[] = await fetchCommonInvestorsForDeal(
    supabase,
    dealId,
    user.id
  );

  async function handleDelete() {
    "use server";
    const admin = await createClient();
    await admin.from("deals").delete().eq("id", dealId);
    redirect("/home/deals");
  }

  const isMarkdownCorpus = (deal as { source?: string | null }).source === "invested-companies-md";
  const scoresHavePlaceholder = ((deal.deal_scores as { scoring_stage?: string }[]) ?? []).some(
    (s) => s.scoring_stage === "corpus_markdown_placeholder"
  );

  return (
    <div className="space-y-6 pb-8">
        {isMarkdownCorpus && (
          <div className="rounded-xl border border-amber-200/90 bg-amber-50 px-4 py-3 text-sm text-amber-950 leading-relaxed">
            <strong className="font-medium">Markdown corpus deal</strong> (Invested Companies profile). Problem,
            solution, traction, and team live in normalized tables and in{" "}
            <code className="text-xs bg-amber-100/80 px-1 rounded">deal_analyses.raw_output</code>. For hierarchical
            nodes, pgvector embeddings, BM25, and hybrid retrieval, run{" "}
            <code className="text-xs bg-amber-100/80 px-1 rounded">
              npx tsx scripts/backfill-deal-context-nodes.ts --index-deals
            </code>
            .
            {scoresHavePlaceholder && (
              <>
                {" "}
                Grid scores with stage <code className="text-xs bg-amber-100/80 px-1 rounded">corpus_markdown_placeholder</code> are
                placeholders until a full PDF pipeline run replaces them.
              </>
            )}
          </div>
        )}
        <Card className="shadow-sm rounded-2xl border-zinc-200/90">
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between gap-2">
              <CardTitle className="text-lg font-semibold pr-2 text-zinc-900">
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
            <p className="text-sm text-zinc-500 mt-1">
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

        <Card className="shadow-sm rounded-2xl border-zinc-200/90">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold text-zinc-900">
              Analysis
            </CardTitle>
            <p className="text-sm text-zinc-500 mt-0.5">
              Expand a section to see details, evidence, and scores.
            </p>
          </CardHeader>
          <CardContent className="pt-0">
            <AnalysisAccordion data={structured} />
          </CardContent>
        </Card>

        <Card className="shadow-sm rounded-2xl border-zinc-200/90 border-dashed">
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-semibold text-zinc-900">Assistant</CardTitle>
            <p className="text-sm text-zinc-500 mt-0.5">
              Ask diligence questions in the main chat — this deal is passed as context when you open it from here.
            </p>
          </CardHeader>
          <CardContent className="pt-0">
            <Link
              href={`/home/chat?deal=${encodeURIComponent(dealId)}`}
              className="inline-flex items-center justify-center rounded-full bg-zinc-900 text-white text-sm font-medium px-4 py-2.5 hover:bg-zinc-800 transition-colors shadow-sm"
            >
              Open chat for this deal
            </Link>
          </CardContent>
        </Card>

        <DealCrmForm
          dealId={dealId}
          initial={{
            crm_notes: (deal as { crm_notes?: string | null }).crm_notes ?? null,
            crm_stage: (deal as { crm_stage?: string | null }).crm_stage ?? null,
            crm_next_step: (deal as { crm_next_step?: string | null }).crm_next_step ?? null,
          }}
        />

        <DealMemoButton dealId={dealId} />

        <Card className="shadow-sm rounded-2xl border-zinc-200/90">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold text-zinc-900">
              Similar companies in your corpus
            </CardTitle>
            <p className="text-sm text-zinc-500 mt-0.5">
              Top {SIMILAR_PEERS_TOP_K} by hybrid similarity (RRF score) among all your deals —
              pass or accept doesn&apos;t matter. Click the chevron to expand problem, solution, and
              investors. Re-run backfill if embeddings are missing.
            </p>
          </CardHeader>
          <CardContent className="pt-0 space-y-2">
            {similarDeals.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No similar deals found yet. After migration 010 is applied and this deal is
                indexed (automatically after upload analysis, or run{" "}
                <code className="text-xs bg-muted px-1 rounded">npm run backfill-embeddings</code>
                ), comparable companies appear here.
              </p>
            ) : (
              similarDeals.map((row) => <SimilarDealCard key={row.deal_id} row={row} />)
            )}
          </CardContent>
        </Card>

        <Card className="shadow-sm rounded-2xl border-zinc-200/90">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold text-zinc-900">
              Common investors across your corpus
            </CardTitle>
            <p className="text-sm text-zinc-500 mt-0.5">
              Investors in this deal who also backed other companies you&apos;ve analyzed (passed or
              invested). Uses your database only, no web search.
            </p>
          </CardHeader>
          <CardContent className="pt-0 space-y-3">
            {commonInvestors.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No overlapping investors found yet between this deal and your existing corpus.
              </p>
            ) : (
              commonInvestors.map((row) => (
                <div key={row.investor_id} className="border border-gray-200/80 rounded-lg px-4 py-3 bg-white">
                  <p className="text-sm font-medium text-gray-900">
                    {row.investor_name || "Unnamed investor"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Backed {row.deals.length} other deal{row.deals.length === 1 ? "" : "s"} in your corpus.
                  </p>
                  <ul className="mt-2 space-y-1 text-xs text-gray-700">
                    {row.deals.slice(0, 6).map((d) => (
                      <li key={d.deal_id} className="flex flex-wrap items-baseline gap-1">
                        <span className="font-medium">
                          <Link href={`/home/deal/${d.deal_id}`} className="hover:underline">
                            {d.company_name || "(Untitled deal)"}
                          </Link>
                        </span>
                        {d.decision && (
                          <span className="text-[11px] uppercase tracking-wide text-gray-500">
                            · {d.decision}
                          </span>
                        )}
                        {d.pass_reason && (
                          <span className="text-[11px] text-gray-500">
                            · {d.pass_reason}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </CardContent>
        </Card>
    </div>
  );
}

