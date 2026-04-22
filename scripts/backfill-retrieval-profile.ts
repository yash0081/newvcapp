/**
 * Backfill hybrid retrieval v2 artifacts:
 * - deal_retrieval_index (section-level vectors + normalized text)
 * - deal_keywords (section concepts + FTS)
 *
 * Requires the same env/auth as other Vertex jobs.
 */
import dotenv from "dotenv";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

import { createClient } from "@supabase/supabase-js";
import {
  buildRetrievalProfileFromParsing,
  embedRetrievalProfile,
  upsertDealRetrievalArtifacts,
} from "../lib/deal-retrieval-profile";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function main() {
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  const admin = createClient(url, key);

  const toStringArray = (v: unknown): string[] => {
    if (!v) return [];
    if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : String(x))).filter(Boolean);
    if (typeof v === "string") {
      const t = v.trim();
      if (!t) return [];
      try {
        const parsed = JSON.parse(t);
        if (Array.isArray(parsed)) return parsed.map((x) => (typeof x === "string" ? x : String(x))).filter(Boolean);
      } catch {
        // ignore
      }
      return [t];
    }
    return [String(v)];
  };

  const parseMaybeString = (v: unknown): string | null => {
    if (typeof v === "string") {
      const t = v.trim();
      return t ? t : null;
    }
    return null;
  };

  // 1) Load normalized parsing_json when it exists (preferred).
  const { data: parsingRows, error: pErr } = await admin
    .from("deal_pipeline_json_parsing")
    .select("analysis_id, deal_id, parsing_json, created_at")
    .order("created_at", { ascending: false })
    .limit(5000);
  if (pErr) throw pErr;

  const parsingByDeal = new Map<string, { analysisId: string; parsing: Record<string, unknown> }>();
  for (const row of parsingRows ?? []) {
    const dealId = row.deal_id as string;
    if (parsingByDeal.has(dealId)) continue;
    const parsing = row.parsing_json as Record<string, unknown>;
    if (!parsing || typeof parsing !== "object" || Object.keys(parsing).length === 0) continue;
    parsingByDeal.set(dealId, { analysisId: row.analysis_id as string, parsing });
  }

  console.log("Found parsing rows:", (parsingRows ?? []).length);
  console.log("Deals with non-empty parsing_json:", parsingByDeal.size);

  // 2) Determine latest analysis per deal (so we can write `analysis_id` into retrieval index).
  const { data: analyses, error: aErr } = await admin
    .from("deal_analyses")
    .select("id, deal_id, run_at, pipeline_version")
    .order("run_at", { ascending: false })
    .limit(2000);
  if (aErr) throw aErr;

  const latestByDeal = new Map<string, { analysisId: string }>();
  for (const row of analyses ?? []) {
    const dealId = row.deal_id as string;
    if (latestByDeal.has(dealId)) continue;
    latestByDeal.set(dealId, { analysisId: row.id as string });
  }

  const dealIds = Array.from(latestByDeal.keys());
  if (dealIds.length === 0) {
    console.log("No analyses found to backfill.");
    return;
  }

  // 3) Only process deals missing retrieval index rows.
  const { data: existingRows, error: eErr } = await admin
    .from("deal_retrieval_index")
    .select("deal_id")
    .in("deal_id", dealIds);
  if (eErr) throw eErr;

  const existing = new Set((existingRows ?? []).map((r) => r.deal_id as string));
  const todo = dealIds.filter((id) => !existing.has(id));
  console.log(`Found ${todo.length} deals missing retrieval profile`);

  if (todo.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  // ---- Relational fallback: rebuild a Phase1-like parsing JSON ----
  async function buildPhase1LikeParsingFromRelational(dealId: string, analysisId: string): Promise<Record<string, unknown>> {
    // Deals / company overview
    const { data: dealRow, error: dErr } = await admin
      .from("deals")
      .select("company_name, sector, business_model, stage, geography")
      .eq("id", dealId)
      .maybeSingle();
    if (dErr || !dealRow) throw dErr ?? new Error("Missing deals row");

    // Phase 1 Problem (from deal_problem)
    const { data: problemRow, error: pErr2 } = await admin
      .from("deal_problem")
      .select(
        "problem_statement, root_cause_depth, structural_urgency, persona_clarity, economic_buyer_persona, budget_priority_validation"
      )
      .eq("deal_id", dealId)
      .eq("analysis_id", analysisId)
      .maybeSingle();
    if (pErr2) throw pErr2;

    // Phase 1 Solution (from deal_solution)
    const { data: solutionRow, error: sErr } = await admin
      .from("deal_solution")
      .select("solution_summary, product_type, moat_type, technical_moat_evidence, replication_difficulty, compounding_potential")
      .eq("deal_id", dealId)
      .eq("analysis_id", analysisId)
      .maybeSingle();
    if (sErr) throw sErr;

    // Traction snapshot (try phase1_traction_json first)
    const { data: tractionRow } = await admin
      .from("deal_traction")
      .select("phase1_traction_json, inferred_stage, benchmark_context")
      .eq("deal_id", dealId)
      .eq("analysis_id", analysisId)
      .maybeSingle();

    const t = (tractionRow?.phase1_traction_json ?? null) as Record<string, unknown> | null;

    // Metrics (market + fundraising + traction metrics)
    const { data: metricRows, error: mErr } = await admin
      .from("deal_metrics")
      .select("metric_name, metric_value")
      .eq("deal_id", dealId);
    if (mErr) throw mErr;

    const metrics = new Map<string, string>();
    for (const mr of metricRows ?? []) {
      const name = mr.metric_name as string | null;
      const val = mr.metric_value as string | null;
      if (!name) continue;
      if (typeof val === "string") metrics.set(name, val);
    }

    const tam_claim = metrics.get("tam_claim") ?? null;
    const sam_claim = metrics.get("sam_claim") ?? null;
    const som_claim = metrics.get("som_claim") ?? null;
    const market_growth_claims = toStringArray(metrics.get("market_growth_claims"));

    const fundraising_raising_amount = metrics.get("fundraising_raising_amount") ?? null;
    const round_type_or_stage = metrics.get("fundraising_round") ?? metrics.get("fundraising_round_type") ?? null;
    const valuation = metrics.get("fundraising_valuation") ?? null;
    const use_of_funds = toStringArray(metrics.get("fundraising_use_of_funds"));

    // Traction fields: prefer phase1_traction_json when present, else fallback to metrics
    const revenue = (t && typeof t === "object" && typeof t.revenue === "string" ? t.revenue : null) ?? metrics.get("traction_revenue") ?? null;
    const arr = (t && typeof t === "object" && typeof t.arr === "string" ? t.arr : null) ?? metrics.get("traction_arr") ?? null;
    const growth_rate =
      (t && typeof t === "object" && typeof t.growth_rate === "string" ? t.growth_rate : null) ?? metrics.get("traction_growth_rate") ?? null;
    const customers = (t && typeof t === "object" && typeof t.customers === "string" ? t.customers : null) ?? metrics.get("traction_customers") ?? null;
    const active_users =
      (t && typeof t === "object" && typeof t.active_users === "string" ? t.active_users : null) ?? metrics.get("traction_active_users") ?? null;
    const retention_or_churn =
      (t && typeof t === "object" && typeof t.retention_or_churn === "string" ? t.retention_or_churn : null) ??
      metrics.get("traction_retention_or_churn") ??
      null;

    const notable_logos = toStringArray(
      (t && typeof t === "object" ? t.notable_logos : null) ?? metrics.get("traction_notable_logos") ?? null
    );
    const partnerships = toStringArray(
      (t && typeof t === "object" ? t.partnerships : null) ?? metrics.get("traction_partnerships") ?? null
    );

    // Team (founders)
    const { data: founderRows, error: fErr } = await admin
      .from("founders")
      .select(
        "name, role, background_summary, previous_companies, institutions, awards_and_honors, past_exits, enrichment_source"
      )
      .eq("deal_id", dealId)
      .order("created_at", { ascending: true })
      .limit(6);
    if (fErr) throw fErr;

    const founders = (founderRows ?? [])
      .map((fr) => ({
        name: parseMaybeString(fr.name),
        role: parseMaybeString(fr.role),
        background_summary: parseMaybeString(fr.background_summary),
        previous_companies: toStringArray(fr.previous_companies),
        institutions: toStringArray(fr.institutions),
        awards_and_honors: toStringArray(fr.awards_and_honors),
        past_exits: toStringArray(fr.past_exits),
      }))
      .filter((x) => x.name && x.name.trim().length > 0)
      .slice(0, 2);

    const parsingLike = {
      company_overview: {
        company_name: parseMaybeString(dealRow.company_name) ?? null,
        tagline: null,
        sector_category: parseMaybeString(dealRow.sector) ?? null,
        business_model: parseMaybeString(dealRow.business_model) ?? null,
        stage: parseMaybeString(dealRow.stage) ?? null,
        geography: parseMaybeString(dealRow.geography) ?? null,
      },
      problem: {
        problem_statement: typeof problemRow?.problem_statement === "string" ? problemRow.problem_statement : null,
        target_customer:
          typeof problemRow?.economic_buyer_persona === "string"
            ? problemRow.economic_buyer_persona
            : typeof problemRow?.persona_clarity === "string"
              ? problemRow.persona_clarity
              : null,
        pain_points: [
          typeof problemRow?.root_cause_depth === "string" ? problemRow.root_cause_depth : null,
          typeof problemRow?.structural_urgency === "string" ? problemRow.structural_urgency : null,
          typeof problemRow?.persona_clarity === "string" ? problemRow.persona_clarity : null,
          typeof problemRow?.economic_buyer_persona === "string" ? problemRow.economic_buyer_persona : null,
          typeof problemRow?.budget_priority_validation === "string" ? problemRow.budget_priority_validation : null,
        ].filter((x): x is string => typeof x === "string" && x.trim().length > 0),
      },
      solution: {
        solution_summary: typeof solutionRow?.solution_summary === "string" ? solutionRow.solution_summary : null,
        product_type: typeof solutionRow?.product_type === "string" ? solutionRow.product_type : null,
        core_features: [
          typeof solutionRow?.technical_moat_evidence === "string" ? solutionRow.technical_moat_evidence : null,
          typeof solutionRow?.product_type === "string" ? solutionRow.product_type : null,
        ].filter((x): x is string => typeof x === "string" && x.trim().length > 0),
        claimed_differentiation: toStringArray(typeof solutionRow?.technical_moat_evidence === "string" ? solutionRow.technical_moat_evidence : solutionRow?.solution_summary)
          .slice(0, 6),
        claimed_defensibility: [
          typeof solutionRow?.technical_moat_evidence === "string" ? solutionRow.technical_moat_evidence : null,
        ].filter((x): x is string => typeof x === "string" && x.trim().length > 0),
      },
      market: {
        tam_claim,
        sam_claim,
        som_claim,
        market_growth_claims,
      },
      traction: {
        revenue: revenue as string | null,
        arr: arr as string | null,
        growth_rate: growth_rate as string | null,
        customers: customers as string | null,
        active_users: active_users as string | null,
        retention_or_churn: retention_or_churn as string | null,
        notable_logos,
        partnerships,
      },
      fundraising: {
        raising_amount: fundraising_raising_amount,
        round_type_or_stage,
        valuation,
        use_of_funds,
      },
      team: founders,
      notable_claims: [],
    };

    return parsingLike;
  }

  for (const dealId of todo) {
    const ctx = parsingByDeal.get(dealId);
    const analysisId = ctx?.analysisId ?? latestByDeal.get(dealId)?.analysisId;
    if (!analysisId) continue;

    try {
      const parsing =
        ctx?.parsing ??
        (await buildPhase1LikeParsingFromRelational(dealId, analysisId));

      const profile = await buildRetrievalProfileFromParsing(parsing);
      const embeddings = await embedRetrievalProfile(profile);

      await upsertDealRetrievalArtifacts({
        admin,
        dealId,
        analysisId,
        profile,
        embeddings,
      });

      const company = (parsing.company_overview as Record<string, unknown> | undefined)?.company_name;
      console.log("✓", typeof company === "string" ? company : dealId);
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

