import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { extractDealIntelSchemaFactsFromText } from "@/lib/deal-intel/extract-schema-facts";
import { persistDealIntelSchemaRelational } from "@/lib/deal-intel/persist-schema-relational";
import type { AcceptedSnippet, CopilotSession } from "@/lib/copilot/types";

function snippetsFromSession(session: CopilotSession): AcceptedSnippet[] {
  const meta = (session.metadata ?? {}) as { acceptedSnippets?: AcceptedSnippet[] };
  return Array.isArray(meta.acceptedSnippets) ? meta.acceptedSnippets : [];
}

function snippetsToSourceText(session: CopilotSession, companyName: string): string {
  const snippets = snippetsFromSession(session);
  const intro = `Company: ${companyName || "Company"}\nDeal: ${session.deal_id}\nSession: ${session.id}\n`;
  const body = snippets
    .map((s, i) => {
      const label = s.source_label || s.hostname || "source";
      const url = s.source_url ? ` (${s.source_url})` : "";
      return `Snippet ${i + 1} - ${label}${url}\n${s.text}`;
    })
    .join("\n\n");
  return `${intro}\n${body}`.trim();
}

function personNameKey(name: unknown): string {
  return typeof name === "string" ? name.trim().toLowerCase() : "";
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function existingPeopleToFactsShape(rows: Array<Record<string, unknown>>): Record<string, unknown>[] {
  return rows
    .map((r) => {
      const name = typeof r.name === "string" ? r.name.trim() : "";
      if (!name) return null;
      return {
        name,
        company_role: typeof r.company_role === "string" ? r.company_role : null,
        general_description: typeof r.general_description === "string" ? r.general_description : null,
        age: r.age ?? null,
        location: typeof r.location === "string" ? r.location : null,
        misc: typeof r.misc === "string" ? r.misc : null,
        education: {
          general_description:
            typeof r.education_general_description === "string" ? r.education_general_description : null,
          institutions: Array.isArray(r.education_institutions) ? r.education_institutions : [],
          majors: Array.isArray(r.education_majors) ? r.education_majors : [],
          gpa: typeof r.education_gpa === "string" ? r.education_gpa : null,
        },
        experience: {
          general_description:
            typeof r.experience_general_description === "string" ? r.experience_general_description : null,
          past_companies_worked_at: Array.isArray(r.past_companies_worked_at) ? r.past_companies_worked_at : [],
          past_companies_founded_or_previous_exits: Array.isArray(r.past_companies_founded_or_previous_exits)
            ? r.past_companies_founded_or_previous_exits
            : [],
          relevant_achievements: Array.isArray(r.relevant_achievements) ? r.relevant_achievements : [],
          research: Array.isArray(r.research) ? r.research : [],
          patents: Array.isArray(r.patents) ? r.patents : [],
          projects: Array.isArray(r.projects) ? r.projects : [],
        },
      };
    })
    .filter((p): p is Record<string, unknown> => Boolean(p));
}

function mergeNotablePeople(
  extractedFacts: Record<string, unknown>,
  existingPeopleFacts: Record<string, unknown>[],
): Record<string, unknown> {
  const merged = new Map<string, Record<string, unknown>>();
  for (const p of existingPeopleFacts) {
    const key = personNameKey(p.name);
    if (!key) continue;
    merged.set(key, p);
  }
  const extracted = Array.isArray(extractedFacts.notable_company_people)
    ? (extractedFacts.notable_company_people as unknown[])
    : [];
  for (const p0 of extracted) {
    const p = asRecord(p0);
    const key = personNameKey(p.name);
    if (!key) continue;
    // New extraction should win for same person.
    merged.set(key, p);
  }
  return {
    ...extractedFacts,
    notable_company_people: Array.from(merged.values()),
  };
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
}

async function fetchExistingFactsBaseline(admin: SupabaseClient, dealId: string): Promise<Record<string, unknown>> {
  const di = admin.schema("deal_intel");
  const [peopleRes, makeupRes, originRes, problemRes, solutionRes, tractionRes, negativeRes] = await Promise.all([
    di
      .from("company_person")
      .select(
        "name, company_role, general_description, age, location, misc, education_general_description, education_institutions, education_majors, education_gpa, experience_general_description, past_companies_worked_at, past_companies_founded_or_previous_exits, relevant_achievements, research, patents, projects",
      )
      .eq("deal_id", dealId),
    di.from("company_makeup").select("*").eq("deal_id", dealId).maybeSingle(),
    di.from("company_origin_story").select("*").eq("deal_id", dealId).maybeSingle(),
    di.from("company_problem").select("*").eq("deal_id", dealId).maybeSingle(),
    di.from("company_solution").select("*").eq("deal_id", dealId).maybeSingle(),
    di.from("company_traction").select("*").eq("deal_id", dealId).maybeSingle(),
    di.from("company_negative").select("*").eq("deal_id", dealId).maybeSingle(),
  ]);

  const people = existingPeopleToFactsShape((peopleRes.data ?? []) as Array<Record<string, unknown>>);
  const makeup = (makeupRes.data ?? {}) as Record<string, unknown>;
  const origin = (originRes.data ?? {}) as Record<string, unknown>;
  const problem = (problemRes.data ?? {}) as Record<string, unknown>;
  const solution = (solutionRes.data ?? {}) as Record<string, unknown>;
  const traction = (tractionRes.data ?? {}) as Record<string, unknown>;
  const negative = (negativeRes.data ?? {}) as Record<string, unknown>;

  return {
    notable_company_people: people,
    company_makeup: {
      general_description: asString(makeup.general_description),
      general_education_history: asString(makeup.general_education_history),
      general_work_background_and_experience: asString(makeup.general_work_background),
      company_size_people_count: makeup.company_size ?? null,
    },
    company_origin_story: {
      general_description_and_founding_team_cohesion_signals:
        asString(origin.general_description) ?? asString(origin.cohesion_signals),
    },
    company_problem: {
      general_problem_description: asString(problem.general_problem_description),
      customers: {
        all_potential_customers: asStringArray(problem.all_potential_customers),
        actual_intended_customers_for_solution: asStringArray(problem.actual_intended_customers_for_solution),
      },
      urgency: asString(problem.urgency),
      current_cost_for_customers: asString(problem.current_cost_for_customers),
      tam: asString(problem.tam),
      sam: asString(problem.sam),
      som: asString(problem.som),
    },
    company_solution: {
      general_description: asString(solution.general_description),
      customers: {
        who_are_the_customers: asStringArray(solution.who_are_the_customers),
        cost_to_customer_to_buy_product: asString(solution.cost_to_customer_to_buy_product),
        customer_benefit: asStringArray(solution.customer_benefit),
      },
      solution_price_for_company: asString(solution.solution_price_for_company),
      price_per_customer_build_and_serve: asString(solution.price_per_customer_build_and_serve),
      novelty_or_uniqueness: asString(solution.novelty_or_uniqueness),
      distinguishing_factors: asStringArray(solution.distinguishing_factors),
      defensibility: asString(solution.defensibility),
      patent_ip: asStringArray(solution.patent_ip),
      proprietary_tech_or_solution: asStringArray(solution.proprietary_tech_or_solution),
      competitors: Array.isArray(solution.competitors) ? solution.competitors : [],
      timeline_description: asString(solution.timeline_description),
    },
    company_traction: {
      revenue_data: asString(traction.revenue_data),
      money_raised_per_stage: asStringArray(traction.money_raised_per_stage),
      investor_list: asStringArray(traction.investor_list),
      notable_partners_or_customers: asStringArray(traction.notable_partners_or_customers),
      company_stage: asString(traction.company_stage),
      product_stage: asString(traction.product_stage),
      customer_size_and_count: asString(traction.customer_size_and_count),
      growth_trends_description: asString(traction.growth_trends_description),
    },
    negative_aspects: asString(negative.negative_aspects),
  };
}

/**
 * Best-effort sync from copilot accepted snippets into the normalized
 * deal_intel company_* facts schema.
 */
export async function syncCopilotSessionToFactsSchema(args: {
  admin: SupabaseClient;
  session: CopilotSession;
  companyName: string;
}): Promise<{ revisionId: string | null; insertedPeople: number }> {
  const snippets = snippetsFromSession(args.session);
  if (snippets.length === 0) return { revisionId: null, insertedPeople: 0 };

  const sourceText = snippetsToSourceText(args.session, args.companyName);
  const existingFactsBaseline = await fetchExistingFactsBaseline(args.admin, args.session.deal_id);
  const extractedFacts = await extractDealIntelSchemaFactsFromText({
    sourceText,
    modelTier: "flash_lite",
    existingFacts: existingFactsBaseline,
  });
  const existingPeopleRes = await args.admin
    .schema("deal_intel")
    .from("company_person")
    .select(
      "name, company_role, general_description, age, location, misc, education_general_description, education_institutions, education_majors, education_gpa, experience_general_description, past_companies_worked_at, past_companies_founded_or_previous_exits, relevant_achievements, research, patents, projects",
    )
    .eq("deal_id", args.session.deal_id);
  const existingPeople = (existingPeopleRes.data ?? []) as Array<Record<string, unknown>>;
  const facts = mergeNotablePeople(extractedFacts, existingPeopleToFactsShape(existingPeople));

  const revisionId = randomUUID();
  await args.admin.schema("deal_intel").from("deal_revision").insert({
    id: revisionId,
    deal_id: args.session.deal_id,
    label: `copilot:session:${args.session.id}`,
    metadata: {
      kind: "copilot_schema_sync",
      source: "copilot_session_finalize",
      session_id: args.session.id,
      snippet_count: snippets.length,
    },
  });

  await persistDealIntelSchemaRelational({
    admin: args.admin,
    dealId: args.session.deal_id,
    revisionId,
    facts,
  });

  const people = Array.isArray((facts as { notable_company_people?: unknown }).notable_company_people)
    ? ((facts as { notable_company_people: unknown[] }).notable_company_people ?? []).length
    : 0;
  return { revisionId, insertedPeople: people };
}

