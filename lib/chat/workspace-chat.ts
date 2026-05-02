import type { SupabaseClient } from "@supabase/supabase-js";
import { parseJsonFromResponseOrNull, parseJsonFromResponseWithRepair } from "@/lib/gemini";
import { classifyChatTaskWithGemma, chatModelForTask, retrieveLimitForTask } from "@/lib/chat-router-gemma";
import { retrieveContextNodesForQuery, type ContextChunk } from "@/lib/retrieval-orchestrator";
import { vectorParam } from "@/lib/data-layer/shared/vector";
import { embedText } from "@/lib/vertex-embeddings";
import { vertexRunWithText } from "@/lib/vertex";

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
      type: "record_update";
      label: string;
      detail: string;
    };

export type ChatCitation = {
  label: string;
  href?: string;
  snippet: string;
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

type ChatIntentPlan = {
  intent: "answer" | "open_document" | "update_records" | "mixed";
  updates: PlannedUpdate[];
  document_query: string | null;
};

type ToolProposalPlan = {
  wantsDocument: boolean;
  wantsResearch: boolean;
  documentPrompt: string;
  documentTypeHint: string | null;
  researchFocus: string;
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

async function planChatIntent(message: string): Promise<ChatIntentPlan> {
  const prompt = `Classify the user's workspace chat request and extract safe tool actions.

Return strict JSON only:
{
  "intent": "answer" | "open_document" | "update_records" | "mixed",
  "document_query": string | null,
  "updates": [
    { "target": ${UPDATE_TARGETS.map((x) => `"${x}"`).join(" | ")}, "value": string }
  ]
}

Rules:
- Extract updates only when the user explicitly asks to update/set/change/add/save a record or says new info should be recorded.
- Do not infer updates from ordinary questions.
- For crm_stage, value must be one of screened, in_process, invested, passed.
- If the user asks to open/show/view a document, set document_query to the title/description they gave.
- If no tool is needed, intent is "answer" and updates is [].

User message:
${message.slice(0, 4000)}`;
  try {
    const raw = await vertexRunWithText(process.env.GEMINI_MODEL_FLASH_LITE || "gemini-2.5-flash-lite", prompt, false);
    const parsed = (parseJsonFromResponseOrNull(raw) ?? (await parseJsonFromResponseWithRepair(raw))) as Record<string, unknown> | null;
    const intentRaw = String(parsed?.intent ?? "answer");
    const intent = ["answer", "open_document", "update_records", "mixed"].includes(intentRaw)
      ? (intentRaw as ChatIntentPlan["intent"])
      : "answer";
    const updatesRaw = Array.isArray(parsed?.updates) ? parsed.updates : [];
    const updates: PlannedUpdate[] = [];
    for (const u of updatesRaw) {
      const o = u && typeof u === "object" ? (u as Record<string, unknown>) : {};
      const target = String(o.target ?? "") as UpdateTarget;
      const value = typeof o.value === "string" ? o.value.trim() : "";
      if (!UPDATE_TARGETS.includes(target) || !value) continue;
      if (target === "deal.crm_stage" && !STAGES.has(value)) continue;
      updates.push({ target, value: value.slice(0, 1200) });
      if (updates.length >= 5) break;
    }
    return {
      intent,
      updates,
      document_query: typeof parsed?.document_query === "string" && parsed.document_query.trim()
        ? parsed.document_query.trim().slice(0, 300)
        : null,
    };
  } catch {
    const lower = message.toLowerCase();
    const wantsDoc = /\b(open|show|view)\b.*\b(doc|deck|pdf|document|file)\b/.test(lower);
    return { intent: wantsDoc ? "open_document" : "answer", updates: [], document_query: wantsDoc ? message : null };
  }
}

async function planToolProposals(message: string): Promise<ToolProposalPlan> {
  const prompt = `Classify whether the user is asking the workspace chat assistant to prepare a document generation run or a research planning run.

Return strict JSON only:
{
  "wantsDocument": boolean,
  "wantsResearch": boolean,
  "documentPrompt": string,
  "documentTypeHint": string | null,
  "researchFocus": string
}

Rules:
- wantsDocument is true only if the user wants to create, draft, write, generate, or make a report, memo, document, brief, analysis, profile, or similar deliverable.
- documentPrompt should be the user's requested document, preserving important details.
- documentTypeHint is a short phrase for the desired reusable document type when one is implied, such as "competitor analysis report" or "investment memo"; otherwise null.
- wantsResearch is true when the user asks to research, investigate, look into, find, verify, or gather information.
- researchFocus should be a concise description of what research should focus on. If the user asks for a document and research is only incidental, wantsResearch should be false.
- Do not classify ordinary questions as tool requests.

User message:
${message.slice(0, 4000)}`;
  try {
    const raw = await vertexRunWithText(process.env.GEMINI_MODEL_FLASH_LITE || "gemini-2.5-flash-lite", prompt, false);
    const parsed = (parseJsonFromResponseOrNull(raw) ?? (await parseJsonFromResponseWithRepair(raw))) as Record<string, unknown> | null;
    return {
      wantsDocument: parsed?.wantsDocument === true,
      wantsResearch: parsed?.wantsResearch === true,
      documentPrompt:
        typeof parsed?.documentPrompt === "string" && parsed.documentPrompt.trim()
          ? parsed.documentPrompt.trim().slice(0, 2000)
          : message,
      documentTypeHint:
        typeof parsed?.documentTypeHint === "string" && parsed.documentTypeHint.trim()
          ? parsed.documentTypeHint.trim().slice(0, 160)
          : null,
      researchFocus:
        typeof parsed?.researchFocus === "string" && parsed.researchFocus.trim()
          ? parsed.researchFocus.trim().slice(0, 600)
          : message.slice(0, 600),
    };
  } catch {
    const lower = message.toLowerCase();
    const wantsDocument =
      /\b(make|create|draft|generate|write|prepare)\b/.test(lower) &&
      /\b(report|memo|document|doc|brief|analysis|profile|writeup)\b/.test(lower);
    const wantsResearch = /\b(research|investigate|look into|find out|verify|gather)\b/.test(lower);
    return {
      wantsDocument,
      wantsResearch: wantsResearch && !wantsDocument,
      documentPrompt: message.slice(0, 2000),
      documentTypeHint: wantsDocument ? message.slice(0, 160) : null,
      researchFocus: message.slice(0, 600),
    };
  }
}

function buildToolActions(args: {
  message: string;
  toolPlan: ToolProposalPlan;
  focusDeal: DealRow | null;
  requestedDealId: string | null;
  allDeals: Array<{ id: string; name: string }>;
  docTypes: DocumentTypeSummary[];
}): { actions: ChatAction[]; notes: string[]; inferredDealId: string | null } {
  const actions: ChatAction[] = [];
  const notes: string[] = [];
  const matchedDeals = matchDealsFromMessage(args.allDeals, args.message);
  const selectedDeal = args.focusDeal
    ? { id: args.focusDeal.id, name: companyName(args.focusDeal) }
    : args.requestedDealId
      ? args.allDeals.find((d) => d.id === args.requestedDealId) ?? null
      : null;
  const targetDeals = selectedDeal ? [selectedDeal] : matchedDeals;
  const inferredDealId = selectedDeal?.id ?? (matchedDeals.length === 1 ? matchedDeals[0]?.id ?? null : null);

  if (args.toolPlan.wantsDocument) {
    const pickedType = pickDocumentType(args.docTypes, args.message, args.toolPlan.documentTypeHint);
    if (!pickedType) {
      notes.push(
        args.docTypes.length
          ? "I can generate this, but I am not confident which saved document type to use. Pick one or tell me to make whatever."
          : "I do not see a saved document type yet. You can open the generator to add a template, or tell me to make whatever and create a reusable type first.",
      );
      actions.push({
        type: "open_link",
        label: "Open document generator",
        href: inferredDealId ? `/home/document-generator?dealId=${inferredDealId}` : "/home/document-generator",
        detail: "Set up or choose the document type before generation.",
      });
    } else if (!inferredDealId && documentLikelyNeedsCompany(pickedType, args.message)) {
      notes.push(`I found the "${pickedType.name}" document type, but I need to know which company to use before generating it.`);
    } else {
      const docPrompt = targetDeals[0]?.name
        ? `Draft a ${pickedType.name} for ${targetDeals[0].name}.\n\nUser request: ${args.message}`
        : args.message;
      actions.push({
        type: "propose_generate_document",
        label: `Generate ${pickedType.name}`,
        prompt: docPrompt,
        dealId: inferredDealId,
        dealName: targetDeals[0]?.name ?? null,
        typeId: pickedType.id,
        typeName: pickedType.name,
        outputFormat: pickedType.output_format || "markdown",
      });
      notes.push(
        `I found a likely document type: ${pickedType.name}${targetDeals[0]?.name ? ` for ${targetDeals[0].name}` : ""}.`,
      );
    }
  }

  if (args.toolPlan.wantsResearch) {
    if (!targetDeals.length) {
      notes.push("I can prepare the research plan, but I need to know which company or companies it should be for.");
    } else {
      actions.push({
        type: "propose_research",
        label: targetDeals.length === 1 ? `Run research plan for ${targetDeals[0]!.name}` : `Run research plans for ${targetDeals.length} companies`,
        focus: args.toolPlan.researchFocus || args.message,
        dealIds: targetDeals.map((d) => d.id),
        dealNames: targetDeals.map((d) => d.name),
      });
      notes.push(
        targetDeals.length === 1
          ? `I can generate a focused research workflow for ${targetDeals[0]!.name}.`
          : `I can generate focused research workflows for ${targetDeals.map((d) => d.name).join(", ")}.`,
      );
    }
  }

  return { actions, notes, inferredDealId };
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
  return "";
}

function confirmationMessage(actions: ChatAction[], notes: string[]): string | null {
  const hasToolProposal = actions.some(
    (a) =>
      a.type === "propose_generate_document" ||
      a.type === "propose_research" ||
      a.type === "propose_record_update",
  );
  if (!hasToolProposal) return null;

  const doc = actions.find((a): a is Extract<ChatAction, { type: "propose_generate_document" }> => a.type === "propose_generate_document");
  if (doc) {
    return [
      `I found the "${doc.typeName}" doc type${doc.dealName ? ` for ${doc.dealName}` : ""}.`,
      "Click the button below when you want me to generate it.",
    ].join("\n\n");
  }

  const research = actions.find((a): a is Extract<ChatAction, { type: "propose_research" }> => a.type === "propose_research");
  if (research) {
    return [
      research.dealNames.length === 1
        ? `I can generate a research plan for ${research.dealNames[0]}.`
        : `I can generate research plans for ${research.dealNames.join(", ")}.`,
      "Click the button below to create the plan.",
    ].join("\n\n");
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
}): Promise<{ message: string; actions: ChatAction[]; citations: ChatCitation[]; dealId: string | null }> {
  const message = args.message.trim();
  if (!message) return { message: "What would you like to look into?", actions: [], citations: [], dealId: args.dealId ?? null };

  const [deal, plan, task, allDeals, docTypes, toolPlan] = await Promise.all([
    resolveDeal(args.admin, args.userId, args.dealId ?? null, message),
    planChatIntent(message),
    classifyChatTaskWithGemma(message),
    listChatDeals(args.admin, args.userId),
    loadDocumentTypes(args.admin, args.userId),
    planToolProposals(message),
  ]);
  const toolPrep = buildToolActions({
    message,
    toolPlan,
    focusDeal: deal,
    requestedDealId: args.dealId ?? null,
    allDeals,
    docTypes,
  });
  const focusDealId = deal?.id ?? toolPrep.inferredDealId ?? args.dealId ?? null;

  const [docs, snapshot, factChunks, docChunks] = await Promise.all([
    loadDocuments(args.admin, args.userId, focusDealId),
    loadDealSnapshot(args.admin, focusDealId),
    retrieveContextNodesForQuery(args.admin, {
      userId: args.userId,
      queryText: message,
      chatTask: task,
      limit: retrieveLimitForTask(task),
      focusDealId,
    }).catch(() => []),
    retrieveDocumentChunks(args.admin, { userId: args.userId, queryText: message, dealId: focusDealId, limit: 8 }),
  ]);

  let actions: ChatAction[] = [...toolPrep.actions];
  if ((plan.intent === "open_document" || plan.intent === "mixed") && docs.length) {
    const picked = pickDocuments(docs, plan.document_query || message, 5);
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

  if ((plan.intent === "update_records" || plan.intent === "mixed") && plan.updates.length) {
    if (!deal) {
      actions.push({ type: "record_update", label: "Record update skipped", detail: "Pick a company before updating records." });
    } else {
      actions.push({
        type: "propose_record_update",
        label: `Apply ${plan.updates.length} record update${plan.updates.length === 1 ? "" : "s"}`,
        dealId: deal.id,
        dealName: companyName(deal),
        updates: plan.updates,
      });
    }
  }

  const preparedMessage = confirmationMessage(actions, toolPrep.notes);
  if (preparedMessage) {
    return {
      message: preparedMessage,
      actions,
      citations: [],
      dealId: focusDealId,
    };
  }
  if (toolPlan.wantsDocument || toolPlan.wantsResearch) {
    return {
      message: toolPrep.notes.length ? toolPrep.notes.join("\n\n") : "I need a bit more direction before I can prepare that tool action.",
      actions,
      citations: [],
      dealId: focusDealId,
    };
  }

  const recentHistory = (args.history ?? [])
    .slice(-8)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 1200)}`)
    .join("\n");
  const dealLine = deal ? `Focused company: ${companyName(deal)} (${deal.id})` : "Focused company: none / workspace-wide";
  const prompt = `You are the user's VC workspace chat assistant.

Capabilities available in this turn:
- Answer using retrieved CRM facts and document snippets.
- Surface links to saved documents when relevant.
- Prepare document generation, research planning, and record-update actions for user confirmation.
- Do not say a tool has run unless the action label says it already completed. Most tool actions are proposals that the user still needs to confirm.

${dealLine}
Task route: ${task}

Recent chat:
${recentHistory || "(none)"}

Deal snapshot:
${JSON.stringify(snapshot, null, 2).slice(0, 6000)}

Retrieved fact context:
${formatChunks(factChunks) || "(none)"}

Retrieved document context:
${formatDocChunks(docChunks, docs) || "(none)"}

Actions already taken or prepared:
${actions.length ? actions.map((a) => `- ${a.label}: ${actionSummary(a)}`).join("\n") : "(none)"}

Tool preparation notes:
${toolPrep.notes.length ? toolPrep.notes.map((n) => `- ${n}`).join("\n") : "(none)"}

User message:
${message}

Respond conversationally and directly. If you used context, mention the basis briefly. If a generated document, research workflow, or record update is prepared, clearly say it is ready for confirmation rather than already done. If you found documents, tell the user which links are available. Do not invent facts.`;

  const response = await vertexRunWithText(chatModelForTask(task), prompt, false);
  return {
    message: response || "I could not produce a response.",
    actions,
    citations: citationsFromContext(factChunks, docChunks, docs),
    dealId: focusDealId,
  };
}
