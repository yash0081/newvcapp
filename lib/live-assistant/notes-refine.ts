import type { SupabaseClient } from "@supabase/supabase-js";
import { vertexRunWithText } from "@/lib/vertex";
import { parseJsonFromResponseOrNull, parseJsonFromResponseWithRepair } from "@/lib/gemini";
import { getLiveAssistantModel } from "@/lib/live-assistant/model-env";
import { embedTexts } from "@/lib/vertex-embeddings";
import { vectorParam } from "@/lib/data-layer/shared/vector";

const FAST = getLiveAssistantModel("fast");

type Row = { id: string; section: string; text: string; parent_bullet_id: string | null; importance_score: number };

export async function maybeRefineMeetingNotes(admin: SupabaseClient, meetingId: string): Promise<void> {
  const enabled = (process.env.LIVE_ASSISTANT_NOTES_REFINE ?? "1") !== "0";
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
    .select("id, section, text, parent_bullet_id, importance_score")
    .eq("meeting_id", meetingId)
    .is("parent_bullet_id", null)
    .order("importance_score", { ascending: false })
    .order("t_ms", { ascending: false })
    .limit(60);
  if (res.error) return;

  const rows = (res.data ?? []) as Row[];
  if (rows.length < 6) return;

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
    const patch: Array<{ id: string; text: string; embedding: string | null; embedding_model: string }> = [];
    for (const u of updates) {
      const r = (u && typeof u === "object" ? (u as Record<string, unknown>) : {}) as Record<string, unknown>;
      const id = String(r.id ?? "");
      const text = String(r.text ?? "").trim().slice(0, 320);
      if (!id || !text) continue;
      patch.push({ id, text, embedding: null, embedding_model: process.env.VERTEX_EMBEDDING_MODEL || "text-embedding-004" });
    }
    if (!patch.length) continue;

    // Re-embed updated texts (batched).
    const vecs = await embedTexts(patch.map((p) => p.text), 24).catch(() => []);
    for (let i = 0; i < patch.length; i++) {
      const v = vecs[i];
      patch[i]!.embedding = v && v.length ? vectorParam(v) : null;
    }

    for (const p of patch) {
      await admin
        .schema("deal_intel")
        .from("meeting_note_bullet")
        .update({ text: p.text, embedding: p.embedding, embedding_model: p.embedding_model, updated_at: new Date().toISOString() })
        .eq("id", p.id);
    }
  }

  await admin
    .schema("deal_intel")
    .from("meeting_notes_state")
    .upsert({ meeting_id: meetingId, last_refine_at: new Date().toISOString(), updated_at: new Date().toISOString() }, { onConflict: "meeting_id" });
}

