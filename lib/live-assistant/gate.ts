import { vertexRunWithText } from "@/lib/vertex";

export type GateReason = "new_fact" | "new_topic" | "key_point" | "pause" | "none";
export type GateUrgency = "low" | "med" | "high";

export type GateInput = {
  window_text: string;
  session_topic_hint?: string;
  ms_since_last_big_call: number;
  is_silence_after_speech: boolean;
};

export type GateOutput = {
  call_big: boolean;
  reason: GateReason;
  confidence: number; // 0..1
  suggested_urgency: GateUrgency;
};

const GATE_MODEL =
  process.env.GEMINI_MODEL_GATE?.trim() ||
  process.env.GEMINI_MODEL_FLASH_LITE?.trim() ||
  process.env.GEMINI_MODEL_FLASH_SUMMARY?.trim() ||
  "gemini-2.5-flash-lite";

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function isGateReason(s: string): s is GateReason {
  return ["new_fact", "new_topic", "key_point", "pause", "none"].includes(s);
}
function isUrgency(s: string): s is GateUrgency {
  return ["low", "med", "high"].includes(s);
}

/**
 * Cheap prefilter: decide whether it is even worth calling the gate model.
 * This prevents spending money on tiny deltas.
 */
export function shouldCallGate(opts: {
  delta_chars_final: number;
  silence_gap_ms: number;
  ms_since_last_big_call: number;
}): boolean {
  const delta = Math.max(0, Math.floor(opts.delta_chars_final));
  const silence = Math.max(0, Math.floor(opts.silence_gap_ms));
  const sinceBig = Math.max(0, Math.floor(opts.ms_since_last_big_call));

  // Always run gate if there is a natural turn boundary.
  if (silence >= 700) return true;

  // If we haven't called big in a while, allow smaller deltas.
  if (sinceBig >= 45_000 && delta >= 20) return true;

  // Normal cadence threshold.
  if (delta >= 40) return true;

  // Otherwise skip.
  return false;
}

/**
 * Call the gating model on a short transcript window. Returns strict-ish JSON.
 * On failure, returns a conservative default (don't call big unless pause + enough text).
 */
export async function runGateModel(input: GateInput): Promise<GateOutput> {
  const windowText = String(input.window_text || "").trim();
  const prompt = `You are a real-time meeting assistant gatekeeper.\n\nYou will be given the last 10–20 seconds of FINAL transcript text.\nDecide whether to call the \"big\" assistant now.\n\nOutput ONLY valid JSON (no markdown, no backticks, no explanation) with this exact shape:\n{\n  \"call_big\": boolean,\n  \"reason\": \"new_fact\"|\"new_topic\"|\"key_point\"|\"pause\"|\"none\",\n  \"confidence\": number,\n  \"suggested_urgency\": \"low\"|\"med\"|\"high\"\n}\n\nRules:\n- Prefer call_big=false unless there is new propositional content, a clear topic shift, a key decision/number, or a good conversational pause.\n- If is_silence_after_speech=true and the text contains a number/metric/commitment, prefer call_big=true.\n- confidence should be 0..1.\n\nInput JSON:\n${JSON.stringify(
    {
      window_text: windowText.slice(0, 4000),
      session_topic_hint: input.session_topic_hint ?? null,
      ms_since_last_big_call: Math.max(0, Math.floor(input.ms_since_last_big_call)),
      is_silence_after_speech: Boolean(input.is_silence_after_speech),
    },
    null,
    2
  )}`;

  const fallback: GateOutput = {
    call_big: Boolean(input.is_silence_after_speech) && windowText.length >= 80,
    reason: input.is_silence_after_speech ? "pause" : "none",
    confidence: input.is_silence_after_speech ? 0.55 : 0.2,
    suggested_urgency: "low",
  };

  try {
    const text = await vertexRunWithText(GATE_MODEL, prompt, false);
    const m = text.match(/\{[\s\S]*\}/);
    const raw = m ? JSON.parse(m[0]) : JSON.parse(text);
    const obj = raw as Partial<GateOutput> & { reason?: unknown; suggested_urgency?: unknown };
    const reason = typeof obj.reason === "string" && isGateReason(obj.reason) ? obj.reason : fallback.reason;
    const urgency =
      typeof obj.suggested_urgency === "string" && isUrgency(obj.suggested_urgency)
        ? obj.suggested_urgency
        : fallback.suggested_urgency;
    return {
      call_big: typeof obj.call_big === "boolean" ? obj.call_big : fallback.call_big,
      reason,
      confidence: clamp01(typeof obj.confidence === "number" ? obj.confidence : fallback.confidence),
      suggested_urgency: urgency,
    };
  } catch {
    return fallback;
  }
}

