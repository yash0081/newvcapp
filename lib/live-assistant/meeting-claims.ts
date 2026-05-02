import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import type { ClassifiedClaim } from "@/lib/live-assistant/claim-classifier";
import { splitClaimTextOnConjunctions } from "@/lib/live-assistant/claim-segmenter";
import { multiLabelSectionsForClaim } from "@/lib/live-assistant/section-labels";
import { embedMeetingClaimTexts } from "@/lib/live-assistant/meeting-embeddings";
import { contradictionBodiesNearDuplicate } from "@/lib/live-assistant/dedupe-contradictions";
import {
  claimSemanticDedupeEnabled,
  claimSemanticDedupeSimThreshold,
} from "@/lib/live-assistant/semantic-assistant-dedupe";
import { cosineSimilarity, parseVectorDim, vectorParam } from "@/lib/data-layer/shared/vector";
import { DEAL_EMBEDDING_DIMENSIONS } from "@/lib/vertex-embeddings";

function dedupeKeyForClaim(meetingId: string, speaker: string, tStart: number, text: string): string {
  const h = createHash("sha256")
    .update(`${meetingId}|${speaker}|${tStart}|${text.toLowerCase().slice(0, 400)}`)
    .digest("hex")
    .slice(0, 24);
  return `mc:${h}`;
}

export type PersistedMeetingClaimRow = {
  id: string;
  dedupe_key: string;
  text: string;
  t_start_ms: number;
  t_end_ms: number;
};

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
): Promise<{ dedupeKeys: string[]; persisted: PersistedMeetingClaimRow[] }> {
  if (!args.claims.length) return { dedupeKeys: [], persisted: [] };
  // Belt-and-suspenders for the worker-level guard: host turns are diligence prompts, not
  // statements to verify. Refuse to write `meeting_claim` rows for host speakers so
  // legacy / future callers can't reintroduce the "host question becomes Claim check" bug.
  if (String(args.speaker ?? "").startsWith("host:")) {
    return { dedupeKeys: [], persisted: [] };
  }
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

  if (!rows.length) return { dedupeKeys: [], persisted: [] };

  const corpusRes = await admin
    .schema("deal_intel")
    .from("meeting_claim")
    .select("text, claim_embedding")
    .eq("meeting_id", args.meetingId)
    .is("superseded_by_claim_id", null)
    .order("updated_at", { ascending: false })
    .limit(80);

  type CorpusRow = { text: string; vec: number[] | null };
  const corpusParsed: CorpusRow[] =
    corpusRes.data?.map((r) => ({
      text: String((r as { text?: string }).text ?? ""),
      vec: parseVectorDim((r as { claim_embedding?: unknown }).claim_embedding, DEAL_EMBEDDING_DIMENSIONS),
    })) ?? [];

  const simTh = claimSemanticDedupeSimThreshold();
  const semOn = claimSemanticDedupeEnabled();

  const acceptedRows: typeof rows = [];
  const acceptedVecs: number[][] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const vec = embeddings[i];

    let dup = false;
    for (const p of corpusParsed) {
      if (p.text && contradictionBodiesNearDuplicate(row.text, p.text)) {
        dup = true;
        break;
      }
    }
    if (!dup) {
      for (const ar of acceptedRows) {
        if (contradictionBodiesNearDuplicate(row.text, ar.text)) {
          dup = true;
          break;
        }
      }
    }

    const vOk = vec && vec.length === DEAL_EMBEDDING_DIMENSIONS ? vec : null;
    if (!dup && semOn && vOk) {
      for (const p of corpusParsed) {
        if (p.vec && cosineSimilarity(vOk, p.vec) >= simTh) {
          dup = true;
          break;
        }
      }
      if (!dup) {
        for (const av of acceptedVecs) {
          if (cosineSimilarity(vOk, av) >= simTh) {
            dup = true;
            break;
          }
        }
      }
    }

    if (dup) continue;
    acceptedRows.push(row);
    if (vOk) acceptedVecs.push(vOk);
  }

  if (!acceptedRows.length) return { dedupeKeys: [], persisted: [] };

  const res = await admin
    .schema("deal_intel")
    .from("meeting_claim")
    .upsert(acceptedRows, {
      onConflict: "meeting_id,dedupe_key",
      ignoreDuplicates: false,
    })
    .select("id, dedupe_key, text, t_start_ms, t_end_ms");
  if (res.error && !String(res.error.message || "").includes("does not exist")) {
    console.error("meeting_claim upsert failed", res.error.message || res.error);
  }

  const persisted = ((res.data ?? []) as PersistedMeetingClaimRow[]).filter((r) => r.id && r.dedupe_key);

  return { dedupeKeys: acceptedRows.map((r) => r.dedupe_key), persisted };
}
