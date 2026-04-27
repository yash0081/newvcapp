import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractDealIntelSchemaFactsFromPdf } from "@/lib/deal-intel/extract-schema-facts";
import { persistDealIntelSchemaRelational } from "@/lib/deal-intel/persist-schema-relational";
import { persistDealIntelFacts } from "@/lib/ingestion/persist-deal-intel-facts";
import { materializeDealIntelTree } from "@/lib/deal-intel/materialize-tree";
import { linkValueToSentence, quoteForProvenance, type SentenceRow } from "@/lib/deal-intel/citation-link";

function collectLeafStrings(value: unknown, path: string, out: Array<{ path: string; value: string }>) {
  if (value == null) return;
  if (typeof value === "string") {
    const t = value.trim();
    if (t) out.push({ path: path || "root", value: t });
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    out.push({ path: path || "root", value: String(value) });
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      collectLeafStrings(value[i], `${path}/${i}`, out);
    }
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      collectLeafStrings(v, path ? `${path}/${k}` : k, out);
    }
  }
}

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
    .select("id, user_id, deal_id, storage_bucket, storage_path, original_filename")
    .eq("id", documentId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (docErr) {
    console.error("deal_intel.document ingest lookup:", docErr);
    return NextResponse.json({ error: docErr.message || "Failed to load document" }, { status: 500 });
  }
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!doc.deal_id) return NextResponse.json({ error: "Document is not linked to a company/deal" }, { status: 400 });

  const dealId = doc.deal_id as string;

  // Create a new revision for this ingest run.
  const revisionId = randomUUID();
  const { error: revErr } = await admin.schema("deal_intel").from("deal_revision").insert({
    id: revisionId,
    deal_id: dealId,
    label: `ingest:document:${documentId}`,
    metadata: { kind: "schema_facts_pdf", document_id: documentId },
  });
  if (revErr) {
    console.error("deal_revision insert:", revErr);
    return NextResponse.json({ error: revErr.message || "Failed to create revision" }, { status: 500 });
  }

  // Download PDF
  const { data: downloaded, error: dlErr } = await admin.storage.from(doc.storage_bucket).download(doc.storage_path);
  if (dlErr || !downloaded) {
    console.error("storage download:", dlErr);
    return NextResponse.json({ error: dlErr?.message || "Failed to download PDF" }, { status: 500 });
  }
  const arrayBuffer = await downloaded.arrayBuffer();
  const pdfBuffer = Buffer.from(arrayBuffer);

  // Load sentences for post-linking citations (best-effort).
  const { data: sentencesRaw, error: sErr } = await admin
    .schema("deal_intel")
    .from("document_sentence")
    .select("id, page_number, text")
    .eq("document_id", documentId)
    .order("page_number", { ascending: true })
    .order("sentence_index", { ascending: true });

  if (sErr) {
    console.error("document_sentence select:", sErr);
    return NextResponse.json({ error: sErr.message || "Failed to load sentences" }, { status: 500 });
  }

  const sentences = (sentencesRaw ?? []) as SentenceRow[];

  try {
    // 1) Schema.pdf extraction (existing prompt)
    const facts = await extractDealIntelSchemaFactsFromPdf({ pdfBuffer, modelTier: "flash_lite" });

    // 2) Best-effort citation linking: per leaf path -> sentence_id/page
    const leaves: Array<{ path: string; value: string }> = [];
    collectLeafStrings(facts, "", leaves);
    const sourcesByPath: Record<
      string,
      Array<{
        document_id: string;
        page_number?: number;
        sentence_id?: string;
        claim_id?: string;
        quote?: string;
      }>
    > = {};

    for (const leaf of leaves) {
      const match = linkValueToSentence(leaf.value, sentences);
      if (!match) continue;
      sourcesByPath[leaf.path] = [
        {
          document_id: documentId,
          page_number: match.page_number,
          sentence_id: match.id,
          quote: quoteForProvenance(leaf.value),
        },
      ];
    }

    // 3) Relational buckets
    await persistDealIntelSchemaRelational({ admin, dealId, revisionId, facts });

    // 4) Flattened fact nodes (with provenance)
    await persistDealIntelFacts({
      admin,
      userId: user.id,
      existing: { dealId, revisionId },
      facts,
      dealMetadata: { file_label: doc.original_filename ?? null, document_id: documentId },
      provenance: {
        primary_document_id: documentId,
        sources_by_path: sourcesByPath,
        sources: [{ document_id: documentId }],
      },
    });

    // 5) FAST tree: root centroid + child narratives only (no sub-child embeddings/personas/signal/anchor).
    await materializeDealIntelTree({ admin, dealId, revisionId, mode: "fast" });

    // 6) Enqueue background enrichment (async)
    // - embed fact nodes
    // - keyword graph + offline reconcile
    // - full tree refinement (sub-child + persona + signal/anchor + root super-centroid)
    await admin.rpc("deal_intel_enqueue_job", {
      p_job_type: "fact_backfill_embeddings",
      p_subject_kind: "deal",
      p_subject_id: dealId,
      p_payload: { deal_id: dealId },
      p_priority: 100,
    });
    await admin.rpc("deal_intel_enqueue_job", {
      p_job_type: "keyword_backfill_graph",
      p_subject_kind: "deal",
      p_subject_id: dealId,
      p_payload: { deal_id: dealId },
      p_priority: 120,
    });
    await admin.rpc("deal_intel_enqueue_job", {
      p_job_type: "deal_refine_tree_full",
      p_subject_kind: "deal",
      p_subject_id: dealId,
      p_payload: { deal_id: dealId, revision_id: revisionId },
      p_priority: 150,
    });

    await admin
      .schema("deal_intel")
      .from("document")
      .update({ status: "ready", error_message: null, updated_at: new Date().toISOString() })
      .eq("id", documentId)
      .eq("user_id", user.id);

    return NextResponse.json({
      documentId,
      dealId,
      revisionId,
      status: "ready",
      linkedPaths: Object.keys(sourcesByPath).length,
      note: "Fast ingest complete; background enrichment enqueued.",
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("ingest-deal-intel failed:", e);
    await admin
      .schema("deal_intel")
      .from("document")
      .update({ status: "error", error_message: message.slice(0, 2000), updated_at: new Date().toISOString() })
      .eq("id", documentId)
      .eq("user_id", user.id);
    return NextResponse.json({ error: message || "Ingest failed", documentId }, { status: 500 });
  }
}

