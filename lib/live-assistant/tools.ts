import type { SupabaseClient } from "@supabase/supabase-js";
import { embedText } from "@/lib/vertex-embeddings";
import { vectorParam } from "@/lib/data-layer/shared/vector";
import { createHash } from "node:crypto";

export type MeetingEventKind =
  | "contradiction"
  | "crm_fact"
  | "key_point"
  | "suggested_question"
  | "action_prompt";

export type MeetingEventSeverity = "low" | "med" | "high";

export type MeetingAssistantEventInput = {
  meeting_id: string;
  kind: MeetingEventKind;
  title?: string | null;
  body: string;
  severity?: MeetingEventSeverity;
  source_map?: unknown;
};

export type ClaimHit = {
  id: string;
  document_id: string;
  page_number: number | null;
  sentence_id: string | null;
  quote: string;
  claim_type: string;
  key: string | null;
  score: number;
};

function rrfMerge(a: Array<{ id: string }>, b: Array<{ id: string }>, k = 60): Array<{ id: string; score: number }> {
  const score = new Map<string, number>();
  const add = (arr: Array<{ id: string }>) => {
    for (let i = 0; i < arr.length; i++) {
      const id = String(arr[i].id);
      score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1));
    }
  };
  add(a);
  add(b);
  return Array.from(score.entries())
    .map(([id, s]) => ({ id, score: s }))
    .sort((x, y) => y.score - x.score);
}

/**
 * Fetch lightweight deal context for prompting (MVP): company metadata + canonical facts.
 */
export async function getDealContext(admin: SupabaseClient, opts: { userId: string; dealId: string }) {
  const [deal, facts] = await Promise.all([
    admin
      .schema("deal_intel")
      .from("deal")
      .select("id, metadata")
      .eq("id", opts.dealId)
      .eq("user_id", opts.userId)
      .maybeSingle(),
    admin
      .schema("deal_intel")
      .from("company_fact")
      .select("id, fact_path, canonical_value_text, canonical_value_jsonb, status, updated_at, source_claim_id")
      .eq("deal_id", opts.dealId)
      .order("updated_at", { ascending: false })
      .limit(120),
  ]);

  return {
    deal: deal.data,
    company_facts: facts.data ?? [],
  };
}

/**
 * Retrieve top-K claims using hybrid (vector + FTS) and RRF merge.
 */
export async function matchClaimsHybrid(admin: SupabaseClient, opts: { userId: string; dealId: string; queryText: string; limit?: number }) {
  const limit = Math.max(5, Math.min(40, opts.limit ?? 18));
  const queryText = opts.queryText.trim().slice(0, 500);
  if (!queryText) return [] as ClaimHit[];

  let emb: number[] | null = null;
  try {
    emb = await embedText(queryText);
  } catch {
    emb = null;
  }

  const matchCount = Math.max(10, limit * 2);
  const [vec, fts] = await Promise.all([
    emb
      ? admin.rpc("deal_intel_match_claims_vector", {
          p_user_id: opts.userId,
          p_query_embedding: vectorParam(emb),
          p_match_count: matchCount,
          p_deal_id: opts.dealId,
        })
      : Promise.resolve({ data: [] as unknown[] }),
    admin.rpc("deal_intel_match_claims_fts", {
      p_user_id: opts.userId,
      p_query: queryText,
      p_match_count: matchCount,
      p_deal_id: opts.dealId,
    }),
  ]);

  const vecRows = ((vec as { data?: unknown[] }).data ?? []) as Array<Record<string, unknown> & { id: string; similarity: number }>;
  const ftsRows = ((fts as { data?: unknown[] }).data ?? []) as Array<Record<string, unknown> & { id: string; score: number }>;

  const order = rrfMerge(
    vecRows.map((r) => ({ id: String(r.id) })),
    ftsRows.map((r) => ({ id: String(r.id) })),
  );

  const byId = new Map<string, Record<string, unknown>>();
  for (const r of [...vecRows, ...ftsRows]) byId.set(String(r.id), r);

  const out: ClaimHit[] = [];
  for (const it of order.slice(0, limit)) {
    const r = byId.get(it.id);
    if (!r) continue;
    out.push({
      id: it.id,
      document_id: String(r.document_id),
      page_number: r.page_number == null ? null : Number(r.page_number),
      sentence_id: r.sentence_id == null ? null : String(r.sentence_id),
      quote: String(r.quote ?? ""),
      claim_type: String(r.claim_type ?? ""),
      key: r.key == null ? null : String(r.key),
      score: it.score,
    });
  }
  return out;
}

/**
 * Create an assistant event card row (server-side).
 */
export async function createMeetingAssistantEvent(admin: SupabaseClient, input: MeetingAssistantEventInput) {
  const severity: MeetingEventSeverity = input.severity ?? "low";
  const sourceMap = (input.source_map && typeof input.source_map === "object" ? input.source_map : {}) as Record<string, unknown>;
  const fastLane = sourceMap.fast_lane === true;
  const dedupeKey =
    typeof sourceMap.dedupe_key === "string" && sourceMap.dedupe_key.trim()
      ? sourceMap.dedupe_key.trim()
      : createHash("sha256")
          .update(`${input.meeting_id}|${input.kind}|${input.title ?? ""}|${input.body.slice(0, 280)}`)
          .digest("hex")
          .slice(0, 24);

  // Best-effort dedupe: avoid inserting the same card repeatedly.
  // We only scan recent rows (cheap) and match on source_map.dedupe_key.
  if (!fastLane) {
    try {
      const recent = await admin
        .schema("deal_intel")
        .from("meeting_assistant_event")
        .select("id, source_map")
        .eq("meeting_id", input.meeting_id)
        .order("created_at", { ascending: false })
        .limit(80);
      if (!recent.error) {
        for (const r of (recent.data ?? []) as Array<{ id: string; source_map: unknown }>) {
          const sm = (r.source_map && typeof r.source_map === "object" ? (r.source_map as Record<string, unknown>) : {}) as Record<
            string,
            unknown
          >;
          if (String(sm.dedupe_key ?? "") === dedupeKey) return { data: { id: r.id }, error: null };
        }
      }
    } catch {
      // ignore dedupe read errors
    }
  }

  const row = {
    meeting_id: input.meeting_id,
    kind: input.kind,
    title: input.title ?? null,
    body: input.body,
    severity,
    source_map: { ...sourceMap, dedupe_key: dedupeKey },
  };
  const res = await admin.schema("deal_intel").from("meeting_assistant_event").insert(row).select("id").maybeSingle();
  if (res.error) {
    console.error("createMeetingAssistantEvent insert failed", res.error.message || res.error, input.kind);
  }
  return res;
}

