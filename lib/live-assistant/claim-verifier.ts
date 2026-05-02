/**
 * Canonical claim verifier — thin back-compat wrapper.
 *
 * Lite mode (the only canonical mode now) emits cards inline from the transcription worker
 * via `runCanonicalClaimVerifyLite` (see `lib/live-assistant/claim-verifier-lite.ts`).
 *
 * This file used to host a heavy multi-source per-claim verifier. It now just resolves any
 * in-flight `meeting_canonical_claim_verify` queue rows (or callers that still expect the
 * old `claim_dedupe_keys` shape) into the chunk-level inputs the lite verifier needs and
 * delegates. Legacy multi-path mode (auto-verify, slow reasoning, KPI middle/fast) lives
 * unchanged in its own files and runs when `LIVE_ASSISTANT_CANONICAL_VERIFIER=false`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  runCanonicalClaimVerifyLite,
  type RunCanonicalClaimVerifyLiteArgs,
} from "@/lib/live-assistant/claim-verifier-lite";

export type RunCanonicalClaimVerifyArgs = {
  meeting_id: string;
  deal_id: string;
  user_id: string;
  /** dedupe_keys from `meeting_claim` (worker-supplied). Resolved per-key to a chunk. */
  claim_dedupe_keys: string[];
};

/**
 * Back-compat entry point for the `meeting_canonical_claim_verify` queue job. Each
 * dedupe key resolves to a `meeting_claim` row, which carries the `chunk_id` and
 * `t_start_ms` we need to call the lite verifier. We deduplicate on `chunk_id` so a
 * chunk that produced multiple claim rows still emits one card.
 */
export async function runCanonicalClaimVerify(
  admin: SupabaseClient,
  payload: Record<string, unknown> | RunCanonicalClaimVerifyArgs,
): Promise<void> {
  const meetingId = String((payload as Record<string, unknown>).meeting_id ?? "");
  const dealId = String((payload as Record<string, unknown>).deal_id ?? "");
  const userId = String((payload as Record<string, unknown>).user_id ?? "");
  const keysRaw = (payload as Record<string, unknown>).claim_dedupe_keys;
  const dedupeKeys = Array.isArray(keysRaw)
    ? [...new Set(keysRaw.map((x) => String(x).trim()).filter(Boolean))]
    : [];
  if (!meetingId || !dealId || !userId || !dedupeKeys.length) return;

  const claimRes = await admin
    .schema("deal_intel")
    .from("meeting_claim")
    .select("id, chunk_id, speaker, dedupe_key, superseded_by_claim_id")
    .eq("meeting_id", meetingId)
    .in("dedupe_key", dedupeKeys);
  if (claimRes.error || !claimRes.data?.length) return;

  const seenChunkIds = new Set<string>();
  const tasks: Array<RunCanonicalClaimVerifyLiteArgs> = [];

  for (const row of claimRes.data as Array<{
    id: string;
    chunk_id: string | null;
    speaker: string | null;
    superseded_by_claim_id: string | null;
  }>) {
    if (row.superseded_by_claim_id) continue;
    if (String(row.speaker ?? "").startsWith("host:")) continue;
    const chunkId = row.chunk_id ? String(row.chunk_id) : null;
    if (!chunkId || seenChunkIds.has(chunkId)) continue;
    seenChunkIds.add(chunkId);

    const chRes = await admin
      .schema("deal_intel")
      .from("meeting_semantic_chunk")
      .select("text, t_start_ms, speaker")
      .eq("id", chunkId)
      .maybeSingle();
    const chRow = chRes.data as { text?: string; t_start_ms?: number; speaker?: string } | null;
    if (!chRow?.text) continue;

    tasks.push({
      meeting_id: meetingId,
      deal_id: dealId,
      user_id: userId,
      guest_chunk_id: chunkId,
      guest_text: String(chRow.text),
      guest_t_start_ms: typeof chRow.t_start_ms === "number" ? chRow.t_start_ms : 0,
      speaker_label: chRow.speaker ?? row.speaker ?? null,
    });
  }

  for (const t of tasks) {
    try {
      await runCanonicalClaimVerifyLite(admin, t);
    } catch (e) {
      console.warn("[canonical-verifier] queued lite call failed", e instanceof Error ? e.message : e);
    }
  }
}
