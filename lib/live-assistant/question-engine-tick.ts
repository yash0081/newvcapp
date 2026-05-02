import type { SupabaseClient } from "@supabase/supabase-js";
import { runMeetingAssumptionExtract } from "@/lib/live-assistant/assumption-extract";
import { runUserStyleQuestionHydrate } from "@/lib/live-assistant/similar-deal-questions";

export async function runMeetingQuestionEngineTick(
  admin: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<void> {
  const meetingId = String(payload.meeting_id ?? "");
  const dealId = String(payload.deal_id ?? "");
  const userId = String(payload.user_id ?? "");
  if (!meetingId || !dealId || !userId) return;

  await Promise.all([
    runMeetingAssumptionExtract(admin, meetingId),
    runUserStyleQuestionHydrate(admin, { meetingId, userId, dealId }),
  ]);
}
