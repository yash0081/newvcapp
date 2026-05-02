import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Load meeting_claim rows for display. When a row was superseded (correction flow),
 * map its id to the successor claim's text so UI shows the latest wording.
 */
export async function loadMeetingClaimTextsForDisplay(
  admin: SupabaseClient,
  meetingId: string,
  claimIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(claimIds.filter(Boolean))];
  if (!ids.length) return out;

  const cRes = await admin
    .schema("deal_intel")
    .from("meeting_claim")
    .select("id, text, superseded_by_claim_id")
    .eq("meeting_id", meetingId)
    .in("id", ids);
  if (cRes.error || !cRes.data) return out;

  const rows = cRes.data as Array<{ id: string; text: string; superseded_by_claim_id: string | null }>;
  const successorIds = [...new Set(rows.map((r) => r.superseded_by_claim_id).filter((x): x is string => Boolean(x)))];
  let successorText = new Map<string, string>();
  if (successorIds.length) {
    const sr = await admin
      .schema("deal_intel")
      .from("meeting_claim")
      .select("id, text")
      .eq("meeting_id", meetingId)
      .in("id", successorIds);
    if (!sr.error && sr.data) {
      successorText = new Map(
        (sr.data as Array<{ id: string; text: string }>).map((x) => [String(x.id), String(x.text ?? "")]),
      );
    }
  }
  for (const x of rows) {
    const sid = x.superseded_by_claim_id ? String(x.superseded_by_claim_id) : "";
    const text = sid && successorText.has(sid) ? successorText.get(sid)! : String(x.text ?? "");
    out.set(String(x.id), text);
  }
  return out;
}
