import type { SupabaseClient } from "@supabase/supabase-js";

function safeSourceMap(x: unknown): Record<string, unknown> {
  return x && typeof x === "object" ? (x as Record<string, unknown>) : {};
}

function normKey(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

/**
 * Sweep duplicate contradiction event cards for a meeting, keeping the newest one per
 * `source_map.dedupe_key`. All contradiction emitters (fast / middle / slow / deep) now
 * write a fact-anchored `dedupe_key`, so this catches any cross-path leftovers and any
 * pre-existing duplicates from older code paths.
 *
 * In normal operation this should be a no-op now that `createMeetingAssistantEvent`
 * runs the recent-rows dedupe check inline (no `fast_lane` skip), but we keep the sweep
 * for backfill safety and as a belt-and-suspenders cleanup.
 */
export async function dedupeContradictionEventsByFactKey(admin: SupabaseClient, meetingId: string): Promise<void> {
  const res = await admin
    .schema("deal_intel")
    .from("meeting_assistant_event")
    .select("id, kind, title, body, created_at, source_map")
    .eq("meeting_id", meetingId)
    .eq("kind", "contradiction")
    .order("created_at", { ascending: false })
    .limit(250);

  if (res.error) {
    const msg = res.error.message || String(res.error);
    if (msg.includes("does not exist") || msg.includes("schema cache")) return;
    console.error("dedupeContradictionEventsByFactKey", msg);
    return;
  }

  const rows = (res.data ?? []) as Array<{
    id: string;
    kind: string;
    title: string | null;
    body: string;
    created_at: string;
    source_map: unknown;
  }>;

  const del: string[] = [];
  const seen = new Set<string>();

  for (const r of rows) {
    const sm = safeSourceMap(r.source_map);
    const dk = typeof sm.dedupe_key === "string" ? sm.dedupe_key : "";
    // Without a dedupe_key we fall back to title+body — same as before, just no longer gated
    // on `fast_lane`, so deep/slow/mid contradictions also get collapsed.
    const k = dk ? `dk:${dk}` : `b:${normKey(`${r.title ?? ""}|${r.body}`)}`;
    if (seen.has(k)) {
      del.push(r.id);
      continue;
    }
    seen.add(k);
  }

  if (!del.length) return;
  for (let i = 0; i < del.length; i += 50) {
    const batch = del.slice(i, i + 50);
    const dres = await admin.schema("deal_intel").from("meeting_assistant_event").delete().in("id", batch);
    if (dres.error) {
      console.warn("dedupeContradictionEventsByFactKey delete failed", dres.error.message || dres.error);
      return;
    }
  }
}

