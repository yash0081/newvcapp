import type { SupabaseClient } from "@supabase/supabase-js";
import { runMeetingAssumptionExtract } from "@/lib/live-assistant/assumption-extract";
import { runSimilarDealQuestionHydrate } from "@/lib/live-assistant/similar-deal-questions";
import { runMeetingQuestionMatchBatch } from "@/lib/live-assistant/question-match";
import { runMeetingQuestionSpanDetect } from "@/lib/live-assistant/question-spans";

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

  if (chunkText.trim() && tEndMs > tStartMs) {
    await runMeetingQuestionSpanDetect(admin, {
      meetingId,
      chunkText,
      tStartMs,
      tEndMs,
    });
  }

  await Promise.all([
    runMeetingAssumptionExtract(admin, meetingId),
    runSimilarDealQuestionHydrate(admin, { meetingId, userId, dealId }),
    runMeetingQuestionMatchBatch(admin, meetingId),
  ]);
}
