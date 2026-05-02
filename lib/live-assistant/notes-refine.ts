import type { SupabaseClient } from "@supabase/supabase-js";
import { vertexRunWithText } from "@/lib/vertex";
import { parseJsonFromResponseOrNull, parseJsonFromResponseWithRepair } from "@/lib/gemini";
import { getLiveAssistantModel } from "@/lib/live-assistant/model-env";
import { embedTexts } from "@/lib/vertex-embeddings";
import { vectorParam } from "@/lib/data-layer/shared/vector";
import { softGroundMemoBullet } from "@/lib/live-assistant/notes-grounding";

const FAST = getLiveAssistantModel("fast");

type Row = {
  id: string;
  section: string;
  text: string;
  parent_bullet_id: string | null;
  importance_score: number;
  source_claim_ids: string[] | null;
};

export async function maybeRefineMeetingNotes(admin: SupabaseClient, meetingId: string): Promise<void> {
  /** Second-pass LLM rewrite is opt-in — avoids extra hallucination surface unless explicitly enabled. */
  const enabled = process.env.LIVE_ASSISTANT_NOTES_REFINE === "1";
  if (!enabled) return;

  const { data: st } = await admin
    .schema("deal_intel")
    .from("meeting_notes_state")
    .select("last_refine_at")
    .eq("meeting_id", meetingId)
    .maybeSingle();
  const lastMs = st?.last_refine_at ? new Date(String(st.last_refine_at)).getTime() : 0;
  if (lastMs && Date.now() - lastMs < 4 * 60_000) return;

  const res = await admin
    .schema("deal_intel")
    .from("meeting_note_bullet")
    .select("id, section, text, parent_bullet_id, importance_score, source_claim_ids")
    .eq("meeting_id", meetingId)
    .is("parent_bullet_id", null)
    .order("importance_score", { ascending: false })
    .order("t_ms", { ascending: false })
    .limit(60);
  if (res.error) return;

  const rows = (res.data ?? []) as Row[];
  if (rows.length < 6) return;

  const allClaimIds = new Set<string>();
  for (const r of rows) {
    for (const id of r.source_claim_ids ?? []) {
      if (id) allClaimIds.add(String(id));
    }
  }
  const claimTextById = new Map<string, string>();
  if (allClaimIds.size) {
    const cr = await admin
      .schema("deal_intel")
      .from("meeting_claim")
      .select("id, text")
      .eq("meeting_id", meetingId)
      .in("id", [...allClaimIds]);
    if (!cr.error && cr.data) {
      for (const row of cr.data as Array<{ id: string; text: string }>) {
        claimTextById.set(String(row.id), String(row.text ?? ""));
      }
    }
  }

  function haystackForBullet(r: Row): string {
    const ids = Array.isArray(r.source_claim_ids) ? r.source_claim_ids.map((x) => String(x)) : [];
    return ids.map((id) => claimTextById.get(id) ?? "").join(" ").trim();
  }

  const grouped = new Map<string, Row[]>();
  for (const r of rows) {
    const sec = String(r.section || "other");
    const arr = grouped.get(sec) ?? [];
    arr.push(r);
    grouped.set(sec, arr);
  }

  for (const [section, secRows] of grouped.entries()) {
    const bullets = secRows.slice(0, 14).map((r) => ({ id: r.id, text: r.text.slice(0, 260) }));
    const prompt = `You are refining investor meeting notes for section=${section}.\nRewrite bullets to be crisp 1-2 lines each, compress redundancy, preserve meaning, do NOT invent new facts.\nReturn JSON only: {\"updates\":[{\"id\":\"uuid\",\"text\":\"...\"}]}\n\nBullets:\n${JSON.stringify(bullets).slice(0, 12000)}`;
    const raw = await vertexRunWithText(FAST, prompt, false);
    const parsed = (parseJsonFromResponseOrNull(raw) ?? (await parseJsonFromResponseWithRepair(raw))) as { updates?: unknown };
    const updates = Array.isArray(parsed?.updates) ? parsed.updates : [];
    const patch: Array<{ id: string; text: string }> = [];
    for (const u of updates) {
      const r = (u && typeof u === "object" ? (u as Record<string, unknown>) : {}) as Record<string, unknown>;
      const id = String(r.id ?? "");
      const text = String(r.text ?? "").trim().slice(0, 320);
      if (!id || !text) continue;
      patch.push({ id, text });
    }
    if (!patch.length) continue;

    const rowById = new Map(secRows.map((r) => [r.id, r]));
    const groundedPatches: Array<{ id: string; text: string }> = [];
    for (const p of patch) {
      const bulletRow = rowById.get(p.id);
      const hay = bulletRow ? haystackForBullet(bulletRow) : "";
      const grounded = hay ? softGroundMemoBullet(p.text, hay) : { text: p.text };
      const finalText = grounded.text;
      if (!finalText) continue;
      groundedPatches.push({ id: p.id, text: finalText });
    }
    if (!groundedPatches.length) continue;

    const model = process.env.VERTEX_EMBEDDING_MODEL || "text-embedding-004";
    const vecs = await embedTexts(groundedPatches.map((x) => x.text), 24).catch(() => []);
    for (let i = 0; i < groundedPatches.length; i++) {
      const v = vecs[i];
      const emb = v && v.length ? vectorParam(v) : null;
      await admin
        .schema("deal_intel")
        .from("meeting_note_bullet")
        .update({ text: groundedPatches[i]!.text, embedding: emb, embedding_model: model, updated_at: new Date().toISOString() })
        .eq("id", groundedPatches[i]!.id);
    }
  }

  await admin
    .schema("deal_intel")
    .from("meeting_notes_state")
    .upsert({ meeting_id: meetingId, last_refine_at: new Date().toISOString(), updated_at: new Date().toISOString() }, { onConflict: "meeting_id" });
}

