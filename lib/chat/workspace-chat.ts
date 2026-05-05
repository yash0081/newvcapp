import type { SupabaseClient } from "@supabase/supabase-js";
import { parseJsonFromResponseOrNull, parseJsonFromResponseWithRepair } from "@/lib/gemini";
import { classifyChatTaskWithGemma, chatModelForTask, retrieveLimitForTask } from "@/lib/chat-router-gemma";
import { retrieveContextNodesForQuery, type ContextChunk } from "@/lib/retrieval-orchestrator";
import { vectorParam } from "@/lib/data-layer/shared/vector";
import { embedText } from "@/lib/vertex-embeddings";
import { vertexRunWithText, vertexRunWithTextAndGroundingSources, vertexStreamText } from "@/lib/vertex";
import { fetchSimilarDealsFromDealId } from "@/lib/similar-deals/fetch-from-deal";
import { fetchSimilarDealsHybrid } from "@/lib/similar-deals/fetch-hybrid";
import type { SimilarPeerForPrompt } from "@/lib/similar-deals/types";
import { loadAggregatedRulesForUser } from "@/lib/investment-rules";
import { listCustomWorkflowDefinitions, type CustomWorkflowDefinition } from "@/lib/custom-workflows";
import { listMatrixColumns, type MatrixColumn } from "@/lib/diligence-matrix/matrix";
import {
  DEAL_INTEL_LAYER1A_SCHEMA_GUIDE,
  DEAL_INTEL_QUALITY_GUARDRAILS,
  DEAL_INTEL_RESEARCH_FOCUS_GUIDE,
  USER_PREFERENCE_GUARDRAILS,
} from "@/lib/deal-intel/prompt-guidance";
import { stripMarkdownText } from "@/lib/plain-text";

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type ChatAction =
  | {
      type: "tool_call";
      label: string;
      tool:
        | "task_router"
        | "workspace_retrieval"
        | "quick_lookup"
        | "similar_company_search"
        | "criteria_analysis"
        | "research"
        | "document_generation"
        | "workflow"
        | "record_update";
      status: "queued" | "running" | "completed" | "failed";
      detail?: string;
      href?: string;
    }
  | {
      type: "open_document";
      label: string;
      href: string;
      documentId: string;
      filename: string;
    }
  | {
      type: "open_link";
      label: string;
      href: string;
      detail?: string;
    }
  | {
      type: "propose_generate_document";
      label: string;
      prompt: string;
      dealId: string | null;
      dealName: string | null;
      typeId: string | null;
      typeName: string;
      outputFormat: string;
      skipResearch?: boolean;
    }
  | {
      type: "propose_research";
      label: string;
      focus: string;
      userPrompt?: string;
      dealIds: string[];
      dealNames: string[];
    }
  | {
      type: "propose_matrix_fill";
      label: string;
      dealIds: string[];
      dealNames: string[];
      columnIds: string[];
      columnLabels: string[];
      columnsToCreate?: MatrixColumnDraft[];
    }
  | {
      type: "matrix_preview";
      label: string;
      href: string;
      detail?: string;
      columns: Array<{ id: string; label: string }>;
      rows: Array<{
        dealId: string;
        dealName: string;
        values: Array<{ columnId: string; columnLabel: string; value: string; status?: string }>;
      }>;
    }
  | {
      type: "document_preview";
      label: string;
      title: string;
      href: string;
      downloadHref?: string;
      format?: string;
      dealName?: string | null;
      excerpt?: string;
    }
  | {
      type: "propose_record_update";
      label: string;
      dealId: string;
      dealName: string;
      updates: PlannedUpdate[];
    }
  | {
      type: "propose_custom_workflow";
      label: string;
      workflowId: string;
      workflowName: string;
      dealId: string | null;
      dealName: string | null;
      input: string;
    }
  | {
      type: "record_update";
      label: string;
      detail: string;
    };

export type ChatCitation = {
  label: string;
  href?: string;
  snippet: string;
};

export type ChatToolPermissions = {
  generateDocuments: boolean;
  runResearch: boolean;
  editRecords: boolean;
  createCompanies: boolean;
  useSimilarCompanySearch: boolean;
  useCriteriaAnalysis: boolean;
  runWorkflows: boolean;
  useMatrix: boolean;
};

export const DEFAULT_CHAT_TOOL_PERMISSIONS: ChatToolPermissions = {
  generateDocuments: true,
  runResearch: true,
  editRecords: true,
  createCompanies: true,
  useSimilarCompanySearch: true,
  useCriteriaAnalysis: true,
  runWorkflows: true,
  useMatrix: true,
};

type MatrixColumnDraft = {
  label: string;
  description: string;
  dataType: MatrixColumn["data_type"];
  prompt: string;
  researchEnabled?: boolean;
};

type ToolPrecheck = {
  wantsMatrix: boolean;
  wantsDocument: boolean;
  wantsResearch: boolean;
  wantsWorkflow: boolean;
  documentTypeHint: string | null;
  targetDealIds: string[];
  researchDealIds: string[];
  matrixColumnsToCreate: MatrixColumnDraft[];
  researchFocus: string;
  matrixFocus: string;
  documentFocus: string;
  evidence: string[];
};

type DealRow = {
  id: string;
  metadata: Record<string, unknown> | null;
};

type DocumentRow = {
  id: string;
  original_filename: string | null;
  folder_path: string | null;
  source_kind: string | null;
  mime_type: string | null;
  status: string | null;
  created_at: string | null;
};

type QuickLookupResult = {
  text: string;
  citations: ChatCitation[];
};

type DocumentTypeSummary = {
  id: string;
  name: string;
  output_format: string | null;
  description: string | null;
  instructions: string | null;
  learned_preferences: string | null;
  updated_at: string | null;
};

export type UpdateTarget =
  | "deal.company_name"
  | "deal.website"
  | "deal.crm_stage"
  | "makeup.general_description"
  | "makeup.general_education_history"
  | "makeup.general_work_background"
  | "origin.general_description"
  | "traction.revenue_data"
  | "traction.customer_size_and_count"
  | "traction.growth_trends_description"
  | "traction.company_stage"
  | "traction.product_stage"
  | "problem.general_problem_description"
  | "problem.urgency"
  | "problem.current_cost_for_customers"
  | "problem.tam"
  | "problem.sam"
  | "problem.som"
  | "solution.general_description"
  | "solution.cost_to_customer_to_buy_product"
  | "solution.solution_price_for_company"
  | "solution.price_per_customer_build_and_serve"
  | "solution.novelty_or_uniqueness"
  | "solution.defensibility"
  | "solution.timeline_description"
  | "negative.negative_aspects";

export type PlannedUpdate = {
  target: UpdateTarget;
  value: string;
};

type ChatRoutePlan = {
  chatTask: "similar_deal" | "filtering" | "deep_reasoning" | "why" | "questions";
  scope: "focused_company" | "workspace" | "cross_company";
  answerPersonal: boolean;
  targetDealIds: string[];
  openDocumentQuery: string | null;
  createCompany: {
    company_name: string;
    website: string | null;
    crm_stage: "screened" | "in_process" | "invested" | "passed";
  } | null;
  updates: PlannedUpdate[];
  generateDocument: {
    enabled: boolean;
    prompt: string;
    typeHint: string | null;
  };
  runResearch: {
    enabled: boolean;
    focus: string;
    when: "now" | "if_missing_info";
  };
  researchDealIds: string[];
  customWorkflow: {
    enabled: boolean;
    workflowId: string | null;
    input: string;
  };
  quickLookup: {
    enabled: boolean;
    query: string;
  };
  useSimilarCompanies: boolean;
  useCriteria: boolean;
  useMatrix: boolean;
  matrixColumnIds: string[];
  matrixColumnsToCreate: MatrixColumnDraft[];
  missingInfoBehavior: "answer_unknown" | "research" | "ask_clarifying";
};

const UPDATE_TARGETS: UpdateTarget[] = [
  "deal.company_name",
  "deal.website",
  "deal.crm_stage",
  "makeup.general_description",
  "makeup.general_education_history",
  "makeup.general_work_background",
  "origin.general_description",
  "traction.revenue_data",
  "traction.customer_size_and_count",
  "traction.growth_trends_description",
  "traction.company_stage",
  "traction.product_stage",
  "problem.general_problem_description",
  "problem.urgency",
  "problem.current_cost_for_customers",
  "problem.tam",
  "problem.sam",
  "problem.som",
  "solution.general_description",
  "solution.cost_to_customer_to_buy_product",
  "solution.solution_price_for_company",
  "solution.price_per_customer_build_and_serve",
  "solution.novelty_or_uniqueness",
  "solution.defensibility",
  "solution.timeline_description",
  "negative.negative_aspects",
];

const STAGES = new Set(["screened", "in_process", "invested", "passed"]);

function safeMeta(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function companyName(deal: DealRow): string {
  const meta = safeMeta(deal.metadata);
  return typeof meta.company_name === "string" && meta.company_name.trim()
    ? meta.company_name.trim()
    : "Untitled company";
}

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function cleanAssistantResponse(text: string): string {
  return stripMarkdownText(text)
    .replace(/^I could not produce a response\.\s*/i, "")
    .replace(/\bI am creating research plans for ([^.\n,]+), ([^.\n]+)\./g, "I'm starting research for $1 and $2.")
    .replace(/\bI am creating a research plan for ([^.\n]+)\./g, "I'm starting research for $1.")
    .trim();
}

function titleCaseName(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function extractUserNameFromText(text: string): string | null {
  const candidates = [
    /\bmy name is\s+([a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,2})\b/i,
    /\byou can call me\s+([a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,2})\b/i,
    /\bi am\s+([a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,2})\b/i,
    /\bi'm\s+([a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,2})\b/i,
  ];
  const blocked = new Set([
    "asking",
    "curious",
    "looking",
    "not",
    "trying",
    "the",
    "working",
  ]);
  for (const pattern of candidates) {
    const match = text.match(pattern);
    const raw = match?.[1]?.trim();
    if (!raw) continue;
    const normalized = normalizeText(raw);
    if (!normalized || blocked.has(normalized.split(" ")[0])) continue;
    return titleCaseName(raw);
  }
  return null;
}

function inferUserNameFromHistory(history: ChatMessage[]): string | null {
  for (const item of [...history].reverse()) {
    if (item.role !== "user") continue;
    const name = extractUserNameFromText(item.content);
    if (name) return name;
  }
  return null;
}

function answerPersonalUserQuestion(message: string, history: ChatMessage[]): string | null {
  const q = normalizeText(message);
  const asksName =
    q.includes("what is my name") ||
    q.includes("whats my name") ||
    q.includes("what s my name") ||
    q.includes("do you know my name") ||
    q.includes("remember my name");
  const asksIdentity = q === "who am i" || q.includes("who am i ") || q.includes("what do you know about me");
  if (!asksName && !asksIdentity) return null;

  const name = inferUserNameFromHistory(history);
  if (name && asksName) return `You told me your name is ${name}.`;
  if (name) return `You are ${name}, the person using this VC workspace.`;
  return "I don't know your name yet. I can see your workspace data, but I should not infer your identity from people mentioned inside company records.";
}

function hrefForDocument(documentId: string, sourceKind?: string | null): string {
  return sourceKind === "research_step_output"
    ? `/home/research-documents/${documentId}`
    : `/home/documents/${documentId}`;
}

async function loadDealForUser(
  admin: SupabaseClient,
  userId: string,
  dealId: string,
): Promise<DealRow | null> {
  const res = await admin
    .schema("deal_intel")
    .from("deal")
    .select("id, metadata")
    .eq("id", dealId)
    .eq("user_id", userId)
    .maybeSingle();
  if (res.error) throw res.error;
  return (res.data as DealRow | null) ?? null;
}

export async function listChatDeals(admin: SupabaseClient, userId: string): Promise<Array<{ id: string; name: string }>> {
  const res = await admin
    .schema("deal_intel")
    .from("deal")
    .select("id, metadata")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(80);
  if (res.error) throw res.error;
  return ((res.data ?? []) as DealRow[]).map((d) => ({ id: d.id, name: companyName(d) }));
}

async function loadDocumentTypes(admin: SupabaseClient, userId: string): Promise<DocumentTypeSummary[]> {
  const res = await admin
    .schema("deal_intel")
    .from("document_generation_type")
    .select("id, name, output_format, description, instructions, learned_preferences, updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(40);
  if (res.error) return [];
  return (res.data ?? []) as DocumentTypeSummary[];
}

async function resolveDeal(
  admin: SupabaseClient,
  userId: string,
  dealId: string | null,
  message: string,
): Promise<DealRow | null> {
  if (dealId) return loadDealForUser(admin, userId, dealId);
  const deals = await listChatDeals(admin, userId);
  const msg = normalizeText(message);
  const matched = deals.find((d) => d.name.length >= 2 && msg.includes(normalizeText(d.name)));
  return matched ? loadDealForUser(admin, userId, matched.id) : null;
}

function matchDealsFromMessage(deals: Array<{ id: string; name: string }>, message: string): Array<{ id: string; name: string }> {
  const msg = normalizeText(message);
  if (!msg) return [];
  return deals.filter((d) => {
    const name = normalizeText(d.name);
    if (!name || name.length < 2) return false;
    if (msg.includes(name)) return true;
    const tokens = name.split(" ").filter((t) => t.length >= 3);
    return tokens.length >= 2 && tokens.every((t) => msg.includes(t));
  });
}

function scoreDocumentType(type: DocumentTypeSummary, message: string, hint: string | null): number {
  const hay = normalizeText(
    `${type.name} ${type.output_format ?? ""} ${type.description ?? ""} ${type.instructions ?? ""} ${type.learned_preferences ?? ""}`,
  );
  const query = normalizeText(`${hint ?? ""} ${message}`);
  if (!hay || !query) return 0;
  let score = 0;
  if (hint && hay.includes(normalizeText(hint))) score += 10;
  if (query.includes(normalizeText(type.name))) score += 8;
  const tokens = query.split(" ").filter((t) => t.length >= 4);
  for (const t of tokens) if (hay.includes(t)) score += 1;
  return score;
}

function pickDocumentType(types: DocumentTypeSummary[], message: string, hint: string | null): DocumentTypeSummary | null {
  const scored = types
    .map((type) => ({ type, score: scoreDocumentType(type, message, hint) }))
    .sort((a, b) => b.score - a.score);
  return scored[0]?.score ? scored[0].type : null;
}

function documentLikelyNeedsCompany(type: DocumentTypeSummary, message: string): boolean {
  const text = normalizeText(`${type.name} ${type.description ?? ""} ${message}`);
  return /\b(memo|report|analysis|profile|brief|company|competitor|investment|ic|diligence)\b/.test(text);
}

function titleFromDocumentHint(hint: string | null): string {
  if (!hint) return "Document";
  return hint
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function loadDocuments(
  admin: SupabaseClient,
  userId: string,
  dealId: string | null,
): Promise<DocumentRow[]> {
  let q = admin
    .schema("deal_intel")
    .from("document")
    .select("id, original_filename, folder_path, source_kind, mime_type, status, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(80);
  if (dealId) q = q.eq("deal_id", dealId);
  const res = await q;
  if (res.error) return [];
  return (res.data ?? []) as DocumentRow[];
}

function pickDocuments(docs: DocumentRow[], query: string, limit = 5): DocumentRow[] {
  const q = normalizeText(query);
  if (!q) return docs.slice(0, limit);
  const qTokens = new Set(q.split(/\s+/).filter((t) => t.length >= 3));
  const scored = docs.map((d) => {
    const hay = normalizeText(`${d.original_filename ?? ""} ${d.folder_path ?? ""} ${d.source_kind ?? ""}`);
    let score = hay.includes(q) ? 8 : 0;
    for (const t of qTokens) if (hay.includes(t)) score += 1;
    return { d, score };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.d);
}

async function retrieveDocumentChunks(
  admin: SupabaseClient,
  args: { userId: string; queryText: string; dealId: string | null; limit?: number },
): Promise<Array<{ document_id: string; page_start: number; page_end: number; text: string; score: number }>> {
  const limit = args.limit ?? 8;
  const queryText = args.queryText.trim();
  if (!queryText) return [];

  const fts = await admin.rpc("deal_intel_match_document_chunks_fts", {
    p_user_id: args.userId,
    p_query: queryText.slice(0, 500),
    p_match_count: limit,
    p_deal_id: args.dealId,
  });
  const ftsRows = fts.error ? [] : ((fts.data ?? []) as Array<{
    document_id: string;
    page_start: number;
    page_end: number;
    text: string;
    score: number;
  }>);

  let vectorRows: typeof ftsRows = [];
  try {
    const emb = await embedText(queryText.slice(0, 8000));
    const vec = await admin.rpc("deal_intel_match_document_chunks_vector", {
      p_user_id: args.userId,
      p_query_embedding: vectorParam(emb),
      p_match_count: limit,
      p_deal_id: args.dealId,
    });
    if (!vec.error) {
      vectorRows = ((vec.data ?? []) as Array<{
        document_id: string;
        page_start: number;
        page_end: number;
        text: string;
        similarity: number;
      }>).map((r) => ({ ...r, score: r.similarity ?? 0 }));
    }
  } catch {
    vectorRows = [];
  }

  const byKey = new Map<string, (typeof ftsRows)[number]>();
  for (const r of [...vectorRows, ...ftsRows]) {
    const key = `${r.document_id}:${r.page_start}:${r.page_end}:${r.text.slice(0, 80)}`;
    const prev = byKey.get(key);
    if (!prev || Number(r.score ?? 0) > Number(prev.score ?? 0)) byKey.set(key, r);
  }
  return [...byKey.values()].sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0)).slice(0, limit);
}

async function loadDealSnapshot(admin: SupabaseClient, dealId: string | null): Promise<Record<string, unknown>> {
  if (!dealId) return {};
  const di = admin.schema("deal_intel");
  const [problem, solution, traction, people] = await Promise.all([
    di.from("company_problem").select("*").eq("deal_id", dealId).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    di.from("company_solution").select("*").eq("deal_id", dealId).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    di.from("company_traction").select("*").eq("deal_id", dealId).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    di
      .from("company_person")
      .select("name, person_kind, company_role, general_description, relevant_achievements")
      .eq("deal_id", dealId)
      .order("created_at", { ascending: false })
      .limit(10),
  ]);
  return {
    problem: problem.data ?? null,
    solution: solution.data ?? null,
    traction: traction.data ?? null,
    people: people.data ?? [],
  };
}

function parseRouteUpdates(raw: unknown): PlannedUpdate[] {
  if (!Array.isArray(raw)) return [];
  const updates: PlannedUpdate[] = [];
  for (const u of raw) {
    const o = u && typeof u === "object" ? (u as Record<string, unknown>) : {};
    const target = String(o.target ?? "") as UpdateTarget;
    const value = typeof o.value === "string" ? o.value.trim() : "";
    if (!UPDATE_TARGETS.includes(target) || !value) continue;
    if (target === "deal.crm_stage" && !STAGES.has(value)) continue;
    updates.push({ target, value: value.slice(0, 1200) });
    if (updates.length >= 8) break;
  }
  return updates;
}

function asRouteTask(value: unknown): ChatRoutePlan["chatTask"] {
  const v = typeof value === "string" ? value : "";
  return v === "similar_deal" || v === "filtering" || v === "deep_reasoning" || v === "why" || v === "questions"
    ? v
    : "deep_reasoning";
}

function asMatrixDataType(value: unknown): MatrixColumn["data_type"] {
  return value === "number" || value === "percent" || value === "currency" || value === "boolean" || value === "json"
    ? value
    : "text";
}

function parseMatrixColumnsToCreate(raw: unknown, existingColumns: Array<{ label: string }>): MatrixColumnDraft[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set(existingColumns.map((column) => normalizeText(column.label)).filter(Boolean));
  const out: MatrixColumnDraft[] = [];
  for (const item of raw) {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const label = stripMarkdownText(typeof record.label === "string" ? record.label : "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    if (!label) continue;
    const key = normalizeText(label);
    if (!key || seen.has(key)) continue;
    const description = stripMarkdownText(typeof record.description === "string" ? record.description : "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1200);
    const prompt = stripMarkdownText(typeof record.prompt === "string" ? record.prompt : "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 2000);
    seen.add(key);
    out.push({
      label,
      description,
      dataType: asMatrixDataType(record.dataType ?? record.data_type),
      prompt: prompt || description || `Fill the ${label} field for this company using the user's matrix request as the scope.`,
      researchEnabled: record.researchEnabled !== false,
    });
    if (out.length >= 4) break;
  }
  return out;
}

function matrixDraftKey(column: Pick<MatrixColumnDraft, "label">): string {
  return normalizeText(column.label);
}

function mergeMatrixDrafts(existing: MatrixColumnDraft[], extra: MatrixColumnDraft[], matrixColumns: Array<{ label: string }>): MatrixColumnDraft[] {
  const seen = new Set(matrixColumns.map((column) => normalizeText(column.label)).filter(Boolean));
  const out: MatrixColumnDraft[] = [];
  for (const column of [...existing, ...extra]) {
    const key = matrixDraftKey(column);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(column);
    if (out.length >= 8) break;
  }
  return out;
}

function existingMatrixColumnIdsForDrafts(drafts: MatrixColumnDraft[], matrixColumns: Array<{ id: string; label: string; description: string; prompt: string }>): string[] {
  const ids: string[] = [];
  for (const draft of drafts) {
    const key = matrixDraftKey(draft);
    if (!key) continue;
    const match = matrixColumns.find((column) => {
      const columnText = normalizeText(`${column.label} ${column.description} ${column.prompt}`);
      return columnText.includes(key) || key.includes(normalizeText(column.label));
    });
    if (match && !ids.includes(match.id)) ids.push(match.id);
  }
  return ids;
}

function addMatrixDraft(drafts: MatrixColumnDraft[], draft: MatrixColumnDraft) {
  const key = matrixDraftKey(draft);
  if (!key || drafts.some((item) => matrixDraftKey(item) === key)) return;
  drafts.push(draft);
}

function inferDocumentTypeHint(message: string): string | null {
  const lower = message.toLowerCase();
  const pairs: Array<[RegExp, string]> = [
    [/\b(ic|investment committee)\s+memo\b/, "investment memo"],
    [/\binvestment\s+memo\b/, "investment memo"],
    [/\bmemo\b/, "memo"],
    [/\b(notes?|meeting notes|call notes)\b/, "notes"],
    [/\bbrief\b/, "brief"],
    [/\breport\b/, "report"],
    [/\bemail\b/, "email"],
    [/\bsummary\b/, "summary"],
    [/\bteaser\b/, "teaser"],
    [/\bone[- ]?pager\b/, "one pager"],
  ];
  for (const [regex, hint] of pairs) {
    if (regex.test(lower)) return hint;
  }
  return null;
}

function inferMatrixDraftsFromMessage(message: string, dealNames: string[]): MatrixColumnDraft[] {
  const lower = message.toLowerCase();
  const peerText = dealNames.length > 1 ? `Peer companies named in the request: ${dealNames.join(", ")}.` : "";
  const drafts: MatrixColumnDraft[] = [];
  const hasCommonInvestor = /\b(common|shared|overlap(?:ping)?)\s+(?:institutional\s+)?(?:investors?|backers?)\b|\binvestor\s+overlap\b/.test(lower);
  const hasAmount = /\b(amount|how much|specific amount|check size|cheque size|capital|invested|investment amount|round size|money)\b/.test(lower);

  if (hasCommonInvestor) {
    addMatrixDraft(drafts, {
      label: "Common investors",
      description: "Investors shared with the peer companies named in the request.",
      dataType: "text",
      prompt: [
        "Identify investors shared between this company and the peer companies named in the user's request.",
        peerText,
        "Return investor names only when evidence supports the overlap. Include uncertainty if investor lists are incomplete.",
      ].filter(Boolean).join(" "),
      researchEnabled: true,
    });
  }
  if (hasAmount && hasCommonInvestor) {
    addMatrixDraft(drafts, {
      label: "Shared investor amount",
      description: "Amount invested by the shared or overlapping investors, by company or round when available.",
      dataType: "text",
      prompt: [
        "For investors shared between this company and the peer companies named in the user's request, find the specific amount invested in this company when available.",
        peerText,
        "If exact investor-level allocation is unavailable, provide the relevant round amount and clearly say the investor-level amount was not disclosed.",
      ].filter(Boolean).join(" "),
      researchEnabled: true,
    });
  } else if (hasAmount && /\b(funding|investor|round|raised|capital)\b/.test(lower)) {
    addMatrixDraft(drafts, {
      label: "Funding amount",
      description: "Relevant capital raised or investment amount requested by the user.",
      dataType: "text",
      prompt: "Find the funding or investment amount requested by the user for this company. Preserve round names, dates, and uncertainty.",
      researchEnabled: true,
    });
  }
  if (/\bcompetitors?|alternatives?|similar products?|substitutes?\b/.test(lower)) {
    addMatrixDraft(drafts, {
      label: "Relevant competitors",
      description: "Competitors or similar products requested by the user.",
      dataType: "text",
      prompt: "Identify competitors, alternatives, or similar products specifically relevant to the user's request. Do not add broad market landscape details unless asked.",
      researchEnabled: true,
    });
  }
  if (/\bpatents?|ip|intellectual property|filings?\b/.test(lower)) {
    addMatrixDraft(drafts, {
      label: "Patent or IP evidence",
      description: "Patent, filing, or IP evidence requested by the user.",
      dataType: "text",
      prompt: "Find patent, filing, or intellectual property evidence that directly answers the user's request. Distinguish company-owned IP from founder or prior-employer patents.",
      researchEnabled: true,
    });
  }
  return drafts.slice(0, 8);
}

const MATRIX_INTENT_RE = /\b(matrix|table|tabular|side[- ]?by[- ]?side|rows?|columns?|compare(?:\s+in|\s+as)?\s+(?:a\s+)?(?:matrix|table)|company\s+vs\s+company)\b/i;
const DOCUMENT_INTENT_RE = /\b(write|draft|generate|create|make|prepare|produce)\b.{0,80}\b(document|doc|memo|notes?|brief|report|email|one[- ]?pager|summary)\b|\b(ic|investment committee|investment)\s+memo\b/i;
const RESEARCH_INTENT_RE = /\b(research|look into|investigate|find out|dig into|web search|search the web|deep dive|competitors?|patents?|common investors?|shared investors?)\b/i;
const EXPLICIT_RESEARCH_INTENT_RE = /\b(research|look into|investigate|find out|dig into|web search|search the web|deep dive)\b/i;
const WORKFLOW_INTENT_RE = /\b(workflow|playbook|process|run the saved|run saved)\b/i;

function taskClauses(message: string): string[] {
  const split = message
    .replace(/\b(?:and\s+)?(?:also|then|separately|plus)\b/gi, "\n")
    .replace(/\band\s+(?=(?:make|create|build|generate|fill|update|draft|write|research|look|investigate|find)\b)/gi, "\n")
    .split(/[\n.;]+/g)
    .map((part) => part.trim())
    .filter(Boolean);
  return split.length ? split : [message.trim()].filter(Boolean);
}

function focusedSegment(message: string, re: RegExp): string {
  const matches = taskClauses(message).filter((part) => re.test(part));
  return matches.length ? matches.join(". ") : message;
}

function buildToolPrecheck(args: {
  message: string;
  focusDeal: DealRow | null;
  allDeals: Array<{ id: string; name: string }>;
}): ToolPrecheck {
  const researchFocus = focusedSegment(args.message, RESEARCH_INTENT_RE).slice(0, 1800);
  const matrixFocus = focusedSegment(args.message, MATRIX_INTENT_RE).slice(0, 1800);
  const documentFocus = focusedSegment(args.message, DOCUMENT_INTENT_RE).slice(0, 1800);
  const clauses = taskClauses(args.message);
  const mentionedDeals = matchDealsFromMessage(args.allDeals, args.message);
  const researchMentionedDeals = matchDealsFromMessage(args.allDeals, researchFocus);
  const targetDealIds = (mentionedDeals.length ? mentionedDeals.map((deal) => deal.id) : args.focusDeal?.id ? [args.focusDeal.id] : []).slice(0, 8);
  const targetDealNames = targetDealIds
    .map((id) => args.allDeals.find((deal) => deal.id === id)?.name)
    .filter((name): name is string => Boolean(name));
  const wantsMatrix = MATRIX_INTENT_RE.test(args.message);
  const docTypeHint = inferDocumentTypeHint(args.message);
  const wantsDocument = Boolean(docTypeHint) || DOCUMENT_INTENT_RE.test(args.message);
  const standaloneResearchClauses = clauses.filter(
    (clause) => RESEARCH_INTENT_RE.test(clause) && !MATRIX_INTENT_RE.test(clause) && !DOCUMENT_INTENT_RE.test(clause),
  );
  const wantsResearch =
    standaloneResearchClauses.some((clause) => EXPLICIT_RESEARCH_INTENT_RE.test(clause)) ||
    (!wantsDocument && !wantsMatrix && standaloneResearchClauses.some((clause) => RESEARCH_INTENT_RE.test(clause)));
  const wantsWorkflow = WORKFLOW_INTENT_RE.test(args.message);
  const matrixColumnsToCreate = wantsMatrix ? inferMatrixDraftsFromMessage(matrixFocus, targetDealNames) : [];
  const researchDealIds = wantsResearch
    ? (researchMentionedDeals.length ? researchMentionedDeals.map((deal) => deal.id) : targetDealIds).filter((id) => {
        const name = args.allDeals.find((deal) => deal.id === id)?.name.toLowerCase() ?? "";
        if (!name) return true;
        const around = researchFocus.toLowerCase().slice(Math.max(0, researchFocus.toLowerCase().indexOf(name) - 80), researchFocus.toLowerCase().indexOf(name) + name.length + 120);
        return !/\b(matrix row|row|peer reference|common[- ]investor counterpart|benchmark row)\b/.test(around);
      })
    : [];
  const evidence = [
    wantsMatrix ? "matrix/table keyword" : "",
    wantsDocument ? `document keyword${docTypeHint ? `: ${docTypeHint}` : ""}` : "",
    wantsResearch ? "research keyword" : "",
    wantsWorkflow ? "workflow keyword" : "",
    matrixColumnsToCreate.length ? `matrix fields: ${matrixColumnsToCreate.map((column) => column.label).join(", ")}` : "",
  ].filter(Boolean);
  return {
    wantsMatrix,
    wantsDocument,
    wantsResearch,
    wantsWorkflow,
    documentTypeHint: docTypeHint,
    targetDealIds,
    researchDealIds,
    matrixColumnsToCreate,
    researchFocus: researchFocus || args.message,
    matrixFocus: matrixFocus || args.message,
    documentFocus: documentFocus || args.message,
    evidence,
  };
}

function targetDealsFromPlan(
  allDeals: Array<{ id: string; name: string }>,
  focusDeal: DealRow | null,
  rawIds: unknown,
): string[] {
  const allowed = new Set(allDeals.map((d) => d.id));
  const out = new Set<string>();
  if (Array.isArray(rawIds)) {
    for (const id of rawIds) {
      if (typeof id === "string" && allowed.has(id)) out.add(id);
    }
  }
  if (!out.size && focusDeal?.id) out.add(focusDeal.id);
  return [...out].slice(0, 8);
}

function dealIdsFromRaw(allDeals: Array<{ id: string; name: string }>, rawIds: unknown): string[] {
  const allowed = new Set(allDeals.map((d) => d.id));
  const out: string[] = [];
  if (!Array.isArray(rawIds)) return out;
  for (const id of rawIds) {
    if (typeof id !== "string" || !allowed.has(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= 8) break;
  }
  return out;
}

function fallbackRoutePlan(args: {
  message: string;
  focusDeal: DealRow | null;
  allDeals: Array<{ id: string; name: string }>;
  chatTask: ChatRoutePlan["chatTask"];
}): ChatRoutePlan {
  const matchedDeals = matchDealsFromMessage(args.allDeals, args.message);
  const targetDealIds = args.focusDeal?.id
    ? [args.focusDeal.id]
    : matchedDeals.map((d) => d.id).slice(0, 4);
  return {
    chatTask: args.chatTask,
    scope: args.focusDeal ? "focused_company" : targetDealIds.length > 1 ? "cross_company" : "workspace",
    answerPersonal: false,
    targetDealIds,
    openDocumentQuery: null,
    createCompany: null,
    updates: [],
    generateDocument: { enabled: false, prompt: args.message, typeHint: null },
    runResearch: { enabled: false, focus: args.message, when: "now" },
    researchDealIds: [],
    customWorkflow: { enabled: false, workflowId: null, input: args.message },
    quickLookup: { enabled: false, query: args.message },
    useSimilarCompanies: args.chatTask === "similar_deal",
    useCriteria: false,
    useMatrix: false,
    matrixColumnIds: [],
    matrixColumnsToCreate: [],
    missingInfoBehavior: "answer_unknown",
  };
}

function mergeIds(primary: string[], extra: string[], allowed: Set<string>, limit = 8): string[] {
  const out: string[] = [];
  for (const id of [...primary, ...extra]) {
    if (!allowed.has(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}

function applyToolPrecheck(args: {
  plan: ChatRoutePlan;
  precheck: ToolPrecheck;
  permissions: ChatToolPermissions;
  allDeals: Array<{ id: string; name: string }>;
  matrixColumns: Array<{ id: string; label: string; description: string; prompt: string }>;
  message: string;
}): ChatRoutePlan {
  const allowedDeals = new Set(args.allDeals.map((deal) => deal.id));
  const targetDealIds = mergeIds(args.plan.targetDealIds, args.precheck.targetDealIds, allowedDeals);
  const plan: ChatRoutePlan = {
    ...args.plan,
    targetDealIds,
    generateDocument: { ...args.plan.generateDocument },
    runResearch: { ...args.plan.runResearch },
    researchDealIds: mergeIds(args.plan.researchDealIds, [], allowedDeals),
    customWorkflow: { ...args.plan.customWorkflow },
    quickLookup: { ...args.plan.quickLookup },
    matrixColumnIds: [...args.plan.matrixColumnIds],
    matrixColumnsToCreate: [...args.plan.matrixColumnsToCreate],
  };

  if (args.precheck.wantsDocument && args.permissions.generateDocuments) {
    plan.generateDocument.enabled = true;
    plan.generateDocument.prompt = args.precheck.documentFocus || plan.generateDocument.prompt || args.message;
    plan.generateDocument.typeHint = plan.generateDocument.typeHint || args.precheck.documentTypeHint;

    if (!args.precheck.wantsResearch) {
      plan.runResearch.enabled = false;
      plan.quickLookup.enabled = false;
      plan.missingInfoBehavior = "answer_unknown";
    }
  }

  if (args.precheck.wantsResearch && args.permissions.runResearch) {
    plan.runResearch.enabled = true;
    plan.runResearch.when = "now";
    plan.runResearch.focus = args.precheck.researchFocus || plan.runResearch.focus || args.message;
    const precheckResearchIds = args.precheck.researchDealIds.length
      ? args.precheck.researchDealIds
      : args.precheck.targetDealIds;
    plan.researchDealIds = mergeIds(plan.researchDealIds, precheckResearchIds, allowedDeals);
  }

  if (args.precheck.wantsMatrix && args.permissions.useMatrix) {
    plan.useMatrix = true;
    plan.targetDealIds = mergeIds(plan.targetDealIds, args.precheck.targetDealIds, allowedDeals);
    plan.matrixColumnIds = mergeIds(
      plan.matrixColumnIds,
      existingMatrixColumnIdsForDrafts(args.precheck.matrixColumnsToCreate, args.matrixColumns),
      new Set(args.matrixColumns.map((column) => column.id)),
    );
    plan.matrixColumnsToCreate = mergeMatrixDrafts(
      plan.matrixColumnsToCreate,
      args.precheck.matrixColumnsToCreate,
      args.matrixColumns,
    );
  }

  if (args.precheck.wantsWorkflow && args.permissions.runWorkflows && !plan.customWorkflow.enabled) {
    plan.customWorkflow.input = plan.customWorkflow.input || args.message;
  }

  return plan;
}

async function planSmartChatRoute(args: {
  message: string;
  history: ChatMessage[];
  focusDeal: DealRow | null;
  allDeals: Array<{ id: string; name: string }>;
  docTypes: DocumentTypeSummary[];
  customWorkflows: CustomWorkflowDefinition[];
  matrixColumns: Array<{ id: string; label: string; description: string; prompt: string }>;
  preferenceContext: string;
  permissions: ChatToolPermissions;
  fallbackTask: ChatRoutePlan["chatTask"];
}): Promise<ChatRoutePlan> {
  const focusName = args.focusDeal ? companyName(args.focusDeal) : null;
  const precheck = buildToolPrecheck({
    message: args.message,
    focusDeal: args.focusDeal,
    allDeals: args.allDeals,
  });
  const prompt = `You are the tool router for a VC workspace chat assistant.

Route every request through the canonical Deal Intel mental model. Prefer tools and context that fill, verify, update, or explain these buckets:
${DEAL_INTEL_RESEARCH_FOCUS_GUIDE}

${USER_PREFERENCE_GUARDRAILS}

Dynamic user preference, thesis, and criteria context:
${args.preferenceContext || "(none)"}

Deterministic precheck from cheap keyword and regex scans:
${JSON.stringify(precheck, null, 2)}

Return strict JSON only:
{
  "chatTask": "filtering" | "similar_deal" | "deep_reasoning" | "why" | "questions",
  "scope": "focused_company" | "workspace" | "cross_company",
  "answerPersonal": boolean,
  "targetDealIds": string[],
  "openDocumentQuery": string | null,
  "createCompany": { "company_name": string, "website": string | null, "crm_stage": "screened" | "in_process" | "invested" | "passed" } | null,
  "updates": [{ "target": ${UPDATE_TARGETS.map((x) => `"${x}"`).join(" | ")}, "value": string }],
  "generateDocument": { "enabled": boolean, "prompt": string, "typeHint": string | null },
  "runResearch": { "enabled": boolean, "focus": string, "when": "now" | "if_missing_info" },
  "researchDealIds": string[],
  "customWorkflow": { "enabled": boolean, "workflowId": string | null, "input": string },
  "quickLookup": { "enabled": boolean, "query": string },
  "useSimilarCompanies": boolean,
  "useCriteria": boolean,
  "useMatrix": boolean,
  "matrixColumnIds": string[],
  "matrixColumnsToCreate": [{ "label": string, "description": string, "dataType": "text" | "number" | "percent" | "currency" | "boolean" | "json", "prompt": string, "researchEnabled": boolean }],
  "missingInfoBehavior": "answer_unknown" | "research" | "ask_clarifying"
}

Reasoning rules:
- Prefer the focused company when one is selected. Use cross_company only when the user explicitly asks for comps, competitors, comparisons, benchmarks, portfolio-wide views, or multiple named companies.
- If the user asks about "my name", "me", or who they are, set answerPersonal true and do not use company context.
- Use targetDealIds only from the provided deal list. If a selected company exists and the request does not clearly name another company or ask cross-company work, include only that selected deal id.
- Use openDocumentQuery when the user asks to open, show, view, or find saved documents/files/decks.
- Use updates only when the user explicitly asks to save, update, edit, record, change, or add facts to a company record.
- Use createCompany only when the user explicitly asks to add/create/save a new company and gives a concrete company name.
- Use generateDocument when the user wants a memo, report, brief, analysis document, email, or other generated deliverable.
- Use quickLookup for one-off factual/current-public-web questions that likely need only one search, such as current CEO, latest funding round, headquarters, recent news, a single metric, or a simple verification. quickLookup answers directly; it does not create a research workflow.
- Use runResearch for broader or multi-step diligence, such as building a research plan, funding history, competitor landscape, customer evidence, founder background, market sizing, or any task that needs several searches/sources/subquestions. Use when="if_missing_info" only when the saved focused-company context may be insufficient and a fuller workflow is the right next step.
- Use researchDealIds for the companies that actually need research. If another named company is only a matrix row, benchmark row, peer reference, or common-investor counterpart, include it in targetDealIds for matrix/comparison work but leave it out of researchDealIds unless the user explicitly asks to research that company too.
- When runResearch.enabled is true, researchDealIds should normally be non-empty and narrower than targetDealIds when some target companies are only needed for matrix output.
- If the user asks for missing schema coverage, evidence quality, negatives, or "what do we know", prefer the schema buckets above when choosing answer vs research vs update.
- Use customWorkflow when the user asks to run a saved/reusable workflow, playbook, process, or their request clearly matches one workflow's name, description, or step instructions. Choose exactly one workflow id only when the match is clear. If multiple workflows plausibly match, leave customWorkflow disabled and ask which workflow to run by name.
- Do not set both quickLookup and runResearch unless the user asks for a direct answer now plus deeper follow-up research.
- When the user explicitly asks for multiple outputs or tools in one prompt, set every requested tool field. For example, research plus a matrix should run research and fill the matrix; a workflow plus a document should run both if both are requested.
- Tools are not mutually exclusive. If the user explicitly asks for workflow, document, research, matrix, database-backed lookup, or analysis outputs in the same prompt, return all requested tool actions. Avoid only exact duplicate tool work.
- Use useSimilarCompanies for similar companies, comps, peers, comparables, or competitor benchmarking.
- Use useCriteria for thesis fit, uploaded criteria, investment evaluation, scoring, pass/invest reasoning, or criteria-based analysis.
- Use useMatrix when the user asks for a company-vs-company, side-by-side, tabular, row/column, benchmark, or matrix-style comparison across saved companies. Select matrixColumnIds only from Available matrix columns, and only when those columns directly match the requested comparison fields.
- If useMatrix is true and the requested fields do not already exist as matrixColumnIds, create 1-4 focused matrixColumnsToCreate. Each new column must map directly to a requested comparison field, include any peer companies needed for cross-company logic, and avoid broad diligence columns.
- A matrix request is an output/tool request. It should not expand research scope beyond the fields named by the user.
- Treat the deterministic precheck as a floor, not the whole answer. You may add nuance, but do not drop an explicit matrix, document, research, or workflow request found by the precheck unless the related permission is disabled.
- If the precheck names requested matrix fields, include those exact fields either as existing matrixColumnIds or as matrixColumnsToCreate. Do not move a requested matrix field into chat text only.
- Respect disabled permissions by setting the related tool field false/null.
- If no tool is needed, leave tools disabled and answer from context.

Permissions:
${JSON.stringify(args.permissions)}

Focused company:
${focusName ? `${focusName} (${args.focusDeal!.id})` : "(none)"}

Available deals:
${args.allDeals.map((d) => `- ${d.name} (${d.id})`).join("\n").slice(0, 6000) || "(none)"}

Document types:
${args.docTypes.map((d) => `- ${d.name} (${d.id}) format=${d.output_format ?? "unknown"} description=${d.description ?? ""}`).join("\n").slice(0, 4000) || "(none)"}

Available workflows:
${args.customWorkflows.map((w) => {
  const steps = w.steps.map((s, i) => {
    const prompt =
      "prompt" in s && typeof s.prompt === "string"
        ? s.prompt
        : s.type === "record_update"
          ? `${s.target}: ${s.value}`
          : "";
    return `${i + 1}. ${s.type}: ${s.title}${prompt ? ` - ${prompt.slice(0, 180)}` : ""}`;
  }).join("; ");
  return `- ${w.name} (${w.id}) description=${w.description || ""} steps=${steps}`;
}).join("\n").slice(0, 5000) || "(none)"}

Available matrix columns:
${args.matrixColumns.map((c) => `- ${c.label} (${c.id}) description=${c.description || ""} prompt=${c.prompt || ""}`).join("\n").slice(0, 5000) || "(none)"}

Recent chat:
${args.history.slice(-6).map((m) => `${m.role}: ${m.content.slice(0, 500)}`).join("\n") || "(none)"}

User message:
${args.message.slice(0, 4000)}`;

  try {
    const raw = await vertexRunWithText(process.env.GEMINI_MODEL_FLASH_LITE || "gemini-2.5-flash-lite", prompt, false);
    const parsed = (parseJsonFromResponseOrNull(raw) ?? (await parseJsonFromResponseWithRepair(raw))) as Record<string, unknown> | null;
    const scopeRaw = typeof parsed?.scope === "string" ? parsed.scope : "";
    const scope: ChatRoutePlan["scope"] =
      scopeRaw === "focused_company" || scopeRaw === "workspace" || scopeRaw === "cross_company"
        ? scopeRaw
        : args.focusDeal
          ? "focused_company"
          : "workspace";
    const createRaw = parsed?.createCompany && typeof parsed.createCompany === "object"
      ? parsed.createCompany as Record<string, unknown>
      : null;
    const companyNameRaw = typeof createRaw?.company_name === "string" ? createRaw.company_name.trim().slice(0, 160) : "";
    const stageRaw = typeof createRaw?.crm_stage === "string" ? createRaw.crm_stage : "screened";
    const crmStage = STAGES.has(stageRaw) ? stageRaw as "screened" | "in_process" | "invested" | "passed" : "screened";
    const generateRaw = parsed?.generateDocument && typeof parsed.generateDocument === "object"
      ? parsed.generateDocument as Record<string, unknown>
      : {};
    const researchRaw = parsed?.runResearch && typeof parsed.runResearch === "object"
      ? parsed.runResearch as Record<string, unknown>
      : {};
    const workflowRaw = parsed?.customWorkflow && typeof parsed.customWorkflow === "object"
      ? parsed.customWorkflow as Record<string, unknown>
      : {};
    const lookupRaw = parsed?.quickLookup && typeof parsed.quickLookup === "object"
      ? parsed.quickLookup as Record<string, unknown>
      : {};
    const missingRaw = typeof parsed?.missingInfoBehavior === "string" ? parsed.missingInfoBehavior : "";
    const whenRaw = typeof researchRaw.when === "string" ? researchRaw.when : "now";
    const workflowIdRaw = typeof workflowRaw.workflowId === "string" ? workflowRaw.workflowId : "";
    const workflowId = args.customWorkflows.some((w) => w.id === workflowIdRaw) ? workflowIdRaw : null;
    const plan: ChatRoutePlan = {
      chatTask: asRouteTask(parsed?.chatTask ?? args.fallbackTask),
      scope,
      answerPersonal: parsed?.answerPersonal === true,
      targetDealIds: targetDealsFromPlan(args.allDeals, args.focusDeal, parsed?.targetDealIds),
      openDocumentQuery:
        typeof parsed?.openDocumentQuery === "string" && parsed.openDocumentQuery.trim()
          ? parsed.openDocumentQuery.trim().slice(0, 300)
          : null,
      createCompany: companyNameRaw
        ? {
            company_name: companyNameRaw,
            website: typeof createRaw?.website === "string" && createRaw.website.trim() ? createRaw.website.trim().slice(0, 300) : null,
            crm_stage: crmStage,
          }
        : null,
      updates: parseRouteUpdates(parsed?.updates),
      generateDocument: {
        enabled: generateRaw.enabled === true && args.permissions.generateDocuments,
        prompt: typeof generateRaw.prompt === "string" && generateRaw.prompt.trim() ? generateRaw.prompt.trim().slice(0, 2000) : args.message,
        typeHint:
          typeof generateRaw.typeHint === "string" && generateRaw.typeHint.trim()
            ? generateRaw.typeHint.trim().slice(0, 160)
            : null,
      },
      runResearch: {
        enabled: researchRaw.enabled === true && args.permissions.runResearch,
        focus: typeof researchRaw.focus === "string" && researchRaw.focus.trim() ? researchRaw.focus.trim().slice(0, 600) : args.message,
        when: whenRaw === "if_missing_info" ? "if_missing_info" : "now",
      },
      researchDealIds: dealIdsFromRaw(args.allDeals, parsed?.researchDealIds),
      customWorkflow: {
        enabled: workflowRaw.enabled === true && Boolean(workflowId) && args.permissions.runWorkflows,
        workflowId,
        input: typeof workflowRaw.input === "string" && workflowRaw.input.trim() ? workflowRaw.input.trim().slice(0, 2000) : args.message,
      },
      quickLookup: {
        enabled: lookupRaw.enabled === true && args.permissions.runResearch,
        query: typeof lookupRaw.query === "string" && lookupRaw.query.trim() ? lookupRaw.query.trim().slice(0, 600) : args.message,
      },
      useSimilarCompanies: parsed?.useSimilarCompanies === true && args.permissions.useSimilarCompanySearch,
      useCriteria: parsed?.useCriteria === true && args.permissions.useCriteriaAnalysis,
      useMatrix: parsed?.useMatrix === true && args.permissions.useMatrix,
      matrixColumnIds: Array.isArray(parsed?.matrixColumnIds)
        ? parsed.matrixColumnIds.filter((id): id is string => typeof id === "string" && args.matrixColumns.some((c) => c.id === id)).slice(0, 8)
        : [],
      matrixColumnsToCreate: args.permissions.useMatrix
        ? parseMatrixColumnsToCreate(parsed?.matrixColumnsToCreate, args.matrixColumns)
        : [],
      missingInfoBehavior: missingRaw === "research" || missingRaw === "ask_clarifying" ? missingRaw : "answer_unknown",
    };
    return applyToolPrecheck({
      plan,
      precheck,
      permissions: args.permissions,
      allDeals: args.allDeals,
      matrixColumns: args.matrixColumns,
      message: args.message,
    });
  } catch {
    return applyToolPrecheck({
      plan: fallbackRoutePlan({
      message: args.message,
      focusDeal: args.focusDeal,
      allDeals: args.allDeals,
      chatTask: args.fallbackTask,
      }),
      precheck,
      permissions: args.permissions,
      allDeals: args.allDeals,
      matrixColumns: args.matrixColumns,
      message: args.message,
    });
  }
}

async function createCompanyFromChat(
  admin: SupabaseClient,
  args: {
    userId: string;
    companyName: string;
    website: string | null;
    crmStage: "screened" | "in_process" | "invested" | "passed";
  },
): Promise<{ id: string; name: string; created: boolean }> {
  const existing = await listChatDeals(admin, args.userId);
  const match = existing.find((d) => normalizeText(d.name) === normalizeText(args.companyName));
  if (match) return { id: match.id, name: match.name, created: false };

  const res = await admin
    .schema("deal_intel")
    .from("deal")
    .insert({
      user_id: args.userId,
      metadata: {
        company_name: args.companyName,
        website: args.website,
        crm_stage: args.crmStage,
        source: "chat",
      },
    })
    .select("id")
    .single();
  if (res.error) throw res.error;
  return { id: String(res.data.id), name: args.companyName, created: true };
}

export async function applyWorkspaceRecordUpdates(
  admin: SupabaseClient,
  args: { userId: string; deal: DealRow; updates: PlannedUpdate[] },
): Promise<ChatAction[]> {
  if (!args.updates.length) return [];
  const actions: ChatAction[] = [];
  const dealId = args.deal.id;
  const dealUpdates = args.updates.filter((u) => u.target.startsWith("deal."));
  if (dealUpdates.length) {
    const meta = safeMeta(args.deal.metadata);
    for (const u of dealUpdates) {
      const key = u.target.split(".")[1]!;
      meta[key] = u.value;
      actions.push({ type: "record_update", label: "Updated deal record", detail: `${key}: ${u.value}` });
    }
    const res = await admin.schema("deal_intel").from("deal").update({ metadata: meta }).eq("id", dealId).eq("user_id", args.userId);
    if (res.error) throw res.error;
  }

  const tableGroups = new Map<
    "company_traction" | "company_problem" | "company_solution" | "company_makeup" | "company_origin_story" | "company_negative",
    Record<string, string>
  >();
  for (const u of args.updates) {
    if (u.target.startsWith("traction.")) {
      const fields = tableGroups.get("company_traction") ?? {};
      fields[u.target.slice("traction.".length)] = u.value;
      tableGroups.set("company_traction", fields);
    } else if (u.target.startsWith("problem.")) {
      const fields = tableGroups.get("company_problem") ?? {};
      fields[u.target.slice("problem.".length)] = u.value;
      tableGroups.set("company_problem", fields);
    } else if (u.target.startsWith("solution.")) {
      const fields = tableGroups.get("company_solution") ?? {};
      fields[u.target.slice("solution.".length)] = u.value;
      tableGroups.set("company_solution", fields);
    } else if (u.target.startsWith("makeup.")) {
      const fields = tableGroups.get("company_makeup") ?? {};
      fields[u.target.slice("makeup.".length)] = u.value;
      tableGroups.set("company_makeup", fields);
    } else if (u.target.startsWith("origin.")) {
      const fields = tableGroups.get("company_origin_story") ?? {};
      fields[u.target.slice("origin.".length)] = u.value;
      tableGroups.set("company_origin_story", fields);
    } else if (u.target.startsWith("negative.")) {
      const fields = tableGroups.get("company_negative") ?? {};
      fields[u.target.slice("negative.".length)] = u.value;
      tableGroups.set("company_negative", fields);
    }
  }

  for (const [table, fields] of tableGroups) {
    const existing = await admin
      .schema("deal_intel")
      .from(table)
      .select("id")
      .eq("deal_id", dealId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data?.id) {
      const res = await admin.schema("deal_intel").from(table).update(fields).eq("id", String(existing.data.id));
      if (res.error) throw res.error;
    } else {
      const res = await admin.schema("deal_intel").from(table).insert({ deal_id: dealId, ...fields });
      if (res.error) throw res.error;
    }
    for (const [k, v] of Object.entries(fields)) {
      actions.push({ type: "record_update", label: `Updated ${table.replace("company_", "")}`, detail: `${k}: ${v}` });
    }
  }
  return actions;
}

function formatChunks(chunks: ContextChunk[]): string {
  if (!chunks.length) return "";
  return chunks
    .map((c, i) => `[F${i + 1}] deal=${c.deal_id} type=${c.node_type} polarity=${c.polarity}\n${(c.raw_text ?? "").slice(0, 1200)}`)
    .join("\n\n");
}

function formatDocChunks(chunks: Array<{ document_id: string; page_start: number; page_end: number; text: string }>, docs: DocumentRow[]): string {
  if (!chunks.length) return "";
  const docById = new Map(docs.map((d) => [d.id, d]));
  return chunks
    .map((c, i) => {
      const d = docById.get(c.document_id);
      const name = d?.original_filename || c.document_id;
      return `[D${i + 1}] ${name} pp.${c.page_start}-${c.page_end}\n${c.text.slice(0, 1200)}`;
    })
    .join("\n\n");
}

function citationCandidatesFromContext(
  factChunks: ContextChunk[],
  docChunks: Array<{ document_id: string; page_start: number; page_end: number; text: string }>,
  docs: DocumentRow[],
): Array<{ citation: ChatCitation; evidence: string }> {
  const out: Array<{ citation: ChatCitation; evidence: string }> = [];
  for (const [i, c] of factChunks.slice(0, 5).entries()) {
    const evidence = c.raw_text ?? "";
    out.push({
      citation: { label: `Fact ${i + 1}: ${c.node_type}`, snippet: evidence.slice(0, 240) },
      evidence: evidence.slice(0, 1200),
    });
  }
  const docById = new Map(docs.map((d) => [d.id, d]));
  for (const [i, c] of docChunks.slice(0, 5).entries()) {
    const d = docById.get(c.document_id);
    out.push({
      citation: {
        label: `Document ${i + 1}: ${d?.original_filename ?? c.document_id}`,
        href: hrefForDocument(c.document_id, d?.source_kind),
        snippet: c.text.slice(0, 240),
      },
      evidence: c.text.slice(0, 1200),
    });
  }
  return out;
}

async function citationsActuallyUsedInAnswer(args: {
  answer: string;
  userMessage: string;
  factChunks: ContextChunk[];
  docChunks: Array<{ document_id: string; page_start: number; page_end: number; text: string }>;
  docs: DocumentRow[];
  webCitations?: ChatCitation[];
}): Promise<ChatCitation[]> {
  const candidates = [
    ...citationCandidatesFromContext(args.factChunks, args.docChunks, args.docs),
    ...(args.webCitations ?? []).map((citation) => ({
      citation,
      evidence: [citation.label, citation.href, citation.snippet].filter(Boolean).join("\n"),
    })),
  ];
  const answer = cleanAssistantResponse(args.answer);
  if (!answer || !candidates.length) return [];

  const candidateText = candidates
    .map((c, i) =>
      [
        `[${i + 1}] ${c.citation.label}`,
        c.citation.href ? `href: ${c.citation.href}` : "",
        `evidence: ${c.evidence.slice(0, 900)}`,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");

  const prompt = `Decide which retrieved CRM sources were actually used to support the assistant's answer.

Return strict JSON only:
{"used":[1,2]}

Rules:
- Include a source only if its snippet directly supports a concrete claim in the assistant answer.
- Do not include sources that are merely about the same company, same person, or same topic.
- Do not include sources that were retrieved but not needed for the answer.
- If the answer appears to rely on general model knowledge or says the saved CRM does not contain the answer without providing a web-backed fact, return {"used":[]}.
- If the answer only mentions that documents exist or can be opened, include only documents explicitly named in that answer.
- Be conservative. When unsure, exclude the source.

User message:
${args.userMessage.slice(0, 1200)}

Assistant answer:
${answer.slice(0, 5000)}

Candidate CRM sources:
${candidateText.slice(0, 9000)}`;

  try {
    const raw = await vertexRunWithText(chatModelForTask("filtering"), prompt, false);
    const parsed = parseJsonFromResponseOrNull(raw) as { used?: unknown } | null;
    const used = Array.isArray(parsed?.used)
      ? parsed.used
          .map((n) => Number(n))
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= candidates.length)
      : [];
    const unique = Array.from(new Set(used));
    return unique.map((n) => candidates[n - 1]?.citation).filter((c): c is ChatCitation => Boolean(c));
  } catch {
    return [];
  }
}

function formatSimilarPeers(peers: SimilarPeerForPrompt[]): string {
  if (!peers.length) return "";
  return peers
    .slice(0, 8)
    .map((p, i) => {
      const confidence = Number.isFinite(p.similarity_confidence)
        ? `${Math.round(p.similarity_confidence * 100)}%`
        : "n/a";
      return [
        `${i + 1}. ${p.company_name} (${confidence} similarity)`,
        p.problem_one_liner ? `Problem: ${p.problem_one_liner}` : "",
        p.solution_one_liner ? `Solution: ${p.solution_one_liner}` : "",
        p.decision ? `Prior decision: ${p.decision}` : "",
        p.pass_reason ? `Pass reason: ${p.pass_reason}` : "",
      ].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

async function loadCriteriaContext(admin: SupabaseClient, userId: string): Promise<string> {
  const [rules, thesis] = await Promise.all([
    loadAggregatedRulesForUser(admin, userId).catch(() => null),
    admin.from("fund_thesis").select("thesis_text, updated_at").eq("user_id", userId).maybeSingle(),
  ]);
  const sections: string[] = [];
  const thesisText = typeof thesis.data?.thesis_text === "string" ? thesis.data.thesis_text.trim() : "";
  if (thesisText) sections.push(`Fund thesis:\n${thesisText.slice(0, 3000)}`);
  if (rules) {
    const ruleLines = [
      ...rules.problem.map((r) => `Problem: ${r.rule} when ${r.condition}`),
      ...rules.solution.map((r) => `Solution: ${r.rule} when ${r.condition}`),
      ...rules.founder.map((r) => `Founder: ${r.rule} when ${r.condition}`),
    ];
    if (ruleLines.length) sections.push(`Uploaded criteria rules:\n${ruleLines.slice(0, 40).join("\n")}`);
  }
  return sections.join("\n\n");
}

async function runQuickLookup(args: {
  query: string;
  message: string;
  focusCompanyName: string | null;
  savedContext: string;
}): Promise<QuickLookupResult> {
  const prompt = `Answer one quick public-web lookup for a VC workspace chat.

Use Google Search grounding. Keep the answer short and direct.

Rules:
- This is a quick lookup, not a full research plan.
- Answer only the user's specific question.
- If a focused company is provided, keep the lookup about that company unless the user explicitly asked otherwise.
- Prefer current, reliable sources.
- Include source names or URLs briefly when available.
- If the web evidence is unclear or conflicting, say so plainly.
- Prefer facts that map to the Deal Intel schema: people, company makeup, origin, problem, solution, traction, competitors, negatives, or investment preferences.
- Preserve literal numbers and source phrasing; do not calculate, annualize, or embellish metrics.
- Return regular plain text only. Do not use headings, bullets, numbered lists, bold markers, code fences, or link markup.

Focused company:
${args.focusCompanyName ?? "(none)"}

Saved context, if any:
${args.savedContext || "(none)"}

Lookup query:
${args.query}

Original user message:
${args.message}`;
  try {
    const result = await vertexRunWithTextAndGroundingSources(chatModelForTask("why"), prompt, true);
    const text = cleanAssistantResponse(result.text);
    return {
      text,
      citations: result.sources.slice(0, 5).map((source, i) => ({
        label: `Web ${i + 1}: ${source.title}`,
        href: source.uri,
        snippet: text.slice(0, 240) || source.title,
      })),
    };
  } catch {
    return { text: "", citations: [] };
  }
}

function actionSummary(action: ChatAction): string {
  if (action.type === "tool_call") return `${action.tool}: ${action.status}${action.detail ? ` - ${action.detail}` : ""}`;
  if (action.type === "open_document" || action.type === "open_link") return action.href;
  if (action.type === "matrix_preview") return action.href;
  if (action.type === "document_preview") return action.href;
  if (action.type === "record_update") return action.detail;
  if (action.type === "propose_generate_document") {
    return `proposal: type=${action.typeName}, deal=${action.dealName ?? "none"}, format=${action.outputFormat}`;
  }
  if (action.type === "propose_research") return `proposal: ${action.dealNames.join(", ")}; focus=${action.focus}`;
  if (action.type === "propose_record_update") {
    return `proposal: ${action.dealName}; ${action.updates.map((u) => `${u.target}=${u.value}`).join("; ")}`;
  }
  if (action.type === "propose_custom_workflow") {
    return `proposal: workflow=${action.workflowName}, deal=${action.dealName ?? "none"}, input=${action.input}`;
  }
  if (action.type === "propose_matrix_fill") {
    return `proposal: deals=${action.dealNames.join(", ")}, columns=${action.columnLabels.join(", ")}`;
  }
  return "";
}

function researchFocusWithAnalysisContext(args: {
  rawFocus: string;
  message: string;
  task: ChatRoutePlan["chatTask"];
  routePlan: ChatRoutePlan;
}): string {
  const needsAnalysisFrame =
    args.task === "deep_reasoning" ||
    args.routePlan.useCriteria ||
    args.routePlan.useSimilarCompanies ||
    /analysis|analy[sz]e|deep|diligence|memo|investment|thesis|risk|negative|competitor|market|founder|traction/i.test(args.message);
  if (!needsAnalysisFrame) return args.rawFocus || args.message;
  return [
    args.rawFocus || args.message,
    "",
    "Use diligence-grade evidence standards and the default Deal Intel analysis layer as background quality guidance only.",
    "Do not expand the research scope beyond the user's requested topics. The planner and pruning reviewer should remove schema buckets, source families, and steps that do not directly answer the request.",
    "Use saved workspace context, internal database signals, documents, and web research together. Do not limit the answer to internal context, and do not add broad founder, traction, market, or origin research unless the user asked for it.",
    "Respect user investment preferences and website preferences for source choice and interpretation. Keep facts separate from preferences, preserve literal numbers, cite sources, and call out unknowns instead of guessing.",
  ].join("\n");
}

async function polishPlainTextResponse(text: string, userMessage: string): Promise<string> {
  const cleaned = cleanAssistantResponse(text);
  if (!cleaned) return cleaned;
  const prompt = `Rewrite the assistant answer as polished regular chat text.

Rules:
- Preserve all facts, numbers, company names, source names, URLs, and uncertainty exactly.
- Do not add new facts or remove important caveats.
- Fix grammar and awkward phrasing.
- Remove all formatting syntax, headings, bullets, numbered markers, code fences, bold markers, and link markup.
- Use plain text paragraphs only.

User request:
${userMessage.slice(0, 1200)}

Assistant answer:
${cleaned.slice(0, 8000)}`;
  try {
    const polished = await vertexRunWithText(chatModelForTask("filtering"), prompt, false);
    return cleanAssistantResponse(polished || cleaned) || cleaned;
  } catch {
    return cleaned;
  }
}

function confirmationMessage(actions: ChatAction[]): string | null {
  const hasToolProposal = actions.some(
    (a) =>
      a.type === "propose_generate_document" ||
      a.type === "propose_research" ||
      a.type === "propose_custom_workflow" ||
      a.type === "propose_matrix_fill" ||
      a.type === "propose_record_update",
  );
  if (!hasToolProposal) return null;
  return "";
}

export async function applyWorkspaceChatRecordUpdates(args: {
  admin: SupabaseClient;
  userId: string;
  dealId: string;
  updates: PlannedUpdate[];
}): Promise<ChatAction[]> {
  const deal = await loadDealForUser(args.admin, args.userId, args.dealId);
  if (!deal) throw new Error("Deal not found");
  return applyWorkspaceRecordUpdates(args.admin, { userId: args.userId, deal, updates: args.updates });
}

export async function runWorkspaceChat(args: {
  admin: SupabaseClient;
  userId: string;
  message: string;
  dealId?: string | null;
  history?: ChatMessage[];
  permissions?: Partial<ChatToolPermissions>;
  onAssistantDelta?: (chunk: string) => void;
}): Promise<{ message: string; actions: ChatAction[]; citations: ChatCitation[]; dealId: string | null }> {
  const message = args.message.trim();
  if (!message) return { message: "What would you like to look into?", actions: [], citations: [], dealId: args.dealId ?? null };
  const permissions = { ...DEFAULT_CHAT_TOOL_PERMISSIONS, ...(args.permissions ?? {}) };
  const history = args.history ?? [];

  const [deal, fallbackTask, allDeals, docTypes, customWorkflows, matrixColumns, preferenceContext] = await Promise.all([
    resolveDeal(args.admin, args.userId, args.dealId ?? null, message),
    classifyChatTaskWithGemma(message),
    listChatDeals(args.admin, args.userId),
    loadDocumentTypes(args.admin, args.userId),
    listCustomWorkflowDefinitions(args.admin, args.userId),
    listMatrixColumns(args.admin, args.userId).catch(() => []),
    loadCriteriaContext(args.admin, args.userId).catch(() => ""),
  ]);
  const routePlan = await planSmartChatRoute({
    message,
    history,
    focusDeal: deal,
    allDeals,
    docTypes,
    customWorkflows,
    matrixColumns,
    preferenceContext,
    permissions,
    fallbackTask,
  });
  const task = routePlan.chatTask;

  if (routePlan.answerPersonal) {
    return {
      message: answerPersonalUserQuestion(message, history) ?? "I don't know that from this workspace yet.",
      actions: [],
      citations: [],
      dealId: args.dealId ?? null,
    };
  }

  let routeTargetDealIds = [...routePlan.targetDealIds];
  if (routePlan.useMatrix || routePlan.scope === "cross_company") {
    for (const mentionedDeal of matchDealsFromMessage(allDeals, message)) {
      if (!routeTargetDealIds.includes(mentionedDeal.id)) routeTargetDealIds.push(mentionedDeal.id);
    }
    routeTargetDealIds = routeTargetDealIds.slice(0, 8);
  }
  let primaryDealId = routeTargetDealIds[0] ?? deal?.id ?? args.dealId ?? null;
  let primaryDeal =
    primaryDealId && deal?.id === primaryDealId
      ? deal
      : primaryDealId
        ? await loadDealForUser(args.admin, args.userId, primaryDealId)
        : deal;
  let actions: ChatAction[] = [];
  const toolNotes: string[] = [];

  if (routePlan.createCompany) {
    if (!permissions.createCompanies) {
      actions.push({ type: "record_update", label: "Company creation skipped", detail: "Company creation is turned off in chat tool settings." });
    } else {
      const company = await createCompanyFromChat(args.admin, {
        userId: args.userId,
        companyName: routePlan.createCompany.company_name,
        website: routePlan.createCompany.website,
        crmStage: routePlan.createCompany.crm_stage,
      });
      actions.push({
        type: "open_link",
        label: `Open ${company.name}`,
        href: `/home/deal-intel/${company.id}`,
        detail: company.created ? "Created from chat" : "Already existed",
      });
      primaryDealId = company.id;
      primaryDeal = await loadDealForUser(args.admin, args.userId, company.id);
      routeTargetDealIds = [company.id];
      toolNotes.push(company.created ? `Created ${company.name}.` : `${company.name} was already in the pipeline.`);
    }
  }

  const targetDealMap = new Map(allDeals.map((d) => [d.id, d]));
  const targetDeals = routeTargetDealIds
    .map((id) => targetDealMap.get(id))
    .filter((d): d is { id: string; name: string } => Boolean(d));
  const focusDealId =
    routePlan.scope === "cross_company" && routeTargetDealIds.length !== 1
      ? null
      : primaryDealId;
  const crossCompanyContextAllowed = routePlan.scope === "cross_company" || routePlan.useSimilarCompanies;
  const retrievalLimit = retrieveLimitForTask(task);
  const customWorkflowSelected = routePlan.customWorkflow.enabled && Boolean(routePlan.customWorkflow.workflowId);

  if (customWorkflowSelected && routePlan.customWorkflow.workflowId) {
    const workflow = customWorkflows.find((w) => w.id === routePlan.customWorkflow.workflowId);
    if (workflow) {
      const targetName = targetDeals[0]?.name ?? (primaryDeal ? companyName(primaryDeal) : null);
      actions.push({
        type: "propose_custom_workflow",
        label: `Run ${workflow.name}`,
        workflowId: workflow.id,
        workflowName: workflow.name,
        dealId: focusDealId,
        dealName: targetName,
        input: routePlan.customWorkflow.input || message,
      });
      toolNotes.push(`Selected workflow: ${workflow.name}.`);
    }
  }

  const [docs, snapshot, rawFactChunks, docChunks] = await Promise.all([
    loadDocuments(args.admin, args.userId, focusDealId),
    loadDealSnapshot(args.admin, focusDealId),
    retrieveContextNodesForQuery(args.admin, {
      userId: args.userId,
      queryText: message,
      chatTask: task,
      limit: focusDealId && !crossCompanyContextAllowed ? Math.max(retrievalLimit * 3, 24) : retrievalLimit,
      focusDealId,
    }).catch(() => []),
    retrieveDocumentChunks(args.admin, { userId: args.userId, queryText: message, dealId: focusDealId, limit: 8 }),
  ]);
  const factChunks = focusDealId && !crossCompanyContextAllowed
    ? rawFactChunks.filter((chunk) => chunk.deal_id === focusDealId).slice(0, retrievalLimit)
    : rawFactChunks;

  if (routePlan.openDocumentQuery && docs.length) {
    const picked = pickDocuments(docs, routePlan.openDocumentQuery || message, 5);
    actions = actions.concat(
      picked.map((d) => ({
        type: "open_document" as const,
        label: `Open ${d.original_filename || "document"}`,
        href: hrefForDocument(d.id, d.source_kind),
        documentId: d.id,
        filename: d.original_filename || "document",
      })),
    );
  }

  if (routePlan.updates.length) {
    if (!permissions.editRecords) {
      actions.push({ type: "record_update", label: "Record update skipped", detail: "Record editing is turned off in chat tool settings." });
    } else if (!primaryDeal) {
      actions.push({ type: "record_update", label: "Record update skipped", detail: "Pick a company before updating records." });
    } else {
      const applied = await applyWorkspaceRecordUpdates(args.admin, { userId: args.userId, deal: primaryDeal, updates: routePlan.updates });
      actions = actions.concat(applied);
    }
  }

  if (routePlan.generateDocument.enabled) {
    const pickedType = pickDocumentType(docTypes, message, routePlan.generateDocument.typeHint);
    if (!pickedType) {
      const targetName = targetDeals[0]?.name ?? (primaryDeal ? companyName(primaryDeal) : null);
      const typeName = titleFromDocumentHint(routePlan.generateDocument.typeHint);
      actions.push({
        type: "propose_generate_document",
        label: `Generate ${typeName}`,
        prompt: targetName
          ? `Draft a ${typeName} for ${targetName}.\n\nUser request: ${routePlan.generateDocument.prompt}`
          : routePlan.generateDocument.prompt,
        dealId: focusDealId,
        dealName: targetName,
        typeId: null,
        typeName,
        outputFormat: "text",
        skipResearch: true,
      });
      toolNotes.push(`Selected ad hoc document type: ${typeName}.`);
    } else if (!focusDealId && documentLikelyNeedsCompany(pickedType, message)) {
      toolNotes.push(`I found the "${pickedType.name}" document type, but I need to know which company to use.`);
    } else {
      const targetName = targetDeals[0]?.name ?? (primaryDeal ? companyName(primaryDeal) : null);
      actions.push({
        type: "propose_generate_document",
        label: `Generate ${pickedType.name}`,
        prompt: targetName
          ? `Draft a ${pickedType.name} for ${targetName}.\n\nUser request: ${routePlan.generateDocument.prompt}`
          : routePlan.generateDocument.prompt,
        dealId: focusDealId,
        dealName: targetName,
        typeId: pickedType.id,
        typeName: pickedType.name,
        outputFormat: pickedType.output_format || "text",
        skipResearch: true,
      });
      toolNotes.push(`Selected document type: ${pickedType.name}.`);
    }
  }

  if (routePlan.runResearch.enabled && routePlan.runResearch.when === "now") {
    const researchDealIds = routePlan.researchDealIds.length ? routePlan.researchDealIds : routeTargetDealIds;
    const researchTargetDeals = researchDealIds
      .map((id) => targetDealMap.get(id))
      .filter((d): d is { id: string; name: string } => Boolean(d));
    if (!targetDeals.length && !primaryDeal) {
      toolNotes.push("I need to know which company to research.");
    } else {
      const researchTargets = researchTargetDeals.length
        ? researchTargetDeals
        : primaryDealId && primaryDeal
          ? [{ id: primaryDealId, name: companyName(primaryDeal) }]
          : [];
      if (researchTargets.length) {
        actions.push({
          type: "propose_research",
          label: researchTargets.length === 1 ? `Research ${researchTargets[0]!.name}` : `Research ${researchTargets.length} companies`,
          focus: researchFocusWithAnalysisContext({
            rawFocus: routePlan.runResearch.focus || message,
            message,
            task,
            routePlan,
          }),
          userPrompt: message,
          dealIds: researchTargets.map((d) => d.id),
          dealNames: researchTargets.map((d) => d.name),
        });
      }
    }
  }

  if (routePlan.useMatrix && routeTargetDealIds.length >= 1) {
    const selectedColumns = routePlan.matrixColumnIds
      .map((id) => matrixColumns.find((column) => column.id === id))
      .filter((column): column is (typeof matrixColumns)[number] => Boolean(column));
    const columnsToCreate = routePlan.matrixColumnsToCreate;
    if (selectedColumns.length || columnsToCreate.length) {
      const matrixTargets = targetDeals.length
        ? targetDeals
        : primaryDealId && primaryDeal
          ? [{ id: primaryDealId, name: companyName(primaryDeal) }]
          : [];
      if (matrixTargets.length) {
        const selectedLabels = selectedColumns.map((c) => c.label);
        const draftLabels = columnsToCreate.map((c) => c.label);
        actions.push({
          type: "propose_matrix_fill",
          label: "Generate matrix",
          dealIds: matrixTargets.map((d) => d.id),
          dealNames: matrixTargets.map((d) => d.name),
          columnIds: selectedColumns.map((c) => c.id),
          columnLabels: [...selectedLabels, ...draftLabels],
          columnsToCreate,
        });
      }
    }
  }

  const preparedMessage = confirmationMessage(actions);
  if (preparedMessage !== null) {
    return {
      message: cleanAssistantResponse(preparedMessage),
      actions,
      citations: [],
      dealId: focusDealId,
    };
  }
  if (routePlan.generateDocument.enabled || (routePlan.runResearch.enabled && routePlan.runResearch.when === "now")) {
    return {
      message: cleanAssistantResponse(toolNotes.length ? toolNotes.join("\n\n") : "I need a bit more direction before I can use that tool."),
      actions,
      citations: [],
      dealId: focusDealId,
    };
  }

  if (
    focusDealId &&
    !crossCompanyContextAllowed &&
    routePlan.runResearch.enabled &&
    routePlan.runResearch.when === "if_missing_info" &&
    factChunks.length === 0 &&
    docChunks.length === 0 &&
    permissions.runResearch &&
    primaryDeal
  ) {
    actions.push({
      type: "propose_research",
      label: `Research ${companyName(primaryDeal)}`,
      focus: researchFocusWithAnalysisContext({
        rawFocus: routePlan.runResearch.focus || message,
        message,
        task,
        routePlan,
      }),
      userPrompt: message,
      dealIds: [focusDealId],
      dealNames: [companyName(primaryDeal)],
    });
  }

  const savedLookupContext = [
    JSON.stringify(snapshot, null, 2).slice(0, 2500),
    formatChunks(factChunks.slice(0, 3)),
    formatDocChunks(docChunks.slice(0, 2), docs),
  ].filter(Boolean).join("\n\n");
  const [similarPeers, criteriaContext, quickLookupResult] = await Promise.all([
    routePlan.useSimilarCompanies
      ? focusDealId
        ? fetchSimilarDealsFromDealId(args.admin, focusDealId, 8).catch(() => [])
        : embedText(message.slice(0, 8000))
            .then((queryEmbedding) =>
              fetchSimilarDealsHybrid(args.admin, {
                userId: args.userId,
                queryEmbedding,
                queryText: message,
                finalLimit: 8,
              }),
            )
            .catch(() => [])
      : Promise.resolve([]),
    routePlan.useCriteria ? loadCriteriaContext(args.admin, args.userId).catch(() => "") : Promise.resolve(""),
    routePlan.quickLookup.enabled
      ? runQuickLookup({
          query: routePlan.quickLookup.query || message,
          message,
          focusCompanyName: primaryDeal ? companyName(primaryDeal) : null,
          savedContext: savedLookupContext,
        })
      : Promise.resolve({ text: "", citations: [] }),
  ]);
  const recentHistory = (args.history ?? [])
    .slice(-8)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 1200)}`)
    .join("\n");
  const dealLine = primaryDeal && focusDealId ? `Focused company: ${companyName(primaryDeal)} (${focusDealId})` : "Focused company: none / workspace-wide";
  const prompt = `You are the user's VC workspace chat assistant.

The user is the investor/operator using this workspace. Company founders, executives, employees, and other people mentioned in CRM facts are not the user unless the user explicitly says so.

Answer using the canonical Deal Intel schema as your organizing lens:
${DEAL_INTEL_LAYER1A_SCHEMA_GUIDE}

${DEAL_INTEL_QUALITY_GUARDRAILS}

${USER_PREFERENCE_GUARDRAILS}

Capabilities available in this turn:
- Answer using retrieved CRM facts and document snippets.
- Surface links to saved documents when relevant.
- Prepare document generation, research, saved workflow, and record-update actions when the router selected a tool. The UI will run enabled tool actions automatically.
- Do not say a tool has finished until the completed action result is present. You may say you are starting selected tool actions now.
- Write like a normal chat assistant in plain conversational text. Do not use formatting syntax, headings, bold text, star bullets, numbered lists, tables, code fences, or link markup. If the user asks for structure, use short plain-text paragraphs with simple labels.
- Only use retrieved company/person context when it actually answers the user's question. For questions about the user, do not infer identity from company records.
- If a focused company is set, answer about that company by default. Do not answer with another company's facts unless the user explicitly asks for comparisons, competitors, peers, benchmarks, similar companies, portfolio-wide analysis, or all-company context.
- If the focused company's context does not contain the requested fact, say you do not know from the saved context. Do not fill the gap using another company's context. If research has been prepared, mention that you started it.
- If a quick web lookup result is present, use it to answer the simple lookup directly. Do not describe it as a research plan.
- When the user asks for a company analysis, structure the answer around relevant schema buckets rather than generic startup prose.
- Always separate evidence-backed facts from unknowns, gaps, and negative aspects.
- When facts are missing, prefer proposing/focusing research on the missing schema field instead of filling the gap with guesses.
- Do not overwrite or reinterpret user preference rules as company facts. Investment preferences are decision guidance; company facts need citations or saved context.

${dealLine}
Cross-company context allowed: ${crossCompanyContextAllowed ? "yes" : "no"}
Task route: ${task}
Route plan:
${JSON.stringify(routePlan, null, 2).slice(0, 5000)}

Recent chat:
${recentHistory || "(none)"}

Deal snapshot:
${JSON.stringify(snapshot, null, 2).slice(0, 6000)}

Retrieved fact context:
${formatChunks(factChunks) || "(none)"}

Retrieved document context:
${formatDocChunks(docChunks, docs) || "(none)"}

Similar company tool results:
${formatSimilarPeers(similarPeers) || "(not requested or none found)"}

Investment criteria and thesis context:
${criteriaContext || "(not requested or no uploaded criteria found)"}

Quick web lookup result:
${quickLookupResult.text || "(not requested or no quick lookup result)"}

Actions already taken or prepared:
${actions.length ? actions.map((a) => `- ${a.label}: ${actionSummary(a)}`).join("\n") : "(none)"}

Tool preparation notes:
${toolNotes.length ? toolNotes.map((n) => `- ${n}`).join("\n") : "(none)"}

User message:
${message}

Respond conversationally and directly. If you used context, mention the basis briefly. If a quick lookup answered the question, just answer it. If a generated document, saved workflow, or research workflow is prepared, say you are starting it now. If record updates were applied, say they were applied. If you found documents, tell the user which links are available. Do not invent facts.`;

  if (args.onAssistantDelta) {
    let response = "";
    for await (const chunk of vertexStreamText(chatModelForTask(task), prompt, false)) {
      response += chunk;
      args.onAssistantDelta(chunk);
    }
    const finalMessage = cleanAssistantResponse(response || "I could not produce a response.");
    return {
      message: finalMessage,
      actions,
      citations: await citationsActuallyUsedInAnswer({
        answer: finalMessage,
        userMessage: message,
        factChunks,
        docChunks,
        docs,
        webCitations: quickLookupResult.citations,
      }),
      dealId: focusDealId,
    };
  }

  const response = await vertexRunWithText(chatModelForTask(task), prompt, false);
  const finalMessage = await polishPlainTextResponse(response || "I could not produce a response.", message);
  return {
    message: finalMessage,
    actions,
    citations: await citationsActuallyUsedInAnswer({
      answer: finalMessage,
      userMessage: message,
      factChunks,
      docChunks,
      docs,
      webCitations: quickLookupResult.citations,
    }),
    dealId: focusDealId,
  };
}
