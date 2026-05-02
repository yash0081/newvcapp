import { createAdminClient } from "@/lib/supabase/admin";
import { backfillDealIntelFactEmbeddings } from "@/lib/deal-intel/backfill-facts";
import { backfillDealIntelKeywordGraph, reconcileDealIntelKeywordClustersOffline } from "@/lib/deal-intel/keywords";
import { materializeDealIntelTree } from "@/lib/deal-intel/materialize-tree";
import { extractClaimsForDocument } from "@/lib/deal-intel/claim-extract";
import { embedTexts } from "@/lib/vertex-embeddings";
import { cosineSimilarity, parseVector, vectorParam, weightedCentroid } from "@/lib/data-layer/shared/vector";
import { chunkArray, mapWithConcurrency } from "@/lib/async/concurrency";
import { runSlowReasoningForClaim } from "@/lib/live-assistant/reasoning";
import type { ClassifiedClaim } from "@/lib/live-assistant/claim-classifier";
import { runDeepContradictionBatch } from "@/lib/live-assistant/deep-contradictions";
import { fetchDealIntelGroundingPack } from "@/lib/live-assistant/deal-intel-grounding";
import { runKpiMiddlePath } from "@/lib/live-assistant/kpi-middle-path";
import { runMeetingQuestionEngineTick } from "@/lib/live-assistant/question-engine-tick";
import { runMeetingClaimAutoVerify } from "@/lib/live-assistant/claim-verify-auto";
import { runCanonicalClaimVerify } from "@/lib/live-assistant/claim-verifier";
import { runMeetingClaimResearchVerify } from "@/lib/live-assistant/claim-verify-research";
import { dedupeContradictionEventsByFactKey } from "@/lib/live-assistant/dedupe-contradictions";
import { runMeetingNotesTick } from "@/lib/live-assistant/notes";
import { loadLiveAssistantPreferenceSignals } from "@/lib/live-assistant/preferences";
import { finalizeCopilotSessionToDocument } from "@/lib/copilot/finalize";
import { syncCopilotSessionToFactsSchema } from "@/lib/copilot/schema-sync";
import type { AcceptedSnippet } from "@/lib/copilot/types";
import {
  getCopilotSessionById,
  getDealForUser,
  insertCopilotEvent,
  updateCopilotSessionMetadata,
  updateSessionFinalizedDocumentId,
} from "@/lib/copilot/db";

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

function asCompanyName(meta: unknown): string {
  if (!meta || typeof meta !== "object") return "Company";
  const m = meta as Record<string, unknown>;
  return typeof m.company_name === "string" ? m.company_name : "Company";
}

/** ~every 90s: enqueue copilot_session_sync for active sessions with accepts older than 60s and still unsynced. */
async function enqueueDueCopilotSessionSyncs(admin: ReturnType<typeof createAdminClient>) {
  const { data: rows, error } = await admin
    .schema("deal_intel")
    .from("copilot_session")
    .select("id, metadata")
    .eq("status", "active")
    .limit(200);
  if (error || !rows?.length) return;
  const now = Date.now();
  for (const row of rows) {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const unsynced = Number(meta.unsynced_accept_count ?? 0);
    if (unsynced <= 0) continue;
    const lastAccept = meta.last_accept_at ? new Date(String(meta.last_accept_at)).getTime() : 0;
    if (!lastAccept) continue;
    if (now - lastAccept < 60_000) continue;
    const lastSynced = meta.last_synced_at ? new Date(String(meta.last_synced_at)).getTime() : 0;
    if (lastSynced >= lastAccept) continue;
    await admin.rpc("deal_intel_enqueue_job", {
      p_job_type: "copilot_session_sync",
      p_subject_kind: "copilot_session",
      p_subject_id: row.id,
      p_payload: { periodic: true },
      p_priority: 120,
    });
  }
}

async function handleCopilotSessionSyncJob(admin: ReturnType<typeof createAdminClient>, job: JobRow) {
  const payload = (job.payload && typeof job.payload === "object" ? job.payload : {}) as Record<string, unknown>;
  const terminal = Boolean(payload.terminal);
  const sessionId = String(job.subject_id);

  let session = await getCopilotSessionById({ admin, sessionId });
  if (!session) return;

  if (!terminal && session.status !== "active") return;

  const meta0 = (session.metadata ?? {}) as Record<string, unknown>;
  const snippets = Array.isArray(meta0.acceptedSnippets) ? (meta0.acceptedSnippets as AcceptedSnippet[]) : [];
  if (snippets.length === 0) return;

  if (!terminal) {
    const unsynced = Number(meta0.unsynced_accept_count ?? 0);
    if (unsynced <= 0) return;
    const lastAccept = meta0.last_accept_at ? new Date(String(meta0.last_accept_at)).getTime() : 0;
    const lastSynced = meta0.last_synced_at ? new Date(String(meta0.last_synced_at)).getTime() : 0;
    if (lastAccept && lastSynced >= lastAccept) return;
  }

  const acceptAtStart = meta0.last_accept_at;
  const existingDoc =
    typeof meta0.synced_document_id === "string" && meta0.synced_document_id.trim()
      ? meta0.synced_document_id.trim()
      : undefined;

  const deal = await getDealForUser({ admin, dealId: session.deal_id, userId: session.user_id });
  if (!deal) throw new Error("deal not found for copilot session sync");
  const companyName = asCompanyName(deal.metadata);

  session = (await getCopilotSessionById({ admin, sessionId })) ?? session;

  const docResult = await finalizeCopilotSessionToDocument({
    admin,
    session,
    companyName,
    existingDocumentId: existingDoc ?? null,
  });
  const documentId = docResult.documentId;

  session = (await getCopilotSessionById({ admin, sessionId })) ?? session;

  let factsRevisionId: string | null = null;
  let factsPeople = 0;
  try {
    const schemaSync = await syncCopilotSessionToFactsSchema({
      admin,
      session,
      companyName,
    });
    factsRevisionId = schemaSync.revisionId;
    factsPeople = schemaSync.insertedPeople;
  } catch (e) {
    await insertCopilotEvent({
      admin,
      event: {
        session_id: sessionId,
        kind: "error",
        payload: {
          stage: "copilot_session_schema_sync",
          message: e instanceof Error ? e.message : String(e),
        },
      },
    });
  }

  const fresh = await getCopilotSessionById({ admin, sessionId });
  if (!fresh) return;
  const m = {
    ...(typeof fresh.metadata === "object" && fresh.metadata ? (fresh.metadata as Record<string, unknown>) : {}),
  } as Record<string, unknown>;
  if (documentId) {
    m.synced_document_id = documentId;
    if (terminal) {
      await updateSessionFinalizedDocumentId({ admin, sessionId, documentId });
    }
  }
  const acceptNow = m.last_accept_at;
  if (acceptAtStart != null && acceptNow === acceptAtStart) {
    m.unsynced_accept_count = 0;
  }
  m.last_synced_at = new Date().toISOString();
  await updateCopilotSessionMetadata({ admin, sessionId, metadata: m });

  await insertCopilotEvent({
    admin,
    event: {
      session_id: sessionId,
      kind: "reply",
      payload: {
        text: terminal
          ? "Research session ended; document ingested and embeddings queued."
          : "Copilot research document refreshed from accepted snippets.",
        document_id: documentId,
        terminal,
        facts_revision_id: factsRevisionId,
        people_rows: factsPeople,
      },
    },
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
      // Mark document usable; further enrichment is optional.
      await admin
        .schema("deal_intel")
        .from("document")
        .update({ status: "ready", error_message: null, updated_at: new Date().toISOString() })
        .eq("id", documentId);
      return;
    }
    case "doc_extract_claims": {
      const documentId = String(payload.document_id ?? job.subject_id);
      await extractClaimsForDocument(
        admin as unknown as { schema: (s: string) => { from: (t: string) => unknown }; rpc: (fn: string, args: Record<string, unknown>) => unknown },
        documentId
      );
      return;
    }
    case "meeting_claim_reasoning": {
      const meetingId = String(payload.meeting_id ?? job.subject_id);
      const userId = String(payload.user_id ?? "");
      const dealId = String(payload.deal_id ?? "");
      const dedupeKey = payload.dedupe_key == null ? null : String(payload.dedupe_key);
      const claim = {
        text: String(payload.quote ?? payload.source_text ?? ""),
        section: String(payload.section ?? "other"),
        intent: String(payload.intent ?? "claim"),
        confidence: Number(payload.confidence ?? 0.5),
      };
      if (!meetingId || !userId || !dealId || !claim.text) return;
      // Best-effort dedupe: if we already emitted a reasoned card with this dedupe_key, skip.
      if (dedupeKey) {
        const recent = await admin
          .schema("deal_intel")
          .from("meeting_assistant_event")
          .select("id, source_map")
          .eq("meeting_id", meetingId)
          .order("created_at", { ascending: false })
          .limit(80);
        if (!recent.error) {
          const rows = (recent.data ?? []) as Array<{ id: string; source_map: unknown }>;
          for (const r of rows) {
            const sm = (r.source_map && typeof r.source_map === "object" ? (r.source_map as Record<string, unknown>) : {}) as Record<
              string,
              unknown
            >;
            if (String(sm.dedupe_key ?? "") === dedupeKey) return;
          }
        }
      }
      const typedClaim: ClassifiedClaim = {
        text: claim.text,
        section: claim.section as ClassifiedClaim["section"],
        intent: claim.intent as ClassifiedClaim["intent"],
        confidence: Number.isFinite(claim.confidence) ? claim.confidence : 0.5,
      };
      await runSlowReasoningForClaim(admin, {
        meetingId,
        userId,
        dealId,
        claim: typedClaim,
        sourceText: String(payload.source_text ?? claim.text),
        meetingClaimId: payload.meeting_claim_id == null ? null : String(payload.meeting_claim_id),
        preferenceContext:
          payload.preference_context && typeof payload.preference_context === "object"
            ? (payload.preference_context as {
                hints?: string[];
                sectionWeights?: Record<string, number>;
                preferredDomains?: string[];
                confidence?: number;
              })
            : {
                hints: Array.isArray(payload.preference_hints) ? payload.preference_hints.map((x) => String(x)) : [],
              },
      });
      return;
    }
    case "meeting_deep_contradictions": {
      const meetingId = String(payload.meeting_id ?? job.subject_id);
      const userId = String(payload.user_id ?? "");
      const dealId = String(payload.deal_id ?? "");
      const section = String(payload.section ?? "other");
      if (!meetingId || !userId || !dealId) return;
      await runDeepContradictionBatch(admin, { meetingId, userId, dealId, section });
      return;
    }
    case "meeting_dedupe_contradictions": {
      const meetingId = String(payload.meeting_id ?? job.subject_id);
      if (!meetingId) return;
      await dedupeContradictionEventsByFactKey(admin, meetingId);
      return;
    }
    case "meeting_notes_tick": {
      const meetingId = String(payload.meeting_id ?? job.subject_id);
      const userId = String(payload.user_id ?? "");
      if (!meetingId || !userId) return;
      const pref = await loadLiveAssistantPreferenceSignals(admin, userId).catch(() => null);
      await runMeetingNotesTick(admin, { meetingId, userId, pref });
      return;
    }
    case "meeting_question_engine_tick": {
      const meetingId = String(payload.meeting_id ?? job.subject_id);
      if (!meetingId) return;
      await runMeetingQuestionEngineTick(admin, payload);
      return;
    }
    case "meeting_claim_auto_verify": {
      await runMeetingClaimAutoVerify(admin, payload as Record<string, unknown>);
      return;
    }
    case "meeting_canonical_claim_verify": {
      await runCanonicalClaimVerify(admin, payload as Record<string, unknown>);
      return;
    }
    case "meeting_claim_research_verify": {
      await runMeetingClaimResearchVerify(admin, payload as Record<string, unknown>);
      return;
    }
    case "meeting_kpi_middle": {
      const meetingId = String(payload.meeting_id ?? job.subject_id);
      const dealId = String(payload.deal_id ?? "");
      const chunkText = String(payload.chunk_text ?? "");
      const dedupeKey = payload.dedupe_key == null ? "" : String(payload.dedupe_key);
      if (!meetingId || !dealId || !chunkText) return;
      if (dedupeKey) {
        const recent = await admin
          .schema("deal_intel")
          .from("meeting_assistant_event")
          .select("id, source_map")
          .eq("meeting_id", meetingId)
          .order("created_at", { ascending: false })
          .limit(50);
        if (!recent.error) {
          for (const r of (recent.data ?? []) as Array<{ source_map: unknown }>) {
            const sm = (r.source_map && typeof r.source_map === "object" ? (r.source_map as Record<string, unknown>) : {}) as Record<
              string,
              unknown
            >;
            if (String(sm.parent_dedupe ?? "") === dedupeKey && sm.kind === "kpi_middle_path") return;
          }
        }
      }
      const pack = await fetchDealIntelGroundingPack(admin, dealId);
      await runKpiMiddlePath(admin, {
        meetingId,
        dealId,
        chunkText,
        pack,
        dedupeKey: dedupeKey || `mid:${meetingId}`,
      });
      return;
    }
    case "copilot_session_sync": {
      await handleCopilotSessionSyncJob(admin, job);
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
  let lastPeriodicEnqueueAt = 0;

  while (true) {
    const tick = Date.now();
    if (tick - lastPeriodicEnqueueAt >= 90_000) {
      lastPeriodicEnqueueAt = tick;
      await enqueueDueCopilotSessionSyncs(admin).catch((e) => console.error("enqueueDueCopilotSessionSyncs", e));
    }

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

