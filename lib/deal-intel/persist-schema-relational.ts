import type { SupabaseClient } from "@supabase/supabase-js";

function asRecord(v: unknown): Record<string, unknown> {
  return (v ?? {}) as Record<string, unknown>;
}

function asString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => typeof x === "string")
    .map((x) => (x as string).trim())
    .filter(Boolean);
}

function parseIntLoose(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string") {
    const m = v.match(/-?\d+/);
    if (!m) return null;
    const n = parseInt(m[0], 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Persist Schema.pdf facts into normalized relational tables in schema `deal_intel`.
 *
 * This function is idempotent per deal+revision: it clears prior rows for the deal/revision and reinserts.
 */
export async function persistDealIntelSchemaRelational(opts: {
  admin: SupabaseClient;
  dealId: string;
  revisionId: string;
  facts: Record<string, unknown>;
}): Promise<void> {
  const { admin, dealId, revisionId, facts } = opts;

  // Use service-role client; we can write directly into deal_intel schema.
  const di = admin.schema("deal_intel");

  // Clear existing rows for this revision (and revision-null rows tied to this deal, to avoid duplicates).
  // Children are ON DELETE CASCADE via parent ids where applicable.
  await di.from("company_person").delete().eq("deal_id", dealId);
  await di.from("company_makeup").delete().eq("deal_id", dealId);
  await di.from("company_origin_story").delete().eq("deal_id", dealId);
  await di.from("company_problem").delete().eq("deal_id", dealId);
  await di.from("company_solution").delete().eq("deal_id", dealId);
  await di.from("company_traction").delete().eq("deal_id", dealId);
  await di.from("company_negative").delete().eq("deal_id", dealId);

  const people = Array.isArray(facts.notable_company_people) ? (facts.notable_company_people as unknown[]) : [];
  for (const p0 of people) {
    const p = asRecord(p0);
    const name = asString(p.name) ?? "";
    if (!name) continue;

    const edu = asRecord(p.education);
    const exp = asRecord(p.experience);

    const { data: personRow, error: perr } = await di
      .from("company_person")
      .insert({
        deal_id: dealId,
        revision_id: revisionId,
        person_kind: "notable_company_person",
        name,
        company_role: asString(p.company_role),
        general_description: asString(p.general_description),
        age: parseIntLoose(p.age),
        location: asString(p.location),
        misc: asString(p.misc),

        education_general_description: asString(edu.general_description),
        education_institutions: (() => {
          const arr = asStringArray(edu.institutions);
          return arr.length ? arr : null;
        })(),
        education_majors: (() => {
          const arr = asStringArray(edu.majors);
          return arr.length ? arr : null;
        })(),
        education_gpa: asString(edu.gpa),

        experience_general_description: asString(exp.general_description),
        past_companies_worked_at: (() => {
          const arr = asStringArray(exp.past_companies_worked_at);
          return arr.length ? arr : null;
        })(),
        past_companies_founded_or_previous_exits: (() => {
          const arr = asStringArray(exp.past_companies_founded_or_previous_exits);
          return arr.length ? arr : null;
        })(),
        relevant_achievements: (() => {
          const arr = asStringArray(exp.relevant_achievements);
          return arr.length ? arr : null;
        })(),
        research: (() => {
          const arr = asStringArray(exp.research);
          return arr.length ? arr : null;
        })(),
        patents: (() => {
          const arr = asStringArray(exp.patents);
          return arr.length ? arr : null;
        })(),
        projects: (() => {
          const arr = asStringArray(exp.projects);
          return arr.length ? arr : null;
        })(),
      })
      .select("id")
      .single();
    if (perr) throw perr;
    void personRow;
  }

  const cm = asRecord(facts.company_makeup);
  const cmSize = parseIntLoose(cm.company_size_people_count);
  const { error: cmErr } = await di.from("company_makeup").insert({
    deal_id: dealId,
    revision_id: revisionId,
    general_description: asString(cm.general_description),
    general_education_history: asString(cm.general_education_history),
    general_work_background: asString(cm.general_work_background_and_experience),
    company_size: cmSize,
  });
  if (cmErr) throw cmErr;

  const os = asRecord(facts.company_origin_story);
  const origin = asString(os.general_description_and_founding_team_cohesion_signals);
  const { error: osErr } = await di.from("company_origin_story").insert({
    deal_id: dealId,
    revision_id: revisionId,
    general_description: origin,
    cohesion_signals: null,
  });
  if (osErr) throw osErr;

  const prob = asRecord(facts.company_problem);
  const cust = asRecord(prob.customers);
  const { error: pErr } = await di
    .from("company_problem")
    .insert({
      deal_id: dealId,
      revision_id: revisionId,
      general_problem_description: asString(prob.general_problem_description),
      all_potential_customers: (() => {
        const arr = asStringArray(cust.all_potential_customers);
        return arr.length ? arr : null;
      })(),
      actual_intended_customers_for_solution: (() => {
        const arr = asStringArray(cust.actual_intended_customers_for_solution);
        return arr.length ? arr : null;
      })(),
      urgency: asString(prob.urgency),
      current_cost_for_customers: asString(prob.current_cost_for_customers),
      tam: asString(prob.tam),
      sam: asString(prob.sam),
      som: asString(prob.som),
    })
  if (pErr) throw pErr;

  const sol = asRecord(facts.company_solution);
  const solCust = asRecord(sol.customers);
  const competitorsArr = Array.isArray(sol.competitors) ? (sol.competitors as unknown[]) : [];
  const competitorsJson = competitorsArr
    .map((c0) => {
      const c = asRecord(c0);
      const name = asString(c.name);
      if (!name) return null;
      return {
        name,
        type_of_company: asString(c.type_of_company),
        similarity: asString(c.similarity),
        threat_posed: asString(c.threat_posed),
      };
    })
    .filter(Boolean);

  const { error: sErr } = await di
    .from("company_solution")
    .insert({
      deal_id: dealId,
      revision_id: revisionId,
      general_description: asString(sol.general_description),
      who_are_the_customers: (() => {
        const arr = asStringArray(solCust.who_are_the_customers);
        return arr.length ? arr : null;
      })(),
      cost_to_customer_to_buy_product: asString(solCust.cost_to_customer_to_buy_product),
      customer_benefit: (() => {
        const arr = asStringArray(solCust.customer_benefit);
        return arr.length ? arr : null;
      })(),
      solution_price_for_company: asString(sol.solution_price_for_company),
      price_per_customer_build_and_serve: asString(sol.price_per_customer_build_and_serve),
      novelty_or_uniqueness: asString(sol.novelty_or_uniqueness),
      distinguishing_factors: (() => {
        const arr = asStringArray(sol.distinguishing_factors);
        return arr.length ? arr : null;
      })(),
      defensibility: asString(sol.defensibility),
      patent_ip: (() => {
        const arr = asStringArray(sol.patent_ip);
        return arr.length ? arr : null;
      })(),
      proprietary_tech_or_solution: (() => {
        const arr = asStringArray(sol.proprietary_tech_or_solution);
        return arr.length ? arr : null;
      })(),
      competitors: competitorsJson.length ? competitorsJson : null,
      timeline_description: asString(sol.timeline_description),
    })
  if (sErr) throw sErr;

  const tr = asRecord(facts.company_traction);
  const { error: tErr } = await di
    .from("company_traction")
    .insert({
      deal_id: dealId,
      revision_id: revisionId,
      revenue_data: asString(tr.revenue_data),
      money_raised_per_stage: (() => {
        const arr = asStringArray(tr.money_raised_per_stage);
        return arr.length ? arr : null;
      })(),
      investor_list: (() => {
        const arr = asStringArray(tr.investor_list);
        return arr.length ? arr : null;
      })(),
      notable_partners_or_customers: (() => {
        const arr = asStringArray(tr.notable_partners_or_customers);
        return arr.length ? arr : null;
      })(),
      company_stage: asString(tr.company_stage),
      product_stage: asString(tr.product_stage),
      customer_size_and_count: asString(tr.customer_size_and_count),
      growth_trends_description: asString(tr.growth_trends_description),
    })
  if (tErr) throw tErr;

  const neg = asString(facts.negative_aspects);
  const { error: negErr } = await di.from("company_negative").insert({
    deal_id: dealId,
    revision_id: revisionId,
    negative_aspects: neg,
  });
  if (negErr) throw negErr;
}

