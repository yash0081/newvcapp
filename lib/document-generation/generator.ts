import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseJsonFromResponseOrNull, parseJsonFromResponseWithRepair } from "@/lib/gemini";
import { vertexRunWithTextMulti } from "@/lib/vertex";
import { getResearchModel } from "@/lib/research/research-model-env";

export type DocumentTypeRow = {
  id: string;
  user_id: string;
  name: string;
  output_format: "markdown" | "docx" | "pdf" | "text";
  description: string;
  instructions: string;
  learned_preferences: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

export type DocumentReferenceRow = {
  id: string;
  type_id: string;
  kind: "description" | "template" | "sample" | "notes";
  filename: string | null;
  content: string;
  created_at: string;
};

export type MissingInfoItem = {
  field: string;
  reason: string;
  importance: "high" | "medium" | "low";
};

export type SuggestedResearchStep = {
  task: string;
  sourceHint: string;
  reason: string;
};

export type PreflightResult = {
  enoughInfo: boolean;
  missingInfo: MissingInfoItem[];
  researchSteps: SuggestedResearchStep[];
  rationale: string;
};

type DealRow = {
  id: string;
  metadata: Record<string, unknown> | null;
};

function safeMeta(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function clampText(s: string, n: number): string {
  return s.trim().slice(0, n);
}

async function loadDeal(admin: SupabaseClient, userId: string, dealId: string | null): Promise<DealRow | null> {
  if (!dealId) return null;
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

export async function loadDocumentType(
  admin: SupabaseClient,
  userId: string,
  typeId: string,
): Promise<DocumentTypeRow | null> {
  const res = await admin
    .schema("deal_intel")
    .from("document_generation_type")
    .select("id, user_id, name, output_format, description, instructions, learned_preferences, metadata, created_at, updated_at")
    .eq("id", typeId)
    .eq("user_id", userId)
    .maybeSingle();
  if (res.error) throw res.error;
  return (res.data as DocumentTypeRow | null) ?? null;
}

export async function loadTypeReferences(
  admin: SupabaseClient,
  userId: string,
  typeId: string,
): Promise<DocumentReferenceRow[]> {
  const res = await admin
    .schema("deal_intel")
    .from("document_generation_reference")
    .select("id, type_id, kind, filename, content, created_at")
    .eq("type_id", typeId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (res.error) throw res.error;
  return (res.data ?? []) as DocumentReferenceRow[];
}

async function loadDealSnapshot(admin: SupabaseClient, dealId: string | null): Promise<Record<string, unknown>> {
  if (!dealId) return {};
  const di = admin.schema("deal_intel");
  const [problem, solution, traction, people, claims] = await Promise.all([
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
      .from("claim")
      .select("key, value_text, claim_type")
      .eq("deal_id", dealId)
      .order("created_at", { ascending: false })
      .limit(40),
  ]);
  return {
    problem: problem.data ?? null,
    solution: solution.data ?? null,
    traction: traction.data ?? null,
    people: people.data ?? [],
    claims: claims.data ?? [],
  };
}

async function loadDocumentContext(admin: SupabaseClient, userId: string, dealId: string | null, query: string) {
  if (!dealId || !query.trim()) return [];
  const fts = await admin.rpc("deal_intel_match_document_chunks_fts", {
    p_user_id: userId,
    p_query: query.slice(0, 500),
    p_match_count: 10,
    p_deal_id: dealId,
  });
  if (fts.error) return [];
  return ((fts.data ?? []) as Array<{ document_id: string; page_start: number; page_end: number; text: string; score: number }>)
    .map((r) => ({
      document_id: r.document_id,
      pages: `${r.page_start}-${r.page_end}`,
      text: clampText(r.text ?? "", 1200),
      score: Number(r.score ?? 0),
    }))
    .filter((r) => r.text);
}

export async function buildGenerationContext(args: {
  admin: SupabaseClient;
  userId: string;
  dealId: string | null;
  type: DocumentTypeRow;
  prompt: string;
}) {
  const [deal, references] = await Promise.all([
    loadDeal(args.admin, args.userId, args.dealId),
    args.type.id ? loadTypeReferences(args.admin, args.userId, args.type.id) : Promise.resolve([]),
  ]);
  const [snapshot, documentChunks] = await Promise.all([
    loadDealSnapshot(args.admin, deal?.id ?? null),
    loadDocumentContext(args.admin, args.userId, deal?.id ?? null, `${args.type.name} ${args.prompt}`),
  ]);
  return {
    deal,
    dealMetadata: safeMeta(deal?.metadata),
    snapshot,
    references: references.map((r) => ({
      kind: r.kind,
      filename: r.filename,
      content: clampText(r.content, 5000),
    })),
    documentChunks,
  };
}

function parsePreflight(raw: string): PreflightResult | null {
  const parsed = parseJsonFromResponseOrNull(raw) as Record<string, unknown> | null;
  if (!parsed) return null;
  const missing = Array.isArray(parsed.missingInfo) ? parsed.missingInfo : [];
  const steps = Array.isArray(parsed.researchSteps) ? parsed.researchSteps : [];
  return {
    enoughInfo: Boolean(parsed.enoughInfo),
    rationale: asString(parsed.rationale),
    missingInfo: missing
      .map((m) => {
        const x = safeMeta(m);
        const importance = asString(x.importance);
        return {
          field: asString(x.field),
          reason: asString(x.reason),
          importance: importance === "high" || importance === "medium" || importance === "low" ? importance : "medium",
        } satisfies MissingInfoItem;
      })
      .filter((m) => m.field && m.reason)
      .slice(0, 8),
    researchSteps: steps
      .map((s) => {
        const x = safeMeta(s);
        return {
          task: asString(x.task),
          sourceHint: asString(x.sourceHint) || "web",
          reason: asString(x.reason),
        } satisfies SuggestedResearchStep;
      })
      .filter((s) => s.task)
      .slice(0, 8),
  };
}

export async function preflightDocument(args: {
  admin: SupabaseClient;
  userId: string;
  dealId: string | null;
  type: DocumentTypeRow;
  prompt: string;
}): Promise<PreflightResult> {
  const ctx = await buildGenerationContext(args);
  const raw = await vertexRunWithTextMulti(
    getResearchModel("flash_lite"),
    `Decide whether we have enough information to draft the requested document.
Return strict JSON:
{
  "enoughInfo": true,
  "rationale": "short explanation",
  "missingInfo": [{"field":"...","reason":"...","importance":"high|medium|low"}],
  "researchSteps": [{"task":"concrete research task","sourceHint":"web or specific source only if truly required","reason":"..."}]
}
Rules:
- Only mark missing information that materially affects document quality.
- Suggest research steps only for high/medium missing info.
- sourceHint should usually be "web"; use a specific source only when the task truly requires it.
- The user may skip research, so enoughInfo=false should not block drafting.`,
    [
      { label: "Document type", value: args.type },
      { label: "User prompt", value: args.prompt },
      { label: "Context", value: ctx },
    ],
    false,
  );
  return parsePreflight(raw) ?? {
    enoughInfo: true,
    rationale: "Could not parse preflight, allowing generation.",
    missingInfo: [],
    researchSteps: [],
  };
}

function parseGenerated(raw: string): { title: string; content: string } | null {
  const parsed = parseJsonFromResponseOrNull(raw) as Record<string, unknown> | null;
  if (!parsed) return null;
  const content = asString(parsed.content);
  if (!content.trim()) return null;
  return {
    title: asString(parsed.title) || "Generated document",
    content,
  };
}

export async function generateDocumentContent(args: {
  admin: SupabaseClient;
  userId: string;
  dealId: string | null;
  type: DocumentTypeRow;
  prompt: string;
  preflight?: PreflightResult | null;
}) {
  const ctx = await buildGenerationContext(args);
  const raw = await vertexRunWithTextMulti(
    getResearchModel("flash"),
	    `Draft a high-quality business document.
	Return strict JSON:
	{
	  "title": "short document title",
	  "content": "complete plain text document"
	}
	Rules:
	- Follow the saved document type instructions, examples, and learned preferences.
	- The requested output format for this document type is in Document type.output_format. Use regular plain text as the editable preview representation, but structure the content for that final format.
	- Do not use Markdown syntax, markdown headings, bold markers, code fences, or link markup.
	- Use the available company facts and cited source context. Do not invent precise facts.
	- If important information is missing, include a short "Open questions" section instead of fabricating.
	- Keep the output directly usable, polished, and specific to the user's prompt.
- Do not include commentary outside the document.`,
    [
      { label: "Document type", value: args.type },
      { label: "User prompt", value: args.prompt },
      { label: "Preflight", value: args.preflight ?? null },
      { label: "Context", value: ctx },
    ],
    false,
  );
  const parsed =
    parseGenerated(raw) ??
    parseGenerated(JSON.stringify((await parseJsonFromResponseWithRepair(raw).catch(() => null)) ?? null));
  if (parsed) return parsed;
  return { title: `${args.type.name} draft`, content: raw.trim() || "No usable draft was generated." };
}

export async function reviseDocumentContent(args: {
  admin: SupabaseClient;
  userId: string;
  draftId: string;
  instruction: string;
}) {
  const draftRes = await args.admin
    .schema("deal_intel")
    .from("generated_document_draft")
    .select("id, user_id, deal_id, type_id, title, prompt, content, metadata")
    .eq("id", args.draftId)
    .eq("user_id", args.userId)
    .maybeSingle();
  if (draftRes.error) throw draftRes.error;
  const draft = draftRes.data as
    | { id: string; deal_id: string | null; type_id: string | null; title: string; prompt: string; content: string; metadata: Record<string, unknown> | null }
    | null;
  if (!draft) throw new Error("Draft not found");
  const type = draft.type_id ? await loadDocumentType(args.admin, args.userId, draft.type_id) : null;

  const raw = await vertexRunWithTextMulti(
    getResearchModel("flash"),
	    `Revise this generated document.
	Return strict JSON:
	{
	  "title": "updated title",
	  "content": "full revised plain text document",
	  "savePreference": true,
	  "preference": "general reusable preference if relevant, otherwise blank"
	}
	Rules:
	- Apply the requested modification to the full document.
	- Do not use Markdown syntax, markdown headings, bold markers, code fences, or link markup.
	- savePreference should be true only when the instruction is reusable for future documents of this type.
- The preference must be concise and format/style/content guidance, not deal-specific facts.`,
    [
      { label: "Document type", value: type },
      { label: "Current title", value: draft.title },
      { label: "Current document", value: draft.content },
      { label: "Revision instruction", value: args.instruction },
    ],
    false,
  );
  const parsed = (parseJsonFromResponseOrNull(raw) ?? (await parseJsonFromResponseWithRepair(raw))) as Record<string, unknown> | null;
  const title = asString(parsed?.title) || draft.title;
  const content = asString(parsed?.content) || draft.content;
  const preference = asString(parsed?.preference).trim();
  const savePreference = Boolean(parsed?.savePreference && preference && draft.type_id);

  await args.admin
    .schema("deal_intel")
    .from("generated_document_draft")
    .update({ title, content, status: "ready" })
    .eq("id", draft.id)
    .eq("user_id", args.userId);

  await args.admin.schema("deal_intel").from("generated_document_feedback").insert({
    draft_id: draft.id,
    type_id: draft.type_id,
    user_id: args.userId,
    instruction: args.instruction,
    saved_to_type: savePreference,
  });

  if (savePreference && type && draft.type_id) {
    const nextPrefs = `${type.learned_preferences || ""}\n- ${preference}`.trim().slice(-8000);
    await args.admin
      .schema("deal_intel")
      .from("document_generation_type")
      .update({ learned_preferences: nextPrefs })
      .eq("id", draft.type_id)
      .eq("user_id", args.userId);
  }

  return { title, content, savedPreference: savePreference ? preference : null };
}
