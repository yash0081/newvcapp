/**
 * Lite canonical verifier — structured CRM comparison, then one LLM call to summarize.
 *
 * Loads full `fetchDealIntelGroundingPack`, builds a `ClaimComparisonReport` (numeric alignment
 * vs CRM + fact preview), runs `classifyClaimsFromChunk` on the guest chunk, and asks the fast
 * model to summarize using: recent **final** `meeting_transcript_segment` lines (Host/Guest labels),
 * merged host semantic text, and the structured JSON (not free-form CRM invention).
 *
 * Trigger: transcription worker on each guest semantic chunk when `LIVE_ASSISTANT_CANONICAL_VERIFIER=true`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { vertexRunWithText } from "@/lib/vertex";
import { parseJsonFromResponseOrNull, parseJsonFromResponseWithRepair } from "@/lib/gemini";
import { getLiveAssistantModel } from "@/lib/live-assistant/model-env";
import { classifyClaimsFromChunk } from "@/lib/live-assistant/claim-classifier";
import { buildClaimComparisonReport, type ClaimComparisonReport } from "@/lib/live-assistant/claim-comparison";
import {
  fetchDealIntelGroundingPack,
  type DealIntelGroundingPack,
} from "@/lib/live-assistant/deal-intel-grounding";
import { createMeetingAssistantEvent, matchClaimsHybrid, type ClaimHit } from "@/lib/live-assistant/tools";

const FAST = getLiveAssistantModel("fast");

export type LiteCanonicalVerdict = "aligns" | "contradicts" | "new" | "inconclusive";

type EvidenceItem = { text: string; source: string };

export type RunCanonicalClaimVerifyLiteArgs = {
  meeting_id: string;
  deal_id: string;
  user_id: string;
  guest_chunk_id: string;
  guest_text: string;
  guest_t_start_ms: number;
  speaker_label?: string | null;
};

const GROUNDING_TTL_MS = 30_000;
const groundingCacheByDeal = new Map<string, { atMs: number; pack: DealIntelGroundingPack }>();

function normalizeVerdict(v: unknown): LiteCanonicalVerdict {
  const s = String(v ?? "").toLowerCase().trim();
  if (s === "aligns" || s === "contradicts" || s === "new" || s === "inconclusive") return s;
  return "inconclusive";
}

function severityFor(v: LiteCanonicalVerdict): "low" | "med" | "high" {
  if (v === "contradicts") return "high";
  if (v === "new") return "med";
  return "low";
}

function laneFor(v: LiteCanonicalVerdict): "attention" | "context" | "memo" {
  if (v === "contradicts" || v === "new") return "attention";
  if (v === "aligns") return "context";
  return "memo";
}

function normalizeEvidence(raw: unknown): EvidenceItem[] {
  if (!Array.isArray(raw)) return [];
  const out: EvidenceItem[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text.trim() : "";
    const source = typeof o.source === "string" ? o.source.trim() : "";
    if (text && source) out.push({ text: text.slice(0, 400), source: source.slice(0, 60) });
    if (out.length >= 6) break;
  }
  return out;
}

/** Collapse STT/chunk duplicates like "Foo. Foo." */
function dedupeAdjacentSentences(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return t;
  const chunks = t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  if (chunks.length <= 1) return t;
  const out: string[] = [];
  for (const c of chunks) {
    const low = c.toLowerCase().replace(/\s+/g, " ");
    const prev = out.length ? out[out.length - 1]!.toLowerCase().replace(/\s+/g, " ") : "";
    if (prev === low) continue;
    out.push(c);
  }
  return out.join(" ");
}

async function loadGroundingPackCached(admin: SupabaseClient, dealId: string): Promise<DealIntelGroundingPack> {
  const cached = groundingCacheByDeal.get(dealId);
  if (cached && Date.now() - cached.atMs < GROUNDING_TTL_MS) return cached.pack;
  const pack = await fetchDealIntelGroundingPack(admin, dealId);
  groundingCacheByDeal.set(dealId, { atMs: Date.now(), pack });
  return pack;
}

async function loadPairedHostTurn(
  admin: SupabaseClient,
  meetingId: string,
  guestTStartMs: number,
): Promise<{ text: string; gapMs: number | null }> {
  const OVERLAP_SLACK_MS = 2000;
  const MAX_PAIRING_GAP_MS = 25_000;
  /** Host often produces multiple semantic chunks in a row (mic check, then the real question). Pairing only the latest chunk missed earlier prompts — merge chunks whose end times fall in this window. */
  const HOST_LOOKBACK_MS = 90_000;
  const MAX_HOST_CHUNKS = 10;
  if (!Number.isFinite(guestTStartMs) || guestTStartMs <= 0) return { text: "", gapMs: null };

  const windowStart = guestTStartMs - HOST_LOOKBACK_MS;
  const windowEnd = guestTStartMs + OVERLAP_SLACK_MS;

  const res = await admin
    .schema("deal_intel")
    .from("meeting_semantic_chunk")
    .select("text, t_start_ms, t_end_ms")
    .eq("meeting_id", meetingId)
    .like("speaker", "host:%")
    .gte("t_end_ms", windowStart)
    .lte("t_end_ms", windowEnd)
    .order("t_start_ms", { ascending: true });
  if (res.error || !res.data?.length) return { text: "", gapMs: null };

  type Row = { text?: string; t_start_ms?: number; t_end_ms?: number };
  let rows = (res.data ?? []) as Row[];
  rows.sort((a, b) => (Number(a.t_start_ms) || 0) - (Number(b.t_start_ms) || 0));
  if (rows.length > MAX_HOST_CHUNKS) rows = rows.slice(-MAX_HOST_CHUNKS);

  const last = rows[rows.length - 1]!;
  const hostEnd = typeof last.t_end_ms === "number" ? last.t_end_ms : 0;
  const gap = guestTStartMs - hostEnd;
  if (gap > MAX_PAIRING_GAP_MS || gap < -OVERLAP_SLACK_MS) return { text: "", gapMs: gap };

  const raw = rows
    .map((r) => String(r.text ?? "").trim())
    .filter(Boolean)
    .join(" ");
  const text = dedupeAdjacentSentences(raw).slice(0, 1200);
  return { text, gapMs: gap };
}

/** LiveKit `segment_key` is `${participantIdentity}:${startMs}:${endMs}` — first segment names host vs guest. */
function roleLabelFromSegmentKey(segmentKey: string): string {
  const id = String(segmentKey).split(":")[0] ?? "";
  if (id.startsWith("host:")) return "Host";
  if (id.startsWith("guest:")) return "Guest";
  return id.length ? id.slice(0, 48) : "Speaker";
}

/**
 * Raw final transcript lines (append-only revisions deduped) so the LLM sees who said what,
 * not only isolated guest semantic chunks + CRM JSON.
 */
async function loadRecentFinalTranscriptSnippet(
  admin: SupabaseClient,
  meetingId: string,
  anchorTStartMs: number,
): Promise<string> {
  const LOOKBACK_MS = 90_000;
  const FORWARD_MS = 4000;
  const MAX_ROWS = 160;
  if (!Number.isFinite(anchorTStartMs) || anchorTStartMs <= 0) return "";

  const res = await admin
    .schema("deal_intel")
    .from("meeting_transcript_segment")
    .select("segment_key, text, t_start_ms, revision")
    .eq("meeting_id", meetingId)
    .eq("is_final", true)
    .gte("t_start_ms", anchorTStartMs - LOOKBACK_MS)
    .lte("t_start_ms", anchorTStartMs + FORWARD_MS)
    .order("t_start_ms", { ascending: true })
    .limit(MAX_ROWS);

  if (res.error || !res.data?.length) return "";

  type Row = { segment_key?: string; text?: string; t_start_ms?: number; revision?: number };
  const byKey = new Map<string, Row>();
  for (const raw of res.data as Row[]) {
    const k = String(raw.segment_key ?? "");
    if (!k) continue;
    const prev = byKey.get(k);
    const rev = Number(raw.revision ?? 0);
    const prevRev = Number(prev?.revision ?? 0);
    if (!prev || rev >= prevRev) byKey.set(k, raw);
  }

  const merged = [...byKey.values()].sort((a, b) => (Number(a.t_start_ms) || 0) - (Number(b.t_start_ms) || 0));
  const lines: string[] = [];
  for (const r of merged) {
    const t = String(r.text ?? "").trim();
    if (!t) continue;
    lines.push(`${roleLabelFromSegmentKey(String(r.segment_key))}: ${t}`);
  }
  return lines.join("\n").slice(0, 4000);
}

function deterministicVerdictFromReport(r: ClaimComparisonReport): LiteCanonicalVerdict | null {
  const conflicts = r.numeric_rows.filter((x) => x.agreement === "conflicts");
  if (conflicts.length) return "contradicts";
  const aligns = r.numeric_rows.filter((x) => x.agreement === "aligns");
  if (aligns.length && !r.numeric_rows.some((x) => x.agreement === "conflicts")) return "aligns";
  return null;
}

export async function runCanonicalClaimVerifyLite(
  admin: SupabaseClient,
  args: RunCanonicalClaimVerifyLiteArgs,
): Promise<void> {
  const meetingId = String(args.meeting_id ?? "").trim();
  const dealId = String(args.deal_id ?? "").trim();
  const userId = String(args.user_id ?? "").trim();
  const guestChunkId = String(args.guest_chunk_id ?? "").trim();
  let guestTStart = typeof args.guest_t_start_ms === "number" ? args.guest_t_start_ms : 0;
  const guestTextRaw = String(args.guest_text ?? "").trim();
  let guestText = dedupeAdjacentSentences(guestTextRaw).slice(0, 1200);
  if (!meetingId || !dealId || !userId || !guestChunkId) return;

  if (guestTStart <= 0 || guestText.length < 4) {
    const gr = await admin
      .schema("deal_intel")
      .from("meeting_semantic_chunk")
      .select("t_start_ms, text")
      .eq("id", guestChunkId)
      .maybeSingle();
    const gRow = gr.data as { t_start_ms?: number; text?: string } | null;
    if (gRow && typeof gRow.t_start_ms === "number" && gRow.t_start_ms > 0) guestTStart = gRow.t_start_ms;
    if (typeof gRow?.text === "string" && gRow.text.trim()) {
      guestText = dedupeAdjacentSentences(gRow.text.trim()).slice(0, 1200);
    }
  }
  if (!guestText.trim()) return;

  const startedAt = Date.now();

  const [pairedHost, transcriptSnippet, candidateClaims, pack, classifiedClaims] = await Promise.all([
    loadPairedHostTurn(admin, meetingId, guestTStart),
    loadRecentFinalTranscriptSnippet(admin, meetingId, guestTStart),
    matchClaimsHybrid(admin, { userId, dealId, queryText: guestText, limit: 6 }).catch(() => [] as ClaimHit[]),
    loadGroundingPackCached(admin, dealId),
    classifyClaimsFromChunk(guestText).catch(() => []),
  ]);

  const report = buildClaimComparisonReport({
    guestChunkText: guestText,
    claims: classifiedClaims,
    pack,
    priorHits: candidateClaims,
  });

  const lastHostText = pairedHost.text;
  const hostGapMs = pairedHost.gapMs;

  const hostCtxLine = lastHostText
    ? `HOST_SEMANTIC_TEXT (merged host semantic chunks ending before this guest turn): "${lastHostText}"`
    : `(No host semantic chunk paired in this window — check DIAGNOSTIC_TRANSCRIPT below.)`;

  const transcriptBlock =
    transcriptSnippet.trim() ||
    "(No final transcript lines loaded — rely on HOST_SEMANTIC_TEXT and guest excerpt in JSON.)";

  const det = deterministicVerdictFromReport(report);

  const prompt = `You summarize a structured comparison report for a live VC diligence meeting.

Trust order when reasoning about *whether the guest is answering a host question*:
1) DIAGNOSTIC_TRANSCRIPT (verbatim STT, Host/Guest labels from LiveKit participant ids)
2) HOST_SEMANTIC_TEXT
3) guest_chunk_excerpt inside STRUCTURED_COMPARISON_REPORT

Use ONLY these sources plus the JSON — do not invent CRM field values.

DIAGNOSTIC_TRANSCRIPT:
${transcriptBlock}

${hostCtxLine}

STRUCTURED_COMPARISON_REPORT (JSON):
${JSON.stringify(report).slice(0, 14_000)}

Return strict JSON only:
{
  "verdict": "aligns|contradicts|new|inconclusive",
  "summary": "<=1 sentence for the investor",
  "conflicts_with": null | { "fact_path": string|null, "canonical_value": string|null, "claim_quote": string|null },
  "evidence": [{"text":"...", "source":"deal_fact|prior_claim"}]
}

Rules:
- If numeric_rows contains any agreement "conflicts", verdict MUST be "contradicts" and cite the CRM row in conflicts_with / evidence.
- If deterministic numeric alignment already implies contradicts or aligns, you MUST match that verdict.
- "new": substantive factual claim(s) in classified_claims with no CRM anchor in the preview and no numeric conflict. If DIAGNOSTIC_TRANSCRIPT shows a host question that plainly solicits this answer (e.g. CEO name), keep verdict "new" when CRM lacks the field but phrase the summary as **answered the host's question** — do **not** imply unprompted introduction of people or facts.
- "inconclusive": hedged or non-factual, or CRM alignment unclear.
- Keep summary short.`;

  let verdict: LiteCanonicalVerdict = det ?? "inconclusive";
  let summary = "";
  let evidence: EvidenceItem[] = [];
  let conflictsWith: { fact_path: string | null; canonical_value: string | null; claim_quote: string | null } | null =
    null;
  let llmMs = 0;

  try {
    const t0 = Date.now();
    const raw = await vertexRunWithText(FAST, prompt, false);
    llmMs = Date.now() - t0;
    const parsed = (parseJsonFromResponseOrNull(raw) ??
      (await parseJsonFromResponseWithRepair(raw))) as Record<string, unknown> | null;
    if (parsed && typeof parsed === "object") {
      verdict = normalizeVerdict(parsed.verdict);
      if (det === "contradicts" || det === "aligns") verdict = det;
      summary = typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 400) : "";
      evidence = normalizeEvidence(parsed.evidence);
      const cw = parsed.conflicts_with;
      if (cw && typeof cw === "object") {
        const o = cw as Record<string, unknown>;
        conflictsWith = {
          fact_path: o.fact_path == null ? null : String(o.fact_path).slice(0, 200),
          canonical_value: o.canonical_value == null ? null : String(o.canonical_value).slice(0, 400),
          claim_quote: o.claim_quote == null ? null : String(o.claim_quote).slice(0, 400),
        };
      }
    }
  } catch (e) {
    verdict = det ?? "inconclusive";
    summary = det ? "" : "Automatic check failed.";
    console.warn("[canonical-verifier-lite] LLM call failed", e instanceof Error ? e.message : e);
  }

  if (det === "contradicts" && !conflictsWith) {
    const row = report.numeric_rows.find((x) => x.agreement === "conflicts");
    if (row?.record_text) {
      conflictsWith = {
        fact_path: row.metric_key,
        canonical_value: row.record_text,
        claim_quote: guestText.slice(0, 400),
      };
      if (!summary) summary = `Recorded CRM value differs from the figure the guest gave (${row.metric_key}).`;
    }
  }

  const title = verdict === "contradicts" ? "Possible contradiction" : "Claim check";
  const bodyParts: string[] = [];
  if (lastHostText) bodyParts.push(`Host (prompt): "${lastHostText.slice(0, 400)}"`);
  bodyParts.push(`Guest: "${guestText.slice(0, 400)}"`);
  if (summary) bodyParts.push(summary);
  if (verdict === "contradicts" && conflictsWith) {
    const prior =
      conflictsWith.canonical_value ||
      conflictsWith.claim_quote ||
      (conflictsWith.fact_path ? `Fact: ${conflictsWith.fact_path}` : null);
    if (prior) bodyParts.push(`Our records: ${String(prior).slice(0, 260)}`);
  }
  const body = bodyParts.join("\n");

  const dedupeKey = `cclaim_lite:${meetingId}:${guestChunkId}`;

  await createMeetingAssistantEvent(admin, {
    meeting_id: meetingId,
    kind: "claim_verification",
    title,
    severity: severityFor(verdict),
    body,
    source_map: {
      lane: laneFor(verdict),
      canonical: true,
      lite: true,
      dedupe_key: dedupeKey,
      meeting_chunk_id: guestChunkId,
      auto_verdict: verdict,
      auto_summary: summary,
      auto_evidence: evidence,
      conflicts_with: conflictsWith,
      speaker: args.speaker_label ?? null,
      last_host_text: lastHostText || null,
      diagnostic_transcript_snippet: transcriptSnippet.trim().slice(0, 4500) || null,
      guest_text: guestText,
      verify_query: `Verify claim: ${guestText.slice(0, 200)}`,
      comparison_report: report as unknown as Record<string, unknown>,
    },
  });

  console.log("[canonical-verifier-lite]", {
    meeting_id: meetingId,
    guest_chunk_id: guestChunkId,
    verdict,
    deterministic_numeric: det,
    paired_host: Boolean(lastHostText),
    host_gap_ms: hostGapMs,
    prior_claims: candidateClaims.length,
    numeric_rows: report.numeric_rows.length,
    conflicts_numeric: report.numeric_rows.filter((x) => x.agreement === "conflicts").length,
    llm_ms: llmMs,
    total_ms: Date.now() - startedAt,
  });
}
