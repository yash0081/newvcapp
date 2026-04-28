import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { chunkPageText } from "@/lib/deal-intel/chunking";
import { extractKeywords } from "@/lib/data-layer/shared/text";
import { embedText } from "@/lib/vertex-embeddings";
import { vectorParam } from "@/lib/data-layer/shared/vector";

type AdminClient = {
  schema: (s: string) => {
    from: (t: string) => unknown;
  };
  rpc: (fn: string, args: Record<string, unknown>) => unknown;
};

const EMBEDDING_MODEL = process.env.VERTEX_EMBEDDING_MODEL || "text-embedding-004";
const FAST_EMBED_CHUNK_LIMIT = Number(process.env.DEAL_INTEL_FAST_CHUNK_EMBED_LIMIT || 12);

function stripHtmlToText(html: string): string {
  const s = String(html || "");
  // Drop script/style blocks early.
  const noScripts = s.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  const noTags = noScripts.replace(/<\/?[^>]+>/g, " ");
  const decoded = noTags
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return decoded;
}

async function fetchUrlText(url: string, timeoutMs: number): Promise<{ text: string; contentType: string | null }> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          process.env.WEB_INGEST_USER_AGENT ||
          "Mozilla/5.0 (compatible; newvcapp/1.0; +https://example.com) AppleWebKit/537.36 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
      },
    });
    const ct = res.headers.get("content-type");
    const body = await res.text();
    const capped = body.length > 1_200_000 ? body.slice(0, 1_200_000) : body;
    const text = (ct && ct.includes("html")) || capped.includes("<html") ? stripHtmlToText(capped) : capped.trim();
    return { text, contentType: ct };
  } finally {
    clearTimeout(t);
  }
}

export async function ingestWebSourceAsDocument(args: {
  admin: AdminClient;
  userId: string;
  dealId: string;
  sourceUrl: string;
  title?: string;
  // Short context used to label/trace the origin.
  workflowId?: string;
  stepId?: string;
  timeoutMs?: number;
}): Promise<{ documentId: string } | null> {
  const sourceUrl = String(args.sourceUrl || "").trim();
  if (!sourceUrl) return null;

  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }

  const { text, contentType } = await fetchUrlText(url.toString(), Math.max(1000, Math.min(15000, args.timeoutMs ?? 6000)));
  if (!text) return null;

  const sha = createHash("sha256").update(text).digest("hex");
  const docId = randomUUID();

  // Store as a "document" so retrieval + chunking + embeddings use the same path as PDFs.
  // We intentionally do not depend on Supabase storage for web sources.
  const insDoc = await args.admin.schema("deal_intel").from("document").insert({
    id: docId,
    user_id: args.userId,
    deal_id: args.dealId,
    source_kind: "web",
    doc_type: "web_research",
    original_filename: args.title ? `${args.title} (${url.hostname})` : url.hostname,
    mime_type: contentType || "text/html",
    byte_size: text.length,
    sha256: sha,
    storage_provider: "supabase_storage",
    storage_bucket: "web",
    storage_path: `web/${args.userId}/${docId}.html`,
    folder_path: "web",
    status: "parsed",
    error_message: null,
    routing_confidence: 1,
    routing_reason: "web_ingest",
  });
  if (insDoc.error) return null;

  const insPage = await args.admin.schema("deal_intel").from("document_page").insert({
    document_id: docId,
    page_number: 1,
    text,
    char_count: text.length,
    metadata: {
      kind: "web",
      url: url.toString(),
      hostname: url.hostname,
      title: args.title ?? null,
      workflow_id: args.workflowId ?? null,
      step_id: args.stepId ?? null,
      fetched_at: new Date().toISOString(),
    },
  });
  if (insPage.error) return null;

  // Chunk + fast embeddings (same shape as `/api/crm/documents/:id/chunk`).
  await args.admin.schema("deal_intel").from("document_chunk").delete().eq("document_id", docId);

  const chunks = chunkPageText({ pageNumber: 1, text });
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
  const fastLimit = Math.max(1, Math.min(FAST_EMBED_CHUNK_LIMIT, 8)); // web pages can be long; keep fast path small

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
    if (chunkRows.length >= 200) break;
  }

  if (chunkRows.length) {
    const insChunks = await args.admin.schema("deal_intel").from("document_chunk").insert(chunkRows);
    if (insChunks.error) return null;
  }

  await args.admin
    .schema("deal_intel")
    .from("document")
    .update({ status: "chunked", updated_at: new Date().toISOString() })
    .eq("id", docId)
    .eq("user_id", args.userId);

  // Background refine: embed remaining chunks + merging.
  await args.admin.rpc("deal_intel_enqueue_job", {
    p_job_type: "doc_refine_chunks",
    p_subject_kind: "document",
    p_subject_id: docId,
    p_payload: { document_id: docId },
    p_priority: 160,
  });

  return { documentId: docId };
}

