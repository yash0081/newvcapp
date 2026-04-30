import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { chunkPageText } from "@/lib/deal-intel/chunking";
import { extractKeywords } from "@/lib/data-layer/shared/text";
import { embedText } from "@/lib/vertex-embeddings";
import { vectorParam } from "@/lib/data-layer/shared/vector";

export type AdminClient = SupabaseClient;

const EMBEDDING_MODEL = process.env.VERTEX_EMBEDDING_MODEL || "text-embedding-004";
const FAST_EMBED_CHUNK_LIMIT = Number(process.env.DEAL_INTEL_FAST_CHUNK_EMBED_LIMIT || 12);
const MAX_FAST_CHUNKS = 8;

export type IngestPage = {
  pageNumber: number;
  text: string;
  metadata?: Record<string, unknown>;
};

export type IngestTextArgs = {
  admin: AdminClient;
  userId: string;
  dealId: string;
  /** Single-page text. Ignored when `pages` is provided. */
  text?: string;
  /** Multi-page mode: provide explicit page boundaries. Required if `text` omitted. */
  pages?: IngestPage[];
  /** "web" | "copilot_session" | etc. Stored on document.source_kind. */
  sourceKind: string;
  /** Free-form classifier (e.g. "web_research", "copilot_research"). */
  docType: string;
  /** Pretty filename surfaced in the docs UI. */
  originalFilename: string;
  mimeType?: string;
  /** Storage layout used for `storage_path`/`storage_bucket`/`folder_path` columns. */
  storageBucket?: string;
  storagePathPrefix?: string;
  folderPath?: string;
  routingReason?: string;
  /** Extra context attached to document_page.metadata.kind === sourceKind. Merged with per-page metadata. */
  pageMetadata?: Record<string, unknown>;
  /** Hard cap on chunk rows (defaults to 200). */
  maxChunks?: number;
  /**
   * Override fast-path embedding count for this ingest. Pass 0 to skip
   * synchronous embeddings entirely (the worker will fill them in).
   */
  fastEmbedLimit?: number;
  /**
   * Optional precomputed chunks. Used for research-step output documents so chunks
   * can align to citation link boundaries instead of arbitrary page text slicing.
   */
  chunkTextsOverride?: string[];
};

export async function ingestTextAsDocument(args: IngestTextArgs): Promise<{ documentId: string } | null> {
  const pages: IngestPage[] = (args.pages && args.pages.length
    ? args.pages
    : [{ pageNumber: 1, text: String(args.text ?? "") }]
  )
    .map((p) => ({
      pageNumber: Math.max(1, Math.floor(p.pageNumber || 1)),
      text: String(p.text ?? "").trim(),
      metadata: p.metadata,
    }))
    .filter((p) => p.text.length > 0);
  if (pages.length === 0) return null;

  const fullText = pages.map((p) => p.text).join("\n\n");
  if (!fullText) return null;

  const sha = createHash("sha256").update(fullText).digest("hex");
  const docId = randomUUID();
  const mime = args.mimeType ?? "text/plain";
  const bucket = args.storageBucket ?? args.sourceKind;
  const prefix = args.storagePathPrefix ?? `${args.sourceKind}/${args.userId}`;
  const folder = args.folderPath ?? args.sourceKind;

  const insDoc = (await args.admin.schema("deal_intel").from("document").insert({
    id: docId,
    user_id: args.userId,
    deal_id: args.dealId,
    source_kind: args.sourceKind,
    doc_type: args.docType,
    original_filename: args.originalFilename,
    mime_type: mime,
    byte_size: fullText.length,
    sha256: sha,
    storage_provider: "supabase_storage",
    storage_bucket: bucket,
    storage_path: `${prefix}/${docId}.txt`,
    folder_path: folder,
    status: "parsed",
    error_message: null,
    routing_confidence: 1,
    routing_reason: args.routingReason ?? `${args.sourceKind}_ingest`,
  })) as { error: { message: string } | null };
  if (insDoc.error) return null;

  const ingestedAt = new Date().toISOString();
  const pageRows = pages.map((p) => ({
    document_id: docId,
    page_number: p.pageNumber,
    text: p.text,
    char_count: p.text.length,
    metadata: {
      kind: args.sourceKind,
      ingested_at: ingestedAt,
      ...(args.pageMetadata ?? {}),
      ...(p.metadata ?? {}),
    },
  }));
  const insPages = (await args.admin
    .schema("deal_intel")
    .from("document_page")
    .insert(pageRows)) as { error: { message: string } | null };
  if (insPages.error) return null;

  // Idempotent replace.
  await args.admin.schema("deal_intel").from("document_chunk").delete().eq("document_id", docId);

  const chunks =
    Array.isArray(args.chunkTextsOverride) && args.chunkTextsOverride.length
      ? args.chunkTextsOverride.map((t, i) => ({
          pageStart: 1,
          pageEnd: 1,
          charStart: 0 + i, // placeholder; not used for viewer; improves ordering stability
          charEnd: 0 + i,
          text: String(t || "").trim(),
        }))
      : pages.flatMap((page) => chunkPageText({ pageNumber: page.pageNumber, text: page.text }));
  const fastLimit =
    args.fastEmbedLimit !== undefined
      ? Math.max(0, Math.min(args.fastEmbedLimit, MAX_FAST_CHUNKS))
      : Math.max(1, Math.min(FAST_EMBED_CHUNK_LIMIT, MAX_FAST_CHUNKS));
  const maxChunks = Math.max(1, args.maxChunks ?? 200);

  const chunkRows: Array<{
    document_id: string;
    page_start: number;
    page_end: number;
    char_start: number;
    char_end: number;
    text: string;
    embedding: string | null;
    embedding_model: string | null;
    keywords: string[];
    produced_by?: string;
  }> = [];

  let embeddedCount = 0;
  for (const ch of chunks) {
    if (!ch.text) continue;
    const kw = extractKeywords(ch.text, 20);
    const shouldEmbedNow = embeddedCount < fastLimit;
    const emb = shouldEmbedNow ? await embedText(ch.text.slice(0, 8000)) : null;
    if (shouldEmbedNow && emb) embeddedCount++;
    chunkRows.push({
      document_id: docId,
      page_start: ch.pageStart,
      page_end: ch.pageEnd,
      char_start: ch.charStart,
      char_end: ch.charEnd,
      text: ch.text,
      embedding: emb ? vectorParam(emb) : null,
      embedding_model: emb ? EMBEDDING_MODEL : null,
      keywords: kw,
      produced_by: "fast",
    });
    if (chunkRows.length >= maxChunks) break;
  }

  if (chunkRows.length) {
    const insChunks = (await args.admin.schema("deal_intel").from("document_chunk").insert(chunkRows)) as {
      error: { message: string } | null;
    };
    if (insChunks.error) return null;
  }

  await args.admin
    .schema("deal_intel")
    .from("document")
    .update({ status: "chunked", updated_at: new Date().toISOString() })
    .eq("id", docId)
    .eq("user_id", args.userId);

  await args.admin.rpc("deal_intel_enqueue_job", {
    p_job_type: "doc_refine_chunks",
    p_subject_kind: "document",
    p_subject_id: docId,
    p_payload: { document_id: docId },
    p_priority: 160,
  });

  // Generate claims from chunked thoughts (background).
  await args.admin.rpc("deal_intel_enqueue_job", {
    p_job_type: "doc_extract_claims",
    p_subject_kind: "document",
    p_subject_id: docId,
    p_payload: { document_id: docId },
    p_priority: 155,
  });

  return { documentId: docId };
}
