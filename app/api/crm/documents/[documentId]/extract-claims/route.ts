import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractClaimsFromSentences } from "@/lib/deal-intel/claim-heuristics";
import { persistDealIntelFacts } from "@/lib/ingestion/persist-deal-intel-facts";
import { materializeDealIntelTree } from "@/lib/deal-intel/materialize-tree";

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
    .select("id, user_id, deal_id")
    .eq("id", documentId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (docErr) {
    console.error("document lookup:", docErr);
    return NextResponse.json({ error: docErr.message || "Failed to load document" }, { status: 500 });
  }
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!doc.deal_id) return NextResponse.json({ error: "Document is not linked to a company/deal" }, { status: 400 });

  const dealId = doc.deal_id as string;

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

  const sentenceRows = (sentencesRaw ?? []) as Array<{ id: string; page_number: number; text: string }>;
  if (sentenceRows.length === 0) {
    return NextResponse.json({ error: "No sentences for this document yet (run /parse then /chunk)" }, { status: 400 });
  }

  const extracted = extractClaimsFromSentences(sentenceRows.map((s) => s.text), 140);
  if (extracted.length === 0) {
    return NextResponse.json({ documentId, dealId, claimsInserted: 0, status: "claims_extracted" });
  }

  // Insert claims and reconcile to company_fact
  const claimRows = extracted.map((c, i) => {
    const sent = sentenceRows[Math.min(sentenceRows.length - 1, i)]!;
    return {
      id: randomUUID(),
      user_id: user.id,
      deal_id: dealId,
      document_id: documentId,
      page_number: sent.page_number,
      sentence_id: sent.id,
      quote: c.quote,
      claim_type: c.claim_type,
      key: c.key,
      value_text: null,
      value_number: null,
      value_jsonb: null,
      time_start: null,
      time_end: null,
      confidence: c.confidence,
      embedding: null,
      embedding_model: null,
    };
  });

  // Idempotency: replace existing claims for this document (MVP).
  await admin.schema("deal_intel").from("claim").delete().eq("document_id", documentId);
  const { error: insErr } = await admin.schema("deal_intel").from("claim").insert(claimRows);
  if (insErr) {
    console.error("claim insert:", insErr);
    return NextResponse.json({ error: insErr.message || "Failed to insert claims" }, { status: 500 });
  }

  // Upsert canonical facts for keys we can name.
  const factUpsertsRaw = claimRows
    .filter((c) => typeof c.key === "string" && c.key)
    .slice(0, 200)
    .map((c) => ({
      deal_id: dealId,
      fact_path: `claims/${c.key}`,
      canonical_value_text: c.quote,
      canonical_value_jsonb: null,
      source_claim_id: c.id,
      status: "active" as const,
      updated_at: new Date().toISOString(),
      _confidence: typeof c.confidence === "number" ? c.confidence : 0,
    }));

  // Postgres errors if the same (deal_id,fact_path) appears twice in one upsert statement.
  // Deduplicate by fact_path, keeping the highest-confidence claim for each key.
  const byPath = new Map<string, (typeof factUpsertsRaw)[number]>();
  for (const row of factUpsertsRaw) {
    const existing = byPath.get(row.fact_path);
    if (!existing || row._confidence >= existing._confidence) byPath.set(row.fact_path, row);
  }
  const factUpserts = Array.from(byPath.values()).map((r) => {
    const { _confidence: c, ...rest } = r;
    void c;
    return rest;
  });
  if (factUpserts.length > 0) {
    const { error: upErr } = await admin.schema("deal_intel").from("company_fact").upsert(factUpserts, {
      onConflict: "deal_id,fact_path",
    });
    if (upErr) {
      console.warn("company_fact upsert:", upErr);
    }
  }

  // Persist claim facts into deal_fact_node under a non-colliding `claims/*` subtree.
  const revisionId = randomUUID();
  await admin.schema("deal_intel").from("deal_revision").insert({
    id: revisionId,
    deal_id: dealId,
    label: `claims:document:${documentId}`,
    metadata: { kind: "claims", document_id: documentId },
  });

  await persistDealIntelFacts({
    admin,
    userId: user.id,
    existing: { dealId, revisionId },
    facts: { claims: claimRows.map((c) => ({ claim_type: c.claim_type, key: c.key, quote: c.quote })) },
    provenance: {
      primary_document_id: documentId,
      sources: [{ document_id: documentId }],
    },
  });

  await materializeDealIntelTree({ admin, dealId, revisionId, mode: "fast" });

  // Enqueue background enrichment (same as schema-facts ingest).
  await admin.rpc("deal_intel_enqueue_job", {
    p_job_type: "fact_backfill_embeddings",
    p_subject_kind: "deal",
    p_subject_id: dealId,
    p_payload: { deal_id: dealId },
    p_priority: 110,
  });
  await admin.rpc("deal_intel_enqueue_job", {
    p_job_type: "keyword_backfill_graph",
    p_subject_kind: "deal",
    p_subject_id: dealId,
    p_payload: { deal_id: dealId },
    p_priority: 130,
  });
  await admin.rpc("deal_intel_enqueue_job", {
    p_job_type: "deal_refine_tree_full",
    p_subject_kind: "deal",
    p_subject_id: dealId,
    p_payload: { deal_id: dealId, revision_id: revisionId },
    p_priority: 160,
  });

  await admin
    .schema("deal_intel")
    .from("document")
    .update({ status: "claims_extracted", error_message: null, updated_at: new Date().toISOString() })
    .eq("id", documentId)
    .eq("user_id", user.id);

  return NextResponse.json({ documentId, dealId, claimsInserted: claimRows.length, status: "claims_extracted" });
}

