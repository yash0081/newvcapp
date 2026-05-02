import type { SupabaseClient } from "@supabase/supabase-js";
import { vertexRunWithText } from "@/lib/vertex";
import { parseJsonFromResponseOrNull, parseJsonFromResponseWithRepair } from "@/lib/gemini";
import { getLiveAssistantModel } from "@/lib/live-assistant/model-env";
import { createMeetingAssistantEvent } from "@/lib/live-assistant/tools";
import {
  type DealIntelGroundingPack,
  groundingPackToSyntheticFacts,
  kpiCanonicalDedupeKey,
  metricFamily,
} from "@/lib/live-assistant/deal-intel-grounding";
import { normalizeNumberFromText } from "@/lib/live-assistant/fast-crm-compare";
import { contradictionFactDedupeKey } from "@/lib/live-assistant/contradiction";
import { assertGroundedNumber, findVerbatimSpan, labelMatchesQuote } from "@/lib/live-assistant/quote-grounding";
import { buildClaimContext, isBareNumericClaim } from "@/lib/live-assistant/claim-context";
import { formatMemoKpiMiddleBody } from "@/lib/live-assistant/assistant-card-format";

const MODEL = getLiveAssistantModel("fast");

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function envFlag(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v == null) return fallback;
  const s = String(v).toLowerCase().trim();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return fallback;
}

/**
 * When regex fast-path misses a KPI, use a small LLM to extract KPIs from the chunk and compare to DB snapshot.
 */
export async function runKpiMiddlePath(
  admin: SupabaseClient,
  args: {
    meetingId: string;
    dealId: string;
    chunkText: string;
    pack: DealIntelGroundingPack;
    dedupeKey: string;
  },
): Promise<void> {
  const chunk = String(args.chunkText || "").trim().slice(0, 2400);
  if (!chunk || !/\d/.test(chunk)) return;

  // Best-effort: find a recent meeting_claim whose text overlaps this chunk so we can
  // build the same ClaimContext the slow/auto paths use. The middle path runs on chunks
  // with no `meeting_claim_id` directly, but this resolution is enough to (a) honor
  // supersession and (b) require the LLM's metric_label to match the claim's inferred
  // family before we emit a contradiction.
  let resolvedClaimId: string | null = null;
  let resolvedContext: Awaited<ReturnType<typeof buildClaimContext>> | null = null;
  try {
    const recentClaimsRes = await admin
      .schema("deal_intel")
      .from("meeting_claim")
      .select("id, text, t_start_ms, superseded_by_claim_id")
      .eq("meeting_id", args.meetingId)
      .order("t_start_ms", { ascending: false })
      .limit(40);
    const recentClaims = (recentClaimsRes.data ?? []) as Array<{
      id: string;
      text: string;
      superseded_by_claim_id: string | null;
    }>;
    const chunkLower = chunk.toLowerCase();
    let best: { id: string; len: number; superseded: boolean } | null = null;
    for (const c of recentClaims) {
      const t = String(c.text ?? "").trim();
      if (!t || t.length < 12) continue;
      const tl = t.toLowerCase();
      if (chunkLower.includes(tl) || tl.includes(chunkLower.slice(0, Math.min(120, chunkLower.length)))) {
        const len = t.length;
        if (!best || len > best.len) best = { id: String(c.id), len, superseded: !!c.superseded_by_claim_id };
      }
    }
    if (best) {
      // Honor supersession: if this utterance has been superseded, the user already saw
      // the corrected answer card and adding a middle-path KPI mismatch is redundant.
      if (best.superseded) return;
      resolvedClaimId = best.id;
      resolvedContext = await buildClaimContext(admin, {
        meetingId: args.meetingId,
        meetingClaimId: resolvedClaimId,
        claimText: chunk,
      });
    }
  } catch {
    resolvedContext = null;
  }

  // Bare-numeric short-circuit: a chunk that is purely a number with no metric label and
  // no question context is exactly the "$215 billion" hallucination case. Skip emit
  // entirely so the bare-numeric clarify question (slow path) is the only thing the user
  // sees on this utterance.
  if (
    resolvedContext &&
    resolvedContext.inferredTopic.source === "unknown" &&
    isBareNumericClaim(chunk)
  ) {
    return;
  }

  const synthetic = groundingPackToSyntheticFacts(args.pack).slice(0, 80);
  const prompt = `You compare meeting transcript snippets to CRM / deal_intel data for KPI discrepancies.

Transcript chunk:
${chunk}

Our records (paths + text; may be partial):
${JSON.stringify(synthetic, null, 2)}

Return ONLY valid JSON:
{
  "items": [
    {
      "metric_label": "short label e.g. ARR, funding, customers",
      "founder_quote": "short exact phrase from transcript",
      "founder_normalized": number or null (use USD base units for money, 0.2 for 20% if percent),
      "unit": "usd"|"percent"|"count"|"unknown",
      "record_present": boolean,
      "record_quote": string or null (cite which path/field you matched),
      "mismatch": boolean,
      "gap_explanation": string or null (if mismatch: say ours vs theirs; if no record: say not on record),
      "confidence": 0.0-1.0
    }
  ]
}

Rules:
- Only include rows where the transcript clearly states a quantified KPI.
- If you cannot find a matching value in our records, set record_present false and record_quote null.
- mismatch true only if both sides are reasonably specific and conflict.
- Max 4 items.`;

  const raw = await vertexRunWithText(MODEL, prompt, false);
  const parsed = (parseJsonFromResponseOrNull(raw) ?? (await parseJsonFromResponseWithRepair(raw))) as { items?: unknown };
  const items = Array.isArray(parsed?.items) ? parsed.items : [];

  // Build a synthetic-fact lookup so we can verify any LLM-supplied `record_quote` actually
  // came from the snapshot we showed it. Same idea as the deep path.
  const recordsHaystack = JSON.stringify(synthetic);

  for (const it of items) {
    const o = (it && typeof it === "object" ? it : {}) as Record<string, unknown>;
    const rawFounderQuote = String(o.founder_quote ?? "").trim().slice(0, 400);
    if (!rawFounderQuote) continue;
    const conf = clamp01(Number(o.confidence ?? 0));
    if (conf < 0.62) continue;

    // ---- Quote grounding: drop items whose founder_quote isn't actually in this chunk.
    // This is the gate that prevents "$1T funding" from being reported as a "TAM" mention.
    const grounded = findVerbatimSpan(chunk, rawFounderQuote);
    if (!grounded) continue;
    const founderQuote = grounded.matched.slice(0, 400);

    const metricLabel = String(o.metric_label ?? "kpi").trim().slice(0, 80);

    // ---- Label grounding: when the LLM picked a category like "TAM" it must share a token
    // (or known abbreviation expansion) with the matched founder quote. Without this a
    // sentence about funding can be reported under metric_label = "TAM" or "ARR".
    if (!labelMatchesQuote(metricLabel, founderQuote)) continue;

    // ---- Topic gate: when ClaimContext resolved an inferred metric family from the
    // answering question, require the LLM's `metric_label` to map to the SAME family
    // (or to be lexically present in the claim's self-labels). Closes the
    // "TAM contradicts a revenue answer" hallucination at the middle path.
    if (resolvedContext && resolvedContext.inferredTopic.metricFamily && resolvedContext.inferredTopic.confidence >= 0.6) {
      const labelFamily = metricFamily(metricLabel);
      const family = resolvedContext.inferredTopic.metricFamily;
      const labelLower = metricLabel.toLowerCase();
      const selfLabelHit = resolvedContext.selfLabels.some((lab) => labelLower.includes(lab) || lab.includes(labelLower));
      if (labelFamily !== family && !selfLabelHit) continue;
    }

    let founderNorm = o.founder_normalized == null ? null : Number(o.founder_normalized);
    if (founderNorm != null && !Number.isFinite(founderNorm)) founderNorm = null;
    if (founderNorm == null) {
      const parsedN = normalizeNumberFromText(founderQuote);
      if (parsedN) founderNorm = parsedN.value;
    }
    const recordPresent = Boolean(o.record_present);
    const rawRecordQuote = o.record_quote == null ? null : String(o.record_quote).trim().slice(0, 500);
    // Drop items where the LLM cited a `record_quote` that isn't in our snapshot — that
    // means the model invented the "our records say" half of the contradiction.
    if (rawRecordQuote && !findVerbatimSpan(recordsHaystack, rawRecordQuote)) continue;
    const recordQuote = rawRecordQuote;
    let mismatch = Boolean(o.mismatch);
    const gap = o.gap_explanation == null ? null : String(o.gap_explanation).trim().slice(0, 500);

    const family = metricFamily(metricLabel);

    // ---- Number grounding: if the LLM claims a normalized value, it must agree with the
    // numbers actually parseable from the matched founder quote. If the parse disagrees,
    // we keep the card as informational (`crm_fact`) but no longer call it a contradiction.
    if (mismatch && founderNorm != null && !assertGroundedNumber(founderQuote, founderNorm, family)) {
      mismatch = false;
    }
    const canonKey =
      founderNorm != null && Number.isFinite(founderNorm)
        ? kpiCanonicalDedupeKey(args.meetingId, family, founderNorm)
        : kpiCanonicalDedupeKey(args.meetingId, family, founderQuote.length);

    // Stable key per metric family + canonical numeric bucket so this card collapses with the
    // fast/slow/deep emitters for the same fact even when the wording differs ("$5M ARR" vs
    // "five million in revenue"). When founderNorm is unknown we fall back to the family alone.
    const factDk = contradictionFactDedupeKey(args.meetingId, {
      metricFamily: family,
      normalizedValue: founderNorm,
      founderQuote,
    });
    // Local sub-key kept for source_map analytics (per-value bucket within the family).
    const localKey = `mid:${args.meetingId}:${family}:${canonKey}`;

    const isMismatchCard = mismatch && recordPresent;

    const headline = isMismatchCard
      ? `${metricLabel} — possible mismatch with CRM`
      : recordPresent
        ? `${metricLabel} — vs CRM snapshot`
        : `${metricLabel} — not in CRM snapshot`;
    const gapParts = [
      founderNorm != null && Number.isFinite(founderNorm) ? `Normalized ≈ ${founderNorm}` : "",
      !recordPresent ? "Records do not show this KPI (no matching value in snapshot)." : "",
      gap || "",
    ]
      .map((s) => String(s).trim())
      .filter(Boolean);
    const kpiBody = formatMemoKpiMiddleBody({
      headline,
      founderInterpretation: founderQuote.slice(0, 280),
      recordsSnapshot: recordPresent && recordQuote ? recordQuote : null,
      gapNote: gapParts.length ? gapParts.join(" ") : null,
      defaultFollowUp: isMismatchCard,
    });

    // Canonical verifier owns verdicts. The mismatch fact is already encoded in
    // `meeting_kpi_observation` (persisted upstream) and in the chunk text the verifier
    // reads via the dialogue window, so we drop the middle-path contradiction card to
    // avoid stacking on top of the canonical one.
    if (isMismatchCard && envFlag("LIVE_ASSISTANT_CANONICAL_VERIFIER", false)) {
      continue;
    }

    const kind = isMismatchCard ? "contradiction" : "crm_fact";
    const severity = isMismatchCard ? "med" : "low";
    const title = isMismatchCard ? "KPI mismatch (middle path)" : recordPresent ? "KPI vs CRM (middle path)" : "KPI not on record (middle path)";

    // Only contradiction-flavored mid-path cards need the cross-path dedupe; non-mismatch crm_fact
    // cards keep their old per-value local key so distinct KPI captures don't collapse.
    const useFactDedupe = kind === "contradiction";

    await createMeetingAssistantEvent(admin, {
      meeting_id: args.meetingId,
      kind,
      severity,
      title,
      body: kpiBody,
      source_map: {
        lane: mismatch && recordPresent ? "attention" : "context",
        fast_lane: true,
        kind: "kpi_middle_path",
        metric_label: metricLabel,
        metric_family: family,
        confidence: conf,
        record_present: recordPresent,
        mismatch,
        verify_query: `Verify: ${metricLabel} ${founderQuote.slice(0, 120)}`,
        dedupe_key: useFactDedupe ? factDk : localKey,
        local_dedupe_key: localKey,
        parent_dedupe: args.dedupeKey,
        meeting_claim_id: resolvedClaimId,
        answers_question_id: resolvedContext?.answeringQuestion?.id ?? null,
        topic_source: resolvedContext?.inferredTopic.source ?? null,
      },
    });
  }
}
