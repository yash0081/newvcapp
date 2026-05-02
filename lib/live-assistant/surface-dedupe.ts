import type { SupabaseClient } from "@supabase/supabase-js";
import { embedTexts } from "@/lib/vertex-embeddings";
import { cosineSimilarity } from "@/lib/data-layer/shared/vector";

/**
 * Batch-embed meeting assistant card bodies and soft-hide near-duplicates (ui_suppressed)
 * so the feed shows one card per underlying story. Uses a high threshold by default.
 */
export function surfaceDedupeSimThreshold(): number {
  const raw = Number(process.env.LIVE_ASSISTANT_SURFACE_DEDUPE_SIM ?? 0.91);
  return Number.isFinite(raw) ? Math.min(0.99, Math.max(0.84, raw)) : 0.91;
}

type EventRow = { id: string; body: string; source_map: unknown };

function safeMap(x: unknown): Record<string, unknown> {
  return x && typeof x === "object" ? (x as Record<string, unknown>) : {};
}

export async function runMeetingAssistantSurfaceDedupe(admin: SupabaseClient, meetingId: string): Promise<void> {
  if (!process.env.GOOGLE_CLOUD_PROJECT?.trim()) return;

  const res = await admin
    .schema("deal_intel")
    .from("meeting_assistant_event")
    .select("id, body, source_map, kind, created_at")
    .eq("meeting_id", meetingId)
    .in("kind", ["contradiction", "claim_verification"])
    .order("created_at", { ascending: false })
    .limit(200);

  if (res.error) return;

  const rawRows = (res.data ?? []) as EventRow[];
  const rows = rawRows.filter((r) => safeMap(r.source_map).ui_suppressed !== true);
  if (rows.length < 2) return;

  const bodies = rows.map((r) => String(r.body ?? "").trim().slice(0, 3500));
  const thresh = surfaceDedupeSimThreshold();

  let vecs: number[][] = [];
  try {
    vecs = await embedTexts(bodies, 40);
  } catch {
    return;
  }
  if (vecs.length !== rows.length) return;

  const kept: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const vi = vecs[i]!;
    let duplicateOf: string | null = null;
    for (const j of kept) {
      if (cosineSimilarity(vi, vecs[j]!) >= thresh) {
        duplicateOf = rows[j]!.id;
        break;
      }
    }
    if (duplicateOf) {
      const sm = safeMap(rows[i]!.source_map);
      const next = { ...sm, ui_suppressed: true, dedupe_of_event_id: duplicateOf };
      await admin.schema("deal_intel").from("meeting_assistant_event").update({ source_map: next }).eq("id", rows[i]!.id);
    } else {
      kept.push(i);
    }
  }
}
