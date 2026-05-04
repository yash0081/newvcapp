import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { vertexRunWithText } from "@/lib/vertex";
import { parseJsonFromResponseOrNull, parseJsonFromResponseWithRepair } from "@/lib/gemini";
import { getLiveAssistantModel } from "@/lib/live-assistant/model-env";
import { embedTexts } from "@/lib/vertex-embeddings";
import { vectorParam } from "@/lib/data-layer/shared/vector";
import type { LiveAssistantPreferenceSignals } from "@/lib/live-assistant/preferences";
import { maybeRefineMeetingNotes } from "@/lib/live-assistant/notes-refine";
import {
  extractiveBulletsFromClaims,
  narrowChunkContextForClaim,
  softGroundMemoBullet,
  validateAndRepairBullet,
} from "@/lib/live-assistant/notes-grounding";
import { entailmentGate } from "@/lib/live-assistant/notes-entailment";

const FAST = getLiveAssistantModel("fast");

export type NotesMode = "llm" | "hybrid" | "extractive";

function notesModeFromEnv(): NotesMode {
  const v = process.env.LIVE_ASSISTANT_NOTES_MODE?.trim().toLowerCase();
  if (v === "extractive") return "extractive";
  if (v === "hybrid") return "hybrid";
  return "llm";
}

function entailmentEnabled(): boolean {
  const v = process.env.LIVE_ASSISTANT_NOTES_ENTAILMENT?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

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
  const prompt = `You are taking structured notes for an investor diligence meeting. Section=${args.section}.

Convert the claims below into crisp memo bullets (NOT raw transcript quotes—rewrite as clean 1–2 line bullets an associate would write).

Output JSON only: {\"bullets\":[{\"text\":\"...\",\"claim_ids\":[\"uuid\"],\"importance_hint\":0.0}]}

Rules:
- Each bullet: <= 140 chars preferred; investor memo tone; no dialogue labels (no "Guest:", "Host:").
- Every bullet MUST cite claim_ids that support its facts. Do not invent companies, people, products, or numbers not supported by those cited claims.
- Do NOT mention competitors, competitive positioning, or "vs X" comparisons unless those cited claims explicitly discuss competition—never infer competitors from partnerships, channels, or integrations.
- Merge overlapping claims into one bullet when appropriate.
- Section-aware style:
  - traction / financials: lead with metrics, units, stage signals
  - product / solution: capabilities, differentiation
  - team: roles, backgrounds, hiring
  - problem / market: pain, ICP, sizing if stated

Claims:
${JSON.stringify(payload).slice(0, 12000)}`;
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
    .select("id, text, section_labels, t_end_ms, updated_at, chunk_id")
    .eq("meeting_id", args.meetingId)
    .is("superseded_by_claim_id", null)
    .order("updated_at", { ascending: false })
    .limit(120);
  if (claimsRes.error) return;

  const claims = (claimsRes.data ?? []) as Array<{
    id: string;
    text: string;
    section_labels: string[];
    t_end_ms: number;
    updated_at: string;
    chunk_id: string | null;
  }>;
  const newClaims = lastClaim ? claims.filter((c) => String(c.updated_at) > lastClaim) : claims;
  if (!newClaims.length) {
    await admin.schema("deal_intel").from("meeting_notes_state").upsert(
      { meeting_id: args.meetingId, last_notes_tick_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { onConflict: "meeting_id" },
    );
    return;
  }

  const claimRowsById = new Map<string, { text: string; t_end_ms: number; chunk_id: string | null }>();
  for (const c of newClaims) {
    claimRowsById.set(c.id, { text: c.text, t_end_ms: Number(c.t_end_ms ?? 0), chunk_id: c.chunk_id ?? null });
  }
  const chunkIds = [...new Set(newClaims.map((c) => c.chunk_id).filter((x): x is string => Boolean(x)))];
  const chunkTextById = new Map<string, string>();
  if (chunkIds.length) {
    const chRes = await admin
      .schema("deal_intel")
      .from("meeting_semantic_chunk")
      .select("id, text")
      .eq("meeting_id", args.meetingId)
      .in("id", chunkIds);
    if (!chRes.error && chRes.data) {
      for (const row of chRes.data as Array<{ id: string; text: string }>) {
        chunkTextById.set(String(row.id), String(row.text ?? ""));
      }
    }
  }

  function haystackForClaimIds(ids: string[]): string {
    const parts: string[] = [];
    for (const id of ids) {
      const row = claimRowsById.get(id);
      if (!row) continue;
      parts.push(row.text);
      if (row.chunk_id && chunkTextById.has(row.chunk_id)) {
        const fullChunk = chunkTextById.get(row.chunk_id)!;
        const narrow = narrowChunkContextForClaim(fullChunk, row.text);
        if (narrow) parts.push(narrow);
      }
    }
    return parts.join(" ");
  }

  const bySection = new Map<NoteSection, Array<{ id: string; text: string; t_end_ms: number }>>();
  for (const c of newClaims) {
    const sec = normalizeSection((c.section_labels ?? [])[0] ?? "other");
    const arr = bySection.get(sec) ?? [];
    arr.push({ id: c.id, text: c.text, t_end_ms: Number(c.t_end_ms ?? 0) });
    bySection.set(sec, arr);
  }

  const mode = notesModeFromEnv();
  const doEntail = entailmentEnabled();

  const candidates: Array<{ section: NoteSection; bullet: NoteBullet; tMs: number }> = [];
  for (const [section, rows] of bySection.entries()) {
    const top = rows.slice(0, 18);
    let bullets: NoteBullet[] = [];

    if (mode === "extractive") {
      const ext = extractiveBulletsFromClaims(top.map((r) => ({ id: r.id, text: r.text })));
      bullets = ext.map((e) => ({
        text: e.text,
        claim_ids: e.claim_ids,
        importance_hint: e.importance_hint,
      }));
    } else {
      const llmOut = await llmBulletsFromClaims({
        section,
        claims: top.map((r) => ({ id: r.id, text: r.text })),
      }).catch(() => []);
      // hybrid: same LLM output as default llm path (no transcript concatenation).
      bullets = llmOut.map((b) => {
        const known = b.claim_ids.filter((id) => claimRowsById.has(id));
        return { ...b, claim_ids: known.length ? known : b.claim_ids };
      });
    }

    for (let b of bullets) {
      const knownIds = b.claim_ids.filter((id) => claimRowsById.has(id));
      if (!knownIds.length) continue;
      b = { ...b, claim_ids: knownIds };

      const haystack = haystackForClaimIds(b.claim_ids);
      const grounded =
        mode === "extractive"
          ? validateAndRepairBullet(b.text, haystack)
          : softGroundMemoBullet(b.text, haystack);
      if (!grounded.text) continue;
      let finalText = grounded.text;

      if (doEntail) {
        const ent = await entailmentGate(finalText, haystack);
        if (!ent.ok) {
          if (ent.text) {
            finalText = ent.text;
            const again = mode === "extractive" ? validateAndRepairBullet(finalText, haystack) : softGroundMemoBullet(finalText, haystack);
            if (!again.text) continue;
            finalText = again.text;
          } else {
            continue;
          }
        }
      }

      const tMs = Math.max(...top.filter((r) => b.claim_ids.includes(r.id)).map((r) => r.t_end_ms), 0);
      candidates.push({ section, bullet: { ...b, text: finalText }, tMs });
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

  // Parallelize vector match RPCs (read-only) — was fully sequential and dominated tick latency.
  const matchPacks = await Promise.all(
    candidates.map(async (c, i) => {
      const v = vecs[i];
      const embedding = v && v.length ? vectorParam(v) : null;
      let parentId: string | null = null;
      let mergeIntoId: string | null = null;
      let bestSim = 0;
      if (embedding) {
        const match = await admin.rpc("deal_intel_match_meeting_note_bullets", {
          p_meeting_id: args.meetingId,
          p_section: c.section,
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
      return { mergeIntoId, parentId, bestSim, embedding };
    }),
  );

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    const { mergeIntoId, parentId, bestSim, embedding } = matchPacks[i]!;
    const section = c.section;
    const text = c.bullet.text.trim();
    let skipInsert = false;

    const numericSignal = hasNumericSignal(text);
    const categoryWeightScore = categoryWeight(section, args.pref);
    const noveltyScore = 1 - noveltyPenalty(bestSim);
    const userPreferenceWeight = clamp(args.pref?.preferenceConfidence ?? 0.6, 0.25, 1);
    const hint = typeof c.bullet.importance_hint === "number" ? clamp(c.bullet.importance_hint, 0, 1) : 0.5;
    const importance = clamp(
      categoryWeightScore + 0.35 * numericSignal + 0.25 * noveltyScore + 0.25 * userPreferenceWeight + 0.2 * hint,
      0,
      3,
    );

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
