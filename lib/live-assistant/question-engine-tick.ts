import type { SupabaseClient } from "@supabase/supabase-js";
import { runMeetingAssumptionExtract } from "@/lib/live-assistant/assumption-extract";
import { runUserStyleQuestionHydrate } from "@/lib/live-assistant/similar-deal-questions";
import { runMeetingQuestionMatchBatch } from "@/lib/live-assistant/question-match";
import {
  runMeetingHostQuestionSpanBatchCanonical,
  runMeetingQuestionSpanDetect,
} from "@/lib/live-assistant/question-spans";

function envFlag(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export async function runMeetingQuestionEngineTick(
  admin: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<void> {
  const meetingId = String(payload.meeting_id ?? "");
  const dealId = String(payload.deal_id ?? "");
  const userId = String(payload.user_id ?? "");
  const chunkText = payload.chunk_text == null ? "" : String(payload.chunk_text);
  const tStartMs = Number(payload.t_start_ms ?? 0);
  const tEndMs = Number(payload.t_end_ms ?? 0);
  if (!meetingId || !dealId || !userId) return;

  const isHostChunk = payload.is_host === true;
  const canonical = envFlag("LIVE_ASSISTANT_CANONICAL_VERIFIER", false);

  // In canonical mode, `runGuestTurnVerify` is the single source of truth for marking
  // tracked questions answered. The span detector and per-question batch are kept off so
  // they do not race the per-turn verifier or revive the legacy two-LLM-per-turn pattern.
  if (!canonical && chunkText.trim() && tEndMs > tStartMs) {
    await runMeetingQuestionSpanDetect(admin, {
      meetingId,
      chunkText,
      tStartMs,
      tEndMs,
      isHostChunk,
    });
  }

  if (canonical) {
    await Promise.all([
      runMeetingAssumptionExtract(admin, meetingId),
      runUserStyleQuestionHydrate(admin, { meetingId, userId, dealId }),
    ]);
  } else {
    await Promise.all([
      runMeetingAssumptionExtract(admin, meetingId),
      runUserStyleQuestionHydrate(admin, { meetingId, userId, dealId }),
      runMeetingQuestionMatchBatch(admin, meetingId),
    ]);
  }
}

// Imported for type-completeness even when unused in canonical mode (so removing the flag
// later does not break callers). Suppress unused-import warning.
void runMeetingHostQuestionSpanBatchCanonical;
