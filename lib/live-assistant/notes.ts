import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { vertexRunWithText } from "@/lib/vertex";
import { parseJsonFromResponseOrNull, parseJsonFromResponseWithRepair } from "@/lib/gemini";
import { getLiveAssistantModel } from "@/lib/live-assistant/model-env";
import { embedTexts } from "@/lib/vertex-embeddings";
import { vectorParam } from "@/lib/data-layer/shared/vector";
import type { LiveAssistantPreferenceSignals } from "@/lib/live-assistant/preferences";
import { maybeRefineMeetingNotes } from "@/lib/live-assistant/notes-refine";

const FAST = getLiveAssistantModel("fast");

export type NoteSection =
  | "team"
  | "problem"
  | "solution"
  | "market"
  | "product"
  | "traction"
  | "gtm"
  | "competition"
  | "financials"
  | "risks"
  | "other";

export type NoteBullet = {
  text: string;
  claim_ids: string[];
  importance_hint?: number | null;
};

export function normalizeSection(s: unknown): NoteSection {
  const v = String(s || "").toLowerCase().trim();
  const ok: NoteSection[] = [
    "team",
    "problem",
    "solution",
    "market",
    "product",
    "traction",
    "gtm",
    "competition",
    "financials",
    "risks",
    "other",
  ];
  return ok.includes(v as NoteSection) ? (v as NoteSection) : "other";
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function hasNumericSignal(text: string): number {
  const s = text.toLowerCase();
  if (/\d/.test(s)) return 1;
  if (/\b(one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|million|billion)\b/.test(s)) return 0.7;
  return 0;
}

function categoryWeight(section: NoteSection, pref?: LiveAssistantPreferenceSignals | null): number {
  const base: Record<NoteSection, number> = {
    traction: 1.3,
    financials: 1.25,
    risks: 1.2,
    gtm: 1.1,
    market: 1.05,
    solution: 1.0,
    product: 1.0,
    problem: 1.0,
    competition: 1.0,
    team: 0.9,
    other: 0.8,
  };
  const w = base[section] ?? 1;
  const prefW = pref?.sectionWeights?.[section as unknown as keyof typeof pref.sectionWeights];
  if (typeof prefW === "number" && Number.isFinite(prefW)) return clamp(w * clamp(prefW, 0.6, 1.7), 0.5, 2.2);
  return w;
}

function noveltyPenalty(sim: number): number {
  // sim in [0,1]. Higher sim => lower novelty.
  return clamp(sim, 0, 1);
}

function bulletDedupeKey(meetingId: string, section: string, text: string): string {
  return (
    "nb:" +
    createHash("sha256")
      .update(`${meetingId}|${section}|${text.toLowerCase().trim().slice(0, 280)}`)
      .digest("hex")
      .slice(0, 20)
  );
}

export async function llmBulletsFromClaims(args: {
  section: NoteSection;
  claims: Array<{ id: string; text: string }>;
}): Promise<NoteBullet[]> {
  const payload = args.claims.map((c) => ({ id: c.id, text: c.text.slice(0, 320) }));
  const prompt = `Convert the following meeting claims into concise bullet notes for section=${args.section}.\nRules:\n- Output JSON only: {\"bullets\":[{\"text\":\"...\",\"claim_ids\":[\"uuid\"],\"importance_hint\":0.0}]}\n- Each bullet MUST be 1-2 lines (<= 140 chars preferred).\n- Avoid duplication; merge similar claims into one bullet.\n- Section-aware style:\n  - traction/financials: metric-heavy, include numbers/units\n  - product/solution: feature or capability bullets\n  - team: background/hiring/experience bullets\n\nClaims:\n${JSON.stringify(payload).slice(0, 12000)}`;
  const raw = await vertexRunWithText(FAST, prompt, false);
  const parsed = (parseJsonFromResponseOrNull(raw) ?? (await parseJsonFromResponseWithRepair(raw))) as { bullets?: unknown };
  const arr = Array.isArray(parsed?.bullets) ? parsed.bullets : [];
  const out: NoteBullet[] = [];
  for (const b of arr) {
    const r = (b && typeof b === "object" ? (b as Record<string, unknown>) : {}) as Record<string, unknown>;
    const text = String(r.text ?? "").trim().slice(0, 300);
    const claimIds = Array.isArray(r.claim_ids) ? r.claim_ids.map((x) => String(x)).filter(Boolean).slice(0, 6) : [];
    const hint = typeof r.importance_hint === "number" ? r.importance_hint : null;
    if (!text || claimIds.length === 0) continue;
    out.push({ text, claim_ids: claimIds, importance_hint: hint });
  }
  return out;
}

export async function runMeetingNotesTick(admin: SupabaseClient, args: { meetingId: string; userId: string; pref?: LiveAssistantPreferenceSignals | null }) {
  const { data: st } = await admin
    .schema("deal_intel")
    .from("meeting_notes_state")
    .select("last_claim_watermark_at, last_notes_tick_at")
    .eq("meeting_id", args.meetingId)
    .maybeSingle();
  const lastClaim = st?.last_claim_watermark_at ? new Date(String(st.last_claim_watermark_at)).toISOString() : null;

  const claimsRes = await admin
    .schema("deal_intel")
    .from("meeting_claim")
    .select("id, text, section_labels, t_end_ms, updated_at")
    .eq("meeting_id", args.meetingId)
    .order("updated_at", { ascending: false })
    .limit(120);
  if (claimsRes.error) return;

  const claims = (claimsRes.data ?? []) as Array<{
    id: string;
    text: string;
    section_labels: string[];
    t_end_ms: number;
    updated_at: string;
  }>;
  const newClaims = lastClaim ? claims.filter((c) => String(c.updated_at) > lastClaim) : claims;
  if (!newClaims.length) {
    await admin.schema("deal_intel").from("meeting_notes_state").upsert(
      { meeting_id: args.meetingId, last_notes_tick_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { onConflict: "meeting_id" },
    );
    return;
  }

  const bySection = new Map<NoteSection, Array<{ id: string; text: string; t_end_ms: number }>>();
  for (const c of newClaims) {
    const sec = normalizeSection((c.section_labels ?? [])[0] ?? "other");
    const arr = bySection.get(sec) ?? [];
    arr.push({ id: c.id, text: c.text, t_end_ms: Number(c.t_end_ms ?? 0) });
    bySection.set(sec, arr);
  }

  const candidates: Array<{ section: NoteSection; bullet: NoteBullet; tMs: number }> = [];
  for (const [section, rows] of bySection.entries()) {
    const top = rows.slice(0, 18);
    const bullets = await llmBulletsFromClaims({ section, claims: top.map((r) => ({ id: r.id, text: r.text })) }).catch(() => []);
    for (const b of bullets) {
      const tMs = Math.max(...top.filter((r) => b.claim_ids.includes(r.id)).map((r) => r.t_end_ms), 0);
      candidates.push({ section, bullet: b, tMs });
    }
  }
  if (!candidates.length) return;

  // Embed all candidate bullets in one batch.
  const texts = candidates.map((c) => c.bullet.text);
  const vecs = await embedTexts(texts, 24).catch(() => []);
  const model = process.env.VERTEX_EMBEDDING_MODEL || "text-embedding-004";

  // Similarity thresholds (cosine; distance = 1 - sim).
  const mergeSim = clamp(Number(process.env.LIVE_ASSISTANT_NOTES_MERGE_SIM ?? 0.92), 0.7, 0.98);
  const subSim = clamp(Number(process.env.LIVE_ASSISTANT_NOTES_SUBBULLET_SIM ?? 0.82), 0.6, mergeSim - 0.02);

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    const v = vecs[i];
    const embedding = v && v.length ? vectorParam(v) : null;
    const section = c.section;
    const text = c.bullet.text.trim();

    // Default: insert as new bullet.
    let parentId: string | null = null;
    let skipInsert = false;
    let mergeIntoId: string | null = null;
    let bestSim = 0;

    if (v && v.length) {
      const match = await admin.rpc("deal_intel_match_meeting_note_bullets", {
        p_meeting_id: args.meetingId,
        p_section: section,
        p_query_embedding: embedding,
        p_k: 10,
      });
      if (!match.error) {
        const rows = (match.data ?? []) as Array<{ id: string; parent_bullet_id: string | null; distance: number }>;
        for (const r of rows) {
          const sim = clamp(1 - Number(r.distance ?? 1), 0, 1);
          if (sim > bestSim) {
            bestSim = sim;
            if (sim >= mergeSim) mergeIntoId = r.id;
            else if (sim >= subSim) parentId = r.id;
          }
        }
      }
    }

    const numeric = hasNumericSignal(text);
    const baseW = categoryWeight(section, args.pref);
    const novelty = 1 - noveltyPenalty(bestSim);
    const prefBoost = clamp(args.pref?.preferenceConfidence ?? 0.6, 0.25, 1);
    const hint = typeof c.bullet.importance_hint === "number" ? clamp(c.bullet.importance_hint, 0, 1) : 0.5;
    const importance = clamp(baseW + 0.35 * numeric + 0.25 * novelty + 0.25 * prefBoost + 0.2 * hint, 0, 3);

    if (mergeIntoId) {
      // Merge: union source claims + bump score + refresh timestamp.
      const cur = await admin.schema("deal_intel").from("meeting_note_bullet").select("id, source_claim_ids, importance_score, t_ms").eq("id", mergeIntoId).maybeSingle();
      if (!cur.error && cur.data) {
        const curIds = Array.isArray((cur.data as { source_claim_ids?: unknown }).source_claim_ids)
          ? ((cur.data as { source_claim_ids?: unknown }).source_claim_ids as unknown[]).map((x) => String(x))
          : [];
        const mergedIds = Array.from(new Set([...curIds, ...c.bullet.claim_ids])).slice(0, 32);
        await admin
          .schema("deal_intel")
          .from("meeting_note_bullet")
          .update({
            source_claim_ids: mergedIds,
            importance_score: Math.max(Number((cur.data as { importance_score?: unknown }).importance_score ?? 0), importance),
            t_ms: Math.max(Number((cur.data as { t_ms?: unknown }).t_ms ?? 0), c.tMs),
            updated_at: new Date().toISOString(),
          })
          .eq("id", mergeIntoId);
      }
      skipInsert = true;
    }

    if (skipInsert) continue;

    const dk = bulletDedupeKey(args.meetingId, section, text);
    await admin.schema("deal_intel").from("meeting_note_bullet").upsert(
      {
        meeting_id: args.meetingId,
        section,
        text,
        t_ms: c.tMs,
        importance_score: importance,
        source_claim_ids: c.bullet.claim_ids,
        parent_bullet_id: parentId,
        embedding,
        embedding_model: model,
        dedupe_key: dk,
      },
      { onConflict: "meeting_id,dedupe_key" },
    );
  }

  const watermark = newClaims.reduce((acc, x) => (String(x.updated_at) > acc ? String(x.updated_at) : acc), lastClaim ?? "1970-01-01T00:00:00.000Z");
  await admin.schema("deal_intel").from("meeting_notes_state").upsert(
    {
      meeting_id: args.meetingId,
      last_notes_tick_at: new Date().toISOString(),
      last_claim_watermark_at: watermark,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "meeting_id" },
  );

  // Background refinement (gated, slow-ish, optional).
  await maybeRefineMeetingNotes(admin, args.meetingId);
}

