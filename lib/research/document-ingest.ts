import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { chunkPageText } from "@/lib/deal-intel/chunking";
import { extractKeywords } from "@/lib/data-layer/shared/text";
import { embedText } from "@/lib/vertex-embeddings";
import { vectorParam } from "@/lib/data-layer/shared/vector";

export type AdminClient = {
  schema: (s: string) => {
    from: (t: string) => unknown;
  };
  rpc: (fn: string, args: Record<string, unknown>) => unknown;
};

const EMBEDDING_MODEL = process.env.VERTEX_EMBEDDING_MODEL || "text-embedding-004";
const FAST_EMBED_CHUNK_LIMIT = Number(process.env.DEAL_INTEL_FAST_CHUNK_EMBED_LIMIT || 12);
const MAX_FAST_CHUNKS = 8;

export type IngestTextArgs = {
  admin: AdminClient;
  userId: string;
  dealId: string;
  text: string;
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
  /** Extra context attached to document_page.metadata.kind === sourceKind. */
  pageMetadata?: Record<string, unknown>;
  /** Hard cap on chunk rows (defaults to 200). */
  maxChunks?: number;
  /** Override fast-path embedding count for this ingest. */
  fastEmbedLimit?: number;
};

export async function ingestTextAsDocument(args: IngestTextArgs): Promise<{ documentId: string } | null> {
  const text = String(args.text ?? "").trim();
  if (!text) return null;

  const sha = createHash("sha256").update(text).digest("hex");
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
    byte_size: text.length,
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

  const insPage = (await args.admin.schema("deal_intel").from("document_page").insert({
    document_id: docId,
    page_number: 1,
    text,
    char_count: text.length,
    metadata: {
      kind: args.sourceKind,
      ingested_at: new Date().toISOString(),
      ...(args.pageMetadata ?? {}),
    },
  })) as { error: { message: string } | null };
  if (insPage.error) return null;

  // Idempotent replace.
  await args.admin.schema("deal_intel").from("document_chunk").delete().eq("document_id", docId);

  const chunks = chunkPageText({ pageNumber: 1, text });
  const fastLimit = Math.max(1, Math.min(args.fastEmbedLimit ?? FAST_EMBED_CHUNK_LIMIT, MAX_FAST_CHUNKS));
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

  return { documentId: docId };
}
