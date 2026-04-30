import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import type { ClassifiedClaim } from "@/lib/live-assistant/claim-classifier";
import { splitClaimTextOnConjunctions } from "@/lib/live-assistant/claim-segmenter";
import { multiLabelSectionsForClaim } from "@/lib/live-assistant/section-labels";
import { embedMeetingClaimTexts } from "@/lib/live-assistant/meeting-embeddings";
import { vectorParam } from "@/lib/data-layer/shared/vector";

function dedupeKeyForClaim(meetingId: string, speaker: string, tStart: number, text: string): string {
  const h = createHash("sha256")
    .update(`${meetingId}|${speaker}|${tStart}|${text.toLowerCase().slice(0, 400)}`)
    .digest("hex")
    .slice(0, 24);
  return `mc:${h}`;
}

export async function persistClassifiedClaimsForChunk(
  admin: SupabaseClient,
  args: {
    meetingId: string;
    chunkId: string | null;
    speaker: string;
    tStartMs: number;
    tEndMs: number;
    claims: ClassifiedClaim[];
  },
): Promise<void> {
  if (!args.claims.length) return;
  const model = process.env.VERTEX_EMBEDDING_MODEL || "text-embedding-004";
  const rows: Array<{
    meeting_id: string;
    chunk_id: string | null;
    speaker: string;
    text: string;
    t_start_ms: number;
    t_end_ms: number;
    claim_embedding: string | null;
    embedding_model: string;
    confidence: number;
    section_labels: string[];
    raw_classifier_output: Record<string, unknown>;
    dedupe_key: string;
  }> = [];

  const texts: string[] = [];
  const meta: Array<{ claim: ClassifiedClaim; partText: string }> = [];

  for (const claim of args.claims.slice(0, 8)) {
    const parts = splitClaimTextOnConjunctions(claim.text);
    for (const partText of parts) {
      texts.push(partText);
      meta.push({ claim: { ...claim, text: partText }, partText });
    }
  }

  let embeddings: number[][] = [];
  try {
    embeddings = texts.length ? await embedMeetingClaimTexts(texts, 12) : [];
  } catch (e) {
    console.warn("persistClassifiedClaimsForChunk: embed failed", e);
    embeddings = [];
  }

  for (let i = 0; i < meta.length; i++) {
    const { claim, partText } = meta[i]!;
    const emb = embeddings[i];
    rows.push({
      meeting_id: args.meetingId,
      chunk_id: args.chunkId,
      speaker: args.speaker,
      text: partText,
      t_start_ms: args.tStartMs,
      t_end_ms: args.tEndMs,
      claim_embedding: emb && emb.length ? vectorParam(emb) : null,
      embedding_model: model,
      confidence: claim.confidence,
      section_labels: multiLabelSectionsForClaim(claim),
      raw_classifier_output: { intent: claim.intent, primary_section: claim.section },
      dedupe_key: dedupeKeyForClaim(args.meetingId, args.speaker, args.tStartMs, partText),
    });
  }

  if (!rows.length) return;

  const res = await admin.schema("deal_intel").from("meeting_claim").upsert(rows, {
    onConflict: "meeting_id,dedupe_key",
    ignoreDuplicates: false,
  });
  if (res.error && !String(res.error.message || "").includes("does not exist")) {
    console.error("meeting_claim upsert failed", res.error.message || res.error);
  }
}
