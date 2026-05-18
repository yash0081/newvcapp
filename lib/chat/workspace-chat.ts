import type { SupabaseClient } from "@supabase/supabase-js";
import { parseJsonFromResponseOrNull, parseJsonFromResponseWithRepair } from "@/lib/gemini";
import { classifyChatTask } from "@/lib/chat-router";
import { chatModelForTask, retrieveLimitForTask } from "@/lib/chat-router-gemma";
import { retrieveContextNodesForQuery, type ContextChunk } from "@/lib/retrieval-orchestrator";
import { vectorParam } from "@/lib/data-layer/shared/vector";
import { embedText } from "@/lib/vertex-embeddings";
import { vertexRunWithText, vertexRunWithTextAndGroundingSources, vertexStreamText } from "@/lib/vertex";
import { fetchSimilarDealsFromDealId } from "@/lib/similar-deals/fetch-from-deal";
import { fetchSimilarDealsHybrid } from "@/lib/similar-deals/fetch-hybrid";
import type { SimilarPeerForPrompt } from "@/lib/similar-deals/types";
import { loadAggregatedRulesForUser } from "@/lib/investment-rules";
import { listCustomWorkflowDefinitions, type CustomWorkflowDefinition } from "@/lib/custom-workflows";
import {
  buildMatrixHref,
  buildMatrixSnapshotGrid,
  buildMatrixToolBrief,
  executeCreateMatrixFromProposal,
  enrichMatrixCreateFromMessage,
  enrichMatrixRoutePlan,
  extractArtifactSubjectHint,
  formatMatrixContextForPrompt,
  formatMatrixViewsIndex,
  loadMatrixContextForChat,
  messageReferencesSavedMatrix,
  messageRequestsMatrixCreate,
  extractMatrixCreateCompanyHints,
  resolveMatrixViewFromMessage,
  type MatrixColumnSpec,
  type MatrixRoutePlanFields,
  type MatrixSnapshotGrid,
} from "@/lib/diligence-matrix/chat-matrix";
import { listMatrixViews, type MatrixSavedView } from "@/lib/diligence-matrix/views";
import {
  DEAL_INTEL_LAYER1A_SCHEMA_GUIDE,
  DEAL_INTEL_QUALITY_GUARDRAILS,
  DEAL_INTEL_RESEARCH_FOCUS_GUIDE,
  USER_PREFERENCE_GUARDRAILS,
} from "@/lib/deal-intel/prompt-guidance";
import { stripModelPromptEcho } from "@/lib/commentary";
import { stripMarkdownText } from "@/lib/plain-text";
import { loadResearchInternalContext } from "@/lib/research/context";
import {
  buildQuickLookupQuery,
  formatFastIntentForPrompt,
  isExplicitResearchRequest,
  isDocumentPrimaryRequest,
  shouldUsePublicWebForChat,
  type FastResearchIntent,
} from "@/lib/research/fast-intent";
import {
  type DocumentClarifyField,
  type DocumentTypeSummary,
  classifyDocumentDelivery,
  documentLikelyNeedsCompany,
  documentSignalFromMessage,
  findTypeMentionedInMessage,
  formatDeliveryClarificationMessage,
  formatNeedsSetupMessage,
  formatTypeClarificationMessage,
  messageRequestsSavedDocumentGeneration,
  pickSavedDocumentType,
  resolveDocumentGeneration,
  typesNamedInMessage,
} from "@/lib/chat/document-type-routing";
import { inferLightweightResearchIntent } from "@/lib/research/planner";
import {
  classifyResearchModeAsync,
  isInternalOnlyQuestion,
  computeOpenGapsForMode,
  getCachedQueryEmbedding,
  cacheKeyForQuery,
  setCachedQueryEmbedding,
  quickLookupWeak,
  type ResearchModeDecision,
  type ResearchProfile,
} from "@/lib/research/mode-router";

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
      userMessage?: string;
      dealId: string | null;
      dealName: string | null;
      typeId: string;
      typeName: string;
      outputFormat: string;
      skipResearch?: boolean;
      autoRun?: boolean;
    }
  | {
      type: "propose_research";
      label: string;
      focus: string;
      userPrompt?: string;
      dealIds: string[];
      dealNames: string[];
      researchProfile?: ResearchProfile;
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
    }
  | {
      type: "propose_create_matrix";
      label: string;
      name: string;
      dealIds: string[];
      dealNames: string[];
      columnTheme: string | null;
      explicitColumns: MatrixColumnSpec[];
    }
  | {
      type: "matrix_snapshot";
      label: string;
      href?: string;
      viewName?: string | null;
      grid?: MatrixSnapshotGrid;
      /** @deprecated Legacy flat rows */
      rows?: Array<{ dealName: string; columnLabel: string; valueText: string | null; status: string }>;
      filledCount?: number;
      truncated?: boolean;
      markdown?: string;
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
  createMatrices: boolean;
};

export const DEFAULT_CHAT_TOOL_PERMISSIONS: ChatToolPermissions = {
  generateDocuments: true,
  runResearch: true,
  editRecords: true,
  createCompanies: true,
  useSimilarCompanySearch: true,
  useCriteriaAnalysis: true,
  runWorkflows: true,
  createMatrices: true,
};

export type MatrixClarifyField = "companies" | "columns" | "which_matrix";

export type MatrixRoutePlan = {
  action: "none" | "read" | "create";
  viewId: string | null;
  dealIds: string[];
  name: string | null;
  columnTheme: string | null;
  explicitColumns: MatrixColumnSpec[];
  clarify: MatrixClarifyField[];
  useMatrixIfRelevant: boolean;
};

type ToolPrecheck = {
  wantsDocument: boolean;
  documentDelivery: "explicit" | "ambiguous" | "none";
  documentSignal: boolean;
  wantsResearch: boolean;
  wantsWorkflow: boolean;
  documentTypeHint: string | null;
  targetDealIds: string[];
  researchDealIds: string[];
  researchFocus: string;
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
    typeId: string | null;
    clarify: DocumentClarifyField[];
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
  matrix: MatrixRoutePlan;
  quickLookup: {
    enabled: boolean;
    query: string;
  };
  useSimilarCompanies: boolean;
  useCriteria: boolean;
  missingInfoBehavior: "answer_unknown" | "research" | "ask_clarifying";
  researchProfile: ResearchProfile;
  researchModeReason?: string;
};

function emptyMatrixPlan(): MatrixRoutePlan {
  return {
    action: "none",
    viewId: null,
    dealIds: [],
    name: null,
    columnTheme: null,
    explicitColumns: [],
    clarify: [],
    useMatrixIfRelevant: false,
  };
}

function parseMatrixRouteFromRouter(
  raw: unknown,
  allowedDealIds: Set<string>,
): MatrixRoutePlan {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const actionRaw = typeof o.action === "string" ? o.action : "none";
  const action: MatrixRoutePlan["action"] =
    actionRaw === "read" || actionRaw === "create" ? actionRaw : "none";
  const viewId = typeof o.viewId === "string" && o.viewId.trim() ? o.viewId.trim() : null;
  const dealIds: string[] = [];
  if (Array.isArray(o.dealIds)) {
    for (const id of o.dealIds) {
      if (typeof id === "string" && allowedDealIds.has(id) && !dealIds.includes(id)) dealIds.push(id);
    }
  }
  const name = typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 120) : null;
  const columnTheme =
    typeof o.columnTheme === "string" && o.columnTheme.trim() ? o.columnTheme.trim().slice(0, 500) : null;
  const explicitColumns: MatrixColumnSpec[] = [];
  if (Array.isArray(o.explicitColumns)) {
    for (const item of o.explicitColumns) {
      if (!item || typeof item !== "object") continue;
      const col = item as Record<string, unknown>;
      const label = typeof col.label === "string" ? col.label.trim() : "";
      if (!label) continue;
      explicitColumns.push({
        label: label.slice(0, 80),
        prompt: typeof col.prompt === "string" ? col.prompt.trim().slice(0, 2000) : undefined,
        dataType:
          col.dataType === "text" ||
          col.dataType === "number" ||
          col.dataType === "percent" ||
          col.dataType === "currency" ||
          col.dataType === "boolean"
            ? col.dataType
            : undefined,
      });
    }
  }
  const clarify: MatrixClarifyField[] = [];
  if (Array.isArray(o.clarify)) {
    for (const c of o.clarify) {
      if (c === "companies" || c === "columns" || c === "which_matrix") clarify.push(c);
    }
  }
  const useMatrixIfRelevant = o.useMatrixIfRelevant === true;
  return {
    action: clarify.length && action === "create" ? "none" : action,
    viewId,
    dealIds,
    name,
    columnTheme,
    explicitColumns,
    clarify,
    useMatrixIfRelevant,
  };
}

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
  return stripModelPromptEcho(stripMarkdownText(text))
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
  if (res.error) {
    console.error("[workspace-chat] loadDocumentTypes failed", res.error.message);
    return [];
  }
  return (res.data ?? []) as DocumentTypeSummary[];
}

async function resolveDeal(
  admin: SupabaseClient,
  userId: string,
  dealId: string | null,
  message: string,
  matrixViews: MatrixSavedView[] = [],
): Promise<DealRow | null> {
  if (dealId) return loadDealForUser(admin, userId, dealId);
  if (matrixViews.length && messageReferencesSavedMatrix(message, matrixViews)) return null;
  const deals = await listChatDeals(admin, userId);
  const msg = normalizeText(message);
  const artifactHint = extractArtifactSubjectHint(message);
  const matched = deals.find((d) => {
    const name = normalizeText(d.name);
    if (!name || name.length < 2) return false;
    if (artifactHint && normalizeText(artifactHint) === name) return false;
    return msg.includes(name);
  });
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
  args: { userId: string; queryText: string; dealId: string | null; limit?: number; queryEmbedding?: Promise<number[] | null> },
): Promise<Array<{ document_id: string; page_start: number; page_end: number; text: string; score: number }>> {
  const limit = args.limit ?? 8;
  const queryText = args.queryText.trim();
  if (!queryText) return [];

  const ftsPromise = admin.rpc("deal_intel_match_document_chunks_fts", {
    p_user_id: args.userId,
    p_query: queryText.slice(0, 500),
    p_match_count: limit,
    p_deal_id: args.dealId,
  });

  const vectorPromise = (async () => {
    const emb = args.queryEmbedding ? await args.queryEmbedding : await embedText(queryText.slice(0, 8000)).catch(() => null);
    if (!emb) return [] as Array<{ document_id: string; page_start: number; page_end: number; text: string; score: number }>;
    const vec = await admin.rpc("deal_intel_match_document_chunks_vector", {
      p_user_id: args.userId,
      p_query_embedding: vectorParam(emb),
      p_match_count: limit,
      p_deal_id: args.dealId,
    });
    if (vec.error) return [];
    return ((vec.data ?? []) as Array<{
        document_id: string;
        page_start: number;
        page_end: number;
        text: string;
        similarity: number;
    }>).map((r) => ({ ...r, score: r.similarity ?? 0 }));
  })().catch(() => []);

  const [fts, vectorRows] = await Promise.all([ftsPromise, vectorPromise]);
  const ftsRows = fts.error ? [] : ((fts.data ?? []) as Array<{
    document_id: string;
    page_start: number;
    page_end: number;
    text: string;
    score: number;
  }>);

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

const DOCUMENT_INTENT_RE = /\b(write|draft|generate|create|make|prepare|produce)\b.{0,80}\b(document|doc|memo|notes?|brief|report|email|one[- ]?pager|summary)\b|\b(ic|investment committee|investment)\s+memo\b/i;
const RESEARCH_INTENT_RE = /\b(research|look into|investigate|find out|dig into|web search|search the web|deep dive|competitors?|patents?|common investors?|shared investors?)\b/i;
const RESEARCH_TOPIC_WORKFLOW_RE = /\b(competitor landscape|competitors?|patents?|common investors?|shared investors?)\b/i;
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

function buildDocumentPickerActions(args: {
  types: DocumentTypeSummary[];
  message: string;
  dealId: string | null;
  dealName: string | null;
  autoRun: boolean;
}): ChatAction[] {
  return args.types.map((type) => ({
    type: "propose_generate_document" as const,
    label: `Generate ${type.name}`,
    prompt: args.message,
    userMessage: args.message,
    dealId: args.dealId,
    dealName: args.dealName,
    typeId: type.id,
    typeName: type.name,
    outputFormat: type.output_format || "text",
    skipResearch: true,
    autoRun: args.autoRun,
  }));
}

function buildToolPrecheck(args: {
  message: string;
  focusDeal: DealRow | null;
  allDeals: Array<{ id: string; name: string }>;
  docTypes?: DocumentTypeSummary[];
}): ToolPrecheck {
  if (messageRequestsMatrixCreate(args.message)) {
    return {
      wantsDocument: false,
      documentDelivery: "none",
      documentSignal: false,
      wantsResearch: false,
      wantsWorkflow: false,
      documentTypeHint: null,
      targetDealIds: args.focusDeal?.id ? [args.focusDeal.id] : [],
      researchDealIds: [],
      researchFocus: args.message,
      documentFocus: args.message,
      evidence: ["matrix create intent"],
    };
  }
  const researchFocus = focusedSegment(args.message, RESEARCH_INTENT_RE).slice(0, 1800);
  const documentFocus = focusedSegment(args.message, DOCUMENT_INTENT_RE).slice(0, 1800);
  const clauses = taskClauses(args.message);
  const mentionedDeals = matchDealsFromMessage(args.allDeals, args.message);
  const researchMentionedDeals = matchDealsFromMessage(args.allDeals, researchFocus);
  const targetDealIds = (mentionedDeals.length ? mentionedDeals.map((deal) => deal.id) : args.focusDeal?.id ? [args.focusDeal.id] : []).slice(0, 8);
  const docTypes = args.docTypes ?? [];
  const documentDelivery = classifyDocumentDelivery(args.message);
  const namedType = findTypeMentionedInMessage(args.message, docTypes);
  const namedInMessage = typesNamedInMessage(args.message, docTypes);
  const wantsDocument =
    documentDelivery === "explicit" ||
    Boolean(namedType) ||
    namedInMessage.length > 0;
  const documentSignal = documentSignalFromMessage(args.message, docTypes);
  const standaloneResearchClauses = clauses.filter(
    (clause) => RESEARCH_INTENT_RE.test(clause) && !DOCUMENT_INTENT_RE.test(clause),
  );
  const wantsResearch =
    standaloneResearchClauses.some((clause) => isExplicitResearchRequest(clause)) ||
    (!wantsDocument && standaloneResearchClauses.some((clause) => RESEARCH_TOPIC_WORKFLOW_RE.test(clause)));
  const wantsWorkflow = WORKFLOW_INTENT_RE.test(args.message);
  const researchDealIds = wantsResearch
    ? (researchMentionedDeals.length ? researchMentionedDeals.map((deal) => deal.id) : targetDealIds).filter((id) => {
        const name = args.allDeals.find((deal) => deal.id === id)?.name.toLowerCase() ?? "";
        if (!name) return true;
        const around = researchFocus.toLowerCase().slice(Math.max(0, researchFocus.toLowerCase().indexOf(name) - 80), researchFocus.toLowerCase().indexOf(name) + name.length + 120);
        return !/\b(matrix row|row|peer reference|common[- ]investor counterpart|benchmark row)\b/.test(around);
      })
    : [];
  const evidence = [
    wantsDocument ? "document explicit" : "",
    documentDelivery === "ambiguous" ? "document ambiguous" : "",
    wantsResearch ? "research keyword" : "",
    wantsWorkflow ? "workflow keyword" : "",
  ].filter(Boolean);
  return {
    wantsDocument,
    documentDelivery,
    documentSignal,
    wantsResearch,
    wantsWorkflow,
    documentTypeHint: namedType?.name ?? namedInMessage[0]?.name ?? null,
    targetDealIds,
    researchDealIds,
    researchFocus: researchFocus || args.message,
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
    generateDocument: emptyGenerateDocumentPlan(args.message),
    runResearch: { enabled: false, focus: args.message, when: "now" },
    researchDealIds: [],
    customWorkflow: { enabled: false, workflowId: null, input: args.message },
    matrix: emptyMatrixPlan(),
    quickLookup: { enabled: false, query: args.message },
    useSimilarCompanies: args.chatTask === "similar_deal",
    useCriteria: false,
    missingInfoBehavior: "answer_unknown",
    researchProfile: "fast",
    researchModeReason: "",
  };
}

function suppressResearchForMatrixTool(plan: ChatRoutePlan): void {
  plan.quickLookup.enabled = false;
  plan.runResearch.enabled = false;
  plan.runResearch.when = "if_missing_info";
  plan.missingInfoBehavior = "answer_unknown";
  plan.useSimilarCompanies = false;
}

function applyResearchModeToRoutePlan(args: {
  plan: ChatRoutePlan;
  decision: ResearchModeDecision;
  message: string;
  precheck: ReturnType<typeof buildToolPrecheck>;
  permissions: ChatToolPermissions;
  focusDealId: string | null;
  targetDealIds: string[];
  matrixToolActive?: boolean;
}): void {
  if (args.matrixToolActive) return;

  const documentPrimary = isDocumentPrimaryRequest({
    message: args.message,
    generateDocumentEnabled: args.plan.generateDocument.enabled,
    wantsResearchFromPrecheck: args.precheck.wantsResearch,
    documentDelivery: args.precheck.documentDelivery,
  });

  if (documentPrimary) {
    args.plan.researchProfile = "fast";
    args.plan.researchModeReason = args.decision.reason;
    args.plan.runResearch.enabled = false;
    args.plan.runResearch.when = "if_missing_info";
    args.plan.quickLookup.enabled = args.decision.needsWeb && args.permissions.runResearch;
    if (args.plan.quickLookup.enabled) {
      args.plan.quickLookup.query = args.plan.quickLookup.query || args.message.slice(0, 600);
    }
    return;
  }

  args.plan.researchProfile = args.decision.profile;
  args.plan.researchModeReason = args.decision.reason;

  if (args.decision.profile === "deep" && args.permissions.runResearch) {
    args.plan.runResearch.enabled = true;
    args.plan.runResearch.when = "now";
    args.plan.runResearch.focus = args.plan.runResearch.focus || args.message;
    if (!args.plan.researchDealIds.length && args.focusDealId) {
      args.plan.researchDealIds = [args.focusDealId];
    }
    return;
  }

  const wantsBriefWeb =
    args.decision.needsWeb ||
    (args.decision.profile === "fast" && shouldUsePublicWebForChat(args.message));
  if (wantsBriefWeb && args.permissions.runResearch) {
    args.plan.quickLookup = {
      enabled: true,
      query: args.plan.quickLookup.query || args.message.slice(0, 600),
    };
  }

  if (
    args.decision.needsWorkflow &&
    args.permissions.runResearch &&
    (args.decision.profile === "standard" ||
      args.decision.profile === "deep" ||
      args.precheck.wantsResearch)
  ) {
    args.plan.runResearch.enabled = true;
    args.plan.runResearch.when = "now";
    args.plan.runResearch.focus = args.plan.runResearch.focus || args.message;
    const ids = args.plan.researchDealIds.length ? args.plan.researchDealIds : args.targetDealIds.slice(0, 4);
    if (ids.length) args.plan.researchDealIds = ids;
  }
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

function parseDocumentClarifyFromRouter(raw: unknown): DocumentClarifyField[] {
  const clarify: DocumentClarifyField[] = [];
  if (!Array.isArray(raw)) return clarify;
  for (const item of raw) {
    if (item === "delivery_mode" || item === "which_type" || item === "which_company") {
      clarify.push(item);
    }
  }
  return clarify;
}

function emptyGenerateDocumentPlan(prompt: string): ChatRoutePlan["generateDocument"] {
  return {
    enabled: false,
    prompt,
    typeHint: null,
    typeId: null,
    clarify: [],
  };
}

function applyToolPrecheck(args: {
  plan: ChatRoutePlan;
  precheck: ToolPrecheck;
  permissions: ChatToolPermissions;
  allDeals: Array<{ id: string; name: string }>;
  message: string;
  docTypes?: DocumentTypeSummary[];
  enforceToolSignals?: boolean | "document_only";
}): ChatRoutePlan {
  const allowedDeals = new Set(args.allDeals.map((deal) => deal.id));
  const enforceAll = args.enforceToolSignals === true || args.enforceToolSignals === undefined;
  const enforceDocumentOnly = enforceAll || args.enforceToolSignals === "document_only";
  const targetDealIds = mergeIds(args.plan.targetDealIds, args.precheck.targetDealIds, allowedDeals);
  const plan: ChatRoutePlan = {
    ...args.plan,
    targetDealIds,
    generateDocument: { ...args.plan.generateDocument },
    runResearch: { ...args.plan.runResearch },
    researchDealIds: mergeIds(args.plan.researchDealIds, [], allowedDeals),
    customWorkflow: { ...args.plan.customWorkflow },
    matrix: { ...args.plan.matrix },
    quickLookup: { ...args.plan.quickLookup },
  };

  const docTypes = args.docTypes ?? [];
  const namedType = findTypeMentionedInMessage(args.message, docTypes);
  const shouldEnableDocument =
    args.precheck.documentDelivery === "explicit" ||
    Boolean(namedType) ||
    typesNamedInMessage(args.message, docTypes).length > 0 ||
    Boolean(plan.generateDocument.typeId && docTypes.some((type) => type.id === plan.generateDocument.typeId));

  if (enforceDocumentOnly && shouldEnableDocument && args.permissions.generateDocuments) {
    const pick = pickSavedDocumentType(args.message, docTypes, plan.generateDocument.typeId);
    plan.generateDocument.enabled = true;
    plan.generateDocument.prompt = args.precheck.documentFocus || plan.generateDocument.prompt || args.message;
    if (pick.kind === "ready") {
      plan.generateDocument.typeId = pick.type.id;
      plan.generateDocument.typeHint = pick.type.name;
    } else {
      plan.generateDocument.typeId = null;
      plan.generateDocument.typeHint = null;
    }

    if (!args.precheck.wantsResearch) {
      plan.runResearch.enabled = false;
      plan.quickLookup.enabled = false;
      plan.missingInfoBehavior = "answer_unknown";
    }
  }

  if (enforceAll && args.precheck.wantsResearch && args.permissions.runResearch) {
    plan.runResearch.enabled = true;
    plan.runResearch.when = "now";
    plan.runResearch.focus = args.precheck.researchFocus || plan.runResearch.focus || args.message;
    const precheckResearchIds = args.precheck.researchDealIds.length
      ? args.precheck.researchDealIds
      : args.precheck.targetDealIds;
    plan.researchDealIds = mergeIds(plan.researchDealIds, precheckResearchIds, allowedDeals);
  }

  if (enforceAll && args.precheck.wantsWorkflow && args.permissions.runWorkflows && !plan.customWorkflow.enabled) {
    plan.customWorkflow.input = plan.customWorkflow.input || args.message;
  }

  return plan;
}

const QUICK_LOOKUP_INTENT_RE =
  /\b(current|latest|recent|today|now|new|news|ceo|founder|headquarters|hq|funding round|raised|valuation|announced|verify|confirm)\b/i;
const OPEN_DOCUMENT_INTENT_RE = /\b(open|show|view|find|pull up)\b.{0,80}\b(doc|document|file|pdf|deck|memo|report|notes?)\b/i;
const UPDATE_RECORD_INTENT_RE = /\b(save|update|edit|record|change|add)\b.{0,80}\b(company|deal|record|crm|stage|website|traction|problem|solution|founder|note)\b/i;
const CREATE_COMPANY_INTENT_RE = /\b(add|create|save)\b.{0,40}\b(company|deal)\b/i;
const CRITERIA_INTENT_RE = /\b(criteria|thesis|fit|score|scoring|evaluate|evaluation|pass|invest|investment decision)\b/i;
const CROSS_COMPANY_INTENT_RE =
  /\b(compare|comparison|benchmark|benchmarks|portfolio|all companies|all deals|across companies|side[- ]?by[- ]?side)\b/i;
const WORKSPACE_ARTIFACT_QUESTION_RE =
  /\b(tell me about|what(?:'s| is| are)|who is|show me|open|view|see|describe|summarize|explain|look at)\b/i;

function messageMayTargetNamedWorkspaceArtifact(args: {
  message: string;
  matrixViews: MatrixSavedView[];
  allDeals: Array<{ id: string; name: string }>;
}): boolean {
  if (messageReferencesSavedMatrix(args.message, args.matrixViews)) return true;
  if (!args.matrixViews.length || !WORKSPACE_ARTIFACT_QUESTION_RE.test(args.message)) return false;
  const subjectHint = extractArtifactSubjectHint(args.message);
  if (!subjectHint || subjectHint.length < 2) return false;
  return matchDealsFromMessage(args.allDeals, subjectHint).length === 0;
}

function shouldUseSmartRouter(args: {
  message: string;
  precheck: ToolPrecheck;
  fallbackTask: ChatRoutePlan["chatTask"];
  matchedDeals: Array<{ id: string; name: string }>;
  matrixViews: MatrixSavedView[];
  allDeals: Array<{ id: string; name: string }>;
}): boolean {
  if (args.precheck.wantsWorkflow) return true;
  if (OPEN_DOCUMENT_INTENT_RE.test(args.message)) return true;
  if (UPDATE_RECORD_INTENT_RE.test(args.message) || CREATE_COMPANY_INTENT_RE.test(args.message)) return true;
  if (CRITERIA_INTENT_RE.test(args.message)) return true;
  if (messageMayTargetNamedWorkspaceArtifact(args)) return true;
  if (messageRequestsMatrixCreate(args.message)) return true;
  if (args.fallbackTask === "similar_deal") return true;
  if (args.matchedDeals.length > 1 || CROSS_COMPANY_INTENT_RE.test(args.message)) return true;
  return false;
}

function deterministicRoutePlan(args: {
  message: string;
  focusDeal: DealRow | null;
  allDeals: Array<{ id: string; name: string }>;
  precheck: ToolPrecheck;
  permissions: ChatToolPermissions;
  fallbackTask: ChatRoutePlan["chatTask"];
  docTypes?: DocumentTypeSummary[];
}): ChatRoutePlan {
  const plan = fallbackRoutePlan({
    message: args.message,
    focusDeal: args.focusDeal,
    allDeals: args.allDeals,
    chatTask: args.fallbackTask,
  });
  if (answerPersonalUserQuestion(args.message, [])) {
    plan.answerPersonal = true;
    return plan;
  }
  const lookupOnly =
    QUICK_LOOKUP_INTENT_RE.test(args.message) &&
    !args.precheck.wantsDocument &&
    !args.precheck.wantsResearch &&
    !args.precheck.wantsWorkflow &&
    args.permissions.runResearch;
  if (lookupOnly) {
    plan.quickLookup = { enabled: true, query: args.message.slice(0, 600) };
    plan.chatTask = "questions";
  }
  return applyToolPrecheck({
    plan,
    precheck: args.precheck,
    permissions: args.permissions,
    allDeals: args.allDeals,
    message: args.message,
    docTypes: args.docTypes,
  });
}

async function planSmartChatRoute(args: {
  message: string;
  history: ChatMessage[];
  focusDeal: DealRow | null;
  allDeals: Array<{ id: string; name: string }>;
  docTypes: DocumentTypeSummary[];
  customWorkflows: CustomWorkflowDefinition[];
  preferenceContext: string;
  permissions: ChatToolPermissions;
  fallbackTask: ChatRoutePlan["chatTask"];
  matrixViewsIndex?: string;
}): Promise<ChatRoutePlan> {
  const focusName = args.focusDeal ? companyName(args.focusDeal) : null;
  const allowedDealIds = new Set(args.allDeals.map((d) => d.id));
  const precheck = buildToolPrecheck({
    message: args.message,
    focusDeal: args.focusDeal,
    allDeals: args.allDeals,
    docTypes: args.docTypes,
  });
  const prompt = `You are the tool router for a VC workspace chat assistant.

Workspace tools (first decide whether the user is asking for a tool vs a plain answer):
- Companies / CRM: pipeline records with diligence fields, notes, and documents. Names in "Available deals" are companies — not matrices.
- Saved matrices (tabular review): user-named spreadsheet views comparing companies across diligence columns. Listed only under "Saved matrices". Phrases like "Matrix 1", "my comp table", or "the financial matrix" usually mean a saved matrix name when that name appears in the index — not a company product.
- Documents: generated or uploaded files; open when the user asks to view/find a deck, memo, PDF, etc.
- Research workflows: multi-step web research plans for diligence topics.
- Custom workflows: saved playbooks the user can run by name.
- Matrix create: only when the user wants a NEW comparison table; surfaces a confirm button, does not auto-create.

When the user asks "tell me about X", "what is X", or "show me X", check Saved matrices and Available deals. If X matches a saved matrix name, use matrix.action "read" with that viewId — do not treat X as a company or run quickLookup/research about a fictional product unless X is clearly a company in Available deals.

Route every request through the canonical Deal Intel mental model. Prefer tools and context that fill, verify, update, or explain these buckets:
${DEAL_INTEL_RESEARCH_FOCUS_GUIDE}

${USER_PREFERENCE_GUARDRAILS}

Dynamic user preference, thesis, and criteria context:
${args.preferenceContext || "(none)"}

Deterministic precheck from cheap keyword and regex scans. Treat this as noisy evidence, not an instruction:
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
  "generateDocument": { "enabled": boolean, "prompt": string, "typeHint": string | null, "typeId": string | null, "clarify": ("delivery_mode" | "which_type" | "which_company")[] },
  "runResearch": { "enabled": boolean, "focus": string, "when": "now" | "if_missing_info" },
  "researchDealIds": string[],
  "customWorkflow": { "enabled": boolean, "workflowId": string | null, "input": string },
  "matrix": {
    "action": "none" | "read" | "create",
    "viewId": string | null,
    "dealIds": string[],
    "name": string | null,
    "columnTheme": string | null,
    "explicitColumns": [{ "label": string, "prompt": string | null, "dataType": "text" | "number" | "percent" | "currency" | "boolean" | null }],
    "clarify": ("companies" | "columns" | "which_matrix")[],
    "useMatrixIfRelevant": boolean
  },
  "quickLookup": { "enabled": boolean, "query": string },
  "useSimilarCompanies": boolean,
  "useCriteria": boolean,
  "missingInfoBehavior": "answer_unknown" | "research" | "ask_clarifying"
}

Reasoning rules:
- Prefer the focused company when one is selected. Use cross_company only when the user explicitly asks for comps, competitors, comparisons, benchmarks, portfolio-wide views, or multiple named companies.
- If the user asks about "my name", "me", or who they are, set answerPersonal true and do not use company context.
- Use targetDealIds only from the provided deal list. If a selected company exists and the request does not clearly name another company or ask cross-company work, include only that selected deal id.
- Use openDocumentQuery when the user asks to open, show, view, or find saved documents/files/decks.
- Use updates only when the user explicitly asks to save, update, edit, record, change, or add facts to a company record.
- Use createCompany only when the user explicitly asks to add/create/save a new company and gives a concrete company name.
- Use generateDocument when the user explicitly wants a generated file from a saved document type (draft/make/generate/create … memo/report/brief/etc.).
- Set generateDocument.typeId to an id from Document types when confident. If multiple types could match, set enabled false and clarify: ["which_type"]. If the user might want a chat answer instead (e.g. "give me a summary", "tell me about X" without generate verbs), set enabled false and clarify: ["delivery_mode"].
- Do not use generateDocument for matrix, tabular review, table, or spreadsheet-style comparison requests unless the user explicitly asks for a written document/report in addition to the matrix.
- Never invent document types; only use ids from the Document types list.
- Use quickLookup for one-off factual/current-public-web questions that likely need only one search, such as current CEO, latest funding round, headquarters, recent news, a single metric, or a simple verification. quickLookup answers directly; it does not create a research workflow.
- Use runResearch for broader or multi-step diligence, such as building a research plan, funding history, competitor landscape, customer evidence, founder background, market sizing, or any task that needs several searches/sources/subquestions. Use when="if_missing_info" only when the saved focused-company context may be insufficient and a fuller workflow is the right next step.
- Mentions of research, data, documents, or company facts are not tool requests by themselves. If the user is asking a meta question, expressing dissatisfaction, giving a command, or asking what you can/cannot do, answer that request directly and leave tools disabled unless a concrete supported action is explicitly requested.
- Use researchDealIds for the companies that actually need research. If another named company is only a benchmark row, peer reference, or common-investor counterpart, include it in targetDealIds for comparison context but leave it out of researchDealIds unless the user explicitly asks to research that company too.
- When runResearch.enabled is true, researchDealIds should normally be non-empty and narrower than targetDealIds when some target companies are only needed for comparison context.
- If the user asks for missing schema coverage, evidence quality, negatives, or "what do we know", prefer the schema buckets above when choosing answer vs research vs update.
- Use customWorkflow when the user asks to run a saved/reusable workflow, playbook, process, or their request clearly matches one workflow's name, description, or step instructions. Choose exactly one workflow id only when the match is clear. If multiple workflows plausibly match, leave customWorkflow disabled and ask which workflow to run by name.
- Matrix / tabular review tool (saved diligence spreadsheets — see Saved matrices index):
  - action "read": user asks about, wants to open, summarize, or compare using an existing saved matrix; or names a matrix from the index (e.g. "Matrix 1", "tell me about my SaaS comps matrix"). Set viewId from the index id when matched. Put that matrix's company ids in dealIds when known. Do NOT run research/quickLookup just to explain a saved matrix name.
  - action "create": user explicitly asks to create/build/make a new matrix or tabular comparison (e.g. "make a matrix for Company A and B with TAM and SAM"). Put matched company ids in dealIds. Put TAM/SAM and other column labels in explicitColumns; use columnTheme for vague "a few more columns" requests. Set runResearch.enabled false — matrix creation does not require a research workflow first.
  - When matrix.action is "create", runResearch.enabled must be false and quickLookup.enabled must be false unless the user separately asked for research in the same message.
  - action "none": CRM-only comparison with no saved matrix involved, or vague create request with clarify set.
  - useMatrixIfRelevant: true when comparing 2+ companies and saved matrix cells may help even if action is "none".
  - Saved matrix names take precedence over guessing a company/product when both could match.
  - Matrix create runs immediately server-side and returns an open-matrix link; do not also enable research to populate cells first.
- Do not set both quickLookup and runResearch unless the user asks for a direct answer now plus deeper follow-up research.
- When the user explicitly asks for multiple outputs or tools in one prompt, set every requested tool field. For example, a workflow plus a document should run both if both are requested.
- Tools are not mutually exclusive. If the user explicitly asks for workflow, document, research, database-backed lookup, or analysis outputs in the same prompt, return all requested tool actions. Avoid only exact duplicate tool work.
- Use useSimilarCompanies for similar companies, comps, peers, comparables, or competitor benchmarking.
- Use useCriteria for thesis fit, uploaded criteria, investment evaluation, scoring, pass/invest reasoning, or criteria-based analysis.
- Use the deterministic precheck as a hint. You may override it when the actual user intent is better served by a direct answer or a different tool choice.
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

Saved matrices (tabular review views):
${args.matrixViewsIndex || "(none loaded)"}

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
    const typeIdRaw = typeof generateRaw.typeId === "string" ? generateRaw.typeId : "";
    const typeId = args.docTypes.some((t) => t.id === typeIdRaw) ? typeIdRaw : null;
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
        typeId,
        clarify: parseDocumentClarifyFromRouter(generateRaw.clarify),
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
      matrix: parseMatrixRouteFromRouter(parsed?.matrix, allowedDealIds),
      quickLookup: {
        enabled: lookupRaw.enabled === true && args.permissions.runResearch,
        query: typeof lookupRaw.query === "string" && lookupRaw.query.trim() ? lookupRaw.query.trim().slice(0, 600) : args.message,
      },
      useSimilarCompanies: parsed?.useSimilarCompanies === true && args.permissions.useSimilarCompanySearch,
      useCriteria: parsed?.useCriteria === true && args.permissions.useCriteriaAnalysis,
      missingInfoBehavior: missingRaw === "research" || missingRaw === "ask_clarifying" ? missingRaw : "answer_unknown",
      researchProfile: "fast",
      researchModeReason: "",
    };
    return applyToolPrecheck({
      plan,
      precheck,
      permissions: args.permissions,
      allDeals: args.allDeals,
      message: args.message,
      docTypes: args.docTypes,
      enforceToolSignals: "document_only",
    });
  } catch {
    return deterministicRoutePlan({
      message: args.message,
      focusDeal: args.focusDeal,
      allDeals: args.allDeals,
      precheck,
      permissions: args.permissions,
      fallbackTask: args.fallbackTask,
      docTypes: args.docTypes,
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
  researchProfile?: ResearchProfile;
  plannerIntent?: FastResearchIntent;
}): Promise<QuickLookupResult> {
  const profile = args.researchProfile ?? "fast";
  const intentBlock = args.plannerIntent ? formatFastIntentForPrompt(args.plannerIntent) : "";
  const prompt = `Answer one quick public-web lookup for a VC workspace chat.

Use Google Search grounding. Keep the answer short and direct.

Rules:
- This is a quick lookup, not a full research plan.
- Answer only the user's specific question and planner angles below; do not run broad diligence.
- Use saved workspace context as background only; you must still check current public web evidence.
- If saved context conflicts with the web, say so and prefer the newer public source.
- If a focused company is provided, keep the lookup about that company unless the user explicitly asked otherwise.
- Prefer current, reliable sources.
- Include source names or URLs briefly when available.
- If the web evidence is unclear or conflicting, say so plainly.
- Prefer facts that map to the Deal Intel schema: people, company makeup, origin, problem, solution, traction, competitors, negatives, or investment preferences.
- Preserve literal numbers and source phrasing; do not calculate, annualize, or embellish metrics.
- Return regular plain text only. Do not use headings, bullets, numbered lists, bold markers, code fences, or link markup.

Focused company:
${args.focusCompanyName ?? "(none)"}

Planner scope (same rules as research planner, narrow only):
${intentBlock || "(infer from the user message)"}

Saved context, if any:
${args.savedContext || "(none)"}

Lookup query:
${args.query}

Original user message:
${args.message}`;
  try {
    const result = await vertexRunWithTextAndGroundingSources(chatModelForTask("why", profile), prompt, true);
    const text = cleanAssistantResponse(result.text);
    return {
      text,
      citations: result.sources
        .filter((source) => {
          try {
            const host = new URL(source.uri).hostname;
            return Boolean(host && host.includes("."));
          } catch {
            return false;
          }
        })
        .slice(0, 5)
        .map((source, i) => ({
          label: `Web ${i + 1}: ${source.title}`,
          href: source.uri,
          snippet: source.title.slice(0, 240),
        })),
    };
  } catch {
    return { text: "", citations: [] };
  }
}

function actionSummary(action: ChatAction): string {
  if (action.type === "tool_call") return `${action.tool}: ${action.status}${action.detail ? ` - ${action.detail}` : ""}`;
  if (action.type === "open_document" || action.type === "open_link") return action.href;
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
  if (action.type === "propose_create_matrix") {
    return `proposal: matrix for ${action.dealNames.join(", ")}; columns=${action.columnTheme ?? action.explicitColumns.map((c) => c.label).join(", ")}`;
  }
  if (action.type === "matrix_snapshot") {
    const rowCount = action.rows?.length ?? 0;
    return `matrix snapshot: ${action.viewName ?? action.label}; rows=${rowCount}`;
  }
  return "";
}

function userResearchFocus(rawFocus: string, message: string): string {
  return (rawFocus || message).trim().slice(0, 1800);
}

async function polishPlainTextResponse(text: string, userMessage: string): Promise<string> {
  const cleaned = cleanAssistantResponse(text);
  if (!cleaned) return cleaned;
  const looksFormatted = /(^|\n)\s*(#{1,6}\s|\* |- |\d+[.)]\s|```|\|.+\|)|\*\*|__|\[[^\]]+\]\([^)]+\)/.test(cleaned);
  if (!looksFormatted) return cleaned;
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
      a.type === "propose_record_update" ||
      a.type === "propose_create_matrix",
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
  deepMode?: boolean;
  onAssistantDelta?: (chunk: string) => void;
}): Promise<{ message: string; actions: ChatAction[]; citations: ChatCitation[]; dealId: string | null }> {
  const message = args.message.trim();
  if (!message) return { message: "What would you like to look into?", actions: [], citations: [], dealId: args.dealId ?? null };
  const deepMode = args.deepMode === true;
  const permissions = { ...DEFAULT_CHAT_TOOL_PERMISSIONS, ...(args.permissions ?? {}) };
  // Deep mode always enables research and prefers richer context
  if (deepMode) permissions.runResearch = true;
  const history = args.history ?? [];

  const [allDeals, matrixViewsForRoute, docTypesEarly] = await Promise.all([
    listChatDeals(args.admin, args.userId),
    listMatrixViews(args.admin, args.userId).catch(() => [] as MatrixSavedView[]),
    permissions.generateDocuments
      ? loadDocumentTypes(args.admin, args.userId)
      : Promise.resolve([] as DocumentTypeSummary[]),
  ]);
  const deal = await resolveDeal(args.admin, args.userId, args.dealId ?? null, message, matrixViewsForRoute);
  const fallbackTask = classifyChatTask(message);
  const precheck = buildToolPrecheck({ message, focusDeal: deal, allDeals, docTypes: docTypesEarly });
  const matchedDeals = matchDealsFromMessage(allDeals, message);
  const allowedDealIds = new Set(allDeals.map((d) => d.id));
  const needsSmartRouter = shouldUseSmartRouter({
    message,
    precheck,
    fallbackTask,
    matchedDeals,
    matrixViews: matrixViewsForRoute,
    allDeals,
  });
  const docTypesForRoute = docTypesEarly;
  const [customWorkflowsForRoute, preferenceContext] = needsSmartRouter
    ? await Promise.all([
        listCustomWorkflowDefinitions(args.admin, args.userId),
        loadCriteriaContext(args.admin, args.userId).catch(() => ""),
      ])
    : [[], ""];
  const routed = needsSmartRouter
    ? await planSmartChatRoute({
        message,
        history,
        focusDeal: deal,
        allDeals,
        docTypes: docTypesForRoute,
        customWorkflows: customWorkflowsForRoute,
        preferenceContext,
        permissions,
        fallbackTask,
        matrixViewsIndex: formatMatrixViewsIndex(matrixViewsForRoute),
      })
    : deterministicRoutePlan({
        message,
        focusDeal: deal,
        allDeals,
        precheck,
        permissions,
        fallbackTask,
        docTypes: docTypesForRoute,
      });
  let routePlan = {
    ...routed,
    matrix: enrichMatrixRoutePlan(
      enrichMatrixCreateFromMessage(
        { ...routed.matrix, explicitColumns: [...routed.matrix.explicitColumns] } as MatrixRoutePlanFields,
        message,
        allDeals,
        allowedDealIds,
        matchDealsFromMessage,
      ),
      message,
      matrixViewsForRoute,
      allowedDealIds,
    ),
  };
  const matrixArtifactRead =
    routePlan.matrix.action === "read" && Boolean(routePlan.matrix.viewId);
  const matrixToolCreate = routePlan.matrix.action === "create";
  const matrixToolActive = matrixArtifactRead || matrixToolCreate || messageRequestsMatrixCreate(message);
  const resolvedMatrixView = matrixArtifactRead
    ? matrixViewsForRoute.find((view) => view.id === routePlan.matrix.viewId) ??
      resolveMatrixViewFromMessage(message, matrixViewsForRoute)
    : null;
  let matrixToolBrief = buildMatrixToolBrief({
    action: routePlan.matrix.action,
    viewId: routePlan.matrix.viewId,
    viewName: resolvedMatrixView?.name ?? null,
  });
  if (matrixToolActive) {
    suppressResearchForMatrixTool(routePlan);
  }
  // Deep Research toggle: prefer deep_reasoning task tier and auto-enable workflow when user opted in.
  // Profile (fast/standard/deep) is chosen by the mode router after retrieval, not forced here.
  let task = routePlan.chatTask;
  const documentPrimaryEarly = isDocumentPrimaryRequest({
    message,
    generateDocumentEnabled: routePlan.generateDocument.enabled,
    wantsResearchFromPrecheck: precheck.wantsResearch,
    documentDelivery: precheck.documentDelivery,
  });
  if (deepMode && !documentPrimaryEarly && !matrixToolActive) {
    task = task === "filtering" || task === "similar_deal" || task === "questions" ? "deep_reasoning" : task;
    if (!routePlan.runResearch.enabled) {
      routePlan.runResearch = { enabled: true, focus: message, when: "now" };
    } else if (routePlan.runResearch.when === "if_missing_info") {
      routePlan.runResearch = { ...routePlan.runResearch, when: "now" };
    }
  }
  if (matrixToolActive) {
    suppressResearchForMatrixTool(routePlan);
  }

  if (routePlan.answerPersonal) {
    return {
      message: answerPersonalUserQuestion(message, history) ?? "I don't know that from this workspace yet.",
      actions: [],
      citations: [],
      dealId: args.dealId ?? null,
    };
  }

  let routeTargetDealIds = [...routePlan.targetDealIds];
  if (routePlan.scope === "cross_company") {
    for (const mentionedDeal of matchDealsFromMessage(allDeals, message)) {
      if (!routeTargetDealIds.includes(mentionedDeal.id)) routeTargetDealIds.push(mentionedDeal.id);
    }
    routeTargetDealIds = routeTargetDealIds.slice(0, 8);
  }
  if (routePlan.matrix.dealIds.length && !matrixArtifactRead && !matrixToolCreate) {
    for (const id of routePlan.matrix.dealIds) {
      if (!routeTargetDealIds.includes(id)) routeTargetDealIds.push(id);
    }
    routeTargetDealIds = routeTargetDealIds.slice(0, 8);
  }
  let primaryDealId =
    matrixArtifactRead || matrixToolCreate
      ? args.dealId ?? null
      : routeTargetDealIds[0] ?? deal?.id ?? args.dealId ?? null;
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
  const [docTypes, customWorkflows] = await Promise.all([
    docTypesForRoute.length
      ? Promise.resolve(docTypesForRoute)
      : routePlan.generateDocument.enabled ||
          precheck.documentSignal ||
          messageRequestsSavedDocumentGeneration(message)
        ? loadDocumentTypes(args.admin, args.userId)
        : Promise.resolve([] as DocumentTypeSummary[]),
    customWorkflowSelected && !customWorkflowsForRoute.length
      ? listCustomWorkflowDefinitions(args.admin, args.userId)
      : Promise.resolve(customWorkflowsForRoute),
  ]);

  let resolvedDocumentType: DocumentTypeSummary | null = null;
  if (
    permissions.generateDocuments &&
    (precheck.documentSignal || routePlan.generateDocument.enabled || routePlan.generateDocument.clarify.length > 0)
  ) {
    const docResolution = resolveDocumentGeneration({
      message,
      types: docTypes,
      typeIdFromRouter: routePlan.generateDocument.typeId,
      clarifyFromRouter: routePlan.generateDocument.clarify,
      generateEnabled: routePlan.generateDocument.enabled,
    });
    if (docResolution.status === "needs_setup") {
      return {
        message: cleanAssistantResponse(formatNeedsSetupMessage()),
        actions: [
          {
            type: "open_link",
            label: "Open Documents",
            href: "/home/document-generator",
            detail: "Create document types and templates.",
          },
        ],
        citations: [],
        dealId: focusDealId,
      };
    }
    if (docResolution.status === "clarify_delivery") {
      return {
        message: cleanAssistantResponse(formatDeliveryClarificationMessage(docResolution.suggestedTypes)),
        actions: [],
        citations: [],
        dealId: focusDealId,
      };
    }
    if (docResolution.status === "clarify_type") {
      const targetName = targetDeals[0]?.name ?? (primaryDeal ? companyName(primaryDeal) : null);
      return {
        message: cleanAssistantResponse(formatTypeClarificationMessage(docResolution.candidates)),
        actions: buildDocumentPickerActions({
          types: docResolution.candidates,
          message,
          dealId: focusDealId,
          dealName: targetName,
          autoRun: false,
        }),
        citations: [],
        dealId: focusDealId,
      };
    }
    if (docResolution.status === "ready") {
      const saved = docTypes.find((row) => row.id === docResolution.type.id);
      if (!saved) {
        const targetName = targetDeals[0]?.name ?? (primaryDeal ? companyName(primaryDeal) : null);
        return {
          message: cleanAssistantResponse(formatTypeClarificationMessage(docTypes)),
          actions: buildDocumentPickerActions({
            types: docTypes,
            message,
            dealId: focusDealId,
            dealName: targetName,
            autoRun: false,
          }),
          citations: [],
          dealId: focusDealId,
        };
      }
      resolvedDocumentType = saved;
      routePlan.generateDocument.enabled = true;
      routePlan.generateDocument.typeId = saved.id;
      routePlan.generateDocument.typeHint = routePlan.generateDocument.typeHint ?? saved.name;
    } else {
      routePlan.generateDocument.enabled = false;
    }
  }

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

  let matrixContextText = "";
  const matrixPlan = routePlan.matrix;
  const matrixDealIds = matrixArtifactRead
    ? (resolvedMatrixView?.dealIds ?? matrixPlan.dealIds)
    : matrixPlan.dealIds.length
      ? matrixPlan.dealIds
      : routeTargetDealIds.length
        ? routeTargetDealIds
        : primaryDealId
          ? [primaryDealId]
          : [];

  if (matrixPlan.clarify.length) {
    const clarifyParts: string[] = [];
    if (matrixPlan.clarify.includes("companies")) clarifyParts.push("which companies to include");
    if (matrixPlan.clarify.includes("columns")) clarifyParts.push("which columns or themes (e.g. financial, team)");
    if (matrixPlan.clarify.includes("which_matrix")) clarifyParts.push("which saved matrix to use");
    if (clarifyParts.length) {
      toolNotes.push(`Before using the matrix tool, ask the user to clarify: ${clarifyParts.join("; ")}.`);
    }
  }

  const shouldLoadMatrixContext =
    matrixPlan.action === "read" ||
    (matrixPlan.action === "none" && matrixPlan.useMatrixIfRelevant && matrixDealIds.length >= 2);

  if (shouldLoadMatrixContext) {
    const resolvedView = resolveMatrixViewFromMessage(message, matrixViewsForRoute);
    try {
      const matrixCtx = await loadMatrixContextForChat(args.admin, args.userId, {
        viewId: matrixPlan.viewId ?? resolvedView?.id ?? null,
        viewNameHint: resolvedView?.name ?? extractArtifactSubjectHint(message),
        dealIds: matrixDealIds.length ? matrixDealIds : resolvedView?.dealIds,
        message,
        filledOnly: true,
      });
      matrixContextText = formatMatrixContextForPrompt(matrixCtx);
      if (matrixCtx.viewId) {
        const href = buildMatrixHref({
          viewId: matrixCtx.viewId,
          dealIds: matrixDealIds,
          singleDealId: args.dealId ?? primaryDealId,
        });
        actions.push({
          type: "open_link",
          label: matrixCtx.viewName ? `Open ${matrixCtx.viewName}` : "Open matrix",
          href,
          detail: `${matrixCtx.filledCount} filled cells in saved matrix`,
        });
      }
      if (matrixPlan.action === "read") {
        if (!matrixToolBrief) {
          matrixToolBrief = buildMatrixToolBrief({
            action: "read",
            viewId: matrixCtx.viewId,
            viewName: matrixCtx.viewName,
          });
        }
        const hrefDealIds =
          matrixDealIds.length > 0
            ? matrixDealIds
            : resolvedView?.dealIds?.length
              ? resolvedView.dealIds
              : matrixViewsForRoute.find((view) => view.id === matrixCtx.viewId)?.dealIds ?? [];
        const grid = buildMatrixSnapshotGrid(matrixCtx.rows, {
          viewName: matrixCtx.viewName,
          companyNames: matrixCtx.companyOrder.map((company) => company.name),
          columnLabels: matrixCtx.columnOrder.map((column) => column.label),
        });
        actions.push({
          type: "matrix_snapshot",
          label: matrixCtx.viewName ?? "Matrix snapshot",
          viewName: matrixCtx.viewName,
          grid,
          filledCount: grid.filledCount,
          truncated: grid.truncated,
          href: matrixCtx.viewId
            ? buildMatrixHref({
                viewId: matrixCtx.viewId,
                dealIds: hrefDealIds,
                singleDealId: args.dealId ?? null,
              })
            : undefined,
        });
        suppressResearchForMatrixTool(routePlan);
        if (!grid.filledCount) {
          toolNotes.push("This matrix has no filled cells yet — open it to add or run research on columns.");
        }
      }
    } catch {
      toolNotes.push("Could not load saved matrix data.");
    }
  }

  if (
    matrixPlan.action === "create" &&
    !matrixPlan.clarify.length &&
    permissions.createMatrices
  ) {
    const matrixDeals = matrixDealIds
      .map((id) => targetDealMap.get(id))
      .filter((d): d is { id: string; name: string } => Boolean(d));
    const hasColumnIntent =
      Boolean(matrixPlan.columnTheme?.trim()) || matrixPlan.explicitColumns.length > 0;
    if (!matrixDeals.length) {
      toolNotes.push("I need to know which companies to include in the matrix.");
    } else if (!hasColumnIntent) {
      toolNotes.push("Specify which columns or themes you want in the matrix (e.g. revenue, headcount, financial metrics).");
    } else {
      const matrixLabel =
        matrixPlan.name?.trim() ||
        (matrixDeals.length > 1
          ? `Matrix: ${matrixDeals.map((d) => d.name).slice(0, 3).join(" vs ")}`
          : `Matrix: ${matrixDeals[0]!.name}`);
      suppressResearchForMatrixTool(routePlan);
      try {
        const created = await executeCreateMatrixFromProposal(args.admin, args.userId, {
          name: matrixLabel,
          dealIds: matrixDeals.map((d) => d.id),
          dealNames: matrixDeals.map((d) => d.name),
          columnTheme: matrixPlan.columnTheme,
          explicitColumns: matrixPlan.explicitColumns,
        });
        actions.push({
          type: "open_link",
          label: `Open ${created.view.name}`,
          href: created.href,
          detail: `${matrixDeals.length} companies · ${created.columnCount} columns`,
        });
        const companyList = matrixDeals.map((d) => d.name).join(" and ");
        return {
          message: cleanAssistantResponse(
            `Created "${created.view.name}" comparing ${companyList} (${created.columnCount} columns). Open the matrix when you're ready to fill cells.`,
          ),
          actions,
          citations: [],
          dealId: args.dealId ?? null,
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Could not create matrix";
        toolNotes.push(detail);
        actions.push({
          type: "record_update",
          label: "Matrix creation failed",
          detail,
        });
      }
    }
  }

  if (matrixToolCreate && matrixPlan.clarify.length) {
    suppressResearchForMatrixTool(routePlan);
    const hints = extractMatrixCreateCompanyHints(message);
    const clarifyParts: string[] = [];
    if (matrixPlan.clarify.includes("companies")) {
      clarifyParts.push(
        hints.length >= 2
          ? `add these companies to your pipeline first: ${hints.join(", ")}`
          : "which companies to include (they must exist in your CRM)",
      );
    }
    if (matrixPlan.clarify.includes("columns")) clarifyParts.push("which columns or themes you want");
    return {
      message: cleanAssistantResponse(
        `I can create that comparison matrix once you clarify ${clarifyParts.join("; ")}.`,
      ),
      actions,
      citations: [],
      dealId: args.dealId ?? null,
    };
  }

  const embedCacheKey = cacheKeyForQuery(args.userId, message);
  const sharedQueryEmbedding = (async () => {
    const cached = getCachedQueryEmbedding(embedCacheKey);
    if (cached) return cached;
    const vec = await embedText(message.slice(0, 8000)).catch(() => null);
    if (vec) setCachedQueryEmbedding(embedCacheKey, vec);
    return vec;
  })();
  // Fast mode: fewer chunks to keep latency low. Deep mode: fetch more for richer context.
  const factLimit = focusDealId && !crossCompanyContextAllowed
    ? Math.max(retrievalLimit * 3, 24)
    : retrievalLimit;
  const docLimit = deepMode ? 10 : (task === "questions" ? 4 : 8);
  const [docs, rawFactChunks, docChunks] = await Promise.all([
    loadDocuments(args.admin, args.userId, focusDealId),
    retrieveContextNodesForQuery(args.admin, {
      userId: args.userId,
      queryText: message,
      chatTask: task,
      limit: deepMode ? Math.max(factLimit, 36) : factLimit,
      focusDealId,
      queryEmbedding: sharedQueryEmbedding,
    }).catch(() => []),
    retrieveDocumentChunks(args.admin, { userId: args.userId, queryText: message, dealId: focusDealId, limit: docLimit, queryEmbedding: sharedQueryEmbedding }),
  ]);
  // Load richer deal context: for focused single-company requests use loadResearchInternalContext
  // which includes full relational snapshot, deal-tree, doc chunks, and investor signals.
  // For cross-company or workspace queries keep loadDealSnapshot (cheaper).
  const snapshot: Record<string, unknown> = await (async () => {
    if (focusDealId && !crossCompanyContextAllowed) {
      try {
        const ctx = await loadResearchInternalContext({
          admin: args.admin,
          userId: args.userId,
          dealId: focusDealId,
          query: message,
          mode: deepMode ? "execution" : "planning",
        });
        // Return as a structured object the prompt can read
        return { rich_context: ctx.slice(0, deepMode ? 16000 : 8000) };
      } catch {
        // fallback to basic snapshot below
      }
    }
    return loadDealSnapshot(args.admin, focusDealId);
  })();
  const factChunks = focusDealId && !crossCompanyContextAllowed
    ? rawFactChunks.filter((chunk) => chunk.deal_id === focusDealId).slice(0, deepMode ? retrievalLimit * 2 : retrievalLimit)
    : rawFactChunks;

  const openGapsForMode = computeOpenGapsForMode({
    metadata: primaryDeal?.metadata ?? undefined,
    recentClaims: [],
  });
  const fastPlannerIntent = inferLightweightResearchIntent({
    message,
    openGapFields: openGapsForMode.map((g) => g.field),
  });
  const savedLookupContextEarly = [
    JSON.stringify(snapshot, null, 2).slice(0, 2500),
    formatChunks(factChunks.slice(0, 3)),
    formatDocChunks(docChunks.slice(0, 2), docs),
  ].filter(Boolean).join("\n\n");
  const focusCompanyLabel = primaryDeal ? companyName(primaryDeal) : null;
  const quickLookupQuery = buildQuickLookupQuery({
    message,
    companyName: focusCompanyLabel,
    intent: fastPlannerIntent,
  });
  const documentPrimary = isDocumentPrimaryRequest({
    message,
    generateDocumentEnabled: routePlan.generateDocument.enabled,
    wantsResearchFromPrecheck: precheck.wantsResearch,
    documentDelivery: precheck.documentDelivery,
  });
  const modeDecision = await classifyResearchModeAsync({
    message,
    deepModeEnabled: deepMode,
    openGaps: openGapsForMode,
    factChunkCount: factChunks.length,
    docChunkCount: docChunks.length,
    wantsResearchFromPrecheck: precheck.wantsResearch,
    runResearchEnabled: routePlan.runResearch.enabled,
    documentGenerationOnly: documentPrimary,
  });

  applyResearchModeToRoutePlan({
    plan: routePlan,
    decision: modeDecision,
    message,
    precheck,
    permissions,
    focusDealId,
    targetDealIds: routeTargetDealIds,
    matrixToolActive,
  });
  if (matrixToolActive) {
    suppressResearchForMatrixTool(routePlan);
  }

  let prefetchedQuickLookup: QuickLookupResult = { text: "", citations: [] };
  const willRunFullResearchNow =
    !matrixToolActive && routePlan.runResearch.enabled && routePlan.runResearch.when === "now";
  if (
    !matrixToolActive &&
    routePlan.quickLookup.enabled &&
    !willRunFullResearchNow &&
    permissions.runResearch
  ) {
    prefetchedQuickLookup = await runQuickLookup({
      query: routePlan.quickLookup.query || quickLookupQuery,
      message,
      focusCompanyName: focusCompanyLabel,
      savedContext: savedLookupContextEarly,
      researchProfile: routePlan.researchProfile,
      plannerIntent: fastPlannerIntent,
    });
    if (
      !documentPrimary &&
      quickLookupWeak(prefetchedQuickLookup) &&
      modeDecision.needsWorkflow &&
      (routePlan.researchProfile === "fast" || routePlan.researchProfile === "standard") &&
      permissions.runResearch &&
      focusDealId
    ) {
      routePlan.runResearch = {
        enabled: true,
        focus: routePlan.runResearch.focus || message,
        when: "now",
      };
      if (!routePlan.researchDealIds.length) {
        routePlan.researchDealIds = routeTargetDealIds.length ? routeTargetDealIds.slice(0, 4) : [focusDealId];
      }
      toolNotes.push("Quick web check was thin; starting a short research workflow.");
    }
  }

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

  if (resolvedDocumentType?.id && permissions.generateDocuments) {
    const pickedType = resolvedDocumentType;
    const targetName = targetDeals[0]?.name ?? (primaryDeal ? companyName(primaryDeal) : null);
    actions.push({
      type: "propose_generate_document",
      label: `Generate ${pickedType.name}`,
      prompt: targetName
        ? `Draft a ${pickedType.name} for ${targetName}.\n\nUser request: ${routePlan.generateDocument.prompt}`
        : routePlan.generateDocument.prompt,
      userMessage: message,
      dealId: focusDealId,
      dealName: targetName,
      typeId: pickedType.id,
      typeName: pickedType.name,
      outputFormat: pickedType.output_format || "text",
      skipResearch: true,
      autoRun: true,
    });
    toolNotes.push(`Selected document type: ${pickedType.name}.`);
    if (!focusDealId && documentLikelyNeedsCompany(pickedType, message)) {
      toolNotes.push(`I found the "${pickedType.name}" document type, but I need to know which company to use.`);
    }
    routePlan.generateDocument.enabled = true;
  }

  if (
    !matrixToolActive &&
    !documentPrimary &&
    routePlan.runResearch.enabled &&
    routePlan.runResearch.when === "now"
  ) {
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
          focus: userResearchFocus(routePlan.runResearch.focus || message, message),
          userPrompt: message,
          dealIds: researchTargets.map((d) => d.id),
          dealNames: researchTargets.map((d) => d.name),
          researchProfile: routePlan.researchProfile,
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
  if (
    resolvedDocumentType ||
    routePlan.generateDocument.enabled ||
    (routePlan.runResearch.enabled && routePlan.runResearch.when === "now")
  ) {
    return {
      message: cleanAssistantResponse(toolNotes.length ? toolNotes.join("\n\n") : "I need a bit more direction before I can use that tool."),
      actions,
      citations: [],
      dealId: focusDealId,
    };
  }

  if (
    !matrixToolActive &&
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
      focus: userResearchFocus(routePlan.runResearch.focus || message, message),
      userPrompt: message,
      dealIds: [focusDealId],
      dealNames: [companyName(primaryDeal)],
      researchProfile: routePlan.researchProfile,
    });
  }

  const documentGenerationRequested =
    permissions.generateDocuments && messageRequestsSavedDocumentGeneration(message, docTypes);
  if (
    documentGenerationRequested &&
    !resolvedDocumentType &&
    !actions.some((action) => action.type === "propose_generate_document")
  ) {
    const targetName = targetDeals[0]?.name ?? (primaryDeal ? companyName(primaryDeal) : null);
    return {
      message: cleanAssistantResponse(formatTypeClarificationMessage(docTypes)),
      actions: buildDocumentPickerActions({
        types: docTypes,
        message,
        dealId: focusDealId,
        dealName: targetName,
        autoRun: false,
      }),
      citations: [],
      dealId: focusDealId,
    };
  }

  const savedLookupContext = [
    JSON.stringify(snapshot, null, 2).slice(0, 2500),
    formatChunks(factChunks.slice(0, 3)),
    formatDocChunks(docChunks.slice(0, 2), docs),
  ].filter(Boolean).join("\n\n");
  const [similarPeers, criteriaContext, quickLookupResult] = await Promise.all([
    matrixToolActive
      ? Promise.resolve([])
      : routePlan.useSimilarCompanies
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
    !matrixToolActive && routePlan.quickLookup.enabled
      ? prefetchedQuickLookup.text || prefetchedQuickLookup.citations.length
        ? Promise.resolve(prefetchedQuickLookup)
        : runQuickLookup({
            query: buildQuickLookupQuery({
              message: routePlan.quickLookup.query || message,
              companyName: primaryDeal ? companyName(primaryDeal) : null,
              intent: fastPlannerIntent,
            }),
            message,
            focusCompanyName: primaryDeal ? companyName(primaryDeal) : null,
            savedContext: savedLookupContext,
            researchProfile: routePlan.researchProfile,
            plannerIntent: fastPlannerIntent,
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
- Never draft a full memo, report, brief, or other standalone document in chat text when document generation is prepared or requested. The workspace only generates files through saved document types.
- Do not say a tool has finished until the completed action result is present. You may say you are starting selected tool actions now.
- Write like a normal chat assistant in plain conversational text. Do not use formatting syntax, headings, bold text, star bullets, numbered lists, tables, code fences, or link markup. If the user asks for structure, use short plain-text paragraphs with simple labels.
- Only use retrieved company/person context when it actually answers the user's question. For questions about the user, do not infer identity from company records.
- If a focused company is set, answer about that company by default. Do not answer with another company's facts unless the user explicitly asks for comparisons, competitors, peers, benchmarks, similar companies, portfolio-wide analysis, or all-company context.
- If the focused company's context does not contain the requested fact, check the quick web lookup result first before saying you do not know. Do not fill the gap using another company's context. If research has been prepared, mention that you started it.
- If a quick web lookup result is present, use it to answer directly. Do not describe it as a research plan or say you only have saved context when web evidence is available.
- Focus on the user's actual question or command. Do not summarize company background, facts, or research unless that directly answers what they asked.
- When the user asks for a company analysis, structure the answer around relevant schema buckets rather than generic startup prose.
- Always separate evidence-backed facts from unknowns, gaps, and negative aspects.
- When facts are missing, prefer proposing/focusing research on the missing schema field instead of filling the gap with guesses.
- When saved matrix data is present, use it for comparisons and matrix-specific questions. If matrix cells are empty for the asked dimension, say so and offer to create or fill a matrix — do not guess. Do not paste markdown/ASCII tables in your reply; the UI shows a matrix card and open link when available.
- Do not overwrite or reinterpret user preference rules as company facts. Investment preferences are decision guidance; company facts need citations or saved context.

${dealLine}
Cross-company context allowed: ${crossCompanyContextAllowed ? "yes" : "no"}
${matrixToolBrief ? `\n${matrixToolBrief}\n` : ""}
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

Quick web lookup result (use this for current public facts; prefer over stale saved context when they conflict):
${quickLookupResult.text || "(not requested or no quick lookup result)"}

Saved matrix / tabular review data (prefer these values for cross-company comparisons when present; do not invent matrix values):
${matrixContextText || "(not loaded for this turn)"}

Actions already taken or prepared:
${actions.length ? actions.map((a) => `- ${a.label}: ${actionSummary(a)}`).join("\n") : "(none)"}

Tool preparation notes:
${toolNotes.length ? toolNotes.map((n) => `- ${n}`).join("\n") : "(none)"}

User message:
${message}

Respond conversationally and directly to the user's actual request. If you used context, mention the basis briefly. If a quick lookup answered the question, just answer it. If a generated document, saved workflow, or research workflow is prepared, say the user can confirm the button to run it. If a matrix was already created (open-matrix link in actions), say it is ready to open and fill — do not suggest running research first. If record updates were applied, say they were applied. If a matrix snapshot card or open-matrix link is shown, summarize insights in prose and point the user to the card/link — never reproduce the table in the message body. If you found documents or matrix links, tell the user which links are available. Do not invent facts.`;

  if (args.onAssistantDelta) {
    let response = "";
    for await (const chunk of vertexStreamText(chatModelForTask(task, routePlan.researchProfile), prompt, false)) {
      response += chunk;
      args.onAssistantDelta(chunk);
    }
    const finalMessage = cleanAssistantResponse(response || "I could not produce a response.");
    const citations = await citationsActuallyUsedInAnswer({
      answer: finalMessage,
      userMessage: message,
      factChunks,
      docChunks,
      docs,
      webCitations: quickLookupResult.citations,
    });
    return {
      message: finalMessage,
      actions,
      citations,
      dealId: focusDealId,
    };
  }

  const response = await vertexRunWithText(chatModelForTask(task, routePlan.researchProfile), prompt, false);
  // Use a conservative citation filter in every mode. Retrieved context is not
  // enough: only sources that directly support claims in the final answer should
  // be returned to the UI.
  let finalMessage: string;
  let citations: ChatCitation[];
  if (deepMode) {
    finalMessage = await polishPlainTextResponse(response || "I could not produce a response.", message);
  } else {
    finalMessage = cleanAssistantResponse(response || "I could not produce a response.");
  }
  citations = await citationsActuallyUsedInAnswer({
    answer: finalMessage,
    userMessage: message,
    factChunks,
    docChunks,
    docs,
    webCitations: quickLookupResult.citations,
  });
  return {
    message: finalMessage,
    actions,
    citations,
    dealId: focusDealId,
  };
}
