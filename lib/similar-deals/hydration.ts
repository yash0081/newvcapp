import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchDealInvestorRows,
  fetchLatestAnalyses,
  fetchMoatRows,
  fetchProblemRows,
  fetchSolutionRows,
  fetchDealFlags,
} from "@/lib/data-layer/schema-access/similar-deals";
import type { CandidateMeta, SimilarPeerForPrompt } from "@/lib/similar-deals/types";

async function loadLatestAnalysisByDeal(admin: SupabaseClient, dealIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (dealIds.length === 0) return out;
  const { data } = await fetchLatestAnalyses(admin, dealIds);
  for (const row of data ?? []) {
    const did = row.deal_id as string;
    if (!out.has(did)) out.set(did, row.id as string);
  }
  return out;
}

export async function loadMoatByDeal(admin: SupabaseClient, dealIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (dealIds.length === 0) return out;
  const latest = await loadLatestAnalysisByDeal(admin, dealIds);
  const { data } = await fetchMoatRows(admin, dealIds);
  for (const s of data ?? []) {
    const did = s.deal_id as string;
    const aid = s.analysis_id as string;
    if (latest.get(did) !== aid) continue;
    if (!out.has(did)) out.set(did, typeof s.moat_type === "string" ? s.moat_type : null);
  }
  return out;
}

/** Richer than summary alone so "Unified API"–style matches survive in prompts when summary is empty or generic. */
function buildSolutionOneLinerFromRow(s: {
  solution_summary: string | null;
  product_type: string | null;
  moat_type: string | null;
  technical_moat_evidence: string | null;
}): string | null {
  const parts: string[] = [];
  if (s.product_type?.trim()) parts.push(`Product type: ${s.product_type.trim()}`);
  if (s.solution_summary?.trim()) parts.push(s.solution_summary.trim());
  if (s.moat_type?.trim()) parts.push(`Moat: ${s.moat_type.trim()}`);
  if (parts.length === 0 && s.technical_moat_evidence?.trim()) {
    parts.push(s.technical_moat_evidence.trim().slice(0, 400));
  }
  const out = parts.join(" | ");
  return out.length ? out.slice(0, 520) : null;
}

function buildProblemOneLinerFromRow(p: {
  problem_statement: string | null;
  stated_problem_ref: string | null;
  economic_gravity: string | null;
}): string | null {
  const a = p.problem_statement?.trim();
  const b = p.stated_problem_ref?.trim();
  const g = p.economic_gravity?.trim();
  const parts: string[] = [];
  if (a) parts.push(a);
  if (b && b !== a) parts.push(b);
  if (g && g !== a && g !== b) parts.push(g);
  const out = parts.join(" — ");
  return out.length ? out.slice(0, 520) : null;
}

export async function loadDealFlagsBatch(admin: SupabaseClient, dealIds: string[]): Promise<Map<string, string[]>> {
  const flagsByDeal = new Map<string, string[]>();
  if (dealIds.length === 0) return flagsByDeal;
  const { data: flagsRows } = await fetchDealFlags(admin, dealIds);
  for (const f of flagsRows ?? []) {
    const did = f.deal_id as string;
    const msg = typeof f.flag_message === "string" ? f.flag_message.trim() : "";
    if (!msg) continue;
    const arr = flagsByDeal.get(did) ?? [];
    if (arr.length < 5) arr.push(msg);
    flagsByDeal.set(did, arr);
  }
  return flagsByDeal;
}

export async function hydrateSimilarPeersBatch(
  admin: SupabaseClient,
  orderedDealIds: string[],
  metaById: Map<string, CandidateMeta>,
  scoreById: Map<string, number>,
  flagsByDeal: Map<string, string[]>
): Promise<SimilarPeerForPrompt[]> {
  const unique = [...new Set(orderedDealIds)];
  if (unique.length === 0) return [];

  // Normalize `rrf_score` -> 0..1 within this peer batch so prompts can gate thresholds.
  const scoreVals = unique.map((id) => Number(scoreById.get(id) ?? 0));
  const min = scoreVals.length ? Math.min(...scoreVals) : 0;
  const max = scoreVals.length ? Math.max(...scoreVals) : 0;
  const denom = max - min;
  const normalize = (rrf: number): number => {
    if (Math.abs(denom) < 1e-9) return max > 0 ? 1 : 0;
    return Math.max(0, Math.min(1, (rrf - min) / denom));
  };

  const latest = await loadLatestAnalysisByDeal(admin, unique);
  const { data: problems } = await fetchProblemRows(admin, unique);
  const { data: solutions } = await fetchSolutionRows(admin, unique);
  const { data: invRows } = await fetchDealInvestorRows(admin, unique);

  const problemByDeal = new Map<
    string,
    { statement: string | null; ref: string | null; economic_gravity: string | null }
  >();
  for (const p of problems ?? []) {
    const did = p.deal_id as string;
    if (latest.get(did) !== (p.analysis_id as string)) continue;
    if (!problemByDeal.has(did)) {
      problemByDeal.set(did, {
        statement: typeof p.problem_statement === "string" ? p.problem_statement : null,
        ref: typeof p.stated_problem_ref === "string" ? p.stated_problem_ref : null,
        economic_gravity: typeof p.economic_gravity === "string" ? p.economic_gravity : null,
      });
    }
  }
  const solutionByDeal = new Map<
    string,
    {
      solution_summary: string | null;
      product_type: string | null;
      moat_type: string | null;
      technical_moat_evidence: string | null;
    }
  >();
  for (const s of solutions ?? []) {
    const did = s.deal_id as string;
    if (latest.get(did) !== (s.analysis_id as string)) continue;
    if (!solutionByDeal.has(did)) {
      solutionByDeal.set(did, {
        solution_summary: typeof s.solution_summary === "string" ? s.solution_summary : null,
        product_type: typeof s.product_type === "string" ? s.product_type : null,
        moat_type: typeof s.moat_type === "string" ? s.moat_type : null,
        technical_moat_evidence:
          typeof s.technical_moat_evidence === "string" ? s.technical_moat_evidence : null,
      });
    }
  }
  const investorsByDeal = new Map<string, string[]>();
  for (const ir of invRows ?? []) {
    const did = ir.deal_id as string;
    const n = (ir.investors as { name?: string } | null)?.name;
    if (!n) continue;
    const arr = investorsByDeal.get(did) ?? [];
    if (arr.length < 12) arr.push(n);
    investorsByDeal.set(did, arr);
  }

  const byId = new Map<string, SimilarPeerForPrompt>();
  for (const dealId of unique) {
    const meta = metaById.get(dealId);
    if (!meta) continue;
    const pid = problemByDeal.get(dealId);
    const solRow = solutionByDeal.get(dealId);
    const solLine = (solRow ? buildSolutionOneLinerFromRow(solRow) : null) ?? meta.solution_one_liner ?? null;
    const probLine =
      (pid
        ? buildProblemOneLinerFromRow({
            problem_statement: pid.statement,
            stated_problem_ref: pid.ref,
            economic_gravity: pid.economic_gravity,
          })
        : null) ?? meta.problem_one_liner ?? null;
    byId.set(dealId, {
      deal_id: dealId,
      company_name: meta.company_name,
      problem_one_liner: probLine,
      solution_one_liner: solLine,
      investors: investorsByDeal.get(dealId) ?? [],
      decision: meta.decision,
      pass_reason: meta.pass_reason,
      pass_reason_detail: meta.pass_reason_detail,
      risk_flags: flagsByDeal.get(dealId) ?? [],
      rrf_score: Number(scoreById.get(dealId) ?? 0),
      similarity_confidence: normalize(Number(scoreById.get(dealId) ?? 0)),
    });
  }

  return orderedDealIds.map((id) => byId.get(id)).filter((x): x is SimilarPeerForPrompt => x != null);
}
