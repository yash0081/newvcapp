import { vertexRunWithText } from "@/lib/vertex";
import { parseJsonFromResponseOrNull, parseJsonFromResponseWithRepair } from "@/lib/gemini";

const BIG_MODEL =
  process.env.GEMINI_MODEL_FLASH?.trim() ||
  process.env.GEMINI_MODEL_FLASH_LITE?.trim() ||
  "gemini-2.5-flash";

export type QuestionSuggestDecision = {
  suggest: boolean;
  reason: "silence" | "new_fact" | "topic_boundary" | "rate_limited" | "none";
};

export function shouldSuggestQuestion(opts: {
  gate_call_big: boolean;
  gate_reason: string;
  is_silence_after_speech: boolean;
  ms_since_last_question: number;
}): QuestionSuggestDecision {
  const since = Math.max(0, Math.floor(opts.ms_since_last_question));
  if (since < 2 * 60_000) return { suggest: false, reason: "rate_limited" };

  // Strongest signal: a conversational slot.
  if (opts.is_silence_after_speech && opts.gate_call_big) return { suggest: true, reason: "silence" };

  // Otherwise be conservative: only when gate believes there's a new fact or topic.
  if (opts.gate_call_big && (opts.gate_reason === "new_fact" || opts.gate_reason === "new_topic")) {
    return { suggest: true, reason: "new_fact" };
  }

  return { suggest: false, reason: "none" };
}

export type SuggestedQuestion = {
  question: string;
  rationale: string;
  urgency: "low" | "med" | "high";
};

/**
 * Optional second micro-call: generate ONE tasteful question suggestion.
 * Intended UI: show as a chip (not TTS) and allow user to click-to-pin.
 */
export async function generateSuggestedQuestion(opts: {
  recent_transcript: string;
  running_summary: string;
  deal_context_hint?: string;
}): Promise<SuggestedQuestion | null> {
  const prompt = `You are a VC meeting assistant.\n\nGiven the recent transcript, propose ONE concise, high-signal question to ask next.\nThe question should:\n- be answerable by the founder\n- reduce uncertainty relevant to investing\n- not be spammy or obvious\n- avoid repeating what's already answered\n\nOutput ONLY JSON:\n{\n  \"question\": string,\n  \"rationale\": string,\n  \"urgency\": \"low\"|\"med\"|\"high\"\n}\n\nRunning summary:\n---\n${opts.running_summary.slice(0, 8000)}\n---\n\nRecent transcript:\n---\n${opts.recent_transcript.slice(0, 6000)}\n---\n\nDeal context hint (optional):\n${(opts.deal_context_hint ?? "").slice(0, 1200)}`;

  const text = await vertexRunWithText(BIG_MODEL, prompt, false);
  const parsed = (parseJsonFromResponseOrNull(text) ?? (await parseJsonFromResponseWithRepair(text))) as Record<string, unknown>;
  const q = typeof parsed.question === "string" ? parsed.question.trim() : "";
  const r = typeof parsed.rationale === "string" ? parsed.rationale.trim() : "";
  const u = typeof parsed.urgency === "string" ? parsed.urgency : "low";
  if (!q || q.length < 8) return null;
  return {
    question: q.slice(0, 240),
    rationale: (r || "High-signal clarification.").slice(0, 320),
    urgency: u === "high" || u === "med" || u === "low" ? u : "low",
  };
}

