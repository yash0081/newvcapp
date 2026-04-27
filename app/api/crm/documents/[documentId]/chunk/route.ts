import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { splitIntoSentenceSpans } from "@/lib/deal-intel/sentences";
import { chunkPageText } from "@/lib/deal-intel/chunking";
import { embedText } from "@/lib/vertex-embeddings";
import { vectorParam } from "@/lib/data-layer/shared/vector";
import { extractKeywords } from "@/lib/data-layer/shared/text";

const EMBEDDING_MODEL = process.env.VERTEX_EMBEDDING_MODEL || "text-embedding-004";
const FAST_EMBED_CHUNK_LIMIT = Number(process.env.DEAL_INTEL_FAST_CHUNK_EMBED_LIMIT || 12);

export async function POST(_req: Request, ctx: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: doc, error: docErr } = await admin
    .schema("deal_intel")
    .from("document")
    .select("id, user_id")
    .eq("id", documentId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (docErr) {
    console.error("deal_intel.document chunk lookup:", docErr);
    return NextResponse.json({ error: docErr.message || "Failed to load document" }, { status: 500 });
  }
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data: pages, error: pagesErr } = await admin
    .schema("deal_intel")
    .from("document_page")
    .select("page_number, text")
    .eq("document_id", documentId)
    .order("page_number", { ascending: true });

  if (pagesErr) {
    console.error("document_page select:", pagesErr);
    return NextResponse.json({ error: pagesErr.message || "Failed to load pages" }, { status: 500 });
  }

  const pageRows = (pages ?? []) as Array<{ page_number: number; text: string }>;
  if (pageRows.length === 0) {
    return NextResponse.json({ error: "Document has no parsed pages yet", status: "uploaded" }, { status: 400 });
  }

  // Idempotent replace.
  await admin.schema("deal_intel").from("document_sentence").delete().eq("document_id", documentId);
  await admin.schema("deal_intel").from("document_chunk").delete().eq("document_id", documentId);

  // 1) Sentences (no embeddings by default for MVP)
  const sentenceInserts: Array<{
    document_id: string;
    page_number: number;
    sentence_index: number;
    text: string;
    char_start: number;
    char_end: number;
  }> = [];

  for (const p of pageRows) {
    const spans = splitIntoSentenceSpans(p.text);
    spans.forEach((sp, idx) => {
      sentenceInserts.push({
        document_id: documentId,
        page_number: p.page_number,
        sentence_index: idx,
        text: sp.text,
        char_start: sp.charStart,
        char_end: sp.charEnd,
      });
    });
  }

  if (sentenceInserts.length > 0) {
    const { error: sErr } = await admin.schema("deal_intel").from("document_sentence").insert(sentenceInserts);
    if (sErr) {
      console.error("document_sentence insert:", sErr);
      return NextResponse.json({ error: sErr.message || "Failed to insert sentences" }, { status: 500 });
    }
  }

  // 2) Chunks + embeddings
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
  for (const p of pageRows) {
    const chunks = chunkPageText({ pageNumber: p.page_number, text: p.text });
    for (const ch of chunks) {
      const kw = extractKeywords(ch.text, 20);
      const shouldEmbedNow = embeddedCount < FAST_EMBED_CHUNK_LIMIT;
      const emb = shouldEmbedNow ? await embedText(ch.text.slice(0, 8000)) : null;
      if (shouldEmbedNow && emb) embeddedCount++;
      chunkRows.push({
        document_id: documentId,
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
    }
  }

  if (chunkRows.length > 0) {
    const { error: cErr } = await admin.schema("deal_intel").from("document_chunk").insert(chunkRows);
    if (cErr) {
      console.error("document_chunk insert:", cErr);
      return NextResponse.json({ error: cErr.message || "Failed to insert chunks" }, { status: 500 });
    }
  }

  await admin
    .schema("deal_intel")
    .from("document")
    .update({ status: "chunked", error_message: null, updated_at: new Date().toISOString() })
    .eq("id", documentId)
    .eq("user_id", user.id);

  // Enqueue background refinement: embed remaining chunks + semantic merging (refined chunking).
  await admin.rpc("deal_intel_enqueue_job", {
    p_job_type: "doc_refine_chunks",
    p_subject_kind: "document",
    p_subject_id: documentId,
    p_payload: { document_id: documentId },
    p_priority: 140,
  });

  return NextResponse.json({
    documentId,
    pages: pageRows.length,
    sentences: sentenceInserts.length,
    chunks: chunkRows.length,
    chunksEmbeddedFast: embeddedCount,
    status: "chunked",
  });
}

