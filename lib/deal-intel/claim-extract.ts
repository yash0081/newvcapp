import { randomUUID } from "node:crypto";
import { persistDealIntelFacts } from "@/lib/ingestion/persist-deal-intel-facts";
import { materializeDealIntelTree } from "@/lib/deal-intel/materialize-tree";
import { vertexRunWithTextMulti } from "@/lib/vertex";
import { getDealIntelIngestionModel } from "@/lib/deal-intel/ingestion-model-env";
import { chunkArray, mapWithConcurrency } from "@/lib/async/concurrency";

type Admin = {
  schema: (s: string) => any;
  rpc: (fn: string, args: Record<string, unknown>) => any;
};

type LlmClaim = {
  claim_type: string;
  key: string | null;
  quote: string;
  confidence: number;
};

function stripCodeFence(raw: string): string {
  const s = raw.trim();
  if (!s.startsWith("```")) return s;
  return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

function parseClaims(raw: string): LlmClaim[] {
  try {
    const parsed = JSON.parse(stripCodeFence(raw)) as { claims?: unknown };
    const arr = Array.isArray(parsed.claims) ? (parsed.claims as unknown[]) : [];
    return arr
      .map((c) => {
        const x = (c && typeof c === "object" ? (c as Record<string, unknown>) : {}) as Record<string, unknown>;
        const quote = typeof x.quote === "string" ? x.quote.trim() : "";
        const claim_type = typeof x.claim_type === "string" ? x.claim_type.trim() : "other";
        const key = typeof x.key === "string" ? x.key.trim() : null;
        const conf = typeof x.confidence === "number" ? x.confidence : 0.5;
        if (!quote) return null;
        return {
          quote: quote.length > 800 ? `${quote.slice(0, 800)}…` : quote,
          claim_type,
          key: key && key.length ? key : null,
          confidence: Math.max(0, Math.min(1, conf)),
        } satisfies LlmClaim;
      })
      .filter(Boolean) as LlmClaim[];
  } catch {
    return [];
  }
}

async function extractClaimsForChunkViaLlm(args: {
  chunkText: string;
  companyContext: string;
}): Promise<LlmClaim[]> {
  const prompt = `Extract atomic, evidence-grounded claims from ONE text chunk.
Return strict JSON only:
{
  "claims": [
    { "quote": "string", "claim_type": "metric|product|market|risk|relationship|commitment|other", "key": "string|null", "confidence": 0.0 }
  ]
}
Rules:
- 0-10 claims max.
- Quotes must be directly supported by the chunk (no inference).
- Prefer falsifiable / specific statements.
- If the chunk is vague or redundant, return an empty list.
- key is optional (e.g. "revenue","arr","customers","funding","tam","sam","som").`;

  const raw = await vertexRunWithTextMulti(
    getDealIntelIngestionModel("flash_lite"),
    prompt,
    [
      { label: "Company context (json)", value: args.companyContext.slice(0, 8000) },
      { label: "Chunk text", value: args.chunkText.slice(0, 8000) },
    ],
    false
  );
  return parseClaims(raw);
}

export async function extractClaimsForDocument(admin: Admin, documentId: string) {
  const docRes = await admin
    .schema("deal_intel")
    .from("document")
    .select("id, user_id, deal_id")
    .eq("id", documentId)
    .maybeSingle();
  if (docRes.error) throw docRes.error;
  if (!docRes.data?.deal_id || !docRes.data?.user_id) return { inserted: 0 };

  const dealId = String(docRes.data.deal_id);
  const userId = String(docRes.data.user_id);

  // Prefer chunks (your desired algorithm: "chunked thoughts -> claims").
  const chunksRes = await admin
    .schema("deal_intel")
    .from("document_chunk")
    .select("page_start, text")
    .eq("document_id", documentId)
    .order("page_start", { ascending: true })
    .order("char_start", { ascending: true })
    .limit(400);
  if (chunksRes.error) throw chunksRes.error;
  const chunkRows = (chunksRes.data ?? []) as Array<{ page_start: number; text: string }>;
  const texts = chunkRows.map((c) => String(c.text || "").trim()).filter(Boolean);
  if (!texts.length) return { inserted: 0 };

  const dealRes = await admin
    .schema("deal_intel")
    .from("deal")
    .select("metadata")
    .eq("id", dealId)
    .eq("user_id", userId)
    .maybeSingle();
  const companyContext = JSON.stringify((dealRes.data?.metadata ?? {}) as Record<string, unknown>, null, 2);

  const concurrency = Math.max(1, Math.min(6, Number(process.env.CLAIMS_EXTRACT_CONCURRENCY || 3)));
  const batches = chunkArray(texts.slice(0, 120), 8); // cap work per doc
  const perChunkClaims = (
    await mapWithConcurrency(batches, concurrency, async (batch) => {
      const out: LlmClaim[][] = [];
      for (const chunkText of batch) {
        out.push(await extractClaimsForChunkViaLlm({ chunkText, companyContext }));
      }
      return out;
    })
  ).flat();
  const extracted = perChunkClaims.flat().slice(0, 220);

  if (!extracted.length) {
    await admin
      .schema("deal_intel")
      .from("document")
      .update({ status: "claims_extracted", updated_at: new Date().toISOString() })
      .eq("id", documentId);
    return { inserted: 0 };
  }

  const claimRows = extracted.map((c, i) => ({
    id: randomUUID(),
    user_id: userId,
    deal_id: dealId,
    document_id: documentId,
    page_number: chunkRows[Math.min(chunkRows.length - 1, i)]?.page_start ?? 1,
    sentence_id: null,
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
  }));

  await admin.schema("deal_intel").from("claim").delete().eq("document_id", documentId);
  const ins = await admin.schema("deal_intel").from("claim").insert(claimRows);
  if (ins.error) throw ins.error;

  // Persist as deal_fact_node under claims/* (same pattern as the API route).
  const revisionId = randomUUID();
  await admin.schema("deal_intel").from("deal_revision").insert({
    id: revisionId,
    deal_id: dealId,
    label: `claims:document:${documentId}`,
    metadata: { kind: "claims", document_id: documentId },
  });

  await persistDealIntelFacts({
    admin: admin as any,
    userId,
    existing: { dealId, revisionId },
    // IMPORTANT: avoid collisions on deal_fact_node (unique on deal_id+path).
    // Store claims under a unique per-run root (no shared ancestors).
    facts: {
      [`claims_doc_${documentId.replaceAll("-", "")}_${revisionId.replaceAll("-", "")}`]: claimRows.map((c) => ({
        claim_type: c.claim_type,
        key: c.key,
        quote: c.quote,
      })),
    },
    provenance: {
      primary_document_id: documentId,
      sources: [{ document_id: documentId }],
    },
  });

  await materializeDealIntelTree({ admin: admin as any, dealId, revisionId, mode: "fast" });

  // Enqueue enrichment for the new facts.
  await admin.rpc("deal_intel_enqueue_job", {
    p_job_type: "fact_backfill_embeddings",
    p_subject_kind: "deal",
    p_subject_id: dealId,
    p_payload: { deal_id: dealId },
    p_priority: 110,
  });

  await admin
    .schema("deal_intel")
    .from("document")
    .update({ status: "claims_extracted", error_message: null, updated_at: new Date().toISOString() })
    .eq("id", documentId);

  return { inserted: claimRows.length };
}

