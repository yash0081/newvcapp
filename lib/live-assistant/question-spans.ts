import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { vertexRunWithText } from "@/lib/vertex";
import { parseJsonFromResponseOrNull, parseJsonFromResponseWithRepair } from "@/lib/gemini";
import { getLiveAssistantModel } from "@/lib/live-assistant/model-env";
import { cosineSimilarity } from "@/lib/data-layer/shared/vector";
import { embedText } from "@/lib/vertex-embeddings";

const FAST = getLiveAssistantModel("fast");

function isQuestionLike(s: string): number {
  const t = s.trim();
  if (!t) return 0;
  let score = 0;
  if (/\?\s*$/.test(t)) score += 0.55;
  if (/^(who|what|when|where|why|how|are you|do you|can you|could you|would you)\b/i.test(t)) score += 0.35;
  if (/\b(tell me|explain|clarify|walk me through)\b/i.test(t)) score += 0.2;
  return Math.min(1, score);
}

export function extractQuestionSpansFromChunk(args: { text: string; tStartMs: number; tEndMs: number }): Array<{
  text: string;
  tStartMs: number;
  tEndMs: number;
  score: number;
}> {
  const raw = String(args.text || "").replace(/\s+/g, " ").trim();
  if (!raw) return [];
  const parts = raw.split(/(?<=[.!?])\s+/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return [];
  const dur = Math.max(1, args.tEndMs - args.tStartMs);
  const out: Array<{ text: string; tStartMs: number; tEndMs: number; score: number }> = [];
  let buf: string[] = [];
  let bufScore = 0;

  const flush = () => {
    if (!buf.length) return;
    const text = buf.join(" ").trim();
    const sc = Math.max(bufScore, isQuestionLike(text));
    if (sc >= 0.35) {
      const frac = out.length / Math.max(1, parts.length);
      const t0 = args.tStartMs + Math.floor(dur * frac);
      const t1 = args.tStartMs + Math.floor(dur * Math.min(1, frac + buf.length / Math.max(1, parts.length)));
      out.push({ text, tStartMs: t0, tEndMs: t1, score: sc });
    }
    buf = [];
    bufScore = 0;
  };

  for (const p of parts) {
    const sc = isQuestionLike(p);
    if (sc >= 0.25) {
      if (buf.length && sc > 0 && bufScore < 0.25) flush();
      buf.push(p);
      bufScore = Math.max(bufScore, sc);
    } else {
      flush();
    }
  }
  flush();
  return out;
}

async function confirmSpanMapsToQuestion(span: string, questionText: string): Promise<boolean | null> {
  const prompt = `Does the SPAN ask essentially the same question as the TRACKED_QUESTION? Return JSON only: {"same":true|false}
SPAN: ${span.slice(0, 400)}
TRACKED_QUESTION: ${questionText.slice(0, 400)}`;
  try {
    const raw = await vertexRunWithText(FAST, prompt, false);
    const parsed = (parseJsonFromResponseOrNull(raw) ?? (await parseJsonFromResponseWithRepair(raw))) as { same?: boolean };
    if (typeof parsed?.same === "boolean") return parsed.same;
  } catch {
    /* ignore */
  }
  return null;
}

export async function runMeetingQuestionSpanDetect(
  admin: SupabaseClient,
  args: { meetingId: string; chunkText: string; tStartMs: number; tEndMs: number },
): Promise<void> {
  const spans = extractQuestionSpansFromChunk({
    text: args.chunkText,
    tStartMs: args.tStartMs,
    tEndMs: args.tEndMs,
  });
  if (!spans.length) return;

  const qRes = await admin
    .schema("deal_intel")
    .from("meeting_tracked_question")
    .select("id, text")
    .eq("meeting_id", args.meetingId)
    .limit(60);
  const tracked = (qRes.data ?? []) as Array<{ id: string; text: string }>;

  for (const sp of spans) {
    const dk = `qs:${createHash("sha256").update(`${args.meetingId}:${sp.tStartMs}:${sp.text.slice(0, 200)}`).digest("hex").slice(0, 20)}`;
    let linked: string | null = null;
    let confirmed = false;
    let spanEmb: number[] | null = null;
    try {
      spanEmb = await embedText(sp.text);
    } catch {
      spanEmb = null;
    }
    let best: { id: string; sim: number; text: string } | null = null;
    for (const tq of tracked) {
      let sim = 0;
      try {
        const qEmb = await embedText(tq.text);
        if (spanEmb && qEmb.length === spanEmb.length) sim = cosineSimilarity(spanEmb, qEmb);
      } catch {
        sim = 0;
      }
      if (!best || sim > best.sim) best = { id: tq.id, sim, text: tq.text };
    }
    if (best && best.sim >= 0.78) {
      linked = best.id;
      const c = best.sim < 0.88 ? await confirmSpanMapsToQuestion(sp.text, best.text) : true;
      confirmed = c === true;
      if (c === false) linked = null;
    }

    await admin.schema("deal_intel").from("meeting_question_span").upsert(
      {
        meeting_id: args.meetingId,
        t_start_ms: sp.tStartMs,
        t_end_ms: sp.tEndMs,
        text: sp.text.slice(0, 1500),
        is_question_score: sp.score,
        intent_classifier_version: "v1-regex",
        merged_from_span_ids: [],
        linked_tracked_question_id: linked,
        confirmed_by_llm: confirmed,
        dedupe_key: dk,
      },
      { onConflict: "meeting_id,dedupe_key" },
    );
  }
}
