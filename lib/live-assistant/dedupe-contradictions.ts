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

export async function dedupeFastContradictionEvents(admin: SupabaseClient, meetingId: string): Promise<void> {
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
    console.error("dedupeFastContradictionEvents", msg);
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

  const keep = new Set<string>();
  const del: string[] = [];
  const seen = new Set<string>();

  for (const r of rows) {
    const sm = safeSourceMap(r.source_map);
    if (sm.fast_lane !== true) continue; // only dedupe fast path
    const dk = typeof sm.dedupe_key === "string" ? sm.dedupe_key : "";
    const k = dk ? `dk:${dk}` : `b:${normKey(`${r.title ?? ""}|${r.body}`)}`;
    if (seen.has(k)) {
      del.push(r.id);
      continue;
    }
    seen.add(k);
    keep.add(r.id);
  }

  if (!del.length) return;
  // Delete in small batches.
  for (let i = 0; i < del.length; i += 50) {
    const batch = del.slice(i, i + 50);
    const dres = await admin.schema("deal_intel").from("meeting_assistant_event").delete().in("id", batch);
    if (dres.error) {
      console.warn("dedupeFastContradictionEvents delete failed", dres.error.message || dres.error);
      return;
    }
  }
}

