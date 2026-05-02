import type { SupabaseClient } from "@supabase/supabase-js";
import {
  contradictionEmbedSimThreshold,
  contradictionSweepSemanticEnabled,
  embeddingDedupeIndicesNewestFirst,
} from "@/lib/live-assistant/semantic-assistant-dedupe";

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

/** Tokens long enough to matter; strips labels like Host/Guest so the same story matches across templates. */
function significantTokens(body: string): Set<string> {
  const stripped = String(body || "")
    .replace(/\b(host|guest|summary|our records)\b:?/gi, " ")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ");
  const parts = stripped
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4);
  return new Set(parts);
}

function tokenJaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) inter++;
  }
  const uni = a.size + b.size - inter;
  return uni ? inter / uni : 0;
}

/**
 * Second-pass duplicate detection when different emitters used different `dedupe_key`s
 * (e.g. ctxt: vs cmetric: vs cclaim:) but the card body is the same narrative.
 */
export function contradictionBodiesNearDuplicate(a: string, b: string): boolean {
  const na = normKey(a);
  const nb = normKey(b);
  if (na === nb && na.length >= 24) return true;

  const sa = significantTokens(a);
  const sb = significantTokens(b);
  if (sa.size < 5 || sb.size < 5) return false;

  let inter = 0;
  for (const x of sa) {
    if (sb.has(x)) inter++;
  }
  if (inter < 4) return false;

  const j = tokenJaccard(sa, sb);
  return j >= 0.8;
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
  /** Newest-first rows we kept — used to drop older cards that describe the same conflict with different keys. */
  const keptBodies: Array<{ body: string }> = [];

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

    let narrativeDup = false;
    for (const prev of keptBodies) {
      if (contradictionBodiesNearDuplicate(r.body, prev.body)) {
        narrativeDup = true;
        break;
      }
    }
    if (narrativeDup) {
      del.push(r.id);
      continue;
    }

    seen.add(k);
    keptBodies.push({ body: r.body });
  }

  if (contradictionSweepSemanticEnabled()) {
    const pass1 = new Set(del);
    const survivors = rows.filter((r) => !pass1.has(r.id));
    if (survivors.length >= 2) {
      const bodies = survivors.map((r) => r.body);
      const dropIdx = await embeddingDedupeIndicesNewestFirst(bodies, contradictionEmbedSimThreshold());
      for (const i of dropIdx) {
        const row = survivors[i];
        if (row) del.push(row.id);
      }
    }
  }

  const uniqDel = [...new Set(del)];
  if (!uniqDel.length) return;
  for (let i = 0; i < uniqDel.length; i += 50) {
    const batch = uniqDel.slice(i, i + 50);
    const dres = await admin.schema("deal_intel").from("meeting_assistant_event").delete().in("id", batch);
    if (dres.error) {
      console.warn("dedupeContradictionEventsByFactKey delete failed", dres.error.message || dres.error);
      return;
    }
  }
}

