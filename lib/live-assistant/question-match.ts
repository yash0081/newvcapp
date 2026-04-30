import type { SupabaseClient } from "@supabase/supabase-js";
import { vertexRunWithText } from "@/lib/vertex";
import { parseJsonFromResponseOrNull, parseJsonFromResponseWithRepair } from "@/lib/gemini";
import { getLiveAssistantModel } from "@/lib/live-assistant/model-env";
import { cosineSimilarity, parseVector, vectorParam } from "@/lib/data-layer/shared/vector";
import { embedMeetingQuestionText } from "@/lib/live-assistant/meeting-embeddings";

const FAST = getLiveAssistantModel("fast");

export type ClaimRelation = "answers" | "partial" | "contradicts" | "irrelevant";

function recencyWeightWithinMeeting(tEndMs: number, latestEndMs: number): number {
  // `meeting_claim.t_end_ms` is *relative to meeting start* (not epoch). Use relative time deltas.
  const halfLife = Math.max(30_000, Number(process.env.LIVE_ASSISTANT_Q_RECENCY_HALFLIFE_MS ?? 180_000));
  const dt = Math.max(0, latestEndMs - tEndMs);
  return Math.pow(0.5, dt / halfLife);
}

function heuristicRelation(question: string, claimText: string, sim: number): { rel: ClaimRelation; margin: number } {
  const qLow = question.toLowerCase();
  const c = claimText.toLowerCase();
  const overlap = qLow.split(/\s+/).filter((w) => w.length > 3 && c.includes(w)).length;
  const neg = /\b(no|not|never|didn't|wasn't|isn't|can't|won't)\b/.test(c);
  const pos = /\b(yes|we do|we have|we are|because|due to|our)\b/.test(c);
  if (sim >= 0.82 && pos && !neg) return { rel: "answers", margin: sim - 0.82 };
  if (sim >= 0.68 && (pos || sim >= 0.78 || overlap >= 2)) return { rel: "partial", margin: sim - 0.68 };
  if (sim >= 0.55 && neg) return { rel: "contradicts", margin: sim - 0.55 };
  if (sim < 0.52) return { rel: "irrelevant", margin: 0.52 - sim };
  return { rel: "irrelevant", margin: 0.1 };
}

async function llmRelation(question: string, claimText: string): Promise<ClaimRelation | null> {
  const prompt = `Classify how the CLAIM relates to the QUESTION for an investor meeting.
Return JSON only: {"relation":"answers|partial|contradicts|irrelevant"}
QUESTION: ${question.slice(0, 400)}
CLAIM: ${claimText.slice(0, 500)}`;
  try {
    const raw = await vertexRunWithText(FAST, prompt, false);
    const parsed = (parseJsonFromResponseOrNull(raw) ?? (await parseJsonFromResponseWithRepair(raw))) as { relation?: string };
    const r = String(parsed?.relation ?? "").toLowerCase();
    if (r === "answers" || r === "partial" || r === "contradicts" || r === "irrelevant") return r;
  } catch {
    /* fall through */
  }
  return null;
}

export async function runMeetingQuestionMatchBatch(admin: SupabaseClient, meetingId: string): Promise<void> {
  const { data: st } = await admin
    .schema("deal_intel")
    .from("meeting_question_engine_state")
    .select("last_match_batch_at")
    .eq("meeting_id", meetingId)
    .maybeSingle();
  const lastMs = st?.last_match_batch_at ? new Date(String(st.last_match_batch_at)).getTime() : 0;
  if (lastMs && Date.now() - lastMs < 6_000) return;

  const qRes = await admin
    .schema("deal_intel")
    .from("meeting_tracked_question")
    .select("id, text, question_embedding, importance_weight, state")
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
    .select("id, text, confidence, t_end_ms, claim_embedding")
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

  for (const q of questions) {
    const rows = byQ.get(q.id);
    if (!rows?.length) continue;
    const qw = await embedMeetingQuestionText(q.text).catch(() => null);
    let best: { rel: ClaimRelation; combined: number; claimId: string; scores: Record<string, number> } | null = null;

    for (const p of rows) {
      const cr = claimsById.get(p.claim_id);
      if (!cr) continue;
      const claimText = String(cr.text ?? "");
      const claimEmb = parseVector(cr.claim_embedding);
      const sim =
        qw && claimEmb && qw.length === claimEmb.length ? cosineSimilarity(qw, claimEmb) : Math.max(0, 1 - Number(p.distance || 0));
      const rw = recencyWeightWithinMeeting(Number(cr.t_end_ms ?? 0), latestEndMs);
      const conf = typeof cr.confidence === "number" ? cr.confidence : 0.5;
      const { rel, margin } = heuristicRelation(q.text, claimText, sim);
      const importance = typeof q.importance_weight === "number" ? q.importance_weight : 0.5;
      let useRel = rel;
      if ((margin < 0.08 || importance >= 0.9) && process.env.LIVE_ASSISTANT_Q_MATCH_LLM !== "0") {
        const lr = await llmRelation(q.text, claimText);
        if (lr) useRel = lr;
      }
      const combined = 0.45 * sim + 0.25 * conf + 0.2 * rw + (useRel === "answers" ? 0.1 : useRel === "partial" ? 0.04 : 0);
      if (!best || combined > best.combined) {
        best = {
          rel: useRel,
          combined,
          claimId: p.claim_id,
          scores: { sim, claim_confidence: conf, recency_weight: rw, combined },
        };
      }
    }

    if (!best) continue;

    const mapRel = (r: ClaimRelation): "answers" | "partial" | "contradicts" | "irrelevant" => {
      if (r === "answers") return "answers";
      if (r === "partial") return "partial";
      if (r === "contradicts") return "contradicts";
      return "irrelevant";
    };

    await admin.schema("deal_intel").from("meeting_question_claim_match").insert({
      question_id: q.id,
      claim_id: best.claimId,
      relation: mapRel(best.rel),
      classifier_version: "v1-hybrid",
      scores: best.scores,
    });

    let nextState = q.state;
    if (best.rel === "answers" && best.scores.sim >= 0.72 && best.scores.claim_confidence >= 0.42) {
      nextState = "answered";
    } else if (best.rel === "partial" && best.scores.sim >= 0.62) {
      nextState = "partially_answered";
    } else if (best.rel === "contradicts" && best.scores.sim >= 0.55) {
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
  }

  await admin
    .schema("deal_intel")
    .from("meeting_question_engine_state")
    .upsert(
      { meeting_id: meetingId, last_match_batch_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { onConflict: "meeting_id" },
    );
}
