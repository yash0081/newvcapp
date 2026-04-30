import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { embedText } from "@/lib/vertex-embeddings";
import { cosineSimilarity, parseVector, vectorParam } from "@/lib/data-layer/shared/vector";
import { embedMeetingQuestionText } from "@/lib/live-assistant/meeting-embeddings";
import { upsertMeetingTrackedQuestion } from "@/lib/live-assistant/tracked-questions";

function metaStr(meta: unknown, key: string): string {
  if (!meta || typeof meta !== "object") return "";
  const v = (meta as Record<string, unknown>)[key];
  return v == null ? "" : String(v).toLowerCase().trim();
}

function dealSimilarityFilter(
  base: { stage: string; businessModel: string },
  candMeta: unknown,
): boolean {
  const st = metaStr(candMeta, "stage") || metaStr(candMeta, "company_stage");
  const bm = metaStr(candMeta, "business_model") || metaStr(candMeta, "businessModel");
  if (!base.stage && !base.businessModel) return true;
  let ok = true;
  if (base.stage) {
    ok = ok && (!st || st.includes(base.stage) || base.stage.includes(st));
  }
  if (base.businessModel) {
    ok = ok && (!bm || bm.includes(base.businessModel) || base.businessModel.includes(bm));
  }
  return ok;
}

function dedupeTemplatesByEmbedding(
  items: Array<{ id: string; text: string; source_deal_id: string; section: string; distance: number; embedding?: unknown }>,
  threshold: number,
): typeof items {
  const kept: typeof items = [];
  const vecs: number[][] = [];
  for (const it of items) {
    const v = parseVector(it.embedding);
    let dup = false;
    if (v && v.length) {
      for (let i = 0; i < kept.length; i++) {
        const kv = vecs[i];
        if (!kv?.length) continue;
        if (cosineSimilarity(v, kv) >= threshold) {
          dup = true;
          break;
        }
      }
    }
    if (!dup) {
      kept.push(it);
      vecs.push(v && v.length ? v : []);
    }
  }
  return kept;
}

export async function seedSimilarDealQuestionTemplatesFromEvents(admin: SupabaseClient, dealId: string): Promise<void> {
  const meetingsRes = await admin.schema("deal_intel").from("meeting_session").select("id").eq("deal_id", dealId).limit(80);
  if (meetingsRes.error) return;
  const mids = (meetingsRes.data ?? []).map((r) => r.id as string);
  if (!mids.length) return;

  const evRes = await admin
    .schema("deal_intel")
    .from("meeting_assistant_event")
    .select("body, source_map")
    .in("meeting_id", mids)
    .eq("kind", "suggested_question")
    .limit(300);
  if (evRes.error) return;

  const dealRow = await admin.schema("deal_intel").from("deal").select("metadata").eq("id", dealId).maybeSingle();
  const meta = dealRow.data?.metadata;
  const stageCap = metaStr(meta, "stage") || metaStr(meta, "company_stage");
  const bmCap = metaStr(meta, "business_model") || metaStr(meta, "businessModel");

  const model = process.env.VERTEX_EMBEDDING_MODEL || "text-embedding-004";
  const rows: Array<Record<string, unknown>> = [];

  for (const e of evRes.data ?? []) {
    const text = String((e as { body?: string }).body ?? "").trim();
    if (text.length < 12 || text.length > 1800) continue;
    const sm = (e as { source_map?: unknown }).source_map;
    const lane = sm && typeof sm === "object" ? String((sm as Record<string, unknown>).lane ?? "") : "";
    const dk = `seed:${createHash("sha256").update(`${dealId}:${text.slice(0, 400)}`).digest("hex").slice(0, 20)}`;
    let emb: string | null = null;
    try {
      emb = vectorParam(await embedMeetingQuestionText(text));
    } catch {
      emb = null;
    }
    rows.push({
      source_deal_id: dealId,
      text,
      section: "other",
      embedding: emb,
      embedding_model: model,
      importance_weight: 0.55,
      is_meeting_question: lane !== "memo",
      stage_at_capture: stageCap || null,
      business_model_at_capture: bmCap || null,
      dedupe_key: dk,
    });
  }

  for (let i = 0; i < rows.length; i += 20) {
    const batch = rows.slice(i, i + 20);
    await admin.schema("deal_intel").from("similar_deal_question_template").upsert(batch, { onConflict: "source_deal_id,dedupe_key" });
  }
}

export async function runSimilarDealQuestionHydrate(
  admin: SupabaseClient,
  args: { meetingId: string; userId: string; dealId: string },
): Promise<void> {
  const { data: st } = await admin
    .schema("deal_intel")
    .from("meeting_question_engine_state")
    .select("last_similar_hydrate_at")
    .eq("meeting_id", args.meetingId)
    .maybeSingle();
  const lastMs = st?.last_similar_hydrate_at ? new Date(String(st.last_similar_hydrate_at)).getTime() : 0;
  if (lastMs && Date.now() - lastMs < 5 * 60_000) return;

  const dealRes = await admin.schema("deal_intel").from("deal").select("metadata").eq("id", args.dealId).maybeSingle();
  const meta = dealRes.data?.metadata;
  const base = {
    stage: metaStr(meta, "stage") || metaStr(meta, "company_stage"),
    businessModel: metaStr(meta, "business_model") || metaStr(meta, "businessModel"),
  };

  const recent = await admin
    .schema("deal_intel")
    .from("meeting_claim")
    .select("text")
    .eq("meeting_id", args.meetingId)
    .order("updated_at", { ascending: false })
    .limit(12);
  const qText = (recent.data ?? [])
    .map((r) => String((r as { text?: string }).text ?? ""))
    .join(" ")
    .slice(0, 1200);
  const queryText = qText || `${base.stage} ${base.businessModel} diligence questions`;

  let qEmb: number[];
  try {
    qEmb = await embedText(queryText);
  } catch {
    return;
  }

  const simRes = await admin.rpc("deal_intel_match_similar_deals_hybrid", {
    p_user_id: args.userId,
    p_query_embedding: vectorParam(qEmb),
    p_query_text: queryText.slice(0, 500),
    p_exclude_deal_id: args.dealId,
    p_final_limit: 24,
  });
  if (simRes.error) {
    console.error("runSimilarDealQuestionHydrate similar deals", simRes.error);
    return;
  }

  const rawDeals = (simRes.data ?? []) as Array<{ deal_id: string }>;
  let candidateIds = rawDeals.map((r) => r.deal_id).filter(Boolean);
  if (!candidateIds.length) {
    await seedSimilarDealQuestionTemplatesFromEvents(admin, args.dealId);
    candidateIds = [args.dealId];
  }

  const dealMetaRes = await admin
    .schema("deal_intel")
    .from("deal")
    .select("id, metadata")
    .in("id", candidateIds.slice(0, 40));
  const metas = new Map<string, unknown>();
  for (const d of dealMetaRes.data ?? []) metas.set(String((d as { id: string }).id), (d as { metadata: unknown }).metadata);

  const filtered = candidateIds.filter((id) => id !== args.dealId && dealSimilarityFilter(base, metas.get(id)));

  const templateDeals = filtered.length ? filtered : candidateIds.filter((id) => id !== args.dealId).slice(0, 8);
  for (const d of templateDeals.slice(0, 6)) {
    await seedSimilarDealQuestionTemplatesFromEvents(admin, d);
  }

  const pool = templateDeals.length ? templateDeals : [args.dealId];
  const tmplRes = await admin.rpc("deal_intel_match_similar_deal_question_templates", {
    p_source_deal_ids: pool,
    p_query_embedding: vectorParam(qEmb),
    p_k: 20,
  });
  if (tmplRes.error) {
    console.error("runSimilarDealQuestionHydrate templates", tmplRes.error);
    return;
  }

  const tmplRows = (tmplRes.data ?? []) as Array<{
    id: string;
    source_deal_id: string;
    text: string;
    section: string;
    distance: number;
  }>;

  if (!tmplRows.length) {
    await admin
      .schema("deal_intel")
      .from("meeting_question_engine_state")
      .upsert(
        {
          meeting_id: args.meetingId,
          last_similar_hydrate_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "meeting_id" },
      );
    return;
  }

  const withEmb = await admin
    .schema("deal_intel")
    .from("similar_deal_question_template")
    .select("id, text, source_deal_id, section, embedding")
    .in(
      "id",
      tmplRows.map((t) => t.id),
    );
  const byId = new Map((withEmb.data ?? []).map((r) => [String((r as { id: string }).id), r as Record<string, unknown>]));

  const merged = tmplRows.map((t) => {
    const full = byId.get(t.id);
    return {
      id: t.id,
      text: t.text,
      source_deal_id: t.source_deal_id,
      section: t.section,
      distance: t.distance,
      embedding: full?.embedding,
    };
  });

  const deduped = dedupeTemplatesByEmbedding(merged, Number(process.env.LIVE_ASSISTANT_Q_TEMPLATE_DEDUPE_SIM ?? 0.92)).slice(0, 8);

  for (const t of deduped) {
    const relevance = Math.max(0, Math.min(1, 1 - Number(t.distance || 0)));
    const importance = 0.5 + relevance * 0.4;
    const score = 0.45 * relevance + 0.35 * importance + 0.2 * 1;
    if (score < 0.35) continue;
    await upsertMeetingTrackedQuestion(admin, {
      meetingId: args.meetingId,
      text: t.text,
      section: t.section || "other",
      importanceWeight: importance,
      state: "unanswered",
      provenance: "similar_company",
      venue: "memo_prep",
      similarDealId: t.source_deal_id,
      templateId: t.id,
      dedupeKey: `sim:${t.id}`,
      metadata: { template_distance: t.distance, score },
      syncEvent: { title: "Peer question", lane: "memo", severity: "low" },
    });
  }

  await admin
    .schema("deal_intel")
    .from("meeting_question_engine_state")
    .upsert(
      {
        meeting_id: args.meetingId,
        last_similar_hydrate_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "meeting_id" },
    );
}
