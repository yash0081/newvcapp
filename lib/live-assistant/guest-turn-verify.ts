/**
 * Guest-turn canonical verifier.
 *
 * Triggered once per settled guest turn (see `GuestTurnTracker`). Sends the last 3-4 labeled
 * dialogue lines, a small CRM fact preview, and the open tracked-question shortlist to the
 * fast model. The model returns one verdict and (optionally) the tracked-question id it
 * answered. We write a single `meeting_assistant_event` and, if applicable, mark the
 * tracked question as answered.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { vertexRunWithText } from "@/lib/vertex";
import { parseJsonFromResponseOrNull, parseJsonFromResponseWithRepair } from "@/lib/gemini";
import { getLiveAssistantModel } from "@/lib/live-assistant/model-env";
import {
  fetchDealIntelGroundingPack,
  groundingPackToSyntheticFacts,
  recordSnippetForMetric,
  type DealIntelGroundingPack,
} from "@/lib/live-assistant/deal-intel-grounding";
import { extractFastSignals } from "@/lib/live-assistant/fast-kpi";
import { createMeetingAssistantEvent } from "@/lib/live-assistant/tools";
import { upsertMeetingTrackedQuestion } from "@/lib/live-assistant/tracked-questions";
import { formatMemoClaimVerificationBody } from "@/lib/live-assistant/assistant-card-format";
import type { DialogueLine, SettledTurn } from "@/lib/live-assistant/guest-turn-tracker";
import { isDiscourseFragment } from "@/lib/live-assistant/guest-turn-gate";

export type GuestTurnVerdict = "aligns" | "contradicts" | "new" | "inconclusive";

type EvidenceItem = { text: string; source: string };

type NumericPrecheck = {
  verdict: "aligns" | "contradicts";
  metric_key: string;
  guest_value: string;
  record_value: string;
} | null;

type AnswerResolutionStatus = "answered" | "partial" | "not_answered";

type AnswerResolution = {
  status: AnswerResolutionStatus;
  confidence: number;
  rationale: string | null;
  answerExcerpt: string | null;
};

export type RunGuestTurnVerifyArgs = {
  meetingId: string;
  dealId: string;
  userId: string;
  turn: SettledTurn;
  recentTurns: DialogueLine[];
};

const GROUNDING_TTL_MS = 30_000;
const groundingCacheByDeal = new Map<string, { atMs: number; pack: DealIntelGroundingPack }>();

async function loadGroundingPackCached(admin: SupabaseClient, dealId: string): Promise<DealIntelGroundingPack> {
  const cached = groundingCacheByDeal.get(dealId);
  if (cached && Date.now() - cached.atMs < GROUNDING_TTL_MS) return cached.pack;
  const pack = await fetchDealIntelGroundingPack(admin, dealId);
  groundingCacheByDeal.set(dealId, { atMs: Date.now(), pack });
  return pack;
}

function severityFor(v: GuestTurnVerdict): "low" | "med" | "high" {
  if (v === "contradicts") return "high";
  if (v === "new") return "med";
  return "low";
}

function laneFor(v: GuestTurnVerdict): "attention" | "context" | "memo" {
  if (v === "contradicts" || v === "new") return "attention";
  if (v === "aligns") return "context";
  return "memo";
}

function normalizeVerdict(v: unknown): GuestTurnVerdict {
  const s = String(v ?? "").toLowerCase().trim();
  if (s === "aligns" || s === "contradicts" || s === "new" || s === "inconclusive") return s;
  return "inconclusive";
}

function normalizeEvidence(raw: unknown): EvidenceItem[] {
  if (!Array.isArray(raw)) return [];
  const out: EvidenceItem[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text.trim() : "";
    const source = typeof o.source === "string" ? o.source.trim() : "";
    if (text && source) out.push({ text: text.slice(0, 400), source: source.slice(0, 60) });
    if (out.length >= 6) break;
  }
  return out;
}

function normalizeFollowupQuestion(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const q = raw.replace(/\s+/g, " ").trim();
  if (q.length < 18 || q.length > 220) return null;
  if (!/\?\s*$/.test(q)) return null;
  if (/\b(?:tell me more|can you elaborate|how should we think about|what does that mean|what are the implications)\b/i.test(q)) {
    return null;
  }
  return q.slice(0, 220);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function normalizeAnswerResolution(raw: unknown): AnswerResolution {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const rawStatus = String(o.status ?? "").toLowerCase().trim();
  const status: AnswerResolutionStatus =
    rawStatus === "answered" || rawStatus === "partial" || rawStatus === "not_answered"
      ? rawStatus
      : "not_answered";
  const confidence = clamp01(typeof o.confidence === "number" ? o.confidence : 0);
  const rationale = typeof o.rationale === "string" && o.rationale.trim()
    ? o.rationale.trim().slice(0, 220)
    : null;
  const answerExcerpt = typeof o.answer_excerpt === "string" && o.answer_excerpt.trim()
    ? o.answer_excerpt.trim().slice(0, 500)
    : null;
  return { status, confidence, rationale, answerExcerpt };
}

const LOW_INFORMATION_ANSWER_RE =
  /\b(?:chill|nice|cool|great|awesome|smart|pretty|good guy|good person|solid guy|solid person|like him|like her)\b/i;

const FACTUAL_ANSWER_TOKEN_RE =
  /\b(?:ceo|cto|cfo|coo|founder|cofounder|co-founder|president|leadership|team|role|responsible|owns|owner|leads|runs|reports|current|currently|now|was|used to|changed|actually|source|definition|means|because|as of|since|named|name is|his name|her name|their name|it's|it is)\b/i;

const CLARIFICATION_QUESTION_RE =
  /\b(?:clarify|reconcile|resolve|current|currently|record|records|indicate|source|definition|timing|as of|who|name|ceo|cto|cfo|coo|founder|leadership|team|role)\b/i;

function contentTokens(text: string): string[] {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4 && !["what", "when", "where", "which", "would", "could", "should", "about", "with", "from", "that", "this", "your", "their", "there", "have", "been"].includes(t));
}

export function guestTurnActuallyAnswersQuestion(question: string, answer: string): boolean {
  const q = String(question || "").trim();
  const a = String(answer || "").trim();
  if (!q || !a) return false;
  if (a.length < 12) return false;

  const asksForClarification = CLARIFICATION_QUESTION_RE.test(q);
  const hasFactualToken = FACTUAL_ANSWER_TOKEN_RE.test(a);
  if (asksForClarification) {
    // A related opinion ("he's a chill guy") is not an answer to "who is CEO / reconcile records".
    if (LOW_INFORMATION_ANSWER_RE.test(a) && !hasFactualToken) return false;
    if (hasFactualToken) return true;

    const qTokens = new Set(contentTokens(q));
    const answerTokens = contentTokens(a);
    const overlap = answerTokens.filter((t) => qTokens.has(t)).length;
    return overlap >= 2;
  }

  const qTokens = new Set(contentTokens(q));
  const answerTokens = contentTokens(a);
  if (!answerTokens.length) return false;
  if (LOW_INFORMATION_ANSWER_RE.test(a) && !hasFactualToken) return false;
  return answerTokens.some((t) => qTokens.has(t)) || hasFactualToken || /\d/.test(a);
}

async function verifyAnswerResolutionWithLlm(args: {
  question: string;
  guestText: string;
  recentTurns: DialogueLine[];
}): Promise<AnswerResolution> {
  const question = args.question.trim().slice(0, 600);
  const guestText = args.guestText.trim().slice(0, 1200);
  if (!question || !guestText) {
    return { status: "not_answered", confidence: 1, rationale: "Missing question or answer text.", answerExcerpt: null };
  }

  const dialogue = args.recentTurns
    .slice(-5)
    .map((r) => `${dialogueLabel(r.role)}${r.inProgress ? " (in progress)" : ""}: ${r.text.slice(0, 500)}`)
    .join("\n");

  const prompt = `Decide whether the GUEST_TURN actually answers the TRACKED_QUESTION.

TRACKED_QUESTION:
${question}

RECENT_DIALOGUE:
${dialogue || "(none)"}

GUEST_TURN:
${guestText}

Return strict JSON only:
{
  "status": "answered" | "partial" | "not_answered",
  "confidence": 0.0,
  "rationale": "<= 1 sentence",
  "answer_excerpt": string | null
}

Rules:
- Use "answered" only if the guest directly provides the requested information or clearly resolves the uncertainty, so the host would not need to ask the same question again.
- Use "partial" if the guest addresses the topic but leaves a key requested fact unresolved.
- Use "not_answered" if the guest is merely related, gives color/opinion, deflects, jokes, repeats the premise, or answers a different question.
- For clarification/reconciliation questions, the guest must provide the actual reconciliation: name, title, owner, timing, definition, source, metric basis, or correction.
- Example: Question asks "Could you clarify the current leadership team...?" and guest says "He is a chill guy." => not_answered.
- Example: Question asks "Could you clarify the current leadership team...?" and guest says "Daniel is CEO now; Jensen moved to advisor in March." => answered.`;

  try {
    const raw = await vertexRunWithText(getLiveAssistantModel("fast"), prompt, false);
    const parsed = (parseJsonFromResponseOrNull(raw) ??
      (await parseJsonFromResponseWithRepair(raw))) as Record<string, unknown> | null;
    return normalizeAnswerResolution(parsed);
  } catch (e) {
    console.warn("[guest-turn-verify] answer-resolution LLM failed", e instanceof Error ? e.message : e);
    // Fail conservatively: only close on fallback if the deterministic guard sees a direct answer.
    const answered = guestTurnActuallyAnswersQuestion(question, guestText);
    return {
      status: answered ? "answered" : "not_answered",
      confidence: answered ? 0.62 : 0.8,
      rationale: "Fallback answer-resolution check.",
      answerExcerpt: answered ? guestText.slice(0, 500) : null,
    };
  }
}

function dialogueLabel(role: DialogueLine["role"]): string {
  if (role === "host") return "Host";
  if (role === "guest") return "Guest";
  return "Speaker";
}

function renderDialogueBlock(turn: SettledTurn, recent: DialogueLine[]): string {
  const lines: string[] = [];
  for (const r of recent) {
    if (r.turnId === turn.turnId) continue;
    const tag = dialogueLabel(r.role) + (r.inProgress ? " (in progress)" : "");
    lines.push(`${tag}: ${r.text.slice(0, 800)}`);
  }
  lines.push(`GUEST_TURN: "${turn.text.slice(0, 1200)}"`);
  return lines.join("\n");
}

function buildNumericPrecheck(turnText: string, pack: DealIntelGroundingPack): NumericPrecheck {
  const ALIGN_RATIO = 1.05;
  const CONFLICT_RATIO_RAW = Number(process.env.LIVE_ASSISTANT_NUMERIC_CONFLICT_RATIO ?? 1.2);
  const CONFLICT_RATIO = Number.isFinite(CONFLICT_RATIO_RAW) && CONFLICT_RATIO_RAW > 1 ? CONFLICT_RATIO_RAW : 1.2;
  const metrics = extractFastSignals(turnText).metrics.slice(0, 6);
  for (const m of metrics) {
    const rec = recordSnippetForMetric(m.key, pack);
    if (!rec) continue;
    const a = Math.abs(rec.recordValue);
    const b = Math.abs(m.normalizedValue);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const hi = Math.max(a, b);
    const lo = Math.max(Math.min(a, b), 1e-9);
    const ratio = hi / lo;
    if (ratio >= CONFLICT_RATIO) {
      return {
        verdict: "contradicts",
        metric_key: m.key,
        guest_value: m.rawValue,
        record_value: rec.recordText.slice(0, 220),
      };
    }
    if (ratio <= ALIGN_RATIO) {
      return {
        verdict: "aligns",
        metric_key: m.key,
        guest_value: m.rawValue,
        record_value: rec.recordText.slice(0, 220),
      };
    }
  }
  return null;
}

async function loadOpenTrackedQuestions(
  admin: SupabaseClient,
  meetingId: string,
): Promise<Array<{ id: string; text: string }>> {
  const res = await admin
    .schema("deal_intel")
    .from("meeting_tracked_question")
    .select("id, text, importance_weight, state, created_at")
    .eq("meeting_id", meetingId)
    .in("state", ["unanswered", "partially_answered", "needs_followup"])
    .order("created_at", { ascending: false })
    .limit(12);
  if (res.error) {
    if (!String(res.error.message || "").includes("does not exist")) {
      console.warn("[guest-turn-verify] tracked questions load", res.error.message);
    }
    return [];
  }
  return ((res.data ?? []) as Array<{ id: string; text: string }>).map((q) => ({
    id: String(q.id),
    text: String(q.text ?? "").slice(0, 400),
  }));
}

function crmFactPreview(pack: DealIntelGroundingPack): string {
  const facts = groundingPackToSyntheticFacts(pack).slice(0, 30);
  if (!facts.length) return "(no CRM facts loaded)";
  return facts
    .map((f) => `- ${f.fact_path}: ${String(f.canonical_value_text ?? "").slice(0, 220)}`)
    .join("\n")
    .slice(0, 4000);
}

export async function runGuestTurnVerify(
  admin: SupabaseClient,
  args: RunGuestTurnVerifyArgs,
): Promise<void> {
  const { meetingId, dealId, userId, turn } = args;
  if (!meetingId || !dealId || !userId) return;
  if (!turn || turn.role !== "guest") return;
  const guestText = turn.text.trim();
  if (!guestText) return;
  if (isDiscourseFragment(guestText)) return;

  const startedAt = Date.now();

  const [pack, trackedQuestions] = await Promise.all([
    loadGroundingPackCached(admin, dealId),
    loadOpenTrackedQuestions(admin, meetingId),
  ]);

  const numericPrecheck = buildNumericPrecheck(guestText, pack);
  const dialogueBlock = renderDialogueBlock(turn, args.recentTurns);
  const factPreview = crmFactPreview(pack);
  const trackedJson = JSON.stringify(trackedQuestions).slice(0, 6000);
  const numericJson = JSON.stringify(numericPrecheck);

  const prompt = `You are reviewing a live VC diligence call. Decide what the GUEST's most recent turn does.

DIALOGUE (most recent on bottom; only the GUEST_TURN below is being judged now):
${dialogueBlock}

OPEN_TRACKED_QUESTIONS (the host has these on their list — pick at most one if the GUEST_TURN clearly answers it; use null otherwise):
${trackedJson}

RELEVANT_CRM_FACTS (subset of the company record; do not invent values not listed):
${factPreview}

NUMERIC_PRECHECK (trust this verdict when present and non-null):
${numericJson}

Return strict JSON only:
{
  "verdict": "aligns" | "contradicts" | "new" | "inconclusive",
  "suppress_card": boolean,
  "answers_question_id": string | null,
  "answer_excerpt": string | null,
  "summary": "<= 1 short sentence; phrased as the guest answered/stated/contradicted (never 'introduced')",
  "conflicts_with": null | { "fact": string, "record_value": string },
  "evidence": [{ "text": "...", "source": "crm_fact|prior_turn" }],
  "suggested_followup_question": string | null
}

Rules:
- Set "suppress_card" to true when GUEST_TURN is not ready to score: mid-sentence cutoff, only a conjunction/discourse marker, filler, or otherwise incomplete — do NOT emit a user-visible card in those cases (set verdict "inconclusive").
- If NUMERIC_PRECHECK has verdict "contradicts" or "aligns", verdict MUST match it and suppress_card should be false.
- Pick "answers_question_id" only when the GUEST_TURN clearly and completely answers that tracked question. Otherwise null.
- Related but non-answering remarks do NOT count. Example: if the question asks to clarify who the CEO/leadership is, "he is a chill guy" is not an answer because it gives no name, title, timing, source, or reconciliation.
- When answers_question_id is non-null, set "answer_excerpt" to a short verbatim or tight paraphrase of the answering phrase (max ~400 chars). The server persists the **full guest turn text** for the Questions UI so partial phrases here do not replace the stored answer.
- "new": substantive factual claim not anchored in CRM facts but still valid (e.g. naming a CEO when CRM lacks that field) — phrase summary as "Guest answered..." when the prior dialogue shows the host asked.
- "contradicts": the guest figure / fact disagrees with CRM.
- "aligns": the guest figure / fact matches CRM.
- "inconclusive": hedged, off-topic, or insufficient evidence.
- For "contradicts", include suggested_followup_question only when there is a crisp, natural question the host should ask to resolve the mismatch. It should ask for the source, timing, definition, or reconciliation of the conflicting fact; do not restate the contradiction.
- Keep summary short and factual; never write "introduced" or "introduces".`;

  let verdict: GuestTurnVerdict = numericPrecheck?.verdict ?? "inconclusive";
  let summary = "";
  let evidence: EvidenceItem[] = [];
  let answersQuestionId: string | null = null;
  let nominatedQuestion: { id: string; text: string } | null = null;
  let answerResolution: AnswerResolution | null = null;
  let suppressCard = false;
  let conflictsWith: { fact: string; record_value: string } | null = null;
  let suggestedFollowupQuestion: string | null = null;
  let llmMs = 0;

  try {
    const t0 = Date.now();
    const raw = await vertexRunWithText(getLiveAssistantModel("fast"), prompt, false);
    llmMs = Date.now() - t0;
    const parsed = (parseJsonFromResponseOrNull(raw) ??
      (await parseJsonFromResponseWithRepair(raw))) as Record<string, unknown> | null;
    if (parsed && typeof parsed === "object") {
      verdict = normalizeVerdict(parsed.verdict);
      if (numericPrecheck?.verdict === "contradicts" || numericPrecheck?.verdict === "aligns") {
        verdict = numericPrecheck.verdict;
      }
      suppressCard =
        parsed.suppress_card === true ||
        String(parsed.suppress_card ?? "").toLowerCase() === "true";
      summary = typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 400) : "";
      evidence = normalizeEvidence(parsed.evidence);
      const aqid = parsed.answers_question_id;
      if (typeof aqid === "string" && aqid.trim()) {
        const known = trackedQuestions.find((q) => q.id === aqid.trim());
        if (known) nominatedQuestion = known;
      }
      // `answer_excerpt` remains in the prompt schema for compatibility. The canonical UI
      // stores the full settled guest turn below so short LLM snippets never replace it.
      const cw = parsed.conflicts_with;
      if (cw && typeof cw === "object") {
        const o = cw as Record<string, unknown>;
        const fact = o.fact == null ? "" : String(o.fact).slice(0, 220);
        const rv = o.record_value == null ? "" : String(o.record_value).slice(0, 400);
        if (fact || rv) conflictsWith = { fact, record_value: rv };
      }
      suggestedFollowupQuestion = normalizeFollowupQuestion(parsed.suggested_followup_question);
    }
  } catch (e) {
    console.warn("[guest-turn-verify] LLM call failed", e instanceof Error ? e.message : e);
    if (!summary && !numericPrecheck) summary = "Automatic check failed.";
  }

  if (numericPrecheck?.verdict === "contradicts" || numericPrecheck?.verdict === "aligns") {
    suppressCard = false;
  }

  if (numericPrecheck?.verdict === "contradicts" && !conflictsWith) {
    conflictsWith = {
      fact: numericPrecheck.metric_key,
      record_value: numericPrecheck.record_value,
    };
    if (!summary) {
      summary = `Guest's ${numericPrecheck.metric_key} (${numericPrecheck.guest_value}) differs from the CRM value.`;
    }
  }

  if (nominatedQuestion && !suppressCard) {
    answerResolution = await verifyAnswerResolutionWithLlm({
      question: nominatedQuestion.text,
      guestText,
      recentTurns: args.recentTurns,
    });
    if (answerResolution.status === "answered" && answerResolution.confidence >= 0.72) {
      answersQuestionId = nominatedQuestion.id;
    }
  }

  const dedupeKey = `gturn:${meetingId}:${turn.turnId}`;
  const title = verdict === "contradicts" ? "Possible contradiction" : "Claim check";

  // Persist the full finalized guest utterance as the canonical answer so the UI never
  // shows a partial LLM fragment or a later matcher span instead of the whole reply.
  const resolvedAnswerExcerpt: string | null = answersQuestionId ? guestText.trim().slice(0, 800) : null;

  if (!suppressCard) {
    const recordsSnap =
      verdict === "contradicts" && conflictsWith ? conflictsWith.record_value || conflictsWith.fact || null : null;
    const matchedTracked =
      answersQuestionId ? trackedQuestions.find((q) => String(q.id) === String(answersQuestionId)) : null;
    const body = formatMemoClaimVerificationBody({
      summary:
        summary ||
        (verdict === "contradicts"
          ? "Possible mismatch between what was stated and CRM snapshot."
          : verdict === "new"
            ? "New factual detail vs prior records."
            : "Claim checked against workspace records."),
      recordsSnapshot: recordsSnap ? String(recordsSnap).slice(0, 320) : null,
      relatedQuestion: matchedTracked?.text ?? null,
    });

    await createMeetingAssistantEvent(admin, {
      meeting_id: meetingId,
      kind: "claim_verification",
      title,
      severity: severityFor(verdict),
      body,
      source_map: {
        lane: laneFor(verdict),
        canonical: true,
        guest_turn: true,
        dedupe_key: dedupeKey,
        turn_id: turn.turnId,
        speaker: turn.speaker,
        auto_verdict: verdict,
        auto_summary: summary,
        auto_evidence: evidence,
        suggested_followup_question: suggestedFollowupQuestion,
        nominated_answers_question_id: nominatedQuestion?.id ?? null,
        answer_resolution: answerResolution,
        answers_question_id: answersQuestionId,
        answer_excerpt: resolvedAnswerExcerpt ?? undefined,
        conflicts_with: conflictsWith,
        numeric_precheck: numericPrecheck,
        guest_text: guestText,
        suppress_card: false,
        recent_dialogue: args.recentTurns
          .filter((r) => r.turnId !== turn.turnId)
          .map((r) => ({
            role: r.role,
            text: r.text.slice(0, 600),
            t_start_ms: r.tStartMs,
            t_end_ms: r.tEndMs,
            in_progress: Boolean(r.inProgress),
          })),
      },
    });
  }

  if (verdict === "contradicts" && suggestedFollowupQuestion && !suppressCard) {
    try {
      await upsertMeetingTrackedQuestion(admin, {
        meetingId,
        text: suggestedFollowupQuestion,
        section: "risks",
        importanceWeight: 0.86,
        state: "needs_followup",
        provenance: "contradiction",
        venue: "in_meeting",
        dedupeKey: `gturn_contra:${meetingId}:${turn.turnId}`,
        metadata: {
          source: "guest_turn_canonical",
          turn_id: turn.turnId,
          guest_text: guestText.slice(0, 800),
          conflicts_with: conflictsWith,
        },
        syncEvent: { title: "Contradiction follow-up", lane: "attention", severity: "med" },
      });
    } catch (e) {
      console.warn(
        "[guest-turn-verify] contradiction follow-up upsert failed",
        e instanceof Error ? e.message : e,
      );
    }
  }

  if (answersQuestionId && !suppressCard) {
    try {
      const prevRes = await admin
        .schema("deal_intel")
        .from("meeting_tracked_question")
        .select("metadata")
        .eq("id", answersQuestionId)
        .eq("meeting_id", meetingId)
        .maybeSingle();
      const prevMeta =
        prevRes.data?.metadata && typeof prevRes.data.metadata === "object"
          ? (prevRes.data.metadata as Record<string, unknown>)
          : {};
      await admin
        .schema("deal_intel")
        .from("meeting_tracked_question")
        .update({
          state: "answered",
          metadata: {
            ...prevMeta,
            answered_at: new Date().toISOString(),
            answer_source: "guest_turn_canonical",
            answer_excerpt: resolvedAnswerExcerpt ?? guestText.slice(0, 800),
            answer_resolution: answerResolution,
            answer_verdict: verdict,
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", answersQuestionId)
        .eq("meeting_id", meetingId)
        // Do not overwrite a prior canonical answer if this path races or re-runs.
        .in("state", ["unanswered", "partially_answered", "needs_followup"]);
    } catch (e) {
      console.warn(
        "[guest-turn-verify] tracked-question state update failed",
        e instanceof Error ? e.message : e,
      );
    }
  }

  console.log("[guest-turn-verify]", {
    meeting_id: meetingId,
    turn_id: turn.turnId,
    verdict,
    suppress_card: suppressCard,
    answers_question_id: answersQuestionId,
    nominated_answers_question_id: nominatedQuestion?.id ?? null,
    answer_resolution: answerResolution,
    numeric_precheck: numericPrecheck?.verdict ?? null,
    tracked_q_count: trackedQuestions.length,
    llm_ms: llmMs,
    total_ms: Date.now() - startedAt,
  });

  // Avoid unused-var lint when userId becomes only metadata.
  void userId;
}
