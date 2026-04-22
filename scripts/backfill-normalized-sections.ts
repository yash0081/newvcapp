import dotenv from "dotenv";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

import { createClient } from "@supabase/supabase-js";
import { buildRetrievalProfileFromParsing } from "../lib/deal-retrieval-profile";
import type { SupabaseClient } from "@supabase/supabase-js";

type ParsingLike = Record<string, unknown>;

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean);
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  return [];
}

async function buildPhase1LikeParsing(
  admin: SupabaseClient,
  dealId: string,
  analysisId: string
): Promise<ParsingLike> {
  const { data: parsingRow } = await admin
    .from("deal_pipeline_json_parsing")
    .select("parsing_json")
    .eq("deal_id", dealId)
    .eq("analysis_id", analysisId)
    .maybeSingle();
  const parsingRec = parsingRow as { parsing_json?: unknown } | null;
  if (parsingRec?.parsing_json && typeof parsingRec.parsing_json === "object") {
    return parsingRec.parsing_json as ParsingLike;
  }

  const { data: deal } = await admin
    .from("deals")
    .select("company_name, sector, stage, business_model, pass_reason_detail")
    .eq("id", dealId)
    .maybeSingle();

  const { data: problem } = await admin
    .from("deal_problem")
    .select("problem_statement, economic_gravity, structural_urgency")
    .eq("deal_id", dealId)
    .eq("analysis_id", analysisId)
    .maybeSingle();

  const { data: solution } = await admin
    .from("deal_solution")
    .select("solution_summary, product_type, moat_type, technical_moat_evidence")
    .eq("deal_id", dealId)
    .eq("analysis_id", analysisId)
    .maybeSingle();

  const dealRec = (deal ?? {}) as Record<string, unknown>;
  const problemRec = (problem ?? {}) as Record<string, unknown>;
  const solutionRec = (solution ?? {}) as Record<string, unknown>;

  return {
    company_overview: {
      company_name: (dealRec.company_name as string | null) ?? null,
      sector_category: (dealRec.sector as string | null) ?? null,
      stage: (dealRec.stage as string | null) ?? null,
      business_model: (dealRec.business_model as string | null) ?? null,
    },
    problem: {
      problem_statement: (problemRec.problem_statement as string | null) ?? null,
      pain_points: toStringArray(
        [problemRec.economic_gravity, problemRec.structural_urgency].filter(Boolean)
      ),
    },
    solution: {
      solution_summary: (solutionRec.solution_summary as string | null) ?? null,
      product_type: (solutionRec.product_type as string | null) ?? null,
      claimed_differentiation: toStringArray(solutionRec.technical_moat_evidence),
      claimed_defensibility: toStringArray(solutionRec.moat_type),
    },
    market: {
      tam_claim: null,
      sam_claim: null,
      som_claim: null,
      market_growth_claims: [],
    },
    notable_claims: [],
    traction: {},
    fundraising: {},
    team: [],
    assumptions_context: {
      pass_reason_detail: (dealRec.pass_reason_detail as string | null) ?? null,
    },
  };
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  const admin = createClient(url, key);

  const { data: rows, error } = await admin
    .from("deal_retrieval_index")
    .select("deal_id, analysis_id, problem_normalized, solution_normalized, market_normalized")
    .limit(5000);
  if (error) throw error;

  const targets = (rows ?? []).filter((r) => {
    const p = typeof r.problem_normalized === "string" ? r.problem_normalized.trim() : "";
    const s = typeof r.solution_normalized === "string" ? r.solution_normalized.trim() : "";
    const m = typeof r.market_normalized === "string" ? r.market_normalized.trim() : "";
    return !p || !s || !m;
  });

  console.log(`Found ${targets.length} rows missing normalized section text`);
  for (const row of targets) {
    const dealId = row.deal_id as string;
    const analysisId = row.analysis_id as string;
    try {
      const parsing = await buildPhase1LikeParsing(admin, dealId, analysisId);
      const profile = await buildRetrievalProfileFromParsing(parsing);

      const { error: upErr } = await admin
        .from("deal_retrieval_index")
        .update({
          problem_normalized: profile.problem.normalized_slice,
          solution_normalized: profile.solution.normalized_slice,
          market_normalized: profile.market_document,
          risk_normalized: null,
          concepts_json: {
            problem: profile.problem.search_concepts,
            solution: profile.solution.search_concepts,
          },
          normalized_json: {
            problem: profile.problem.normalized_slice,
            solution: profile.solution.normalized_slice,
            market: profile.market_document,
          },
          updated_at: new Date().toISOString(),
        })
        .eq("deal_id", dealId);
      if (upErr) throw upErr;

      console.log("✓", dealId);
    } catch (e) {
      console.error("✗", dealId, e);
    }
  }
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

