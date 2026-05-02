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
import { formatMemoClaimVerificationBody } from "@/lib/live-assistant/assistant-card-format";
import type { DialogueLine, SettledTurn } from "@/lib/live-assistant/guest-turn-tracker";
import { isDiscourseFragment } from "@/lib/live-assistant/guest-turn-gate";

const FAST = getLiveAssistantModel("fast");

export type GuestTurnVerdict = "aligns" | "contradicts" | "new" | "inconclusive";

type EvidenceItem = { text: string; source: string };

type NumericPrecheck = {
  verdict: "aligns" | "contradicts";
  metric_key: string;
  guest_value: string;
  record_value: string;
} | null;

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
  "evidence": [{ "text": "...", "source": "crm_fact|prior_turn" }]
}

Rules:
- Set "suppress_card" to true when GUEST_TURN is not ready to score: mid-sentence cutoff, only a conjunction/discourse marker, filler, or otherwise incomplete — do NOT emit a user-visible card in those cases (set verdict "inconclusive").
- If NUMERIC_PRECHECK has verdict "contradicts" or "aligns", verdict MUST match it and suppress_card should be false.
- Pick "answers_question_id" only when the GUEST_TURN clearly and completely answers that tracked question. Otherwise null.
- When answers_question_id is non-null, set "answer_excerpt" to a short verbatim or tight paraphrase of the answering phrase (max ~400 chars). The server persists the **full guest turn text** for the Questions UI so partial phrases here do not replace the stored answer.
- "new": substantive factual claim not anchored in CRM facts but still valid (e.g. naming a CEO when CRM lacks that field) — phrase summary as "Guest answered..." when the prior dialogue shows the host asked.
- "contradicts": the guest figure / fact disagrees with CRM.
- "aligns": the guest figure / fact matches CRM.
- "inconclusive": hedged, off-topic, or insufficient evidence.
- Keep summary short and factual; never write "introduced" or "introduces".`;

  let verdict: GuestTurnVerdict = numericPrecheck?.verdict ?? "inconclusive";
  let summary = "";
  let evidence: EvidenceItem[] = [];
  let answersQuestionId: string | null = null;
  let answerExcerpt: string | null = null;
  let suppressCard = false;
  let conflictsWith: { fact: string; record_value: string } | null = null;
  let llmMs = 0;

  try {
    const t0 = Date.now();
    const raw = await vertexRunWithText(FAST, prompt, false);
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
        if (known) answersQuestionId = aqid.trim();
      }
      const ax = parsed.answer_excerpt;
      if (typeof ax === "string" && ax.trim()) answerExcerpt = ax.trim().slice(0, 800);
      const cw = parsed.conflicts_with;
      if (cw && typeof cw === "object") {
        const o = cw as Record<string, unknown>;
        const fact = o.fact == null ? "" : String(o.fact).slice(0, 220);
        const rv = o.record_value == null ? "" : String(o.record_value).slice(0, 400);
        if (fact || rv) conflictsWith = { fact, record_value: rv };
      }
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
    numeric_precheck: numericPrecheck?.verdict ?? null,
    tracked_q_count: trackedQuestions.length,
    llm_ms: llmMs,
    total_ms: Date.now() - startedAt,
  });

  // Avoid unused-var lint when userId becomes only metadata.
  void userId;
}
