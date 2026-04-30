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

const MODEL = getLiveAssistantModel("fast");

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
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

  for (const it of items) {
    const o = (it && typeof it === "object" ? it : {}) as Record<string, unknown>;
    const founderQuote = String(o.founder_quote ?? "").trim().slice(0, 400);
    if (!founderQuote) continue;
    const conf = clamp01(Number(o.confidence ?? 0));
    if (conf < 0.62) continue;
    const metricLabel = String(o.metric_label ?? "kpi").trim().slice(0, 80);
    let founderNorm = o.founder_normalized == null ? null : Number(o.founder_normalized);
    if (founderNorm != null && !Number.isFinite(founderNorm)) founderNorm = null;
    if (founderNorm == null) {
      const parsedN = normalizeNumberFromText(founderQuote);
      if (parsedN) founderNorm = parsedN.value;
    }
    const recordPresent = Boolean(o.record_present);
    const recordQuote = o.record_quote == null ? null : String(o.record_quote).trim().slice(0, 500);
    const mismatch = Boolean(o.mismatch);
    const gap = o.gap_explanation == null ? null : String(o.gap_explanation).trim().slice(0, 500);

    const family = metricFamily(metricLabel);
    const canonKey =
      founderNorm != null && Number.isFinite(founderNorm)
        ? kpiCanonicalDedupeKey(args.meetingId, family, founderNorm)
        : kpiCanonicalDedupeKey(args.meetingId, family, founderQuote.length);

    const dedupe = `mid:${args.meetingId}:${family}:${canonKey}`;

    const lines: string[] = [];
    lines.push(`Founder said: "${founderQuote}"`);
    if (founderNorm != null && Number.isFinite(founderNorm)) lines.push(`Normalized (middle path): ≈ ${founderNorm}`);
    if (!recordPresent) {
      lines.push("Our records: we do not have this KPI on file (no matching numeric/value in the snapshot).");
    } else if (recordQuote) {
      lines.push(`Our records: ${recordQuote}`);
    }
    if (gap) {
      lines.push("");
      lines.push(gap);
    }
    if (mismatch && recordPresent) {
      lines.push("");
      lines.push("Follow-up: Confirm definition, timeframe, and source.");
    }

    const kind = mismatch && recordPresent ? "contradiction" : "crm_fact";
    const severity = mismatch && recordPresent ? "med" : "low";
    const title = mismatch && recordPresent ? "KPI mismatch (middle path)" : recordPresent ? "KPI vs CRM (middle path)" : "KPI not on record (middle path)";

    await createMeetingAssistantEvent(admin, {
      meeting_id: args.meetingId,
      kind,
      severity,
      title,
      body: lines.join("\n"),
      source_map: {
        lane: mismatch && recordPresent ? "attention" : "context",
        fast_lane: true,
        kind: "kpi_middle_path",
        metric_label: metricLabel,
        confidence: conf,
        record_present: recordPresent,
        mismatch,
        verify_query: `Verify: ${metricLabel} ${founderQuote.slice(0, 120)}`,
        dedupe_key: dedupe,
        parent_dedupe: args.dedupeKey,
      },
    });
  }
}
