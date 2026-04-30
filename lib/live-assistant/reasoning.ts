import type { SupabaseClient } from "@supabase/supabase-js";
import { getDealContext, matchClaimsHybrid, createMeetingAssistantEvent } from "@/lib/live-assistant/tools";
import { verifyContradictions } from "@/lib/live-assistant/contradiction";
import type { ClassifiedClaim } from "@/lib/live-assistant/claim-classifier";
import { fetchDealIntelGroundingPack, groundingPackToSyntheticFacts } from "@/lib/live-assistant/deal-intel-grounding";
import { upsertMeetingTrackedQuestion } from "@/lib/live-assistant/tracked-questions";

const DISPLAY_MIN_CONF = Number(process.env.LIVE_ASSISTANT_CONTRADICTION_DISPLAY_MIN_CONF ?? 0.72);

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export async function runSlowReasoningForClaim(
  admin: SupabaseClient,
  args: {
    meetingId: string;
    userId: string;
    dealId: string;
    claim: ClassifiedClaim;
    sourceText: string;
    preferenceContext?: {
      hints?: string[];
      sectionWeights?: Record<string, number>;
      preferredDomains?: string[];
      confidence?: number;
    };
  },
) {
  const queryText = args.claim.text || args.sourceText;
  const numeric = /\d/.test(queryText) || /\b(one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|million|billion)\b/i.test(queryText);
  const isKpiLike = /\b(arr|mrr|revenue|growth|churn|runway|burn|funding|raised|valuation|round|customers?|users?)\b/i.test(queryText);
  const [ctx, candidates, pack] = await Promise.all([
    getDealContext(admin, { userId: args.userId, dealId: args.dealId }),
    matchClaimsHybrid(admin, { userId: args.userId, dealId: args.dealId, queryText, limit: 18 }),
    fetchDealIntelGroundingPack(admin, args.dealId),
  ]);
  const synthetic = groundingPackToSyntheticFacts(pack);
  const pathSet = new Set(synthetic.map((s) => s.fact_path));
  const extra = (ctx.company_facts ?? [])
    .filter((f) => !pathSet.has(String((f as { fact_path?: unknown }).fact_path ?? "")))
    .slice(0, 40)
    .map((f) => ({
      fact_path: String((f as { fact_path?: unknown }).fact_path ?? ""),
      canonical_value_text:
        (f as { canonical_value_text?: unknown }).canonical_value_text == null
          ? null
          : String((f as { canonical_value_text?: unknown }).canonical_value_text),
    }));
  const canonicalFacts = [...synthetic, ...extra].slice(0, 100).map((f) => ({
    fact_path: f.fact_path,
    canonical_value_text: f.canonical_value_text,
  }));
  const flags = await verifyContradictions({
    new_quote: queryText,
    canonical_facts: canonicalFacts,
    candidate_claims: candidates,
  });
  if (flags.length) {
    for (const f of flags) {
      const conf = clamp01(f.confidence);
      if (conf < DISPLAY_MIN_CONF) continue;
      const prior =
        f.conflicts_with?.canonical_value ||
        f.conflicts_with?.claim_quote ||
        (f.conflicts_with?.fact_path ? `Fact: ${f.conflicts_with.fact_path}` : null) ||
        null;
      const lines: string[] = [];
      lines.push(`Founder said: "${queryText.slice(0, 280)}"`);
      if (prior) lines.push(`Our records: ${String(prior).slice(0, 260)}`);
      if (f.conflicts_with?.fact_path) lines.push(`Field: ${String(f.conflicts_with.fact_path).slice(0, 120)}`);
      if (f.suggested_followup_question) {
        lines.push("");
        lines.push(`Follow-up: ${f.suggested_followup_question}`);
      }
      await createMeetingAssistantEvent(admin, {
        meeting_id: args.meetingId,
        kind: "contradiction",
        severity: f.severity,
        title: "Possible contradiction",
        body: lines.join("\n"),
        source_map: {
          lane: "attention",
          reasoned: true,
          section: args.claim.section,
          intent: args.claim.intent,
          confidence: conf,
          conflicts_with: f.conflicts_with,
          candidates: candidates.slice(0, 6),
          verify_query: `Verify claim: ${queryText.slice(0, 200)}`,
          dedupe_key: `contra:${args.meetingId}:${queryText.toLowerCase().slice(0, 120)}`,
        },
      });
      if (f.suggested_followup_question) {
        const fk = `lev_contra:${args.meetingId}:${String(f.suggested_followup_question).toLowerCase().slice(0, 80)}`;
        await upsertMeetingTrackedQuestion(admin, {
          meetingId: args.meetingId,
          text: String(f.suggested_followup_question).slice(0, 500),
          section: args.claim.section,
          importanceWeight: 0.65 + conf * 0.25,
          state: "needs_followup",
          provenance: "contradiction",
          venue: "in_meeting",
          dedupeKey: fk,
          metadata: { reasoned_contradiction: true, claim_excerpt: queryText.slice(0, 200) },
        });
      }
    }
    return;
  }

  if (candidates.length === 0) {
    // Only emit low-evidence questions for *numeric* KPI-like claims (avoid vague funding prompts).
    if (args.claim.confidence >= 0.42 && numeric && isKpiLike) {
      const dk = `low_ev:${args.meetingId}:${queryText.toLowerCase().slice(0, 100)}`;
      await upsertMeetingTrackedQuestion(admin, {
        meetingId: args.meetingId,
        text: `What substantiates: “${queryText.slice(0, 220)}”?`,
        section: args.claim.section,
        importanceWeight: 0.45 + args.claim.confidence * 0.35,
        state: "unanswered",
        provenance: "low_evidence",
        venue: "in_meeting",
        dedupeKey: dk,
        metadata: { evidence_score: 0.2, reason: "no_crm_claim_hits" },
        syncEvent: { title: "Substantiation", lane: "memo", severity: "low" },
      });
    }
    return;
  }

  const topScore = candidates[0]?.score ?? 0;
  if (topScore < 0.11 && args.claim.confidence >= 0.5 && numeric && isKpiLike) {
    const dk = `low_ev_weak:${args.meetingId}:${queryText.toLowerCase().slice(0, 100)}`;
    await upsertMeetingTrackedQuestion(admin, {
      meetingId: args.meetingId,
      text: `Records only weakly support “${queryText.slice(0, 200)}” — what primary evidence exists?`,
      section: args.claim.section,
      importanceWeight: 0.5,
      state: "unanswered",
      provenance: "low_evidence",
      venue: "in_meeting",
      dedupeKey: dk,
      metadata: { evidence_score: topScore, reason: "weak_retrieval" },
      syncEvent: { title: "Low evidence", lane: "memo", severity: "low" },
    });
  }

  if (candidates.length > 0) {
    const lines: string[] = [];
    lines.push(`Claim: "${queryText.slice(0, 280)}"`);
    if (args.preferenceContext?.hints?.length) {
      lines.push("");
      lines.push(`Preference context: ${args.preferenceContext.hints.slice(0, 2).join(" | ")}`);
    }
    if (args.preferenceContext?.preferredDomains?.length) {
      lines.push(`Preferred domains: ${args.preferenceContext.preferredDomains.slice(0, 3).join(", ")}`);
    }
    lines.push("");
    lines.push("Related prior claims:");
    for (const c of candidates.slice(0, 4)) {
      const where = c.page_number != null ? `p.${c.page_number}` : "doc";
      lines.push(`- (${where}) ${c.quote.slice(0, 220)}`);
    }
    await createMeetingAssistantEvent(admin, {
      meeting_id: args.meetingId,
      kind: "crm_fact",
      severity: "low",
      title: "Related context",
      body: lines.join("\n"),
      source_map: {
        lane: "context",
        reasoned: true,
        section: args.claim.section,
        intent: args.claim.intent,
        candidates: candidates.slice(0, 6),
        preference_context: args.preferenceContext ?? null,
      },
    });
  }
}

