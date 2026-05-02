import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseJsonFromResponseOrNull, parseJsonFromResponseWithRepair } from "@/lib/gemini";
import { executeResearchStep } from "@/lib/research/executor";
import { getResearchModel } from "@/lib/research/research-model-env";
import { vertexRunWithTextMulti } from "@/lib/vertex";

export type MatrixColumn = {
  id: string;
  user_id: string;
  label: string;
  description: string;
  data_type: "text" | "number" | "percent" | "currency" | "boolean" | "json";
  prompt: string;
  research_enabled: boolean;
  position: number;
  created_at: string;
  updated_at: string;
};

export type MatrixCell = {
  id: string;
  user_id: string;
  deal_id: string;
  column_id: string;
  status: "empty" | "filled" | "needs_research" | "researching" | "error";
  value_text: string | null;
  value_jsonb: Record<string, unknown> | null;
  confidence: number | null;
  source_kind: "none" | "internal" | "research" | "manual";
  rationale: string | null;
  citations: MatrixCitation[];
  research_notes: string | null;
  error_message: string | null;
  filled_at: string | null;
  created_at: string;
  updated_at: string;
};

export type MatrixCitation = {
  label: string;
  snippet?: string;
  href?: string;
};

type DealRow = {
  id: string;
  metadata: Record<string, unknown> | null;
};

type ParsedCell = {
  answer: string;
  valueJson: Record<string, unknown> | null;
  confidence: number;
  status: "filled" | "needs_research";
  rationale: string;
  citations: MatrixCitation[];
  researchTask: string;
};

function safeMeta(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function companyName(deal: DealRow): string {
  const meta = safeMeta(deal.metadata);
  return asString(meta.company_name).trim() || "Untitled company";
}

function citationFromRaw(v: unknown): MatrixCitation | null {
  const o = safeMeta(v);
  const label = asString(o.label).trim();
  const snippet = asString(o.snippet).trim();
  const href = asString(o.href).trim();
  if (!label && !snippet && !href) return null;
  return {
    label: label || href || "Source",
    ...(snippet ? { snippet: snippet.slice(0, 500) } : {}),
    ...(href ? { href } : {}),
  };
}

function parseCell(raw: string): ParsedCell | null {
  const parsed = parseJsonFromResponseOrNull(raw) as Record<string, unknown> | null;
  if (!parsed) return null;
  const answer = asString(parsed.answer).trim();
  const status = parsed.status === "filled" ? "filled" : "needs_research";
  const confidenceRaw = Number(parsed.confidence);
  const citations = Array.isArray(parsed.citations)
    ? parsed.citations.map(citationFromRaw).filter((c): c is MatrixCitation => Boolean(c)).slice(0, 8)
    : [];
  if (!answer && status === "filled") return null;
  return {
    answer: answer.slice(0, 2000),
    valueJson: parsed.valueJson && typeof parsed.valueJson === "object" ? (parsed.valueJson as Record<string, unknown>) : null,
    confidence: Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0.5,
    status,
    rationale: asString(parsed.rationale).slice(0, 1000),
    citations,
    researchTask: asString(parsed.researchTask).slice(0, 500),
  };
}

async function parseCellWithRepair(raw: string): Promise<ParsedCell | null> {
  return parseCell(raw) ?? parseCell(JSON.stringify((await parseJsonFromResponseWithRepair(raw).catch(() => null)) ?? null));
}

export async function listMatrixDeals(admin: SupabaseClient, userId: string): Promise<Array<{ id: string; name: string }>> {
  const res = await admin
    .schema("deal_intel")
    .from("deal")
    .select("id, metadata")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(120);
  if (res.error) throw res.error;
  return ((res.data ?? []) as DealRow[]).map((d) => ({ id: d.id, name: companyName(d) }));
}

export async function listMatrixColumns(admin: SupabaseClient, userId: string): Promise<MatrixColumn[]> {
  const res = await admin
    .schema("deal_intel")
    .from("diligence_matrix_column")
    .select("id, user_id, label, description, data_type, prompt, research_enabled, position, created_at, updated_at")
    .eq("user_id", userId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (res.error) throw res.error;
  return (res.data ?? []) as MatrixColumn[];
}

export async function listMatrixCells(admin: SupabaseClient, userId: string): Promise<MatrixCell[]> {
  const res = await admin
    .schema("deal_intel")
    .from("diligence_matrix_cell")
    .select("id, user_id, deal_id, column_id, status, value_text, value_jsonb, confidence, source_kind, rationale, citations, research_notes, error_message, filled_at, created_at, updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(2000);
  if (res.error) throw res.error;
  return ((res.data ?? []) as Array<Omit<MatrixCell, "citations"> & { citations: unknown }>).map((c) => ({
    ...c,
    citations: Array.isArray(c.citations) ? c.citations.map(citationFromRaw).filter((x): x is MatrixCitation => Boolean(x)) : [],
  }));
}

export async function createMatrixColumn(
  admin: SupabaseClient,
  userId: string,
  input: { label: string; description: string; dataType: MatrixColumn["data_type"]; prompt: string; researchEnabled: boolean },
): Promise<MatrixColumn> {
  const count = await admin
    .schema("deal_intel")
    .from("diligence_matrix_column")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  if (count.error) throw count.error;
  const res = await admin
    .schema("deal_intel")
    .from("diligence_matrix_column")
    .insert({
      user_id: userId,
      label: input.label,
      description: input.description,
      data_type: input.dataType,
      prompt: input.prompt,
      research_enabled: input.researchEnabled,
      position: count.count ?? 0,
    })
    .select("id, user_id, label, description, data_type, prompt, research_enabled, position, created_at, updated_at")
    .single();
  if (res.error) throw res.error;
  return res.data as MatrixColumn;
}

async function loadDeal(admin: SupabaseClient, userId: string, dealId: string): Promise<DealRow> {
  const res = await admin
    .schema("deal_intel")
    .from("deal")
    .select("id, metadata")
    .eq("id", dealId)
    .eq("user_id", userId)
    .maybeSingle();
  if (res.error) throw res.error;
  if (!res.data) throw new Error("Company not found");
  return res.data as DealRow;
}

async function loadColumn(admin: SupabaseClient, userId: string, columnId: string): Promise<MatrixColumn> {
  const res = await admin
    .schema("deal_intel")
    .from("diligence_matrix_column")
    .select("id, user_id, label, description, data_type, prompt, research_enabled, position, created_at, updated_at")
    .eq("id", columnId)
    .eq("user_id", userId)
    .maybeSingle();
  if (res.error) throw res.error;
  if (!res.data) throw new Error("Column not found");
  return res.data as MatrixColumn;
}

async function loadInternalContext(admin: SupabaseClient, userId: string, dealId: string, query: string) {
  const di = admin.schema("deal_intel");
  const [problem, solution, traction, people, facts, claims, docChunks] = await Promise.all([
    di.from("company_problem").select("*").eq("deal_id", dealId).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    di.from("company_solution").select("*").eq("deal_id", dealId).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    di.from("company_traction").select("*").eq("deal_id", dealId).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    di
      .from("company_person")
      .select("name, person_kind, company_role, general_description, relevant_achievements")
      .eq("deal_id", dealId)
      .order("created_at", { ascending: false })
      .limit(12),
    di
      .from("deal_fact_node")
      .select("path, value_text, value_jsonb, embedding_input, source_map")
      .eq("deal_id", dealId)
      .order("updated_at", { ascending: false })
      .limit(80),
    di
      .from("claim")
      .select("quote, claim_type, key, value_text, value_number, confidence")
      .eq("deal_id", dealId)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50),
    admin.rpc("deal_intel_match_document_chunks_fts", {
      p_user_id: userId,
      p_query: query.slice(0, 500),
      p_match_count: 8,
      p_deal_id: dealId,
    }),
  ]);

  return {
    structured: {
      problem: problem.data ?? null,
      solution: solution.data ?? null,
      traction: traction.data ?? null,
      people: people.data ?? [],
    },
    facts: facts.error ? [] : facts.data ?? [],
    claims: claims.error ? [] : claims.data ?? [],
    documentSnippets: docChunks.error ? [] : docChunks.data ?? [],
  };
}

async function inferFromContext(args: {
  companyName: string;
  column: MatrixColumn;
  internalContext: unknown;
  researchNotes?: string | null;
  researchSources?: MatrixCitation[];
}): Promise<ParsedCell> {
  const raw = await vertexRunWithTextMulti(
    getResearchModel("flash"),
    `Fill one diligence matrix cell.
Return strict JSON:
{
  "status": "filled" | "needs_research",
  "answer": "short cell value",
  "valueJson": {},
  "confidence": 0.0,
  "rationale": "brief explanation",
  "citations": [{"label":"internal fact or source title","snippet":"supporting quote","href":"optional url"}],
  "researchTask": "specific web research task if status is needs_research"
}
Rules:
- Answer the exact column for the company. Do not fill adjacent metrics.
- Prefer concise spreadsheet-style values, e.g. "32%", "$18M ARR", "Beat Q3 revenue goal by 12%", or "Not found".
- If the evidence does not actually answer the column, return status "needs_research" and explain what is missing.
- If research notes are provided, use them only when they directly answer the column.
- For confidence, use 0.85+ only when supported by direct evidence.
- Do not invent values.`,
    [
      { label: "Company", value: args.companyName },
      { label: "Column", value: args.column },
      { label: "Internal context", value: args.internalContext },
      { label: "Research notes", value: args.researchNotes ?? null },
      { label: "Research citations", value: args.researchSources ?? [] },
    ],
    false,
  );
  return (
    (await parseCellWithRepair(raw)) ?? {
      status: "needs_research",
      answer: "",
      valueJson: null,
      confidence: 0,
      rationale: "Could not parse a grounded answer.",
      citations: [],
      researchTask: `Find ${args.column.label} for ${args.companyName}.`,
    }
  );
}

async function upsertCell(
  admin: SupabaseClient,
  input: {
    userId: string;
    dealId: string;
    columnId: string;
    status: MatrixCell["status"];
    valueText: string | null;
    valueJson: Record<string, unknown> | null;
    confidence: number | null;
    sourceKind: MatrixCell["source_kind"];
    rationale: string | null;
    citations: MatrixCitation[];
    researchNotes?: string | null;
    errorMessage?: string | null;
  },
): Promise<MatrixCell> {
  const res = await admin
    .schema("deal_intel")
    .from("diligence_matrix_cell")
    .upsert(
      {
        user_id: input.userId,
        deal_id: input.dealId,
        column_id: input.columnId,
        status: input.status,
        value_text: input.valueText,
        value_jsonb: input.valueJson,
        confidence: input.confidence,
        source_kind: input.sourceKind,
        rationale: input.rationale,
        citations: input.citations,
        research_notes: input.researchNotes ?? null,
        error_message: input.errorMessage ?? null,
        filled_at: input.status === "filled" ? new Date().toISOString() : null,
      },
      { onConflict: "deal_id,column_id" },
    )
    .select("id, user_id, deal_id, column_id, status, value_text, value_jsonb, confidence, source_kind, rationale, citations, research_notes, error_message, filled_at, created_at, updated_at")
    .single();
  if (res.error) throw res.error;
  const row = res.data as Omit<MatrixCell, "citations"> & { citations: unknown };
  return {
    ...row,
    citations: Array.isArray(row.citations) ? row.citations.map(citationFromRaw).filter((c): c is MatrixCitation => Boolean(c)) : [],
  };
}

export async function fillMatrixCell(args: {
  admin: SupabaseClient;
  userId: string;
  dealId: string;
  columnId: string;
  allowResearch: boolean;
}): Promise<MatrixCell> {
  const [deal, column] = await Promise.all([
    loadDeal(args.admin, args.userId, args.dealId),
    loadColumn(args.admin, args.userId, args.columnId),
  ]);
  const name = companyName(deal);
  const query = `${column.label} ${column.description} ${column.prompt} ${name}`;
  const internalContext = await loadInternalContext(args.admin, args.userId, deal.id, query);
  const internal = await inferFromContext({ companyName: name, column, internalContext });
  if (internal.status === "filled" || !args.allowResearch || !column.research_enabled) {
    return upsertCell(args.admin, {
      userId: args.userId,
      dealId: deal.id,
      columnId: column.id,
      status: internal.status,
      valueText: internal.answer || null,
      valueJson: internal.valueJson,
      confidence: internal.confidence,
      sourceKind: internal.status === "filled" ? "internal" : "none",
      rationale: internal.rationale,
      citations: internal.citations,
    });
  }

  const researchTask =
    internal.researchTask ||
    column.prompt ||
    `Find ${column.label} for ${name}. Return only evidence that directly answers the metric.`;
  const research = await executeResearchStep({
    companyName: name,
    companyContext: JSON.stringify({ metadata: deal.metadata, internalContext }).slice(0, 16000),
    website: "web",
    task: researchTask,
  });
  if (!research.ok) {
    return upsertCell(args.admin, {
      userId: args.userId,
      dealId: deal.id,
      columnId: column.id,
      status: "error",
      valueText: null,
      valueJson: null,
      confidence: null,
      sourceKind: "none",
      rationale: internal.rationale,
      citations: internal.citations,
      errorMessage: research.errorMessage,
    });
  }

  const researchCitations = research.sources.map((s) => ({
    label: s.title || s.url,
    href: s.url,
    snippet: s.snippet,
  }));
  const grounded = await inferFromContext({
    companyName: name,
    column,
    internalContext,
    researchNotes: research.notes,
    researchSources: researchCitations,
  });
  return upsertCell(args.admin, {
    userId: args.userId,
    dealId: deal.id,
    columnId: column.id,
    status: grounded.status,
    valueText: grounded.answer || null,
    valueJson: grounded.valueJson,
    confidence: grounded.confidence,
    sourceKind: grounded.status === "filled" ? "research" : "none",
    rationale: grounded.rationale,
    citations: grounded.citations.length ? grounded.citations : researchCitations,
    researchNotes: research.notes,
  });
}
