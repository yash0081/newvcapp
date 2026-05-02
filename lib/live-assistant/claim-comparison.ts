/**
 * Structured CRM vs guest comparison for the lite canonical verifier.
 * Keeps retrieval + numeric alignment out of the LLM; the model only synthesizes a verdict.
 */

import type { ClassifiedClaim } from "@/lib/live-assistant/claim-classifier";
import type { DealIntelGroundingPack } from "@/lib/live-assistant/deal-intel-grounding";
import { groundingPackToSyntheticFacts, recordSnippetForMetric } from "@/lib/live-assistant/deal-intel-grounding";
import { extractFastSignals } from "@/lib/live-assistant/fast-kpi";
import type { ClaimHit } from "@/lib/live-assistant/tools";

export type NumericAgreement = "aligns" | "conflicts" | "silent";

export type ClaimComparisonReport = {
  guest_chunk_excerpt: string;
  numeric_rows: Array<{
    metric_key: string;
    guest_normalized: number | null;
    guest_raw: string;
    record_value: number | null;
    record_text: string | null;
    agreement: NumericAgreement;
    ratio: number | null;
  }>;
  classified_claims: Array<{ text: string; section: string; intent: string }>;
  prior_claims_top: Array<{ id: string; quote: string }>;
  crm_fact_lines_preview: string[];
};

function numericConflictRatio(): number {
  const raw = Number(process.env.LIVE_ASSISTANT_NUMERIC_CONFLICT_RATIO ?? 1.2);
  return Number.isFinite(raw) && raw > 1 ? raw : 1.2;
}

export function buildClaimComparisonReport(args: {
  guestChunkText: string;
  claims: ClassifiedClaim[];
  pack: DealIntelGroundingPack;
  priorHits: ClaimHit[];
}): ClaimComparisonReport {
  const ratioThreshold = numericConflictRatio();
  const alignThreshold = 1.05;

  const metrics = extractFastSignals(args.guestChunkText).metrics.slice(0, 10);
  const numeric_rows: ClaimComparisonReport["numeric_rows"] = [];

  for (const m of metrics) {
    const rec = recordSnippetForMetric(m.key, args.pack);
    let agreement: NumericAgreement = "silent";
    let ratio: number | null = null;
    const gv = m.normalizedValue;
    if (rec && Number.isFinite(rec.recordValue) && Number.isFinite(gv)) {
      const a = Math.abs(rec.recordValue);
      const b = Math.abs(gv);
      const hi = Math.max(a, b);
      const lo = Math.max(Math.min(a, b), 1e-9);
      ratio = hi / lo;
      if (ratio <= alignThreshold) agreement = "aligns";
      else if (ratio >= ratioThreshold) agreement = "conflicts";
      else agreement = "silent";
    }
    numeric_rows.push({
      metric_key: m.key,
      guest_normalized: Number.isFinite(gv) ? gv : null,
      guest_raw: m.rawValue,
      record_value: rec ? rec.recordValue : null,
      record_text: rec ? rec.recordText.slice(0, 260) : null,
      agreement,
      ratio,
    });
  }

  const syn = groundingPackToSyntheticFacts(args.pack).slice(0, 50);
  const crm_fact_lines_preview = syn.map((f) =>
    `${f.fact_path}: ${String(f.canonical_value_text ?? "").slice(0, 180)}`.slice(0, 220),
  );

  return {
    guest_chunk_excerpt: args.guestChunkText.slice(0, 900),
    numeric_rows,
    classified_claims: args.claims.map((c) => ({
      text: c.text.slice(0, 400),
      section: c.section,
      intent: c.intent,
    })),
    prior_claims_top: args.priorHits.slice(0, 6).map((p) => ({
      id: p.id,
      quote: String(p.quote ?? "").slice(0, 280),
    })),
    crm_fact_lines_preview,
  };
}
