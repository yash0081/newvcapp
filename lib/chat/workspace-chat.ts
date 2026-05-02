import type { SupabaseClient } from "@supabase/supabase-js";
import { parseJsonFromResponseOrNull, parseJsonFromResponseWithRepair } from "@/lib/gemini";
import { classifyChatTaskWithGemma, chatModelForTask, retrieveLimitForTask } from "@/lib/chat-router-gemma";
import { retrieveContextNodesForQuery, type ContextChunk } from "@/lib/retrieval-orchestrator";
import { vectorParam } from "@/lib/data-layer/shared/vector";
import { embedText } from "@/lib/vertex-embeddings";
import { vertexRunWithText } from "@/lib/vertex";
import { fetchSimilarDealsFromDealId } from "@/lib/similar-deals/fetch-from-deal";
import { fetchSimilarDealsHybrid } from "@/lib/similar-deals/fetch-hybrid";
import type { SimilarPeerForPrompt } from "@/lib/similar-deals/types";
import { loadAggregatedRulesForUser } from "@/lib/investment-rules";
import { listCustomWorkflowDefinitions, type CustomWorkflowDefinition } from "@/lib/custom-workflows";

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type ChatAction =
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
      typeId: string;
      typeName: string;
      outputFormat: string;
      skipResearch?: boolean;
    }
  | {
      type: "propose_research";
      label: string;
      focus: string;
      dealIds: string[];
      dealNames: string[];
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
};

export const DEFAULT_CHAT_TOOL_PERMISSIONS: ChatToolPermissions = {
  generateDocuments: true,
  runResearch: true,
  editRecords: true,
  createCompanies: true,
  useSimilarCompanySearch: true,
  useCriteriaAnalysis: true,
  runWorkflows: true,
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
  | "traction.revenue_data"
  | "traction.customer_size_and_count"
  | "traction.growth_trends_description"
  | "traction.company_stage"
  | "traction.product_stage"
  | "problem.general_problem_description"
  | "solution.general_description"
  | "solution.defensibility";

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
  missingInfoBehavior: "answer_unknown" | "research" | "ask_clarifying";
};

const UPDATE_TARGETS: UpdateTarget[] = [
  "deal.company_name",
  "deal.website",
  "deal.crm_stage",
  "traction.revenue_data",
  "traction.customer_size_and_count",
  "traction.growth_trends_description",
  "traction.company_stage",
  "traction.product_stage",
  "problem.general_problem_description",
  "solution.general_description",
  "solution.defensibility",
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
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/\s+\*\s+/g, " ")
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
    customWorkflow: { enabled: false, workflowId: null, input: args.message },
    quickLookup: { enabled: false, query: args.message },
    useSimilarCompanies: args.chatTask === "similar_deal",
    useCriteria: false,
    missingInfoBehavior: "answer_unknown",
  };
}

async function planSmartChatRoute(args: {
  message: string;
  history: ChatMessage[];
  focusDeal: DealRow | null;
  allDeals: Array<{ id: string; name: string }>;
  docTypes: DocumentTypeSummary[];
  customWorkflows: CustomWorkflowDefinition[];
  permissions: ChatToolPermissions;
  fallbackTask: ChatRoutePlan["chatTask"];
}): Promise<ChatRoutePlan> {
  const focusName = args.focusDeal ? companyName(args.focusDeal) : null;
  const prompt = `You are the tool router for a VC workspace chat assistant.

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
  "customWorkflow": { "enabled": boolean, "workflowId": string | null, "input": string },
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
- Use generateDocument when the user wants a memo, report, brief, analysis document, email, or other generated deliverable.
- Use quickLookup for one-off factual/current-public-web questions that likely need only one search, such as current CEO, latest funding round, headquarters, recent news, a single metric, or a simple verification. quickLookup answers directly; it does not create a research workflow.
- Use runResearch for broader or multi-step diligence, such as building a research plan, funding history, competitor landscape, customer evidence, founder background, market sizing, or any task that needs several searches/sources/subquestions. Use when="if_missing_info" only when the saved focused-company context may be insufficient and a fuller workflow is the right next step.
- Use customWorkflow when the user asks to run a saved/reusable workflow, playbook, process, or their request clearly matches a workflow trigger/description. Choose exactly one workflow id from Available workflows. This workflow will run automatically.
- Do not set both quickLookup and runResearch unless the user asks for a direct answer now plus deeper follow-up research.
- Do not set customWorkflow together with generateDocument or runResearch unless the workflow itself is not a fit and the user separately asks for another tool.
- Use useSimilarCompanies for similar companies, comps, peers, comparables, or competitor benchmarking.
- Use useCriteria for thesis fit, uploaded criteria, investment evaluation, scoring, pass/invest reasoning, or criteria-based analysis.
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
  const steps = w.steps.map((s, i) => `${i + 1}. ${s.type}: ${s.title}`).join("; ");
  return `- ${w.name} (${w.id}) description=${w.description || ""} trigger=${w.trigger_hint || ""} steps=${steps}`;
}).join("\n").slice(0, 5000) || "(none)"}

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
    return {
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
      missingInfoBehavior: missingRaw === "research" || missingRaw === "ask_clarifying" ? missingRaw : "answer_unknown",
    };
  } catch {
    return fallbackRoutePlan({
      message: args.message,
      focusDeal: args.focusDeal,
      allDeals: args.allDeals,
      chatTask: args.fallbackTask,
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

  const tableGroups = new Map<"company_traction" | "company_problem" | "company_solution", Record<string, string>>();
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

function citationsFromContext(
  factChunks: ContextChunk[],
  docChunks: Array<{ document_id: string; page_start: number; page_end: number; text: string }>,
  docs: DocumentRow[],
): ChatCitation[] {
  const out: ChatCitation[] = [];
  for (const [i, c] of factChunks.slice(0, 5).entries()) {
    out.push({ label: `Fact ${i + 1}: ${c.node_type}`, snippet: (c.raw_text ?? "").slice(0, 240) });
  }
  const docById = new Map(docs.map((d) => [d.id, d]));
  for (const [i, c] of docChunks.slice(0, 5).entries()) {
    const d = docById.get(c.document_id);
    out.push({
      label: `Document ${i + 1}: ${d?.original_filename ?? c.document_id}`,
      href: hrefForDocument(c.document_id, d?.source_kind),
      snippet: c.text.slice(0, 240),
    });
  }
  return out;
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
}): Promise<string> {
  const prompt = `Answer one quick public-web lookup for a VC workspace chat.

Use Google Search grounding. Keep the answer short and direct.

Rules:
- This is a quick lookup, not a full research plan.
- Answer only the user's specific question.
- If a focused company is provided, keep the lookup about that company unless the user explicitly asked otherwise.
- Prefer current, reliable sources.
- Include source names or URLs briefly when available.
- If the web evidence is unclear or conflicting, say so plainly.

Focused company:
${args.focusCompanyName ?? "(none)"}

Saved context, if any:
${args.savedContext || "(none)"}

Lookup query:
${args.query}

Original user message:
${args.message}`;
  return vertexRunWithText(chatModelForTask("why"), prompt, true).catch(() => "");
}

function actionSummary(action: ChatAction): string {
  if (action.type === "open_document" || action.type === "open_link") return action.href;
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
  return "";
}

function confirmationMessage(actions: ChatAction[], notes: string[]): string | null {
  const hasToolProposal = actions.some(
    (a) =>
      a.type === "propose_generate_document" ||
      a.type === "propose_research" ||
      a.type === "propose_custom_workflow" ||
      a.type === "propose_record_update",
  );
  if (!hasToolProposal) return null;

  const doc = actions.find((a): a is Extract<ChatAction, { type: "propose_generate_document" }> => a.type === "propose_generate_document");
  if (doc) {
    return [
      `I found the "${doc.typeName}" doc type${doc.dealName ? ` for ${doc.dealName}` : ""}.`,
      "I am starting the document generation now.",
    ].join("\n\n");
  }

  const research = actions.find((a): a is Extract<ChatAction, { type: "propose_research" }> => a.type === "propose_research");
  if (research) {
    return [
      research.dealNames.length === 1
        ? `I am creating a research plan for ${research.dealNames[0]}.`
        : `I am creating research plans for ${research.dealNames.join(", ")}.`,
    ].join("\n\n");
  }

  const workflow = actions.find((a): a is Extract<ChatAction, { type: "propose_custom_workflow" }> => a.type === "propose_custom_workflow");
  if (workflow) {
    return `I found the "${workflow.workflowName}" workflow${workflow.dealName ? ` for ${workflow.dealName}` : ""}. I am running it now.`;
  }

  const update = actions.find((a): a is Extract<ChatAction, { type: "propose_record_update" }> => a.type === "propose_record_update");
  if (update) {
    return `I found ${update.updates.length} record update${update.updates.length === 1 ? "" : "s"} for ${update.dealName}. Click the button below to apply them.`;
  }

  return notes[0] ?? "I prepared an action for confirmation.";
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
}): Promise<{ message: string; actions: ChatAction[]; citations: ChatCitation[]; dealId: string | null }> {
  const message = args.message.trim();
  if (!message) return { message: "What would you like to look into?", actions: [], citations: [], dealId: args.dealId ?? null };
  const permissions = { ...DEFAULT_CHAT_TOOL_PERMISSIONS, ...(args.permissions ?? {}) };
  const history = args.history ?? [];

  const [deal, fallbackTask, allDeals, docTypes, customWorkflows] = await Promise.all([
    resolveDeal(args.admin, args.userId, args.dealId ?? null, message),
    classifyChatTaskWithGemma(message),
    listChatDeals(args.admin, args.userId),
    loadDocumentTypes(args.admin, args.userId),
    listCustomWorkflowDefinitions(args.admin, args.userId),
  ]);
  const routePlan = await planSmartChatRoute({
    message,
    history,
    focusDeal: deal,
    allDeals,
    docTypes,
    customWorkflows,
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

  if (routePlan.generateDocument.enabled && !customWorkflowSelected) {
    const pickedType = pickDocumentType(docTypes, message, routePlan.generateDocument.typeHint);
    if (!pickedType) {
      actions.push({
        type: "open_link",
        label: "Open document generator",
        href: focusDealId ? `/home/document-generator?dealId=${focusDealId}` : "/home/document-generator",
        detail: docTypes.length ? "Choose a saved document type." : "Add a document type or template.",
      });
      toolNotes.push("I could not confidently choose a saved document type.");
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
      });
      toolNotes.push(`Selected document type: ${pickedType.name}.`);
    }
  }

  if (routePlan.runResearch.enabled && routePlan.runResearch.when === "now" && !customWorkflowSelected) {
    if (!targetDeals.length && !primaryDeal) {
      toolNotes.push("I need to know which company to research.");
    } else {
      const researchTargets = targetDeals.length
        ? targetDeals
        : primaryDealId && primaryDeal
          ? [{ id: primaryDealId, name: companyName(primaryDeal) }]
          : [];
      if (researchTargets.length) {
        actions.push({
          type: "propose_research",
          label: researchTargets.length === 1 ? `Research ${researchTargets[0]!.name}` : `Research ${researchTargets.length} companies`,
          focus: routePlan.runResearch.focus || message,
          dealIds: researchTargets.map((d) => d.id),
          dealNames: researchTargets.map((d) => d.name),
        });
      }
    }
  }

  const preparedMessage = confirmationMessage(actions, toolNotes);
  if (preparedMessage) {
    return {
      message: preparedMessage,
      actions,
      citations: [],
      dealId: focusDealId,
    };
  }
  if (routePlan.generateDocument.enabled || (routePlan.runResearch.enabled && routePlan.runResearch.when === "now")) {
    return {
      message: toolNotes.length ? toolNotes.join("\n\n") : "I need a bit more direction before I can use that tool.",
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
      focus: routePlan.runResearch.focus || message,
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
      : Promise.resolve(""),
  ]);

  const recentHistory = (args.history ?? [])
    .slice(-8)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 1200)}`)
    .join("\n");
  const dealLine = primaryDeal && focusDealId ? `Focused company: ${companyName(primaryDeal)} (${focusDealId})` : "Focused company: none / workspace-wide";
  const prompt = `You are the user's VC workspace chat assistant.

The user is the investor/operator using this workspace. Company founders, executives, employees, and other people mentioned in CRM facts are not the user unless the user explicitly says so.

Capabilities available in this turn:
- Answer using retrieved CRM facts and document snippets.
- Surface links to saved documents when relevant.
- Prepare document generation, research, saved workflow, and record-update actions when the router selected a tool. The UI will run enabled tool actions automatically.
- Do not say a tool has finished until the completed action result is present. You may say you are starting selected tool actions now.
- Write like a normal chat assistant in plain conversational text. Do not use Markdown styling, headings, bold text, star bullets, or numbered lists unless the user explicitly asks for a list or structured format.
- Only use retrieved company/person context when it actually answers the user's question. For questions about the user, do not infer identity from company records.
- If a focused company is set, answer about that company by default. Do not answer with another company's facts unless the user explicitly asks for comparisons, competitors, peers, benchmarks, similar companies, portfolio-wide analysis, or all-company context.
- If the focused company's context does not contain the requested fact, say you do not know from the saved context. Do not fill the gap using another company's context. If research has been prepared, mention that you started it.
- If a quick web lookup result is present, use it to answer the simple lookup directly. Do not describe it as a research plan.

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
${quickLookupResult || "(not requested or no quick lookup result)"}

Actions already taken or prepared:
${actions.length ? actions.map((a) => `- ${a.label}: ${actionSummary(a)}`).join("\n") : "(none)"}

Tool preparation notes:
${toolNotes.length ? toolNotes.map((n) => `- ${n}`).join("\n") : "(none)"}

User message:
${message}

Respond conversationally and directly. If you used context, mention the basis briefly. If a quick lookup answered the question, just answer it. If a generated document, saved workflow, or research workflow is prepared, say you are starting it now. If record updates were applied, say they were applied. If you found documents, tell the user which links are available. Do not invent facts.`;

  const response = await vertexRunWithText(chatModelForTask(task), prompt, false);
  return {
    message: cleanAssistantResponse(response || "I could not produce a response."),
    actions,
    citations: citationsFromContext(factChunks, docChunks, docs),
    dealId: focusDealId,
  };
}
