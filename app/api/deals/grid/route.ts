import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  snippetPartsFromMarkdownRawOutput,
  teamSnippetFromFounderRows,
  tractionSnippetFromDealTractionRow,
} from "@/lib/markdown-corpus-snippets";

/**
 * Spreadsheet-style row set: deals + latest dimension scores + optional CRM fields.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const limit = Math.min(500, Math.max(1, Number(searchParams.get("limit")) || 200));

  const { data: deals, error } = await supabase
    .from("deals")
    .select(
      "id, company_name, sector, stage, decision, created_at, crm_stage, crm_next_step, deal_scores(dimension, raw_score)"
    )
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("grid deals:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const dealList = (deals ?? []) as Record<string, unknown>[];
  const dealIds = dealList.map((d) => d.id as string);

  const latestSummaryByDeal = new Map<
    string,
    { t: string; json: Record<string, unknown> }
  >();
  const latestThesisByDeal = new Map<
    string,
    { t: string; json: Record<string, unknown> }
  >();
  const problemFallback = new Map<string, string>();
  const solutionFallback = new Map<string, string>();
  const tractionFallback = new Map<string, string>();
  const teamFallback = new Map<string, string>();

  if (dealIds.length > 0) {
    const { data: sumRows } = await supabase
      .from("deal_pipeline_json_summaries")
      .select("deal_id, pipeline_summaries_json, created_at")
      .in("deal_id", dealIds);

    for (const row of sumRows ?? []) {
      const did = row.deal_id as string;
      const t = (row.created_at as string) ?? "";
      const prev = latestSummaryByDeal.get(did);
      if (!prev || t > prev.t) {
        latestSummaryByDeal.set(did, {
          t,
          json: (row.pipeline_summaries_json as Record<string, unknown>) ?? {},
        });
      }
    }

    const { data: thesisRows } = await supabase
      .from("deal_pipeline_json_thesis_fit")
      .select("deal_id, thesis_fit_json, created_at")
      .in("deal_id", dealIds);
    for (const row of thesisRows ?? []) {
      const did = row.deal_id as string;
      const t = (row.created_at as string) ?? "";
      const prev = latestThesisByDeal.get(did);
      if (!prev || t > prev.t) {
        latestThesisByDeal.set(did, {
          t,
          json: (row.thesis_fit_json as Record<string, unknown>) ?? {},
        });
      }
    }

    const { data: analysisRows } = await supabase
      .from("deal_analyses")
      .select("id, deal_id, run_at, raw_output")
      .in("deal_id", dealIds);
    const latestAnalysisIdByDeal = new Map<string, string>();
    const latestRawByDeal = new Map<string, Record<string, unknown>>();
    const byDeal = new Map<string, { id: string; run_at: string }[]>();
    for (const row of analysisRows ?? []) {
      const did = row.deal_id as string;
      const list = byDeal.get(did) ?? [];
      list.push({
        id: row.id as string,
        run_at: (row.run_at as string) ?? "",
      });
      byDeal.set(did, list);
    }
    for (const [did, list] of byDeal) {
      list.sort((a, b) => {
        const ta = a.run_at ? new Date(a.run_at).getTime() : 0;
        const tb = b.run_at ? new Date(b.run_at).getTime() : 0;
        return tb - ta;
      });
      const best = list[0];
      if (best) {
        latestAnalysisIdByDeal.set(did, best.id);
        const full = (analysisRows ?? []).find((r) => r.id === best.id && r.deal_id === did);
        if (full?.raw_output && typeof full.raw_output === "object") {
          latestRawByDeal.set(did, full.raw_output as Record<string, unknown>);
        }
      }
    }

    const { data: probRows } = await supabase
      .from("deal_problem")
      .select("deal_id, analysis_id, problem_statement")
      .in("deal_id", dealIds);
    const { data: solRows } = await supabase
      .from("deal_solution")
      .select("deal_id, analysis_id, solution_summary")
      .in("deal_id", dealIds);
    const { data: tracRows } = await supabase
      .from("deal_traction")
      .select(
        "deal_id, analysis_id, inferred_stage, benchmark_context, revenue_data, growth_signals, customer_depth, user_traction, traction_evidence_json"
      )
      .in("deal_id", dealIds);
    const { data: founderRows } = await supabase
      .from("founders")
      .select("deal_id, name, role, enrichment_raw")
      .in("deal_id", dealIds);

    function pickForAnalysis<T extends { analysis_id?: string }>(
      rows: T[] | undefined,
      dealId: string
    ): T | undefined {
      if (!rows?.length) return undefined;
      const aid = latestAnalysisIdByDeal.get(dealId);
      if (aid) {
        const m = rows.find((r) => r.analysis_id === aid);
        if (m) return m;
      }
      return rows[0];
    }

    for (const did of dealIds) {
      const pr = pickForAnalysis(probRows ?? [], did);
      const sr = pickForAnalysis(solRows ?? [], did);
      const tr = pickForAnalysis(tracRows ?? [], did);
      if (pr?.problem_statement?.trim()) problemFallback.set(did, pr.problem_statement.trim());
      if (sr?.solution_summary?.trim()) solutionFallback.set(did, sr.solution_summary.trim());
      const trSn = tractionSnippetFromDealTractionRow(tr ?? null);
      if (trSn) tractionFallback.set(did, trSn);

      const founders = (founderRows ?? []).filter((f) => f.deal_id === did);
      const teamSn = teamSnippetFromFounderRows(founders);
      if (teamSn) teamFallback.set(did, teamSn);

      const raw = latestRawByDeal.get(did);
      if (raw && !raw.parsing_json) {
        const md = snippetPartsFromMarkdownRawOutput(raw);
        if (!problemFallback.has(did) && md.problem) problemFallback.set(did, md.problem);
        if (!solutionFallback.has(did) && md.solution) solutionFallback.set(did, md.solution);
        if (!tractionFallback.has(did) && md.traction) tractionFallback.set(did, md.traction);
        if (!teamFallback.has(did) && md.team) teamFallback.set(did, md.team);
      }
    }
  }

  function clip(v: unknown, max = 220): string {
    if (typeof v !== "string") return "—";
    const s = v.trim();
    if (!s) return "—";
    return s.length <= max ? s : `${s.slice(0, max)}…`;
  }

  function clipOrFallback(primary: unknown, fallback: string | undefined, max = 220): string {
    const p = clip(primary, max);
    if (p !== "—") return p;
    if (fallback?.trim()) return clip(fallback, max);
    return "—";
  }

  const rows = dealList.map((d: Record<string, unknown>) => {
    const scores = (d.deal_scores as { dimension: string; raw_score: number }[]) ?? [];
    const pick = (dim: string) => scores.find((s) => s.dimension === dim)?.raw_score ?? null;
    const summ = latestSummaryByDeal.get(d.id as string)?.json ?? {};
    const thesis = latestThesisByDeal.get(d.id as string)?.json ?? {};
    const stageFallback =
      typeof (thesis.stage_evaluation as Record<string, unknown> | undefined)?.stage === "string"
        ? String((thesis.stage_evaluation as Record<string, unknown>).stage)
        : null;
    const sectorFallback =
      typeof (thesis.industry_evaluation as Record<string, unknown> | undefined)?.startup_industry === "string"
        ? String((thesis.industry_evaluation as Record<string, unknown>).startup_industry)
        : null;
    const did = d.id as string;
    return {
      id: d.id,
      company_name: d.company_name,
      sector: (d.sector as string | null) ?? sectorFallback,
      stage: (d.stage as string | null) ?? stageFallback,
      decision: d.decision,
      created_at: d.created_at,
      crm_stage: d.crm_stage,
      crm_next_step: d.crm_next_step,
      snippets: {
        problem: clipOrFallback(summ.problem, problemFallback.get(did)),
        solution: clipOrFallback(summ.solution, solutionFallback.get(did)),
        traction: clipOrFallback(summ.traction, tractionFallback.get(did)),
        team: clipOrFallback(summ.founder, teamFallback.get(did)),
      },
      scores: {
        thesis_fit: pick("thesis_fit"),
        founder: pick("founder"),
        traction: pick("traction"),
        problem: pick("problem"),
        solution: pick("solution"),
      },
    };
  });

  return NextResponse.json({ rows });
}
