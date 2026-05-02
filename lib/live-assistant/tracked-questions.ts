import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { embedMeetingQuestionText } from "@/lib/live-assistant/meeting-embeddings";
import { cosineSimilarity, parseVector, vectorParam } from "@/lib/data-layer/shared/vector";
import { createMeetingAssistantEvent } from "@/lib/live-assistant/tools";

export type QuestionProvenance =
  | "assumption_inversion"
  | "similar_company" // legacy: rows from the killed peer-template recycler. UI aliases to peer_style.
  | "peer_style"
  | "low_evidence"
  | "contradiction"
  | "coverage_prompt"
  | "manual";

export type QuestionState = "unanswered" | "partially_answered" | "answered" | "contradicted" | "needs_followup";

// Cosine threshold above which two question embeddings are considered the same question.
// Mirrors the conservative cutoff used in `meeting_question_span` (0.78 + LLM-confirm above 0.88);
// 0.84 collapses paraphrases ("What's your churn?" vs "How is your churn rate trending?")
// without merging genuinely distinct questions ("What's your ARR?" vs "What's your gross margin?").
export const TRACKED_QUESTION_NEAR_DUPLICATE_SIM = 0.84;

const TERMINAL_STATES: ReadonlySet<QuestionState> = new Set(["answered", "contradicted"]);

/** Don't re-emit a suggested_question card for the same tracked question more often than this. */
const TRACKED_QUESTION_RE_EMIT_COOLDOWN_MS = 10 * 60 * 1000;

// Stop-words deliberately small so we keep useful tokens like "ARR", "churn", "enterprise".
// Order doesn't matter (we sort) so this is a true bag-of-content-words key.
const QUESTION_TEXT_NORM_STOPWORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "and", "or", "but", "if", "of", "in", "on", "at", "to", "for", "with",
  "from", "into", "about", "is", "are", "was", "were", "be", "been", "being", "have", "has",
  "had", "do", "does", "did", "will", "would", "could", "should", "can", "may", "might",
  "you", "your", "yours", "we", "our", "ours", "us", "i", "me", "my", "they", "them", "their",
  "this", "that", "these", "those", "it", "its", "what", "when", "where", "who", "whom",
  "which", "why", "how", "any", "some", "no", "not", "yes", "as", "by", "than", "then", "so",
]);

/**
 * Deterministic content-bag hash of question text. Two questions with the same words
 * (order-insensitive, stop-words ignored, punctuation stripped) share a key, so we can do a
 * cheap exact-match lookup on `metadata->>text_norm_key` before paying for an embedding.
 */
export function questionTextNormKey(text: string): string {
  if (!text) return "";
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !QUESTION_TEXT_NORM_STOPWORDS.has(t));
  if (!tokens.length) return "";
  const uniq = [...new Set(tokens)].sort();
  return createHash("sha256").update(uniq.join(" ")).digest("hex").slice(0, 16);
}

type ExistingTrackedQuestion = {
  id: string;
  text: string;
  state: QuestionState;
  dedupe_key: string;
  question_embedding: unknown;
};

/**
 * Find an existing tracked question for this meeting that is semantically near-identical to the
 * provided embedding. Used to suppress per-source dedupe-key collisions across question generators
 * (`assumption_inversion`, `similar_company`, `low_evidence`, `contradiction`, ...), which all use
 * different `dedupe_key` shapes and therefore would otherwise insert distinct rows for the same
 * underlying question.
 */
export async function findNearDuplicateTrackedQuestion(
  admin: SupabaseClient,
  args: { meetingId: string; embedding: number[]; threshold?: number; limit?: number },
): Promise<{ row: ExistingTrackedQuestion; similarity: number } | null> {
  const threshold = args.threshold ?? TRACKED_QUESTION_NEAR_DUPLICATE_SIM;
  // Wider scan than before — a noisy meeting can rack up >80 questions and the older near-
  // duplicates would have slipped through the original 80-row window.
  const limit = Math.max(20, Math.min(500, args.limit ?? 250));
  if (!args.embedding.length) return null;

  const res = await admin
    .schema("deal_intel")
    .from("meeting_tracked_question")
    .select("id, text, state, dedupe_key, question_embedding")
    .eq("meeting_id", args.meetingId)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (res.error) {
    if (!String(res.error.message || "").includes("does not exist")) {
      console.error("findNearDuplicateTrackedQuestion", res.error.message || res.error);
    }
    return null;
  }

  const rows = (res.data ?? []) as ExistingTrackedQuestion[];
  let best: { row: ExistingTrackedQuestion; similarity: number } | null = null;
  for (const row of rows) {
    const v = parseVector(row.question_embedding);
    if (!v || v.length !== args.embedding.length) continue;
    const sim = cosineSimilarity(args.embedding, v);
    if (sim >= threshold && (!best || sim > best.similarity)) {
      best = { row, similarity: sim };
    }
  }
  return best;
}

/**
 * Cheap exact-content-bag lookup. Matches on `metadata->>text_norm_key`, so it catches
 * generators that produced literally the same question (modulo punctuation / stop-words /
 * word order) without paying for an embedding round-trip and without the 80-row scan
 * window that bounds `findNearDuplicateTrackedQuestion`.
 */
async function findTrackedQuestionByNormKey(
  admin: SupabaseClient,
  meetingId: string,
  normKey: string,
): Promise<ExistingTrackedQuestion | null> {
  if (!normKey) return null;
  try {
    const res = await admin
      .schema("deal_intel")
      .from("meeting_tracked_question")
      .select("id, text, state, dedupe_key, question_embedding")
      .eq("meeting_id", meetingId)
      .filter("metadata->>text_norm_key", "eq", normKey)
      .order("updated_at", { ascending: false })
      .limit(1);
    if (res.error) {
      if (!String(res.error.message || "").includes("does not exist")) {
        console.error("findTrackedQuestionByNormKey", res.error.message || res.error);
      }
      return null;
    }
    const row = (res.data ?? [])[0] as ExistingTrackedQuestion | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

async function recentEventForTrackedQuestion(
  admin: SupabaseClient,
  meetingId: string,
  trackedQuestionId: string,
): Promise<{ exists: boolean; createdAtMs: number | null }> {
  try {
    const res = await admin
      .schema("deal_intel")
      .from("meeting_assistant_event")
      .select("id, created_at")
      .eq("meeting_id", meetingId)
      .filter("source_map->>tracked_question_id", "eq", trackedQuestionId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (res.error) return { exists: false, createdAtMs: null };
    const row = (res.data ?? [])[0] as { created_at?: string } | undefined;
    if (!row) return { exists: false, createdAtMs: null };
    const ts = row.created_at ? new Date(row.created_at).getTime() : NaN;
    return { exists: true, createdAtMs: Number.isFinite(ts) ? ts : null };
  } catch {
    return { exists: false, createdAtMs: null };
  }
}

export async function upsertMeetingTrackedQuestion(
  admin: SupabaseClient,
  row: {
    meetingId: string;
    text: string;
    section: string;
    importanceWeight: number;
    state: QuestionState;
    provenance: QuestionProvenance;
    venue?: "in_meeting" | "memo_prep";
    similarDealId?: string | null;
    dedupeKey: string;
    metadata?: Record<string, unknown>;
    syncEvent?: { title: string; lane?: "attention" | "context" | "memo"; severity?: "low" | "med" | "high" };
  },
): Promise<{ id: string | null }> {
  const model = process.env.VERTEX_EMBEDDING_MODEL || "text-embedding-004";

  // Compute the deterministic content-bag key up front so we can do a cheap exact-match
  // dedupe BEFORE we pay for an embedding round-trip. Different generators that produce the
  // same wording (modulo punctuation/stop-words) all collide here.
  const normKey = questionTextNormKey(row.text);

  /**
   * Shared "we found a duplicate, decide whether to emit a fresh card" branch. Used by
   * both the norm-key path and the embedding-similarity path so they have identical UX
   * semantics: never re-emit a card more often than the cooldown, never resurrect a
   * terminal-state question.
   */
  const handleDuplicateHit = async (existing: ExistingTrackedQuestion): Promise<{ id: string | null }> => {
    if (TERMINAL_STATES.has(existing.state)) {
      return { id: existing.id };
    }
    if (row.syncEvent) {
      const recent = await recentEventForTrackedQuestion(admin, row.meetingId, existing.id);
      const cooledDown =
        !recent.exists ||
        (recent.createdAtMs != null && Date.now() - recent.createdAtMs > TRACKED_QUESTION_RE_EMIT_COOLDOWN_MS);
      if (cooledDown) {
        await createMeetingAssistantEvent(admin, {
          meeting_id: row.meetingId,
          kind: "suggested_question",
          severity: row.syncEvent.severity ?? "low",
          title: row.syncEvent.title,
          body: row.text,
          source_map: {
            lane: row.syncEvent.lane ?? "memo",
            tracked_question_id: existing.id,
            provenance: row.provenance,
            dedupe_key: `tq_evt:${existing.dedupe_key}`,
          },
        });
      }
    }
    return { id: existing.id };
  };

  if (normKey) {
    const exactMatch = await findTrackedQuestionByNormKey(admin, row.meetingId, normKey);
    if (exactMatch) {
      return handleDuplicateHit(exactMatch);
    }
  }

  let embedding: number[] | null = null;
  try {
    embedding = await embedMeetingQuestionText(row.text);
  } catch {
    embedding = null;
  }
  const qEmb = embedding ? vectorParam(embedding) : null;

  if (embedding && embedding.length) {
    const dup = await findNearDuplicateTrackedQuestion(admin, {
      meetingId: row.meetingId,
      embedding,
    });
    if (dup) {
      return handleDuplicateHit(dup.row);
    }
  }

  // Stash text_norm_key on insert so subsequent upserts hit the cheap exact-match path.
  const mergedMetadata: Record<string, unknown> = { ...(row.metadata ?? {}) };
  if (normKey) mergedMetadata.text_norm_key = normKey;

  const insertRow = {
    meeting_id: row.meetingId,
    text: row.text.slice(0, 2000),
    section: row.section,
    question_embedding: qEmb,
    question_embedding_model: model,
    importance_weight: row.importanceWeight,
    state: row.state,
    provenance: row.provenance,
    venue: row.venue ?? "in_meeting",
    similar_deal_id: row.similarDealId ?? null,
    dedupe_key: row.dedupeKey,
    metadata: mergedMetadata,
  };

  const res = await admin
    .schema("deal_intel")
    .from("meeting_tracked_question")
    .upsert(insertRow, { onConflict: "meeting_id,dedupe_key" })
    .select("id")
    .maybeSingle();

  if (res.error && !String(res.error.message || "").includes("does not exist")) {
    console.error("upsertMeetingTrackedQuestion", res.error.message || res.error);
  }

  const id = res.data?.id ? String(res.data.id) : null;

  if (row.syncEvent && id) {
    await createMeetingAssistantEvent(admin, {
      meeting_id: row.meetingId,
      kind: "suggested_question",
      severity: row.syncEvent.severity ?? "low",
      title: row.syncEvent.title,
      body: row.text,
      source_map: {
        lane: row.syncEvent.lane ?? "memo",
        tracked_question_id: id,
        provenance: row.provenance,
        dedupe_key: `tq_evt:${row.dedupeKey}`,
      },
    });
  }

  return { id };
}

export function stableKeyAssumption(claimId: string, assumptionText: string): string {
  return createHash("sha256")
    .update(`${claimId}|${assumptionText.toLowerCase().slice(0, 400)}`)
    .digest("hex")
    .slice(0, 20);
}

