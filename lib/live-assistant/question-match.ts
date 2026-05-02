import type { SupabaseClient } from "@supabase/supabase-js";
import { vertexRunWithText } from "@/lib/vertex";
import { parseJsonFromResponseOrNull, parseJsonFromResponseWithRepair } from "@/lib/gemini";
import { getLiveAssistantModel } from "@/lib/live-assistant/model-env";
import { cosineSimilarity, parseVector, vectorParam } from "@/lib/data-layer/shared/vector";
import { embedMeetingQuestionText } from "@/lib/live-assistant/meeting-embeddings";
import { embedText } from "@/lib/vertex-embeddings";

const FAST = getLiveAssistantModel("fast");

function envFlag(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export type ClaimRelation = "answers" | "partial" | "contradicts" | "irrelevant";

function recencyWeightWithinMeeting(tEndMs: number, latestEndMs: number): number {
  // `meeting_claim.t_end_ms` is *relative to meeting start* (not epoch). Use relative time deltas.
  const halfLife = Math.max(30_000, Number(process.env.LIVE_ASSISTANT_Q_RECENCY_HALFLIFE_MS ?? 180_000));
  const dt = Math.max(0, latestEndMs - tEndMs);
  return Math.pow(0.5, dt / halfLife);
}

type QuestionShape = "quantity" | "who_what_where_when" | "yes_no" | "open";

function classifyQuestionShape(q: string): QuestionShape {
  const s = q.trim().toLowerCase();
  // Quantity-shaped: explicit "how much/many", or any KPI-ish noun.
  if (
    /\bhow\s+(many|much|long|often|fast|big|small|large|wide|frequent)\b/.test(s) ||
    /\b(arr|mrr|revenue|growth\s*rate|churn|nrr|grr|runway|burn|valuation|cac|ltv|gmv|acv|arpa|arpu|headcount|fte|count|number|size|amount|price|cost|salary|cap|rate|margin|tam|sam|som|seats?|users?|customers?)\b/.test(
      s,
    )
  ) {
    return "quantity";
  }
  if (
    /^(who|what|when|where|which)\b/.test(s) ||
    /\b(who|when|where)\s+(is|are|was|were|will|did|do|does)\b/.test(s)
  ) {
    return "who_what_where_when";
  }
  if (/^(do|does|did|is|are|was|were|can|could|will|would|have|has|had|should)\b/.test(s)) {
    return "yes_no";
  }
  return "open";
}

/** Stricter shape gate for unprompted answers — kills bare "yeah" without topical overlap, etc. */
function claimHasAnswerShapeStrict(shape: QuestionShape, claim: string, question: string): boolean {
  const c = claim.trim();
  const overlap = questionClaimTokenOverlap(question, claim);
  switch (shape) {
    case "quantity":
      if (
        !(
          /\d/.test(c) ||
          /[$€£¥%]/.test(c) ||
          /\b(one|two|three|four|five|six|seven|eight|nine|ten|dozen|hundred|thousand|million|billion|trillion|few|several|many|dozens|hundreds|thousands)\b/i.test(
            c,
          )
        )
      )
        return false;
      return overlap >= 0.1;
    case "who_what_where_when": {
      const hasEntity =
        /\b\d{4}\b/.test(c) ||
        /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.test(c) ||
        /\b[A-Z][a-zA-Z]{2,}\b/.test(c.slice(1));
      return hasEntity && overlap >= 0.1;
    }
    case "yes_no": {
      const hasAffirm =
        /\b(yes|no|nope|yeah|yep|absolutely|definitely|never)\b/i.test(c) ||
        /\b(we\s+(do|don't|are|aren't|have|haven't|can|can't|will|won't|did|didn't))\b/i.test(c);
      if (!hasAffirm) return false;
      const tokens = c.split(/\s+/).filter(Boolean);
      const bareShort =
        tokens.length <= 2 && /^(yeah|yes|yep|no|nope)\.?$/i.test(c.replace(/\s+/g, " ").trim());
      if (bareShort) return overlap >= 0.22;
      return true;
    }
    case "open":
      return overlap >= 0.12 || c.length > 26;
  }
}

/** Gate promoting unprompted claims to `answered` — requires substantive lexical grounding. */
function substantiveGateModeB(question: string, claimText: string): boolean {
  const shape = classifyQuestionShape(question);
  const overlap = questionClaimTokenOverlap(question, claimText);
  switch (shape) {
    case "quantity":
      return (
        (/\d/.test(claimText) ||
          /[$€£¥%]/.test(claimText) ||
          /\b(one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|million|billion)\b/i.test(claimText)) &&
        overlap >= 0.1
      );
    case "who_what_where_when":
      return (
        (/\b\d{4}\b/.test(claimText) ||
          /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.test(claimText) ||
          /\b[A-Z][a-zA-Z]{2,}\b/.test(claimText.slice(1))) &&
        overlap >= 0.1
      );
    case "yes_no": {
      const tokens = claimText.trim().split(/\s+/).filter(Boolean);
      const bareShort =
        tokens.length <= 2 && /^(yeah|yes|yep|no|nope)\.?$/i.test(claimText.trim().replace(/\s+/g, " "));
      if (bareShort) return overlap >= 0.22;
      return overlap >= 0.18 || tokens.length >= 4;
    }
    case "open":
      return overlap >= 0.12 || claimText.trim().length > 26;
  }
}

/** Cheap pre-filter so we don't waste an LLM call on obviously answer-less claims. */
function claimHasAnswerShape(shape: QuestionShape, claim: string): boolean {
  const c = claim.trim();
  switch (shape) {
    case "quantity":
      return (
        /\d/.test(c) ||
        /[$€£¥%]/.test(c) ||
        /\b(one|two|three|four|five|six|seven|eight|nine|ten|dozen|hundred|thousand|million|billion|trillion|few|several|many|dozens|hundreds|thousands)\b/i.test(
          c,
        )
      );
    case "who_what_where_when": {
      if (/\b\d{4}\b/.test(c)) return true; // year
      if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.test(c)) return true;
      // Capitalized noun anywhere past the first character (proxies for a named entity).
      return /\b[A-Z][a-zA-Z]{2,}\b/.test(c.slice(1));
    }
    case "yes_no":
      return (
        /\b(yes|no|nope|yeah|yep|absolutely|definitely|never)\b/i.test(c) ||
        /\b(we\s+(do|don't|are|aren't|have|haven't|can|can't|will|won't|did|didn't))\b/i.test(c)
      );
    case "open":
      // Can't reliably pre-filter open-ended questions; defer to the LLM.
      return true;
  }
}

/** Share of question content words (minus stopwords) that also appear in the claim — catches Q+A even when embeddings diverge. */
function questionClaimTokenOverlap(question: string, claimText: string): number {
  const stop = new Set([
    "what",
    "when",
    "where",
    "who",
    "whom",
    "whose",
    "which",
    "why",
    "how",
    "does",
    "did",
    "do",
    "is",
    "are",
    "was",
    "were",
    "the",
    "a",
    "an",
    "you",
    "your",
    "our",
    "their",
    "they",
    "this",
    "that",
    "these",
    "those",
    "for",
    "and",
    "but",
    "with",
    "from",
    "into",
    "about",
    "have",
    "has",
    "had",
    "can",
    "could",
    "would",
    "should",
    "will",
    "me",
    "us",
    "we",
    "it",
    "its",
    "be",
    "been",
    "being",
    "of",
    "in",
    "on",
    "at",
    "to",
    "as",
    "by",
    "or",
    "if",
    "so",
    "not",
    "no",
    "yes",
    "there",
    "here",
    "tell",
    "share",
    "describe",
    "explain",
    "kind",
    "sort",
    "some",
    "any",
    "just",
    "like",
    "get",
    "got",
    "really",
    "very",
    "much",
  ]);
  const words = question
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2 && !stop.has(w));
  if (words.length === 0) return 0;
  const c = claimText.toLowerCase();
  let hit = 0;
  for (const w of words) {
    if (c.includes(w)) hit += 1;
  }
  return hit / words.length;
}

function heuristicRelation(
  question: string,
  claimText: string,
  sim: number,
  opts?: { dialogueMode?: boolean; strictUnprompted?: boolean },
): { rel: ClaimRelation; margin: number } {
  const dialogueMode = opts?.dialogueMode ?? false;
  const strictUnprompted = opts?.strictUnprompted ?? false;
  const qLow = question.toLowerCase();
  const c = claimText.toLowerCase();
  const overlap = qLow.split(/\s+/).filter((w) => w.length > 3 && c.includes(w)).length;
  const neg = /\b(no|not|never|didn't|wasn't|isn't|can't|won't)\b/.test(c);
  const pos = /\b(yes|we do|we have|we are|because|due to|our)\b/.test(c);
  // Require an answer-shaped signal in the claim; topical similarity + first-person voice is
  // not enough on its own. Mismatched shape demotes to `partial` so the LLM still gets a look.
  const shape = classifyQuestionShape(question);
  const answerShape = dialogueMode
    ? true
    : strictUnprompted
      ? claimHasAnswerShapeStrict(shape, claimText, question)
      : claimHasAnswerShape(shape, claimText);
  if (sim >= 0.82 && pos && !neg && answerShape) return { rel: "answers", margin: sim - 0.82 };
  if (sim >= 0.68 && (pos || sim >= 0.78 || overlap >= 2)) return { rel: "partial", margin: sim - 0.68 };
  if (sim >= 0.55 && neg) return { rel: "contradicts", margin: sim - 0.55 };
  if (sim < 0.52) return { rel: "irrelevant", margin: 0.52 - sim };
  return { rel: "irrelevant", margin: 0.1 };
}

export type AnswerCheck = {
  answers: boolean;
  partial: boolean;
  contradicts: boolean;
  answerText: string;
  confidence: number;
};

/**
 * Strict LLM check that asks for literal answer extraction. Replaces the prior `llmRelation`
 * classifier — `answered` is now gated on this returning `answers: true` plus a confidence floor,
 * so topical-only matches no longer flip the question state.
 */
async function llmAnswerCheck(question: string, claimText: string): Promise<AnswerCheck | null> {
  const prompt = `You decide whether a single CLAIM literally answers an investor question (live meeting transcript).

QUESTION: "${question.slice(0, 600)}"
CLAIM: "${claimText.slice(0, 800)}"

Return JSON only:
{
  "answers": true|false,
  "partial": true|false,
  "contradicts": true|false,
  "answer_text": "<<=200 chars: the literal piece of the claim that answers the question, or empty>>",
  "confidence": 0.0
}

Rules:
- "answers" is true ONLY if the claim contains the specific information the question asks for.
- Dialogue shape counts: if the speaker restates or echoes the question then supplies the answer in the SAME claim, treat as answering when the substantive reply is there.
- If the question asks a quantity ("how many/how much/what is your X"), the claim must include a number/value (or spelled-out amount).
- If the question asks "who/what/when/where", the claim must name a specific entity/date/place.
- For yes/no questions, the claim must explicitly affirm or deny (including "we do", "we don't", "not yet", etc.).
- Topical relatedness without the actual answer = "answers": false (use "partial" if it gives a non-trivial fragment).
- "contradicts" is true if the claim disagrees with the assumed answer in the question.
- Prefer "answers": true with confidence >= 0.65 when the claim clearly resolves what was asked; use "partial" only when critical specifics are still missing.`;
  try {
    const raw = await vertexRunWithText(FAST, prompt, false);
    const parsed = (parseJsonFromResponseOrNull(raw) ?? (await parseJsonFromResponseWithRepair(raw))) as {
      answers?: unknown;
      partial?: unknown;
      contradicts?: unknown;
      answer_text?: unknown;
      confidence?: unknown;
    } | null;
    if (!parsed) return null;
    const answers = parsed.answers === true;
    const partial = parsed.partial === true;
    const contradicts = parsed.contradicts === true;
    const answerText = typeof parsed.answer_text === "string" ? parsed.answer_text.trim().slice(0, 200) : "";
    let confidence = Number(parsed.confidence);
    if (!Number.isFinite(confidence)) confidence = 0;
    confidence = Math.max(0, Math.min(1, confidence));
    return { answers, partial, contradicts, answerText, confidence };
  } catch {
    return null;
  }
}

async function llmAnswerCheckDialogue(hostSpokenQuestion: string, guestClaim: string): Promise<AnswerCheck | null> {
  const prompt = `The HOST just asked this out loud on a live VC diligence call (verbatim transcript):
"${hostSpokenQuestion.slice(0, 600)}"

The GUEST replied with:
"${guestClaim.slice(0, 800)}"

Does the guest reply DIRECTLY answer what the host asked? Terse replies ("yeah", "no", "about ten thousand", or a bare number) count as answers ONLY when they clearly resolve the host's question.

Return JSON only:
{
  "answers": true|false,
  "partial": true|false,
  "contradicts": true|false,
  "answer_text": "<<=200 chars: literal fragment that answers, or empty>>",
  "confidence": 0.0
}

Rules:
- "answers" true only when the reply resolves the host's question content (not merely topical).
- Related but wrong substance (e.g. wrong animal, wrong metric) = answers false, partial at most.
- Prefer answers=true at confidence >= 0.55 when the terse reply clearly fits the host question.`;
  try {
    const raw = await vertexRunWithText(FAST, prompt, false);
    const parsed = (parseJsonFromResponseOrNull(raw) ?? (await parseJsonFromResponseWithRepair(raw))) as {
      answers?: unknown;
      partial?: unknown;
      contradicts?: unknown;
      answer_text?: unknown;
      confidence?: unknown;
    } | null;
    if (!parsed) return null;
    const answers = parsed.answers === true;
    const partial = parsed.partial === true;
    const contradicts = parsed.contradicts === true;
    const answerText = typeof parsed.answer_text === "string" ? parsed.answer_text.trim().slice(0, 200) : "";
    let confidence = Number(parsed.confidence);
    if (!Number.isFinite(confidence)) confidence = 0;
    confidence = Math.max(0, Math.min(1, confidence));
    return { answers, partial, contradicts, answerText, confidence };
  } catch {
    return null;
  }
}

type HostAskedDialogueCtx = {
  askedEndMs: number;
  askedText: string;
  windowEndMs: number;
};

function hostAnswerWindowMs(): number {
  return Math.max(
    30_000,
    Math.min(120_000, Number(process.env.LIVE_ASSISTANT_Q_HOST_ANSWER_WINDOW_MS ?? 60_000)),
  );
}

async function loadHostTurnStarts(admin: SupabaseClient, meetingId: string): Promise<number[]> {
  const hostRes = await admin
    .schema("deal_intel")
    .from("meeting_semantic_chunk")
    .select("t_start_ms")
    .eq("meeting_id", meetingId)
    .like("speaker", "host:%")
    .order("t_start_ms", { ascending: true });

  const hostStarts: number[] = [];
  if (!hostRes.error && hostRes.data?.length) {
    for (const r of hostRes.data as Array<{ t_start_ms: number }>) {
      const t = Number(r.t_start_ms);
      if (Number.isFinite(t)) hostStarts.push(t);
    }
    hostStarts.sort((a, b) => a - b);
  }
  return hostStarts;
}

/** Latest confirmed host-asked span per tracked question + answer window capped by next host turn. */
async function loadHostAskedDialogueWindows(
  admin: SupabaseClient,
  meetingId: string,
  trackedQuestionIds: Set<string>,
  hostStartsPreloaded?: number[],
): Promise<Map<string, HostAskedDialogueCtx>> {
  const ANSWER_WINDOW_MS = hostAnswerWindowMs();

  const spanRes = await admin
    .schema("deal_intel")
    .from("meeting_question_span")
    .select("linked_tracked_question_id, t_end_ms, text")
    .eq("meeting_id", meetingId)
    .eq("confirmed_by_llm", true)
    .not("linked_tracked_question_id", "is", null)
    .order("t_end_ms", { ascending: false });

  if (spanRes.error) {
    if (!String(spanRes.error.message || "").includes("does not exist"))
      console.warn("loadHostAskedDialogueWindows spans", spanRes.error);
    return new Map();
  }

  const hostStarts = hostStartsPreloaded ?? (await loadHostTurnStarts(admin, meetingId));

  const map = new Map<string, HostAskedDialogueCtx>();
  const spans = (spanRes.data ?? []) as Array<{ linked_tracked_question_id: string; t_end_ms: number; text: string }>;

  for (const sp of spans) {
    const qid = String(sp.linked_tracked_question_id ?? "");
    if (!trackedQuestionIds.has(qid) || map.has(qid)) continue;
    const askedEndMs = Number(sp.t_end_ms);
    if (!Number.isFinite(askedEndMs)) continue;
    const nextHost = hostStarts.find((t) => t > askedEndMs);
    const cap = askedEndMs + ANSWER_WINDOW_MS;
    const windowEndMs = nextHost !== undefined ? Math.min(cap, nextHost) : cap;
    map.set(qid, {
      askedEndMs,
      askedText: String(sp.text ?? "").slice(0, 600),
      windowEndMs,
    });
  }
  return map;
}

/**
 * When the host reads a tracked question aloud but `meeting_question_span` was never linked /
 * confirmed, fall back to lexical overlap against recent host semantic chunks so Mode A dialogue
 * matching still runs.
 */
async function augmentDialogueFromHostChunks(
  admin: SupabaseClient,
  meetingId: string,
  questions: Array<{ id: string; text: string }>,
  existing: Map<string, HostAskedDialogueCtx>,
  hostStarts: number[],
): Promise<void> {
  const ANSWER_WINDOW_MS = hostAnswerWindowMs();
  const OVERLAP_MIN = 0.28;
  const COS_MIN = 0.6;

  const chunkRes = await admin
    .schema("deal_intel")
    .from("meeting_semantic_chunk")
    .select("text, t_start_ms, t_end_ms")
    .eq("meeting_id", meetingId)
    .like("speaker", "host:%")
    .order("t_end_ms", { ascending: false })
    .limit(80);

  if (chunkRes.error || !chunkRes.data?.length) return;

  const rows = chunkRes.data as Array<{ text?: string; t_start_ms?: number; t_end_ms?: number }>;

  const chunkEmbeddings: (number[] | null)[] = await Promise.all(
    rows.map(async (row) => {
      const text = String(row.text ?? "");
      if (text.length < 12) return null;
      try {
        return await embedText(text.slice(0, 1200));
      } catch {
        return null;
      }
    }),
  );

  for (const q of questions) {
    if (existing.has(q.id)) continue;
    let qEmb: number[] | null = null;
    try {
      qEmb = await embedMeetingQuestionText(q.text);
    } catch {
      qEmb = null;
    }
    let best: { score: number; t_end_ms: number; text: string } | null = null;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const text = String(row.text ?? "");
      if (text.length < 12) continue;
      const ov = questionClaimTokenOverlap(q.text, text);
      if (ov < OVERLAP_MIN) continue;
      const ce = chunkEmbeddings[i];
      let cos = 0;
      if (qEmb && ce && qEmb.length === ce.length) cos = cosineSimilarity(qEmb, ce);
      if (cos < COS_MIN) continue;
      const score = 0.55 * cos + 0.45 * ov;
      const tEnd = Number(row.t_end_ms);
      if (!Number.isFinite(tEnd)) continue;
      if (!best || score > best.score) best = { score, t_end_ms: tEnd, text };
    }
    if (!best) continue;

    const askedEndMs = best.t_end_ms;
    const nextHost = hostStarts.find((t) => t > askedEndMs);
    const cap = askedEndMs + ANSWER_WINDOW_MS;
    const windowEndMs = nextHost !== undefined ? Math.min(cap, nextHost) : cap;
    existing.set(q.id, {
      askedEndMs,
      askedText: best.text.slice(0, 600),
      windowEndMs,
    });
  }
}

function clamp01q(n: unknown): number {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function normalizeClaimRelationQ(s: unknown): ClaimRelation {
  const x = String(s ?? "").toLowerCase();
  if (x === "answers" || x === "partial" || x === "contradicts" || x === "irrelevant") return x;
  return "irrelevant";
}

type CanonicalBatchItem = {
  question_id: string;
  question_text: string;
  host_dialogue: string | null;
  mode_a: boolean;
  candidates: Array<{ claim_id: string; claim_text: string; sim: number }>;
};

async function llmCanonicalQuestionBatch(
  items: CanonicalBatchItem[],
): Promise<Map<string, { claim_id: string | null; relation: ClaimRelation; confidence: number; answer_text: string }>> {
  const out = new Map<string, { claim_id: string | null; relation: ClaimRelation; confidence: number; answer_text: string }>();
  if (process.env.LIVE_ASSISTANT_Q_MATCH_LLM === "0" || !items.length) return out;
  const prompt = `You match investor diligence QUESTIONS to GUEST transcript CLAIMS (short snippets from the meeting).

For EACH item, choose at most ONE candidate claim_id that answers the question, or null if none fit.
When mode_a is true, host_dialogue is how the host asked — treat it as the primary question wording.

Relations: "answers" | "partial" | "contradicts" | "irrelevant"

Return JSON only:
{ "results": [ { "question_id": string, "claim_id": string|null, "relation": string, "confidence": number, "answer_text": string } ] }

ITEMS:
${JSON.stringify(items).slice(0, 28000)}`;
  try {
    const raw = await vertexRunWithText(FAST, prompt, false);
    const parsed = (parseJsonFromResponseOrNull(raw) ?? (await parseJsonFromResponseWithRepair(raw))) as {
      results?: Array<{
        question_id?: string;
        claim_id?: string | null;
        relation?: string;
        confidence?: number;
        answer_text?: string;
      }>;
    } | null;
    for (const r of parsed?.results ?? []) {
      const qid = typeof r.question_id === "string" ? r.question_id : "";
      if (!qid) continue;
      out.set(qid, {
        claim_id: r.claim_id == null || r.claim_id === "" ? null : String(r.claim_id),
        relation: normalizeClaimRelationQ(r.relation),
        confidence: clamp01q(r.confidence),
        answer_text: typeof r.answer_text === "string" ? r.answer_text.trim().slice(0, 200) : "",
      });
    }
  } catch {
    /* ignore */
  }
  return out;
}

async function runMeetingQuestionMatchBatchCanonical(admin: SupabaseClient, meetingId: string): Promise<void> {
  const { data: st } = await admin
    .schema("deal_intel")
    .from("meeting_question_engine_state")
    .select("last_match_batch_at")
    .eq("meeting_id", meetingId)
    .maybeSingle();
  const lastMs = st?.last_match_batch_at ? new Date(String(st.last_match_batch_at)).getTime() : 0;
  if (lastMs && Date.now() - lastMs < 4_000) return;

  const qRes = await admin
    .schema("deal_intel")
    .from("meeting_tracked_question")
    .select("id, text, question_embedding, importance_weight, state, provenance, metadata, created_at")
    .eq("meeting_id", meetingId)
    .in("state", ["unanswered", "partially_answered", "needs_followup"])
    .limit(40);
  if (qRes.error) {
    if (!String(qRes.error.message || "").includes("does not exist")) console.error("runMeetingQuestionMatchBatch", qRes.error);
    return;
  }

  const questions = (qRes.data ?? []) as Array<{
    id: string;
    text: string;
    question_embedding: unknown;
    importance_weight: number;
    state: string;
    provenance: string;
    metadata: unknown;
    created_at: string;
  }>;
  if (!questions.length) return;

  const payload: Array<{ question_id: string; embedding: number[] }> = [];
  for (const q of questions) {
    let emb = parseVector(q.question_embedding);
    if (!emb) {
      try {
        emb = await embedMeetingQuestionText(q.text);
        await admin
          .schema("deal_intel")
          .from("meeting_tracked_question")
          .update({ question_embedding: vectorParam(emb), updated_at: new Date().toISOString() })
          .eq("id", q.id);
      } catch {
        continue;
      }
    }
    payload.push({ question_id: q.id, embedding: emb });
  }
  if (!payload.length) return;

  const rpcRes = await admin.rpc("deal_intel_match_meeting_claims_for_questions", {
    p_meeting_id: meetingId,
    p_queries: payload.map((p) => ({ question_id: p.question_id, embedding: p.embedding })),
    p_k: 8,
  });
  if (rpcRes.error) {
    console.error("match_meeting_claims_for_questions", rpcRes.error);
    return;
  }

  const pairs = (rpcRes.data ?? []) as Array<{ question_id: string; claim_id: string; distance: number }>;
  const claimIds = [...new Set(pairs.map((p) => p.claim_id))];
  if (!claimIds.length) return;

  const cRes = await admin
    .schema("deal_intel")
    .from("meeting_claim")
    .select("id, text, speaker, confidence, t_start_ms, t_end_ms, claim_embedding, created_at")
    .in("id", claimIds);
  const claimsById = new Map((cRes.data ?? []).map((r) => [String((r as { id: string }).id), r as Record<string, unknown>]));
  const latestEndMs = Math.max(
    0,
    ...[...claimsById.values()].map((r) => (typeof r.t_end_ms === "number" && Number.isFinite(r.t_end_ms) ? r.t_end_ms : 0)),
  );

  const byQ = new Map<string, typeof pairs>();
  for (const p of pairs) {
    const list = byQ.get(p.question_id) ?? [];
    list.push(p);
    byQ.set(p.question_id, list);
  }

  const hostStarts = await loadHostTurnStarts(admin, meetingId);
  const dialogueByQ = await loadHostAskedDialogueWindows(
    admin,
    meetingId,
    new Set(questions.map((x) => x.id)),
    hostStarts,
  );
  await augmentDialogueFromHostChunks(admin, meetingId, questions, dialogueByQ, hostStarts);

  type Scored = {
    rel: ClaimRelation;
    combined: number;
    claimId: string;
    claimText: string;
    speaker: string;
    tStartMs: number;
    scores: Record<string, number>;
  };

  type Prepared = {
    q: (typeof questions)[0];
    scored: Scored[];
    modeA: boolean;
    dialogueCtx: HostAskedDialogueCtx | undefined;
    excludeClaimIds: Set<string>;
    qCreatedMs: number;
  };

  const prepared: Prepared[] = [];

  for (const q of questions) {
    const rows = byQ.get(q.id);
    if (!rows?.length) continue;
    const qw = await embedMeetingQuestionText(q.text).catch(() => null);

    const md = q.metadata && typeof q.metadata === "object" ? (q.metadata as Record<string, unknown>) : {};
    const excludeClaimIds = new Set<string>();
    const rawEx = md.exclude_claim_ids;
    if (Array.isArray(rawEx)) {
      for (const x of rawEx) excludeClaimIds.add(String(x));
    }
    const qCreatedMs = q.created_at ? new Date(q.created_at).getTime() : 0;
    const dialogueCtx = dialogueByQ.get(q.id);

    const scoredAll: Scored[] = [];
    for (const pr of rows) {
      if (excludeClaimIds.has(pr.claim_id)) continue;
      const cr = claimsById.get(pr.claim_id);
      if (!cr) continue;
      if (qCreatedMs > 0) {
        const claimCreatedMs = cr.created_at ? new Date(String(cr.created_at)).getTime() : NaN;
        if (Number.isFinite(claimCreatedMs) && claimCreatedMs < qCreatedMs - 2000) continue;
      }
      const claimText = String(cr.text ?? "");
      const speaker = String(cr.speaker ?? "");
      const tRaw = cr.t_start_ms;
      const tStartMs =
        typeof tRaw === "number" && Number.isFinite(tRaw) ? tRaw : Number(tRaw ?? Number.NaN);
      const claimEmb = parseVector(cr.claim_embedding);
      const sim =
        qw && claimEmb && qw.length === claimEmb.length
          ? cosineSimilarity(qw, claimEmb)
          : Math.max(0, 1 - Number(pr.distance || 0));
      const rw = recencyWeightWithinMeeting(Number(cr.t_end_ms ?? 0), latestEndMs);
      const conf = typeof cr.confidence === "number" ? cr.confidence : 0.5;
      const { rel } = heuristicRelation(q.text, claimText, sim, { strictUnprompted: true });
      const combined =
        0.45 * sim +
        0.25 * conf +
        0.2 * rw +
        (rel === "answers" ? 0.1 : rel === "partial" ? 0.04 : rel === "contradicts" ? 0.05 : 0);
      scoredAll.push({
        rel,
        combined,
        claimId: pr.claim_id,
        claimText,
        speaker,
        tStartMs: Number.isFinite(tStartMs) ? tStartMs : 0,
        scores: { sim, claim_confidence: conf, recency_weight: rw, combined },
      });
    }

    if (!scoredAll.length) continue;

    let modeA = false;
    let scored = scoredAll;
    if (dialogueCtx) {
      const filtered = scoredAll.filter((s) => {
        if (!s.speaker.startsWith("guest:")) return false;
        return s.tStartMs >= dialogueCtx.askedEndMs - 1000 && s.tStartMs <= dialogueCtx.windowEndMs;
      });
      if (filtered.length) {
        modeA = true;
        scored = filtered.map((s) => {
          const { rel } = heuristicRelation(q.text, s.claimText, s.scores.sim, { dialogueMode: true });
          const combined =
            0.45 * s.scores.sim +
            0.25 * s.scores.claim_confidence +
            0.2 * s.scores.recency_weight +
            (rel === "answers" ? 0.1 : rel === "partial" ? 0.04 : rel === "contradicts" ? 0.05 : 0) +
            0.15;
          return {
            ...s,
            rel,
            combined,
            scores: { ...s.scores, combined, dialogue_boost: 1 },
          };
        });
      }
    }

    scored.sort((a, b) => {
      const ds = b.scores.sim - a.scores.sim;
      if (Math.abs(ds) > 1e-6) return ds;
      const dr = b.scores.recency_weight - a.scores.recency_weight;
      if (Math.abs(dr) > 1e-6) return dr;
      return b.scores.claim_confidence - a.scores.claim_confidence;
    });

    prepared.push({ q, scored, modeA, dialogueCtx, excludeClaimIds, qCreatedMs });
  }

  const batchItems: CanonicalBatchItem[] = prepared.map((p) => ({
    question_id: p.q.id,
    question_text: p.q.text.slice(0, 800),
    host_dialogue: p.dialogueCtx?.askedText ?? null,
    mode_a: p.modeA,
    candidates: p.scored.slice(0, 3).map((s) => ({
      claim_id: s.claimId,
      claim_text: s.claimText.slice(0, 900),
      sim: s.scores.sim,
    })),
  }));

  const llmByQ = await llmCanonicalQuestionBatch(batchItems);

  for (const p of prepared) {
    const q = p.q;
    const scored = p.scored;
    const dialogueCtx = dialogueByQ.get(q.id);
    const modeA = p.modeA;
    const excludeClaimIds = p.excludeClaimIds;

    const overlapPrimary = questionClaimTokenOverlap(q.text, scored[0].claimText);
    let best = scored[0];
    const br = llmByQ.get(q.id);
    if (br?.claim_id) {
      const hit = scored.find((s) => s.claimId === br.claim_id);
      if (hit) best = hit;
    }

    let llm: AnswerCheck | null = null;
    if (process.env.LIVE_ASSISTANT_Q_MATCH_LLM !== "0" && br) {
      llm = {
        answers: br.relation === "answers",
        partial: br.relation === "partial",
        contradicts: br.relation === "contradicts",
        answerText: br.answer_text,
        confidence: br.confidence,
      };
    }

    const overlap = questionClaimTokenOverlap(q.text, best.claimText);
    const substantiveOk = substantiveGateModeB(q.text, best.claimText);

    const matchScores: Record<string, unknown> = {
      ...best.scores,
      heuristic_relation: best.rel,
      question_claim_token_overlap: overlap,
      question_claim_token_overlap_primary: overlapPrimary,
      host_asked: dialogueCtx ? 1 : 0,
      host_asked_end_ms: dialogueCtx?.askedEndMs ?? null,
      host_asked_text: dialogueCtx?.askedText ?? null,
      dialogue_mode_a: modeA ? 1 : 0,
      in_answer_window: modeA ? 1 : 0,
      canonical_batch: 1,
    };
    if (llm) {
      matchScores.llm_answers = llm.answers ? 1 : 0;
      matchScores.llm_partial = llm.partial ? 1 : 0;
      matchScores.llm_contradicts = llm.contradicts ? 1 : 0;
      matchScores.llm_confidence = llm.confidence;
      if (llm.answerText) matchScores.answer_text = llm.answerText;
    }

    let recordedRel: ClaimRelation;
    if (llm) {
      if (llm.answers) recordedRel = "answers";
      else if (llm.contradicts) recordedRel = "contradicts";
      else if (llm.partial) recordedRel = "partial";
      else recordedRel = "irrelevant";
    } else {
      recordedRel = best.rel;
    }

    if (recordedRel === "answers" || recordedRel === "partial") {
      matchScores.answers_question_id = q.id;
      matchScores.answers_question_text = String(q.text ?? "").slice(0, 600);
    }

    await admin.schema("deal_intel").from("meeting_question_claim_match").insert({
      question_id: q.id,
      claim_id: best.claimId,
      relation: recordedRel,
      classifier_version: "v5-canonical-batch",
      scores: matchScores,
    });

    let nextState = q.state;
    const claimConf = best.scores.claim_confidence;
    const sim = best.scores.sim;
    const llmSaysAnswer = modeA
      ? Boolean(
          llm &&
            llm.answers &&
            claimConf >= 0.4 &&
            llm.confidence >= 0.5 &&
            best.speaker.startsWith("guest:"),
        )
      : Boolean(
          llm &&
            llm.answers &&
            claimConf >= 0.4 &&
            substantiveOk &&
            (llm.confidence >= 0.63 ||
              (llm.confidence >= 0.57 && (overlap >= 0.38 || sim >= 0.58 || best.rel !== "irrelevant"))),
        );
    if (llmSaysAnswer) {
      nextState = "answered";
    } else if ((best.rel === "answers" || llm?.partial) && sim >= (modeA ? 0.58 : 0.62)) {
      nextState = "partially_answered";
    } else if (llm?.partial && overlap >= (modeA ? 0.42 : 0.44) && sim >= (modeA ? 0.52 : 0.54)) {
      nextState = "partially_answered";
    } else if (best.rel === "contradicts" && sim >= 0.55) {
      nextState = "contradicted";
    } else if (best.rel === "partial" && (q.importance_weight ?? 0) >= 0.75) {
      nextState = "needs_followup";
    }

    if (nextState !== q.state) {
      await admin
        .schema("deal_intel")
        .from("meeting_tracked_question")
        .update({ state: nextState, updated_at: new Date().toISOString() })
        .eq("id", q.id);
    }

    if (nextState === "answered" && excludeClaimIds.size && best.claimId) {
      try {
        await admin
          .schema("deal_intel")
          .from("meeting_claim")
          .update({
            superseded_by_claim_id: best.claimId,
            superseded_at: new Date().toISOString(),
          })
          .eq("meeting_id", meetingId)
          .in("id", [...excludeClaimIds]);
      } catch (e) {
        console.warn("[question-match] supersession write failed", e instanceof Error ? e.message : e);
      }
    }
  }

  await admin
    .schema("deal_intel")
    .from("meeting_question_engine_state")
    .upsert(
      { meeting_id: meetingId, last_match_batch_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { onConflict: "meeting_id" },
    );
}

export async function runMeetingQuestionMatchBatch(admin: SupabaseClient, meetingId: string): Promise<void> {
  if (envFlag("LIVE_ASSISTANT_CANONICAL_VERIFIER", false)) {
    return runMeetingQuestionMatchBatchCanonical(admin, meetingId);
  }
  return runMeetingQuestionMatchBatchLegacy(admin, meetingId);
}

async function runMeetingQuestionMatchBatchLegacy(admin: SupabaseClient, meetingId: string): Promise<void> {
  const { data: st } = await admin
    .schema("deal_intel")
    .from("meeting_question_engine_state")
    .select("last_match_batch_at")
    .eq("meeting_id", meetingId)
    .maybeSingle();
  const lastMs = st?.last_match_batch_at ? new Date(String(st.last_match_batch_at)).getTime() : 0;
  // Tighter cadence so a guest answer promotes to `answered` within a few seconds of the claim landing.
  if (lastMs && Date.now() - lastMs < 4_000) return;

  const qRes = await admin
    .schema("deal_intel")
    .from("meeting_tracked_question")
    .select("id, text, question_embedding, importance_weight, state, provenance, metadata, created_at")
    .eq("meeting_id", meetingId)
    .in("state", ["unanswered", "partially_answered", "needs_followup"])
    .limit(40);
  if (qRes.error) {
    if (!String(qRes.error.message || "").includes("does not exist")) console.error("runMeetingQuestionMatchBatch", qRes.error);
    return;
  }

  const questions = (qRes.data ?? []) as Array<{
    id: string;
    text: string;
    question_embedding: unknown;
    importance_weight: number;
    state: string;
    provenance: string;
    metadata: unknown;
    created_at: string;
  }>;
  if (!questions.length) return;

  const payload: Array<{ question_id: string; embedding: number[] }> = [];
  for (const q of questions) {
    let emb = parseVector(q.question_embedding);
    if (!emb) {
      try {
        emb = await embedMeetingQuestionText(q.text);
        await admin
          .schema("deal_intel")
          .from("meeting_tracked_question")
          .update({ question_embedding: vectorParam(emb), updated_at: new Date().toISOString() })
          .eq("id", q.id);
      } catch {
        continue;
      }
    }
    payload.push({ question_id: q.id, embedding: emb });
  }
  if (!payload.length) return;

  const rpcRes = await admin.rpc("deal_intel_match_meeting_claims_for_questions", {
    p_meeting_id: meetingId,
    p_queries: payload.map((p) => ({ question_id: p.question_id, embedding: p.embedding })),
    p_k: 8,
  });
  if (rpcRes.error) {
    console.error("match_meeting_claims_for_questions", rpcRes.error);
    return;
  }

  const pairs = (rpcRes.data ?? []) as Array<{ question_id: string; claim_id: string; distance: number }>;
  const claimIds = [...new Set(pairs.map((p) => p.claim_id))];
  if (!claimIds.length) return;

  const cRes = await admin
    .schema("deal_intel")
    .from("meeting_claim")
    .select("id, text, speaker, confidence, t_start_ms, t_end_ms, claim_embedding, created_at")
    .in("id", claimIds);
  const claimsById = new Map((cRes.data ?? []).map((r) => [String((r as { id: string }).id), r as Record<string, unknown>]));
  const latestEndMs = Math.max(
    0,
    ...[...claimsById.values()].map((r) => (typeof r.t_end_ms === "number" && Number.isFinite(r.t_end_ms) ? r.t_end_ms : 0)),
  );

  const byQ = new Map<string, typeof pairs>();
  for (const p of pairs) {
    const list = byQ.get(p.question_id) ?? [];
    list.push(p);
    byQ.set(p.question_id, list);
  }

  const hostStarts = await loadHostTurnStarts(admin, meetingId);
  const dialogueByQ = await loadHostAskedDialogueWindows(
    admin,
    meetingId,
    new Set(questions.map((x) => x.id)),
    hostStarts,
  );
  await augmentDialogueFromHostChunks(admin, meetingId, questions, dialogueByQ, hostStarts);

  for (const q of questions) {
    const rows = byQ.get(q.id);
    if (!rows?.length) continue;
    const qw = await embedMeetingQuestionText(q.text).catch(() => null);

    const md = q.metadata && typeof q.metadata === "object" ? (q.metadata as Record<string, unknown>) : {};
    const excludeClaimIds = new Set<string>();
    const rawEx = md.exclude_claim_ids;
    if (Array.isArray(rawEx)) {
      for (const x of rawEx) excludeClaimIds.add(String(x));
    }
    const qCreatedMs = q.created_at ? new Date(q.created_at).getTime() : 0;
    const dialogueCtx = dialogueByQ.get(q.id);

    type Scored = {
      rel: ClaimRelation;
      combined: number;
      claimId: string;
      claimText: string;
      speaker: string;
      tStartMs: number;
      scores: Record<string, number>;
    };

    const scoredAll: Scored[] = [];
    for (const pr of rows) {
      if (excludeClaimIds.has(pr.claim_id)) continue;
      const cr = claimsById.get(pr.claim_id);
      if (!cr) continue;
      // Time fence (applies to every question regardless of provenance): a claim uttered
      // before the question existed cannot be its answer. The 2s slack absorbs jitter between
      // when a question is materialized server-side and when its triggering claim is
      // persisted by the classifier. Note this is orthogonal to `excludeClaimIds`, which
      // strictly excludes the originating claim for contradiction-followup questions.
      if (qCreatedMs > 0) {
        const claimCreatedMs = cr.created_at ? new Date(String(cr.created_at)).getTime() : NaN;
        if (Number.isFinite(claimCreatedMs) && claimCreatedMs < qCreatedMs - 2000) continue;
      }
      const claimText = String(cr.text ?? "");
      const speaker = String(cr.speaker ?? "");
      const tRaw = cr.t_start_ms;
      const tStartMs =
        typeof tRaw === "number" && Number.isFinite(tRaw) ? tRaw : Number(tRaw ?? Number.NaN);
      const claimEmb = parseVector(cr.claim_embedding);
      const sim =
        qw && claimEmb && qw.length === claimEmb.length
          ? cosineSimilarity(qw, claimEmb)
          : Math.max(0, 1 - Number(pr.distance || 0));
      const rw = recencyWeightWithinMeeting(Number(cr.t_end_ms ?? 0), latestEndMs);
      const conf = typeof cr.confidence === "number" ? cr.confidence : 0.5;
      const { rel } = heuristicRelation(q.text, claimText, sim, { strictUnprompted: true });
      const combined =
        0.45 * sim +
        0.25 * conf +
        0.2 * rw +
        (rel === "answers" ? 0.1 : rel === "partial" ? 0.04 : rel === "contradicts" ? 0.05 : 0);
      scoredAll.push({
        rel,
        combined,
        claimId: pr.claim_id,
        claimText,
        speaker,
        tStartMs: Number.isFinite(tStartMs) ? tStartMs : 0,
        scores: { sim, claim_confidence: conf, recency_weight: rw, combined },
      });
    }

    if (!scoredAll.length) continue;

    let modeA = false;
    let scored = scoredAll;
    if (dialogueCtx) {
      const filtered = scoredAll.filter((s) => {
        if (!s.speaker.startsWith("guest:")) return false;
        return s.tStartMs >= dialogueCtx.askedEndMs - 1000 && s.tStartMs <= dialogueCtx.windowEndMs;
      });
      if (filtered.length) {
        modeA = true;
        scored = filtered.map((s) => {
          const { rel } = heuristicRelation(q.text, s.claimText, s.scores.sim, { dialogueMode: true });
          const combined =
            0.45 * s.scores.sim +
            0.25 * s.scores.claim_confidence +
            0.2 * s.scores.recency_weight +
            (rel === "answers" ? 0.1 : rel === "partial" ? 0.04 : rel === "contradicts" ? 0.05 : 0) +
            0.15;
          return {
            ...s,
            rel,
            combined,
            scores: { ...s.scores, combined, dialogue_boost: 1 },
          };
        });
      }
    }

    // Prefer the nearest-neighbor claim by embedding similarity for LLM scoring — answers often
    // use different wording than the question, so combined-score picks can miss the real reply.
    scored.sort((a, b) => {
      const ds = b.scores.sim - a.scores.sim;
      if (Math.abs(ds) > 1e-6) return ds;
      const dr = b.scores.recency_weight - a.scores.recency_weight;
      if (Math.abs(dr) > 1e-6) return dr;
      return b.scores.claim_confidence - a.scores.claim_confidence;
    });

    const overlapPrimary = questionClaimTokenOverlap(q.text, scored[0].claimText);
    let best = scored[0];
    const llmQuestion = modeA && dialogueCtx ? dialogueCtx.askedText : q.text;
    const runLlm = modeA ? llmAnswerCheckDialogue : llmAnswerCheck;

    let llm: AnswerCheck | null =
      process.env.LIVE_ASSISTANT_Q_MATCH_LLM === "0" ? null : await runLlm(llmQuestion, best.claimText);

    // Second-chance: top combined-scorer sometimes beats pure sim when the true answer is #2 in ANN.
    if (
      scored.length > 1 &&
      process.env.LIVE_ASSISTANT_Q_MATCH_LLM !== "0" &&
      llm &&
      !llm.answers &&
      scored[1].scores.sim >= 0.44
    ) {
      const llm2 = await runLlm(llmQuestion, scored[1].claimText);
      if (llm2?.answers && llm2.confidence >= (llm.confidence ?? 0)) {
        best = scored[1];
        llm = llm2;
      } else if (!llm.partial && llm2?.partial && scored[1].scores.sim >= 0.55) {
        best = scored[1];
        llm = llm2;
      }
    }

    const overlap = questionClaimTokenOverlap(q.text, best.claimText);
    const substantiveOk = substantiveGateModeB(q.text, best.claimText);

    const matchScores: Record<string, unknown> = {
      ...best.scores,
      heuristic_relation: best.rel,
      question_claim_token_overlap: overlap,
      question_claim_token_overlap_primary: overlapPrimary,
      host_asked: dialogueCtx ? 1 : 0,
      host_asked_end_ms: dialogueCtx?.askedEndMs ?? null,
      host_asked_text: dialogueCtx?.askedText ?? null,
      dialogue_mode_a: modeA ? 1 : 0,
      in_answer_window: modeA ? 1 : 0,
    };
    if (llm) {
      matchScores.llm_answers = llm.answers ? 1 : 0;
      matchScores.llm_partial = llm.partial ? 1 : 0;
      matchScores.llm_contradicts = llm.contradicts ? 1 : 0;
      matchScores.llm_confidence = llm.confidence;
      if (llm.answerText) matchScores.answer_text = llm.answerText;
    }

    let recordedRel: ClaimRelation;
    if (llm) {
      if (llm.answers) recordedRel = "answers";
      else if (llm.contradicts) recordedRel = "contradicts";
      else if (llm.partial) recordedRel = "partial";
      else recordedRel = "irrelevant";
    } else {
      recordedRel = best.rel;
    }

    // Persist the answering linkage so `buildClaimContext` can read it as the strongest
    // topic signal (answering tracked question > self-label > host turn). This is what
    // connects the Q&A and contradiction systems: a downstream slow/auto/deep emitter for
    // the same claim now sees "this answers Q about revenue" and won't hallucinate TAM.
    if (recordedRel === "answers" || recordedRel === "partial") {
      matchScores.answers_question_id = q.id;
      matchScores.answers_question_text = String(q.text ?? "").slice(0, 600);
    }

    await admin.schema("deal_intel").from("meeting_question_claim_match").insert({
      question_id: q.id,
      claim_id: best.claimId,
      relation: recordedRel,
      classifier_version: "v4-dialogue-aware",
      scores: matchScores,
    });

    let nextState = q.state;
    const claimConf = best.scores.claim_confidence;
    const sim = best.scores.sim;
    const llmSaysAnswer = modeA
      ? Boolean(
          llm &&
            llm.answers &&
            claimConf >= 0.4 &&
            llm.confidence >= 0.5 &&
            best.speaker.startsWith("guest:"),
        )
      : Boolean(
          llm &&
            llm.answers &&
            claimConf >= 0.4 &&
            substantiveOk &&
            (llm.confidence >= 0.63 ||
              (llm.confidence >= 0.57 && (overlap >= 0.38 || sim >= 0.58 || best.rel !== "irrelevant"))),
        );
    if (llmSaysAnswer) {
      nextState = "answered";
    } else if ((best.rel === "answers" || llm?.partial) && sim >= (modeA ? 0.58 : 0.62)) {
      nextState = "partially_answered";
    } else if (llm?.partial && overlap >= (modeA ? 0.42 : 0.44) && sim >= (modeA ? 0.52 : 0.54)) {
      nextState = "partially_answered";
    } else if (best.rel === "contradicts" && sim >= 0.55) {
      nextState = "contradicted";
    } else if (best.rel === "partial" && (q.importance_weight ?? 0) >= 0.75) {
      nextState = "needs_followup";
    }

    if (nextState !== q.state) {
      await admin
        .schema("deal_intel")
        .from("meeting_tracked_question")
        .update({ state: nextState, updated_at: new Date().toISOString() })
        .eq("id", q.id);
    }

    // Supersession: when the matcher promotes a question to `answered` and that question
    // was generated from one or more origin claims (`exclude_claim_ids` non-empty), the
    // new answering claim corrects them. Mark each origin claim superseded by `best.claimId`
    // so late slow/auto/deep jobs on the stale claim short-circuit at their entry point.
    if (nextState === "answered" && excludeClaimIds.size && best.claimId) {
      try {
        await admin
          .schema("deal_intel")
          .from("meeting_claim")
          .update({
            superseded_by_claim_id: best.claimId,
            superseded_at: new Date().toISOString(),
          })
          .eq("meeting_id", meetingId)
          .in("id", [...excludeClaimIds]);
      } catch (e) {
        console.warn("[question-match] supersession write failed", e instanceof Error ? e.message : e);
      }
    }
  }

  await admin
    .schema("deal_intel")
    .from("meeting_question_engine_state")
    .upsert(
      { meeting_id: meetingId, last_match_batch_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { onConflict: "meeting_id" },
    );
}
