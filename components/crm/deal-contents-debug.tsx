import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

type DocRow = {
  id: string;
  source_kind: string | null;
  doc_type: string | null;
  status: string | null;
  original_filename: string | null;
  folder_path: string | null;
  byte_size: number | null;
  created_at: string;
  updated_at: string | null;
};

type PageRow = {
  document_id: string;
  page_number: number;
  char_count: number | null;
  text: string | null;
  metadata: Record<string, unknown> | null;
};

type ChunkRow = {
  document_id: string;
  page_start: number;
  page_end: number;
  char_start: number;
  char_end: number;
  text: string | null;
  embedding: string | null;
  embedding_model: string | null;
  keywords: string[] | null;
  produced_by?: string | null;
  created_at: string;
};

type ClaimRow = {
  id: string;
  document_id: string | null;
  page_number: number | null;
  claim_type: string | null;
  key: string | null;
  value_text: string | null;
  value_jsonb: unknown;
  confidence: number | null;
  created_at: string;
};

type CopilotSessionRow = {
  id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  finalized_document_id: string | null;
  metadata: Record<string, unknown> | null;
  updated_at: string | null;
};

type CopilotEventRow = {
  id: string;
  session_id: string;
  kind: string;
  hostname: string | null;
  payload: Record<string, unknown> | null;
  parent_event_id: string | null;
  created_at: string;
};

type CompanyPersonRow = {
  id: string;
  person_kind: string;
  name: string;
  company_role: string | null;
  general_description: string | null;
  age: number | null;
  location: string | null;
  education_institutions: string[] | null;
  education_majors: string[] | null;
  education_gpa: string | null;
  past_companies_worked_at: string[] | null;
  past_companies_founded_or_previous_exits: string[] | null;
  relevant_achievements: string[] | null;
  research: string[] | null;
  patents: string[] | null;
  projects: string[] | null;
};

type CompanyMakeupRow = {
  general_description: string | null;
  general_education_history: string | null;
  general_work_background: string | null;
  company_size: number | null;
};

type CompanyOriginStoryRow = {
  general_description: string | null;
  cohesion_signals: string | null;
};

type CompanyProblemRow = {
  general_problem_description: string | null;
  all_potential_customers: string[] | null;
  actual_intended_customers_for_solution: string[] | null;
  urgency: string | null;
  current_cost_for_customers: string | null;
  tam: string | null;
  sam: string | null;
  som: string | null;
};

type CompanySolutionRow = {
  general_description: string | null;
  who_are_the_customers: string[] | null;
  cost_to_customer_to_buy_product: string | null;
  customer_benefit: string[] | null;
  solution_price_for_company: string | null;
  price_per_customer_build_and_serve: string | null;
  novelty_or_uniqueness: string | null;
  distinguishing_factors: string[] | null;
  defensibility: string | null;
  patent_ip: string[] | null;
  proprietary_tech_or_solution: string[] | null;
  competitors: unknown;
  timeline_description: string | null;
};

type CompanyTractionRow = {
  revenue_data: string | null;
  money_raised_per_stage: string[] | null;
  investor_list: string[] | null;
  notable_partners_or_customers: string[] | null;
  company_stage: string | null;
  product_stage: string | null;
  customer_size_and_count: string | null;
  growth_trends_description: string | null;
};

type CompanyNegativeRow = {
  negative_aspects: string | null;
};

const PREVIEW_CHARS = 240;

function previewText(s: string | null | undefined, n = PREVIEW_CHARS): string {
  if (!s) return "";
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function previewJson(v: unknown, n = 220): string {
  if (v == null) return "";
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > n ? `${s.slice(0, n)}…` : s;
  } catch {
    return "[unprintable]";
  }
}

function formatTime(ts: string | null | undefined): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

function claimValue(c: ClaimRow): string {
  if (typeof c.value_text === "string" && c.value_text) return c.value_text;
  if (c.value_jsonb != null) return previewJson(c.value_jsonb);
  return "";
}

export async function DealContentsDebug({
  dealId,
  userId,
}: {
  dealId: string;
  userId: string;
}) {
  const admin = createAdminClient();

  const [docsRes, claimsRes, sessionsRes, peopleRes, makeupRes, originRes, problemRes, solutionRes, tractionRes, negativeRes] = await Promise.all([
    admin
      .schema("deal_intel")
      .from("document")
      .select(
        "id, source_kind, doc_type, status, original_filename, folder_path, byte_size, created_at, updated_at",
      )
      .eq("deal_id", dealId)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(20),
    admin
      .schema("deal_intel")
      .from("claim")
      .select("id, document_id, page_number, claim_type, key, value_text, value_jsonb, confidence, created_at")
      .eq("deal_id", dealId)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50),
    admin
      .schema("deal_intel")
      .from("copilot_session")
      .select("id, status, started_at, ended_at, finalized_document_id, metadata, updated_at")
      .eq("deal_id", dealId)
      .eq("user_id", userId)
      .order("started_at", { ascending: false })
      .limit(10),
    admin
      .schema("deal_intel")
      .from("company_person")
      .select(
        "id, person_kind, name, company_role, general_description, age, location, education_institutions, education_majors, education_gpa, past_companies_worked_at, past_companies_founded_or_previous_exits, relevant_achievements, research, patents, projects",
      )
      .eq("deal_id", dealId)
      .order("created_at", { ascending: false })
      .limit(50),
    admin
      .schema("deal_intel")
      .from("company_makeup")
      .select("general_description, general_education_history, general_work_background, company_size")
      .eq("deal_id", dealId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .schema("deal_intel")
      .from("company_origin_story")
      .select("general_description, cohesion_signals")
      .eq("deal_id", dealId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .schema("deal_intel")
      .from("company_problem")
      .select(
        "general_problem_description, all_potential_customers, actual_intended_customers_for_solution, urgency, current_cost_for_customers, tam, sam, som",
      )
      .eq("deal_id", dealId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .schema("deal_intel")
      .from("company_solution")
      .select(
        "general_description, who_are_the_customers, cost_to_customer_to_buy_product, customer_benefit, solution_price_for_company, price_per_customer_build_and_serve, novelty_or_uniqueness, distinguishing_factors, defensibility, patent_ip, proprietary_tech_or_solution, competitors, timeline_description",
      )
      .eq("deal_id", dealId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .schema("deal_intel")
      .from("company_traction")
      .select(
        "revenue_data, money_raised_per_stage, investor_list, notable_partners_or_customers, company_stage, product_stage, customer_size_and_count, growth_trends_description",
      )
      .eq("deal_id", dealId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .schema("deal_intel")
      .from("company_negative")
      .select("negative_aspects")
      .eq("deal_id", dealId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const docs = (docsRes.data ?? []) as DocRow[];
  const claims = (claimsRes.data ?? []) as ClaimRow[];
  const sessions = (sessionsRes.data ?? []) as CopilotSessionRow[];
  const people = (peopleRes.data ?? []) as CompanyPersonRow[];
  const makeup = (makeupRes.data ?? null) as CompanyMakeupRow | null;
  const origin = (originRes.data ?? null) as CompanyOriginStoryRow | null;
  const problem = (problemRes.data ?? null) as CompanyProblemRow | null;
  const solution = (solutionRes.data ?? null) as CompanySolutionRow | null;
  const traction = (tractionRes.data ?? null) as CompanyTractionRow | null;
  const negative = (negativeRes.data ?? null) as CompanyNegativeRow | null;
  const docIds = docs.map((d) => d.id);

  const [pagesRes, chunksRes] = await Promise.all([
    docIds.length
      ? admin
          .schema("deal_intel")
          .from("document_page")
          .select("document_id, page_number, char_count, text, metadata")
          .in("document_id", docIds)
          .order("page_number", { ascending: true })
          .limit(200)
      : Promise.resolve({ data: [] as PageRow[], error: null }),
    docIds.length
      ? admin
          .schema("deal_intel")
          .from("document_chunk")
          .select(
            "document_id, page_start, page_end, char_start, char_end, text, embedding, embedding_model, keywords, produced_by, created_at",
          )
          .in("document_id", docIds)
          .order("created_at", { ascending: true })
          .limit(800)
      : Promise.resolve({ data: [] as ChunkRow[], error: null }),
  ]);

  const pages = (pagesRes.data ?? []) as PageRow[];
  const chunks = (chunksRes.data ?? []) as ChunkRow[];

  const pagesByDoc = new Map<string, PageRow[]>();
  for (const p of pages) {
    const arr = pagesByDoc.get(p.document_id) ?? [];
    arr.push(p);
    pagesByDoc.set(p.document_id, arr);
  }

  const chunksByDoc = new Map<string, ChunkRow[]>();
  for (const c of chunks) {
    const arr = chunksByDoc.get(c.document_id) ?? [];
    arr.push(c);
    chunksByDoc.set(c.document_id, arr);
  }

  const claimsByDoc = new Map<string, ClaimRow[]>();
  for (const c of claims) {
    if (!c.document_id) continue;
    const arr = claimsByDoc.get(c.document_id) ?? [];
    arr.push(c);
    claimsByDoc.set(c.document_id, arr);
  }

  const latestSession = sessions[0] ?? null;
  let latestEvents: CopilotEventRow[] = [];
  if (latestSession) {
    const evRes = await admin
      .schema("deal_intel")
      .from("copilot_event")
      .select("id, session_id, kind, hostname, payload, parent_event_id, created_at")
      .eq("session_id", latestSession.id)
      .order("created_at", { ascending: false })
      .limit(30);
    latestEvents = (evRes.data ?? []) as CopilotEventRow[];
  }

  return (
    <details className="rounded-md border border-zinc-200 bg-white">
      <summary className="cursor-pointer select-none px-3 py-2 text-sm text-zinc-700">
        Inspect deal contents (facts view)
      </summary>
      <div className="space-y-6 p-3 text-xs text-zinc-700">
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Facts schema summary</h3>
          <ul className="space-y-1">
            <li className="rounded border border-zinc-100 bg-zinc-50 p-2">
              People: <strong>{people.length}</strong> · Makeup: <strong>{makeup ? "yes" : "no"}</strong> · Origin story:{" "}
              <strong>{origin ? "yes" : "no"}</strong> · Problem: <strong>{problem ? "yes" : "no"}</strong> · Solution:{" "}
              <strong>{solution ? "yes" : "no"}</strong> · Traction: <strong>{traction ? "yes" : "no"}</strong> · Negative:{" "}
              <strong>{negative?.negative_aspects ? "yes" : "no"}</strong>
            </li>
            <li className="rounded border border-zinc-100 bg-zinc-50 p-2 text-zinc-600">
              Note: <code>company_*</code> schema rows can be populated by PDF ingest or by copilot finalize schema-sync.
              <code>claim</code> rows are still a separate pipeline and may remain 0 unless claim extraction runs.
            </li>
          </ul>
        </section>

        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Notable company people</h3>
          {people.length === 0 ? (
            <p className="text-zinc-500">No people rows yet.</p>
          ) : (
            <div className="space-y-2">
              {people.map((p) => (
                <details key={p.id} className="rounded border border-zinc-200">
                  <summary className="cursor-pointer select-none px-2 py-1">
                    <span className="font-medium text-zinc-800">{p.name}</span>
                    <span className="ml-2 text-zinc-500">
                      [{p.person_kind}] {p.company_role ? `· ${p.company_role}` : ""}
                    </span>
                  </summary>
                  <div className="space-y-2 px-3 py-2">
                    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[11px]">
                      <dt className="text-zinc-500">general_description</dt>
                      <dd>{p.general_description ?? "—"}</dd>
                      <dt className="text-zinc-500">age</dt>
                      <dd>{p.age ?? "—"}</dd>
                      <dt className="text-zinc-500">location</dt>
                      <dd>{p.location ?? "—"}</dd>
                      <dt className="text-zinc-500">education_institutions</dt>
                      <dd>{(p.education_institutions ?? []).join(", ") || "—"}</dd>
                      <dt className="text-zinc-500">education_majors</dt>
                      <dd>{(p.education_majors ?? []).join(", ") || "—"}</dd>
                      <dt className="text-zinc-500">education_gpa</dt>
                      <dd>{p.education_gpa ?? "—"}</dd>
                      <dt className="text-zinc-500">experience_worked_at</dt>
                      <dd>{(p.past_companies_worked_at ?? []).join(", ") || "—"}</dd>
                      <dt className="text-zinc-500">experience_founded_or_exits</dt>
                      <dd>{(p.past_companies_founded_or_previous_exits ?? []).join(", ") || "—"}</dd>
                      <dt className="text-zinc-500">relevant_achievements</dt>
                      <dd>{(p.relevant_achievements ?? []).join(", ") || "—"}</dd>
                      <dt className="text-zinc-500">research</dt>
                      <dd>{(p.research ?? []).join(", ") || "—"}</dd>
                      <dt className="text-zinc-500">patents</dt>
                      <dd>{(p.patents ?? []).join(", ") || "—"}</dd>
                      <dt className="text-zinc-500">projects</dt>
                      <dd>{(p.projects ?? []).join(", ") || "—"}</dd>
                    </dl>
                  </div>
                </details>
              ))}
            </div>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Company makeup</h3>
          {makeup ? (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded border border-zinc-100 bg-zinc-50 p-2 text-[11px]">
              <dt className="text-zinc-500">general_description</dt>
              <dd>{makeup.general_description ?? "—"}</dd>
              <dt className="text-zinc-500">general_education_history</dt>
              <dd>{makeup.general_education_history ?? "—"}</dd>
              <dt className="text-zinc-500">general_work_background</dt>
              <dd>{makeup.general_work_background ?? "—"}</dd>
              <dt className="text-zinc-500">company_size</dt>
              <dd>{makeup.company_size ?? "—"}</dd>
            </dl>
          ) : (
            <p className="text-zinc-500">No company_makeup row yet.</p>
          )}
          <div className="mt-2 text-[11px] text-zinc-600">Origin story: {origin?.general_description ?? "—"}</div>
        </section>

        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Company problem</h3>
          {problem ? (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded border border-zinc-100 bg-zinc-50 p-2 text-[11px]">
              <dt className="text-zinc-500">general_problem_description</dt>
              <dd>{problem.general_problem_description ?? "—"}</dd>
              <dt className="text-zinc-500">all_potential_customers</dt>
              <dd>{(problem.all_potential_customers ?? []).join(", ") || "—"}</dd>
              <dt className="text-zinc-500">actual_intended_customers</dt>
              <dd>{(problem.actual_intended_customers_for_solution ?? []).join(", ") || "—"}</dd>
              <dt className="text-zinc-500">urgency</dt>
              <dd>{problem.urgency ?? "—"}</dd>
              <dt className="text-zinc-500">current_cost_for_customers</dt>
              <dd>{problem.current_cost_for_customers ?? "—"}</dd>
              <dt className="text-zinc-500">TAM / SAM / SOM</dt>
              <dd>{`${problem.tam ?? "—"} / ${problem.sam ?? "—"} / ${problem.som ?? "—"}`}</dd>
            </dl>
          ) : (
            <p className="text-zinc-500">No company_problem row yet.</p>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Company solution</h3>
          {solution ? (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded border border-zinc-100 bg-zinc-50 p-2 text-[11px]">
              <dt className="text-zinc-500">general_description</dt>
              <dd>{solution.general_description ?? "—"}</dd>
              <dt className="text-zinc-500">customers</dt>
              <dd>{(solution.who_are_the_customers ?? []).join(", ") || "—"}</dd>
              <dt className="text-zinc-500">cost_to_buy_product</dt>
              <dd>{solution.cost_to_customer_to_buy_product ?? "—"}</dd>
              <dt className="text-zinc-500">customer_benefit</dt>
              <dd>{(solution.customer_benefit ?? []).join(", ") || "—"}</dd>
              <dt className="text-zinc-500">solution_price_for_company</dt>
              <dd>{solution.solution_price_for_company ?? "—"}</dd>
              <dt className="text-zinc-500">price_per_customer_build_and_serve</dt>
              <dd>{solution.price_per_customer_build_and_serve ?? "—"}</dd>
              <dt className="text-zinc-500">novelty_or_uniqueness</dt>
              <dd>{solution.novelty_or_uniqueness ?? "—"}</dd>
              <dt className="text-zinc-500">distinguishing_factors</dt>
              <dd>{(solution.distinguishing_factors ?? []).join(", ") || "—"}</dd>
              <dt className="text-zinc-500">defensibility</dt>
              <dd>{solution.defensibility ?? "—"}</dd>
              <dt className="text-zinc-500">patent_ip</dt>
              <dd>{(solution.patent_ip ?? []).join(", ") || "—"}</dd>
              <dt className="text-zinc-500">proprietary_tech_or_solution</dt>
              <dd>{(solution.proprietary_tech_or_solution ?? []).join(", ") || "—"}</dd>
              <dt className="text-zinc-500">competitors</dt>
              <dd>{previewJson(solution.competitors, 300) || "—"}</dd>
              <dt className="text-zinc-500">timeline_description</dt>
              <dd>{solution.timeline_description ?? "—"}</dd>
            </dl>
          ) : (
            <p className="text-zinc-500">No company_solution row yet.</p>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Company traction</h3>
          {traction ? (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded border border-zinc-100 bg-zinc-50 p-2 text-[11px]">
              <dt className="text-zinc-500">revenue_data</dt>
              <dd>{traction.revenue_data ?? "—"}</dd>
              <dt className="text-zinc-500">money_raised_per_stage</dt>
              <dd>{(traction.money_raised_per_stage ?? []).join(", ") || "—"}</dd>
              <dt className="text-zinc-500">investor_list</dt>
              <dd>{(traction.investor_list ?? []).join(", ") || "—"}</dd>
              <dt className="text-zinc-500">notable_partners_or_customers</dt>
              <dd>{(traction.notable_partners_or_customers ?? []).join(", ") || "—"}</dd>
              <dt className="text-zinc-500">company_stage</dt>
              <dd>{traction.company_stage ?? "—"}</dd>
              <dt className="text-zinc-500">product_stage</dt>
              <dd>{traction.product_stage ?? "—"}</dd>
              <dt className="text-zinc-500">customer_size_and_count</dt>
              <dd>{traction.customer_size_and_count ?? "—"}</dd>
              <dt className="text-zinc-500">growth_trends_description</dt>
              <dd>{traction.growth_trends_description ?? "—"}</dd>
            </dl>
          ) : (
            <p className="text-zinc-500">No company_traction row yet.</p>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Negative aspects</h3>
          <div className="rounded border border-zinc-100 bg-zinc-50 p-2 text-[11px]">
            {negative?.negative_aspects ?? "—"}
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Documents</h3>
          {docs.length === 0 ? (
            <p className="text-zinc-500">No documents yet.</p>
          ) : (
            <div className="space-y-3">
              {docs.map((doc) => {
                const dPages = pagesByDoc.get(doc.id) ?? [];
                const dChunks = chunksByDoc.get(doc.id) ?? [];
                const embedded = dChunks.filter((c) => c.embedding).length;
                const dClaims = claimsByDoc.get(doc.id) ?? [];
                return (
                  <details key={doc.id} className="rounded border border-zinc-200">
                    <summary className="cursor-pointer select-none px-2 py-1">
                      <span className="font-medium text-zinc-800">
                        {doc.original_filename || doc.id}
                      </span>
                      <span className="ml-2 text-zinc-500">
                        [{doc.source_kind ?? "?"}/{doc.status ?? "?"}] · {dPages.length} pages · {dChunks.length} chunks
                        ({embedded} embedded) · {dClaims.length} claims
                      </span>
                    </summary>
                    <div className="space-y-3 px-3 py-2">
                      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[11px]">
                        <dt className="text-zinc-500">id</dt>
                        <dd className="font-mono">{doc.id}</dd>
                        <dt className="text-zinc-500">source_kind</dt>
                        <dd>{doc.source_kind ?? "—"}</dd>
                        <dt className="text-zinc-500">doc_type</dt>
                        <dd>{doc.doc_type ?? "—"}</dd>
                        <dt className="text-zinc-500">status</dt>
                        <dd>{doc.status ?? "—"}</dd>
                        <dt className="text-zinc-500">folder_path</dt>
                        <dd>{doc.folder_path ?? "—"}</dd>
                        <dt className="text-zinc-500">byte_size</dt>
                        <dd>{doc.byte_size ?? "—"}</dd>
                        <dt className="text-zinc-500">created_at</dt>
                        <dd>{formatTime(doc.created_at)}</dd>
                        <dt className="text-zinc-500">updated_at</dt>
                        <dd>{formatTime(doc.updated_at)}</dd>
                      </dl>

                      {dPages.length ? (
                        <div>
                          <div className="mb-1 text-[11px] font-semibold uppercase text-zinc-500">
                            Pages ({dPages.length})
                          </div>
                          <div className="space-y-1">
                            {dPages.slice(0, 8).map((p) => (
                              <div
                                key={`${doc.id}-${p.page_number}`}
                                className="rounded border border-zinc-100 bg-zinc-50 p-2"
                              >
                                <div className="text-[11px] text-zinc-500">
                                  page {p.page_number} · {p.char_count ?? 0} chars
                                </div>
                                <div className="whitespace-pre-wrap break-words text-zinc-800">
                                  {previewText(p.text, 360)}
                                </div>
                              </div>
                            ))}
                            {dPages.length > 8 ? (
                              <div className="text-[11px] text-zinc-500">
                                …and {dPages.length - 8} more pages
                              </div>
                            ) : null}
                          </div>
                        </div>
                      ) : null}

                      {dChunks.length ? (
                        <div>
                          <div className="mb-1 text-[11px] font-semibold uppercase text-zinc-500">
                            First chunks ({Math.min(dChunks.length, 3)} of {dChunks.length})
                          </div>
                          <div className="space-y-1">
                            {dChunks.slice(0, 3).map((c, i) => (
                              <div
                                key={`${doc.id}-c-${i}`}
                                className="rounded border border-zinc-100 bg-zinc-50 p-2"
                              >
                                <div className="text-[11px] text-zinc-500">
                                  pages {c.page_start}-{c.page_end} · chars {c.char_start}-{c.char_end} ·{" "}
                                  embedding: {c.embedding ? "ready" : "pending"} ·{" "}
                                  keywords: {(c.keywords ?? []).slice(0, 5).join(", ") || "—"}
                                </div>
                                <div className="whitespace-pre-wrap break-words text-zinc-800">
                                  {previewText(c.text, 240)}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      {dClaims.length ? (
                        <div>
                          <div className="mb-1 text-[11px] font-semibold uppercase text-zinc-500">
                            Claims ({dClaims.length})
                          </div>
                          <ul className="space-y-1">
                            {dClaims.slice(0, 8).map((c) => (
                              <li key={c.id} className="rounded border border-zinc-100 bg-zinc-50 p-2">
                                <span className="text-zinc-500">[{c.claim_type ?? "?"}]</span>{" "}
                                <span className="font-medium">{c.key ?? "(no key)"}</span>:{" "}
                                <span>{claimValue(c) || "—"}</span>{" "}
                                <span className="text-zinc-500">
                                  · p{c.page_number ?? "?"} · conf {c.confidence ?? "—"}
                                </span>
                              </li>
                            ))}
                            {dClaims.length > 8 ? (
                              <li className="text-zinc-500">…and {dClaims.length - 8} more</li>
                            ) : null}
                          </ul>
                        </div>
                      ) : null}
                    </div>
                  </details>
                );
              })}
            </div>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
            Recent claims (deal-wide, latest {claims.length})
          </h3>
          {claims.length === 0 ? (
            <p className="text-zinc-500">No claims yet.</p>
          ) : (
            <ul className="space-y-1">
              {claims.slice(0, 25).map((c) => (
                <li key={c.id} className="rounded border border-zinc-100 bg-zinc-50 p-2">
                  <span className="text-zinc-500">[{c.claim_type ?? "?"}]</span>{" "}
                  <span className="font-medium">{c.key ?? "(no key)"}</span>:{" "}
                  <span>{claimValue(c) || "—"}</span>{" "}
                  <span className="text-zinc-500">
                    · doc {c.document_id ? c.document_id.slice(0, 8) : "—"} · {formatTime(c.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <details className="rounded border border-zinc-200">
          <summary className="cursor-pointer select-none px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
            Technical logs (copilot sessions/events)
          </summary>
          <div className="space-y-4 p-2">
            <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
            Copilot sessions ({sessions.length})
          </h3>
          {sessions.length === 0 ? (
            <p className="text-zinc-500">No copilot sessions yet.</p>
          ) : (
            <div className="space-y-2">
              {sessions.map((s) => {
                const meta = (s.metadata ?? {}) as { acceptedSnippets?: unknown };
                const accepted = Array.isArray(meta.acceptedSnippets) ? meta.acceptedSnippets.length : 0;
                return (
                  <div key={s.id} className="rounded border border-zinc-100 bg-zinc-50 p-2">
                    <div className="text-[11px] text-zinc-500">
                      {formatTime(s.started_at)} → {formatTime(s.ended_at)} · status: {s.status} · accepted:{" "}
                      {accepted} · doc:{" "}
                      {s.finalized_document_id ? s.finalized_document_id.slice(0, 8) : "—"}
                    </div>
                    <div className="font-mono text-[11px] text-zinc-700">{s.id}</div>
                  </div>
                );
              })}
            </div>
          )}
            </section>

            {latestSession ? (
              <section>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
              Latest session events ({latestEvents.length})
            </h3>
            {latestEvents.length === 0 ? (
              <p className="text-zinc-500">No events recorded.</p>
            ) : (
              <ul className="space-y-1">
                {latestEvents.map((ev) => (
                  <li key={ev.id} className="rounded border border-zinc-100 bg-zinc-50 p-2">
                    <div className="text-[11px] text-zinc-500">
                      [{ev.kind}] {ev.hostname ? `@ ${ev.hostname}` : ""} · {formatTime(ev.created_at)}
                    </div>
                    <div className="whitespace-pre-wrap break-words text-zinc-800">
                      {previewJson(ev.payload, 360)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
              </section>
            ) : null}
          </div>
        </details>
      </div>
    </details>
  );
}
