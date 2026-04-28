import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { backfillDealIntelFactEmbeddings } from "@/lib/deal-intel/backfill-facts";
import { backfillDealIntelKeywordGraph, reconcileDealIntelKeywordClustersOffline } from "@/lib/deal-intel/keywords";
import { materializeDealIntelTree } from "@/lib/deal-intel/materialize-tree";
import { embedTexts } from "@/lib/vertex-embeddings";
import { cosineSimilarity, parseVector, vectorParam, weightedCentroid } from "@/lib/data-layer/shared/vector";
import { chunkArray, mapWithConcurrency } from "@/lib/async/concurrency";

type JobRow = {
  id: string;
  job_type: string;
  subject_kind: string;
  subject_id: string;
  payload: unknown;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isAbortLike(e: unknown): boolean {
  const anyErr = e as { message?: unknown; details?: unknown; hint?: unknown } | null;
  const msg =
    e instanceof Error
      ? e.message
      : typeof anyErr?.message === "string"
        ? anyErr.message
        : typeof anyErr?.details === "string"
          ? anyErr.details
          : String(e || "");
  return msg.includes("AbortError") || msg.includes("aborted") || msg.includes("The operation was aborted");
}

function formatWorkerError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    const parts: Record<string, unknown> = {};
    for (const k of ["message", "details", "hint", "code", "status"]) {
      if (o[k] != null) parts[k] = o[k];
    }
    if (Object.keys(parts).length) return JSON.stringify(parts);
    try {
      return JSON.stringify(e);
    } catch {
      /* fall through */
    }
  }
  return String(e);
}

async function embedMissingDocumentChunks(admin: ReturnType<typeof createAdminClient>, documentId: string) {
  const { data: rows, error } = await admin
    .schema("deal_intel")
    .from("document_chunk")
    .select("id, text")
    .eq("document_id", documentId)
    .is("embedding", null)
    .limit(200);
  if (error) throw error;
  const chunkRows = (rows ?? []) as Array<{ id: string; text: string }>;
  if (chunkRows.length === 0) return;
  const texts = chunkRows.map((r) => String(r.text || "").slice(0, 8000));
  const vecs: number[][] = [];
  for (const batch of chunkArray(texts, 24)) {
    vecs.push(...(await embedTexts(batch, 24)));
  }
  const model = process.env.VERTEX_EMBEDDING_MODEL || "text-embedding-004";
  await mapWithConcurrency(chunkRows, 12, async (r, idx) => {
    await admin
      .schema("deal_intel")
      .from("document_chunk")
      .update({ embedding: vectorParam(vecs[idx]!), embedding_model: model, produced_by: "refined" })
      .eq("id", r.id);
  });
}

async function mergeAdjacentRefinedChunks(admin: ReturnType<typeof createAdminClient>, documentId: string) {
  const threshold = Number(process.env.DEAL_INTEL_CHUNK_MERGE_SIM_THRESHOLD || 0.9);
  const maxChars = Number(process.env.DEAL_INTEL_REFINED_CHUNK_MAX_CHARS || 12000);

  const { data: rows, error } = await admin
    .schema("deal_intel")
    .from("document_chunk")
    .select("id, page_start, page_end, char_start, char_end, text, embedding, embedding_model, produced_by")
    .eq("document_id", documentId)
    .order("page_start", { ascending: true })
    .order("char_start", { ascending: true })
    .limit(2000);
  if (error) throw error;
  const chunks = (rows ?? []) as Array<{
    id: string;
    page_start: number;
    page_end: number;
    char_start: number;
    char_end: number;
    text: string;
    embedding: unknown;
    embedding_model: string | null;
    produced_by: string | null;
  }>;
  if (chunks.length < 2) return;

  // Only merge chunks that have embeddings available.
  const parsed = chunks.map((c) => ({ ...c, v: parseVector(c.embedding) })).filter((c) => c.v && c.v.length > 0);
  if (parsed.length < 2) return;

  // Delete any previous refined rows we created from merges (keep fast rows).
  await admin
    .schema("deal_intel")
    .from("document_chunk")
    .delete()
    .eq("document_id", documentId)
    .eq("produced_by", "refined")
    .eq("chunk_version", 2);

  const mergedRows: Array<{
    document_id: string;
    page_start: number;
    page_end: number;
    char_start: number;
    char_end: number;
    text: string;
    embedding: string | null;
    embedding_model: string | null;
    keywords: string[];
    produced_by: string;
    chunk_version: number;
    merge_parent_ids: string[];
  }> = [];

  let i = 0;
  while (i < parsed.length) {
    const cur = parsed[i]!;
    let text = cur.text;
    const start = cur;
    let end = cur;
    let vec = cur.v!;
    const parents: string[] = [cur.id];

    while (i + 1 < parsed.length) {
      const nxt = parsed[i + 1]!;
      if (!nxt.v) break;
      const sim = cosineSimilarity(vec, nxt.v);
      if (sim < threshold) break;
      if ((text.length + 2 + nxt.text.length) > maxChars) break;

      // merge
      text = `${text}\n\n${nxt.text}`;
      vec = weightedCentroid([{ vector: vec, weight: 1 }, { vector: nxt.v, weight: 1 }]) ?? vec;
      end = nxt;
      parents.push(nxt.id);
      i++;
    }

    if (parents.length >= 2) {
      mergedRows.push({
        document_id: documentId,
        page_start: start.page_start,
        page_end: end.page_end,
        char_start: start.char_start,
        char_end: end.char_end,
        text,
        embedding: vec ? vectorParam(vec) : null,
        embedding_model: cur.embedding_model,
        keywords: [],
        produced_by: "refined",
        chunk_version: 2,
        merge_parent_ids: parents,
      });
    }
    i++;
  }

  if (mergedRows.length) {
    await admin.schema("deal_intel").from("document_chunk").insert(mergedRows);
  }
}

async function handleJob(admin: ReturnType<typeof createAdminClient>, job: JobRow) {
  const payload = (job.payload && typeof job.payload === "object" ? (job.payload as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;

  switch (job.job_type) {
    case "fact_backfill_embeddings": {
      const dealId = String(payload.deal_id ?? job.subject_id);
      await backfillDealIntelFactEmbeddings(admin, dealId);
      return;
    }
    case "keyword_backfill_graph": {
      const dealId = String(payload.deal_id ?? job.subject_id);
      await backfillDealIntelKeywordGraph(admin, dealId);
      await reconcileDealIntelKeywordClustersOffline(admin);
      return;
    }
    case "deal_refine_tree_full": {
      const dealId = String(payload.deal_id ?? job.subject_id);
      const revisionId = payload.revision_id == null ? null : String(payload.revision_id);
      await materializeDealIntelTree({ admin, dealId, revisionId, mode: "full" });
      return;
    }
    case "doc_refine_chunks": {
      const documentId = String(payload.document_id ?? job.subject_id);
      await embedMissingDocumentChunks(admin, documentId);
      await mergeAdjacentRefinedChunks(admin, documentId);
      return;
    }
    default:
      return;
  }
}

export type BgWorkerOptions = {
  workerId?: string;
  claimLimit?: number;
  idleSleepMs?: number;
};

export async function runBgWorkerLoop(opts: BgWorkerOptions = {}): Promise<never> {
  const admin = createAdminClient();
  const defaultId =
    (globalThis.crypto && "randomUUID" in globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `r${Math.random().toString(16).slice(2)}${Date.now()}`) as string;
  const workerId = opts.workerId || `bg-worker:${defaultId}`;
  const claimLimit = Math.max(1, Math.min(50, opts.claimLimit ?? 5));
  const idleSleepMs = Math.max(250, Math.min(10_000, opts.idleSleepMs ?? 1000));

  while (true) {
    const { data: jobs, error } = await admin.rpc("deal_intel_claim_jobs", { p_worker_id: workerId, p_limit: claimLimit });
    if (error) {
      // In dev, Next may abort renders/restarts; treat aborts as normal noise.
      if (!isAbortLike(error)) {
        console.error("bg-worker claim_jobs error", error);
      }
      await sleep(2000);
      continue;
    }

    const rows = (jobs ?? []) as unknown as JobRow[];
    if (!rows.length) {
      await sleep(idleSleepMs);
      continue;
    }

    for (const j of rows) {
      try {
        await handleJob(admin, j);
        await admin.rpc("deal_intel_finish_job", { p_job_id: j.id, p_ok: true, p_error: null });
      } catch (e) {
        const msg = formatWorkerError(e);
        if (isAbortLike(e)) {
          // Dev-only noise when tied to Next render aborts; child-process worker avoids this.
          console.warn("bg-worker job aborted (ignored for logging)", { jobId: j.id, jobType: j.job_type });
          await admin.rpc("deal_intel_finish_job", { p_job_id: j.id, p_ok: false, p_error: `aborted: ${msg.slice(0, 2000)}` });
          continue;
        }
        console.error("bg-worker job failed", { jobId: j.id, jobType: j.job_type, msg });
        await admin.rpc("deal_intel_finish_job", { p_job_id: j.id, p_ok: false, p_error: msg.slice(0, 8000) });
      }
    }
  }
}

export function startBgWorkerInProcess() {
  const enabled =
    (process.env.DEAL_INTEL_BG_WORKER_AUTOSTART ?? (process.env.NODE_ENV === "development" ? "1" : "0")) === "1";
  if (!enabled) return;

  const g = globalThis as unknown as { __dealIntelBgWorkerStarted?: boolean };
  if (g.__dealIntelBgWorkerStarted) return;
  g.__dealIntelBgWorkerStarted = true;

  // Fire-and-forget; logs to server console.
  void runBgWorkerLoop({ workerId: `bg-worker:in-process:${Date.now()}` });
}

