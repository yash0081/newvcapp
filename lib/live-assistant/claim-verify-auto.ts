import type { SupabaseClient } from "@supabase/supabase-js";
import { vertexRunWithText } from "@/lib/vertex";
import { parseJsonFromResponseOrNull, parseJsonFromResponseWithRepair } from "@/lib/gemini";
import { getLiveAssistantModel } from "@/lib/live-assistant/model-env";
import { getDealContext, createMeetingAssistantEvent } from "@/lib/live-assistant/tools";
import { getRecentDealClaims, getActiveSession } from "@/lib/copilot/db";
import { contradictionFactDedupeKey } from "@/lib/live-assistant/contradiction";
import { formatMemoClaimVerificationBody } from "@/lib/live-assistant/assistant-card-format";
import { buildClaimContext, filterCompactFactsByTopic, isBareNumericClaim } from "@/lib/live-assistant/claim-context";
import { runCanonicalClaimVerify } from "@/lib/live-assistant/claim-verifier";

function envFlag(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v == null) return fallback;
  const s = String(v).toLowerCase().trim();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return fallback;
}

const FAST = getLiveAssistantModel("fast");

export type MeetingClaimAutoVerdict = "aligns" | "contradicts" | "new" | "inconclusive";

function companyNameFromDeal(meta: unknown): string {
  if (!meta || typeof meta !== "object") return "Company";
  const m = meta as Record<string, unknown>;
  return typeof m.company_name === "string" && m.company_name.trim() ? m.company_name.trim() : "Company";
}

function normalizeAutoVerdict(v: unknown): MeetingClaimAutoVerdict {
  const s = String(v ?? "").toLowerCase().trim();
  if (s === "aligns" || s === "contradicts" || s === "new" || s === "inconclusive") return s;
  return "inconclusive";
}

function severityForAutoVerdict(v: MeetingClaimAutoVerdict): "low" | "med" | "high" {
  if (v === "contradicts") return "high";
  if (v === "new") return "med";
  return "low";
}

function laneForAutoVerdict(v: MeetingClaimAutoVerdict): "attention" | "context" | "memo" {
  if (v === "contradicts" || v === "new") return "attention";
  if (v === "aligns") return "context";
  return "memo";
}

type EvidenceItem = { text: string; source: string };

function normalizeEvidence(raw: unknown): EvidenceItem[] {
  if (!Array.isArray(raw)) return [];
  const out: EvidenceItem[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text.trim() : "";
    const source = typeof o.source === "string" ? o.source.trim() : "";
    if (text && source) out.push({ text: text.slice(0, 500), source: source.slice(0, 80) });
    if (out.length >= 8) break;
  }
  return out;
}

export async function runMeetingClaimAutoVerify(
  admin: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<void> {
  // Backward-compat thin delegator: when the canonical verifier is on, any in-flight
  // `meeting_claim_auto_verify` queue rows route to the unified verifier so we never get
  // a "Claim check" card stacked on top of a canonical one. The legacy implementation
  // below stays as the off-by-default path until the canary completes.
  if (envFlag("LIVE_ASSISTANT_CANONICAL_VERIFIER", false)) {
    await runCanonicalClaimVerify(admin, payload);
    return;
  }

  const meetingId = String(payload.meeting_id ?? "");
  const dealId = String(payload.deal_id ?? "");
  const userId = String(payload.user_id ?? "");
  const keysRaw = payload.claim_dedupe_keys;
  const dedupeKeys = Array.isArray(keysRaw) ? [...new Set(keysRaw.map((x) => String(x).trim()).filter(Boolean))] : [];
  if (!meetingId || !dealId || !userId || !dedupeKeys.length) return;

  const ctx = await getDealContext(admin, { userId, dealId });
  const dealRow = ctx.deal && typeof ctx.deal === "object" ? (ctx.deal as Record<string, unknown>) : null;
  const companyName = companyNameFromDeal(dealRow?.metadata);

  const recentDealClaims = await getRecentDealClaims({ admin, dealId, userId, limit: 24 });

  const factsRows = (ctx.company_facts ?? []) as Array<{
    fact_path?: string | null;
    canonical_value_text?: string | null;
    status?: string | null;
  }>;
  const factsCompact = factsRows.slice(0, 80).map((f) => {
    const path = String(f.fact_path ?? "").slice(0, 120);
    const val = String(f.canonical_value_text ?? "").slice(0, 200);
    const st = String(f.status ?? "");
    return path ? `${path}${st ? ` [${st}]` : ""}: ${val}` : val;
  });

  const session = await getActiveSession({ admin, dealId, userId });
  const meta = session && typeof session.metadata === "object" ? (session.metadata as Record<string, unknown>) : {};
  const rawSnips = Array.isArray(meta.acceptedSnippets) ? meta.acceptedSnippets : [];
  const memoSnippets = rawSnips.slice(0, 20).map((s: unknown) => {
    const o = s && typeof s === "object" ? (s as Record<string, unknown>) : {};
    const text = typeof o.text === "string" ? o.text.trim().slice(0, 400) : "";
    const label = typeof o.source_label === "string" ? o.source_label.trim().slice(0, 80) : "";
    return { text, source_label: label || null };
  });

  const mcRes = await admin
    .schema("deal_intel")
    .from("meeting_claim")
    .select("id, text, speaker, confidence, updated_at")
    .eq("meeting_id", meetingId)
    .is("superseded_by_claim_id", null)
    .order("updated_at", { ascending: false })
    .limit(35);
  const meetingClaimsCompact =
    (mcRes.data ?? []).map((r: Record<string, unknown>) => ({
      text: String(r.text ?? "").slice(0, 320),
      speaker: String(r.speaker ?? ""),
      confidence: typeof r.confidence === "number" ? r.confidence : null,
    })) ?? [];

  for (const dk of dedupeKeys) {
    const claimStart = Date.now();
    const cRes = await admin
      .schema("deal_intel")
      .from("meeting_claim")
      .select("id, text, speaker, confidence")
      .eq("meeting_id", meetingId)
      .eq("dedupe_key", dk)
      .maybeSingle();
    if (cRes.error || !cRes.data) continue;
    const claimRow = cRes.data as {
      id: string;
      text: string;
      speaker?: string | null;
      confidence?: number;
      superseded_by_claim_id?: string | null;
    };
    const claimId = String(claimRow.id);
    const claimText = String(claimRow.text ?? "").trim().slice(0, 800);

    // Honor supersession written by the matcher — late auto-verify jobs on a corrected
    // claim should be silent, otherwise the user sees a stale "Claim check" card after
    // they've already heard the corrected answer.
    const supRes = await admin
      .schema("deal_intel")
      .from("meeting_claim")
      .select("superseded_by_claim_id")
      .eq("id", claimId)
      .maybeSingle();
    if ((supRes.data as { superseded_by_claim_id: string | null } | null)?.superseded_by_claim_id) continue;

    // Build context so we can filter facts and tell the LLM what the speaker is talking
    // about. Without this, the LLM saw 80 facts and tended to pick whichever one was
    // numerically closest, even when the speaker meant a different metric.
    const claimContext = await buildClaimContext(admin, {
      meetingId,
      meetingClaimId: claimId,
      claimText,
    });

    // Bare-numeric short-circuit: when the guest just said a number with no anchoring
    // metric ("100 billion dollars") and we have no answering host question and no host
    // prior turn that lexically names a metric, we have nothing useful to verify. Showing
    // a "Claim check: metric family is unknown" card is worse than silence — skip emit.
    if (
      isBareNumericClaim(claimText) &&
      !claimContext.answeringQuestion &&
      claimContext.inferredTopic.source === "unknown"
    ) {
      continue;
    }

    const filteredFactsCompact = filterCompactFactsByTopic(factsCompact, claimContext.inferredTopic, { minKeep: 12 });

    const contextLines: string[] = [];
    if (claimContext.answeringQuestion) {
      contextLines.push(`This claim is the spoken response to tracked question: "${claimContext.answeringQuestion.text.slice(0, 240)}"${claimContext.answeringQuestion.section ? ` (section: ${claimContext.answeringQuestion.section})` : ""}`);
      if (claimContext.answeringQuestion.askedSpanText) {
        contextLines.push(`Host asked aloud: "${claimContext.answeringQuestion.askedSpanText.slice(0, 240)}"`);
      }
    } else if (claimContext.hostPriorText) {
      contextLines.push(`Host's most recent turn: "${claimContext.hostPriorText.slice(0, 200)}"`);
    }
    if (claimContext.selfLabels.length) {
      contextLines.push(`Lexical metric labels in claim: ${claimContext.selfLabels.join(", ")}`);
    }
    contextLines.push(
      claimContext.inferredTopic.metricFamily
        ? `Inferred metric family: ${claimContext.inferredTopic.metricFamily} (source: ${claimContext.inferredTopic.source}, confidence: ${claimContext.inferredTopic.confidence.toFixed(2)})`
        : "Inferred metric family: unknown",
    );

    const promptInputs = {
      company_name: companyName,
      claim_text: claimText,
      meeting_claim_context: meetingClaimsCompact.filter((c) => c.text !== claimText).slice(0, 28),
      deal_crm_claims: recentDealClaims.map((c) => ({ key: c.key ?? null, value: c.value.slice(0, 280), source: c.source ?? null })),
      company_facts: filteredFactsCompact,
      memo_snippets_from_active_research_session: memoSnippets.filter((s) => s.text),
    };

    const prompt = `You compare one spoken claim from an investor meeting against existing deal knowledge.

CLAIM_CONTEXT:
${contextLines.map((l) => `- ${l}`).join("\n")}

Return strict JSON only:
{"verdict":"aligns|contradicts|new|inconclusive","summary":"<=1 sentence","evidence":[{"text":"...","source":"deal_fact|prior_claim|memo_snippet|meeting_claim"}]}

Rules:
- aligns: the claim is consistent with or corroborated by deal CRM claims, company facts, or memo snippets (prefer those sources in evidence).
- contradicts: the claim clearly conflicts with deal CRM claims, company facts, or memo snippets — cite the conflicting knowledge IN THE SAME METRIC FAMILY.
- new: the claim is plausible but not clearly supported or contradicted by the provided deal context (nothing substantive matches).
- inconclusive: insufficient signal (vague claim, OR the metric the claim refers to is unclear/unknown — when CLAIM_CONTEXT inferred metric family is "unknown" AND no \`Host asked aloud:\` line is present, default to inconclusive unless the claim text itself names the metric).
- If a \`Host asked aloud:\` line is present in CLAIM_CONTEXT, treat that verbatim host question as the topic anchor for the spoken claim — even if the inferred metric family confidence is low or null. Use it to disambiguate bare numbers (e.g. host "what's the annual revenue?" + guest "100 billion dollars" → the guest's claim is about revenue). Do NOT return "the metric is unclear" when the host's question clearly names a metric.
- Do NOT infer the metric from the number alone (e.g. do NOT decide that a bare "$215B" means TAM, market size, or quarterly revenue when CLAIM_CONTEXT didn't anchor it).
- Prefer deal CRM claims and company facts over raw meeting_claim lines when reasoning.
- Evidence items must quote or paraphrase the supporting/contradicting context snippet (short).

INPUT:
${JSON.stringify(promptInputs, null, 2)}`;

    let verdict: MeetingClaimAutoVerdict = "inconclusive";
    let summary = "";
    let evidence: EvidenceItem[] = [];
    try {
      const raw = await vertexRunWithText(FAST, prompt, false);
      const parsed = (parseJsonFromResponseOrNull(raw) ??
        (await parseJsonFromResponseWithRepair(raw))) as Record<string, unknown> | null;
      if (parsed && typeof parsed === "object") {
        verdict = normalizeAutoVerdict(parsed.verdict);
        summary = typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 400) : "";
        evidence = normalizeEvidence(parsed.evidence);
      }
    } catch {
      verdict = "inconclusive";
      summary = "Automatic check failed; try Verify when available.";
    }

    const existingStageRes = await admin
      .schema("deal_intel")
      .from("meeting_claim_verification")
      .select("stage")
      .eq("meeting_id", meetingId)
      .eq("claim_id", claimId)
      .maybeSingle();
    const existingStage = existingStageRes.data?.stage != null ? String(existingStageRes.data.stage) : null;
    const preserveResearchStage = existingStage === "research_pending" || existingStage === "research_done";

    const stamp = new Date().toISOString();
    const autoFields = {
      auto_verdict: verdict,
      auto_summary: summary || null,
      auto_evidence: evidence,
      updated_at: stamp,
    };

    let verificationId: string | null = null;
    if (preserveResearchStage) {
      const upd = await admin
        .schema("deal_intel")
        .from("meeting_claim_verification")
        .update(autoFields)
        .eq("meeting_id", meetingId)
        .eq("claim_id", claimId)
        .select("id")
        .maybeSingle();
      verificationId = upd.data && typeof (upd.data as { id?: unknown }).id === "string" ? String((upd.data as { id: string }).id) : null;
    } else {
      const up = await admin
        .schema("deal_intel")
        .from("meeting_claim_verification")
        .upsert(
          {
            meeting_id: meetingId,
            claim_id: claimId,
            stage: "auto_done",
            ...autoFields,
          },
          { onConflict: "meeting_id,claim_id" },
        )
        .select("id")
        .maybeSingle();
      verificationId = up.data && typeof (up.data as { id?: unknown }).id === "string" ? String((up.data as { id: string }).id) : null;
    }

    // Contradictions vs the deal are surfaced by the dedicated contradiction pipeline ("Possible
    // contradiction"). Emitting a parallel claim_verification card with deal:contradicts reads as
    // duplicate noise — especially when the LLM wrongly labeled the same utterance as `new`.
    if (verdict === "contradicts") continue;

    // Cross-kind precedence: if the contradiction pipeline already emitted a card for this
    // utterance (via `cclaim:` dedupe), don't stack a "Claim check" card on top of it. The
    // contradiction card has its own Verify button, so we lose nothing by suppressing here.
    const existingContra = await admin
      .schema("deal_intel")
      .from("meeting_assistant_event")
      .select("id, source_map")
      .eq("meeting_id", meetingId)
      .eq("kind", "contradiction")
      .order("created_at", { ascending: false })
      .limit(80);
    if (!existingContra.error) {
      const matched = (existingContra.data ?? []).some((r) => {
        const sm = (r.source_map && typeof r.source_map === "object" ? (r.source_map as Record<string, unknown>) : {}) as Record<string, unknown>;
        return String(sm.meeting_claim_id ?? "") === claimId;
      });
      if (matched) continue;
    }

    const memoBody = formatMemoClaimVerificationBody({
      summary: summary || claimText.slice(0, 320),
      recordsSnapshot: null,
      relatedQuestion: claimContext.answeringQuestion?.text ?? null,
    });

    // Anchor the dedupe key on the source utterance so a later "Possible contradiction" card
    // for the same `meeting_claim_id` collapses with this one inside `createMeetingAssistantEvent`'s
    // recent-rows scan. Without this, the auto-verify card and the contradiction card had
    // different keys and would coexist on screen.
    const cardDk = contradictionFactDedupeKey(meetingId, { meetingClaimId: claimId });

    await createMeetingAssistantEvent(admin, {
      meeting_id: meetingId,
      kind: "claim_verification",
      title: "Claim check",
      severity: severityForAutoVerdict(verdict),
      body: memoBody || claimText,
      source_map: {
        lane: laneForAutoVerdict(verdict),
        dedupe_key: cardDk,
        meeting_claim_id: claimId,
        claim_id: claimId,
        verification_id: verificationId,
        auto_verdict: verdict,
        auto_summary: summary,
        auto_evidence: evidence,
        speaker: claimRow.speaker ?? null,
        answers_question_id: claimContext.answeringQuestion?.id ?? null,
        answers_question_text: claimContext.answeringQuestion?.text ?? null,
        metric_family: claimContext.inferredTopic.metricFamily,
        topic_source: claimContext.inferredTopic.source,
      },
    });

    // Telemetry log mirroring the canonical verifier so we can compare verdicts side-by-side
    // when running with the canonical flag off.
    console.log("[legacy-auto-verify] verdict", {
      meeting_id: meetingId,
      claim_id: claimId,
      verdict,
      topic_source: claimContext.inferredTopic.source,
      topic_confidence: Number(claimContext.inferredTopic.confidence.toFixed(2)),
      total_ms: Date.now() - claimStart,
    });
  }
}
