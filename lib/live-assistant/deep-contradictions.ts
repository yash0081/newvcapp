import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { vertexRunWithText } from "@/lib/vertex";
import { parseJsonFromResponseOrNull, parseJsonFromResponseWithRepair } from "@/lib/gemini";
import { getLiveAssistantModel } from "@/lib/live-assistant/model-env";
import { createMeetingAssistantEvent, getDealContext, matchClaimsHybrid } from "@/lib/live-assistant/tools";
import { upsertMeetingTrackedQuestion } from "@/lib/live-assistant/tracked-questions";
import { contradictionFactDedupeKey, metricFamily } from "@/lib/live-assistant/contradiction";
import { findVerbatimSpan } from "@/lib/live-assistant/quote-grounding";
import { normalizeNumberFromText } from "@/lib/live-assistant/fast-crm-compare";
import { buildClaimContext } from "@/lib/live-assistant/claim-context";
import { formatMemoContradictionBody } from "@/lib/live-assistant/assistant-card-format";

const BIG_MODEL = getLiveAssistantModel("big");

type Section = "solution" | "traction" | "problem";

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function sectionFilter(section: string): section is Section {
  return section === "solution" || section === "traction" || section === "problem";
}

function selectNonAdjacent(items: Array<{ text: string; t_start_ms: number }>, k: number): string[] {
  // Non-adjacent heuristic: take diverse timestamps.
  const sorted = [...items].sort((a, b) => a.t_start_ms - b.t_start_ms);
  if (sorted.length <= k) return sorted.map((x) => x.text);
  const out: string[] = [];
  const step = Math.max(1, Math.floor(sorted.length / k));
  for (let i = 0; i < sorted.length && out.length < k; i += step) out.push(sorted[i]!.text);
  return out;
}

function chunkBelongsToSection(text: string, section: Section): boolean {
  const s = text.toLowerCase();
  if (section === "traction") {
    return (
      /\b(arr|mrr|revenue|growth|customer|churn|runway|burn|funding|raised|valuation|round|investor|logo|users?|retention|nrr|pipeline|acv|gmv)\b/i.test(
        s,
      ) || /\d/.test(s)
    );
  }
  if (section === "solution") {
    return /\b(product|platform|solution|build|feature|api|workflow|integration|tech|deploy|defensibility|patent|moat|pricing)\b/i.test(s);
  }
  if (section === "problem") {
    return /\b(problem|pain|challenge|issue|broken|urgent|tam|workflow|inefficient|cost|legacy|waste)\b/i.test(s);
  }
  return true;
}

const DEEP_DISPLAY_MIN_CONF = Math.max(0.55, Math.min(0.9, Number(process.env.LIVE_ASSISTANT_DEEP_CONTRADICTION_MIN_CONF ?? 0.65)));

export async function runDeepContradictionBatch(admin: SupabaseClient, args: { meetingId: string; dealId: string; userId: string; section: string }) {
  if (!sectionFilter(args.section)) return;

  // Load recent semantic chunks for this meeting.
  const chunksRes = await admin
    .schema("deal_intel")
    .from("meeting_semantic_chunk")
    .select("id, text, t_start_ms")
    .eq("meeting_id", args.meetingId)
    .order("t_start_ms", { ascending: true })
    .limit(200);
  if (chunksRes.error) {
    const msg = chunksRes.error.message || String(chunksRes.error);
    const code = (chunksRes.error as { code?: string }).code;
    if (code === "PGRST205" || msg.includes("schema cache") || msg.includes("does not exist")) {
      console.warn("[deep-contradictions] meeting_semantic_chunk unavailable:", msg);
      return;
    }
    throw chunksRes.error;
  }
  const chunks = (chunksRes.data ?? []) as Array<{ id: string; text: string; t_start_ms: number }>;
  const section = args.section as Section;
  const filtered = chunks.filter((c) => chunkBelongsToSection(c.text, section));
  const pool = filtered.length >= 2 ? filtered : chunks;
  const selected = selectNonAdjacent(
    pool.map((c) => ({ text: c.text, t_start_ms: c.t_start_ms })),
    18,
  );
  if (selected.length < 2) return;

  const [ctx, tractionRes, solutionRes, problemRes] = await Promise.all([
    getDealContext(admin, { userId: args.userId, dealId: args.dealId }),
    admin
      .schema("deal_intel")
      .from("company_traction")
      .select(
        "revenue_data, customer_size_and_count, growth_trends_description, money_raised_per_stage, investor_list, notable_partners_or_customers",
      )
      .eq("deal_id", args.dealId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .schema("deal_intel")
      .from("company_solution")
      .select(
        "general_description, novelty_or_uniqueness, who_are_the_customers, distinguishing_factors, defensibility, patent_ip, proprietary_tech_or_solution",
      )
      .eq("deal_id", args.dealId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    section === "problem"
      ? admin
          .schema("deal_intel")
          .from("company_problem")
          .select("general_problem_description, urgency, tam, sam, som")
          .eq("deal_id", args.dealId)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null as null }),
  ]);

  const canonicalFacts = (ctx.company_facts ?? []).slice(0, 40).map((f) => ({
    fact_path: String((f as { fact_path?: unknown }).fact_path ?? ""),
    canonical_value_text:
      (f as { canonical_value_text?: unknown }).canonical_value_text == null
        ? null
        : String((f as { canonical_value_text?: unknown }).canonical_value_text),
  }));
  const retrieval = await matchClaimsHybrid(admin, {
    userId: args.userId,
    dealId: args.dealId,
    queryText: selected.join("\n").slice(0, 900),
    limit: 22,
  });
  const priorClaims = retrieval.slice(0, 14).map((c) => ({ claim_id: c.id, key: c.key, quote: c.quote, claim_type: c.claim_type }));

  const pack = {
    section: args.section,
    transcript_claims: selected,
    canonical_facts: canonicalFacts,
    prior_claims: priorClaims,
    crm_company_traction: tractionRes.data ?? null,
    crm_company_solution: solutionRes.data ?? null,
    crm_company_problem: problemRes && "data" in problemRes ? problemRes.data : null,
  };
  // IMPORTANT: include latest chunk timestamp so input_hash changes as meeting evolves.
  // Otherwise `selectNonAdjacent` can produce a stable selection and we'd dedupe forever → zero deep cards.
  const inputHash = sha(
    JSON.stringify({
      pack,
      latest_chunk_ms: chunks.at(-1)?.t_start_ms ?? 0,
      chunk_count: chunks.length,
    }),
  ).slice(0, 32);

  // Dedup batch runs.
  const insBatch = await admin
    .schema("deal_intel")
    .from("meeting_contradiction_batch")
    .insert({
      meeting_id: args.meetingId,
      section: args.section,
      window_start_ms: chunks[0]?.t_start_ms ?? 0,
      window_end_ms: chunks.at(-1)?.t_start_ms ?? 0,
      input_hash: inputHash,
      model: BIG_MODEL,
      status: "running",
      error: null,
    })
    .select("id")
    .maybeSingle();
  if (insBatch.error) {
    const code = (insBatch.error as { code?: string }).code;
    const msg = (insBatch.error.message || "").toLowerCase();
    if (code === "23505" || msg.includes("duplicate")) return;
    if (code === "PGRST205" || msg.includes("schema cache")) return;
    throw insBatch.error;
  }
  const batchId = insBatch.data?.id;
  if (!batchId) return;

  const prompt = `You are a VC meeting assistant. Find contradictions only for the active section (${args.section}) among Solution / Traction / Problem.\n\nTask:\n- Compare transcript snippets to canonical facts, prior ingested claims, AND the CRM snapshot fields provided.\n- Output a contradiction ONLY if the founder statement clearly conflicts with our records (quote what we have vs what they said).\n- Include numeric deltas when both sides are numeric.\n- kinds: segment_drift (e.g. SMB vs enterprise), external_claim (customers, investors, partnerships), commitment (strong claims vs records).\n\nOutput ONLY JSON:\n{\n  \"contradictions\": [\n    {\n      \"kind\": \"segment_drift\"|\"external_claim\"|\"commitment\",\n      \"confidence\": 0.0,\n      \"severity\": \"low\"|\"med\"|\"high\",\n      \"founder_quote\": \"...\",\n      \"records_quote\": \"...\"|null,\n      \"why_it_matters\": \"...\"|null,\n      \"suggested_followup_question\": \"...\"|null\n    }\n  ]\n}\n\nInput:\n${JSON.stringify(pack, null, 2)}`;

  try {
    const raw = await vertexRunWithText(BIG_MODEL, prompt, false);
    const parsed = (parseJsonFromResponseOrNull(raw) ?? (await parseJsonFromResponseWithRepair(raw))) as { contradictions?: unknown };
    const arr = Array.isArray(parsed?.contradictions) ? parsed.contradictions : [];

    // Pull recent meeting_claim rows so we can map the model's founder_quote back to the
    // exact persisted utterance and reuse its `cclaim:` dedupe key. When this resolves, the
    // deep card collapses onto the slow / auto-verify card for the same source utterance
    // inside `createMeetingAssistantEvent`'s recent-rows scan.
    const recentClaimsRes = await admin
      .schema("deal_intel")
      .from("meeting_claim")
      .select("id, text, t_start_ms, superseded_by_claim_id")
      .eq("meeting_id", args.meetingId)
      .order("t_start_ms", { ascending: false })
      .limit(120);
    const recentClaims = ((recentClaimsRes.data ?? []) as Array<{
      id: string;
      text: string;
      superseded_by_claim_id: string | null;
    }>).map((r) => ({
      id: String(r.id),
      text: String(r.text ?? "").trim(),
      superseded_by_claim_id: r.superseded_by_claim_id ?? null,
    }));

    // Build a single transcript haystack so we can verify every founder_quote actually came
    // from one of the meeting chunks we sent. The records_quote check uses the JSON-serialized
    // pack (covers traction/solution/problem fields and prior_claims).
    const transcriptHaystack = selected.join("\n");
    const recordsHaystack = JSON.stringify({
      canonical_facts: canonicalFacts,
      prior_claims: priorClaims,
      crm_company_traction: tractionRes.data ?? null,
      crm_company_solution: solutionRes.data ?? null,
      crm_company_problem: problemRes && "data" in problemRes ? problemRes.data : null,
    });

    for (const x of arr) {
    const o = (x && typeof x === "object" ? (x as Record<string, unknown>) : {}) as Record<string, unknown>;
    const kind = String(o.kind ?? "");
    if (!["segment_drift", "external_claim", "commitment"].includes(kind)) continue;
    const conf = clamp01(Number(o.confidence ?? 0));
    if (conf < DEEP_DISPLAY_MIN_CONF) continue;
    const sev = String(o.severity ?? "low");
    const severity: "low" | "med" | "high" = sev === "high" ? "high" : sev === "med" ? "med" : "low";
    const rawFounderQuote = String(o.founder_quote ?? "").trim().slice(0, 600);
    if (!rawFounderQuote) continue;

    // Hard-drop: a deep contradiction whose founder_quote is not actually in any of the
    // selected transcript chunks is the model fabricating a quote to justify a finding.
    const grounded = findVerbatimSpan(transcriptHaystack, rawFounderQuote);
    if (!grounded) continue;
    const founderQuote = grounded.matched.slice(0, 600);

    const rawRecordsQuote = o.records_quote == null ? null : String(o.records_quote).trim().slice(0, 600);
    // Same rule for records_quote when present: must be substring of what we showed the model.
    if (rawRecordsQuote && !findVerbatimSpan(recordsHaystack, rawRecordsQuote)) continue;
    const recordsQuote = rawRecordsQuote;
    const why = o.why_it_matters == null ? null : String(o.why_it_matters).trim().slice(0, 500);
    const follow = o.suggested_followup_question == null ? null : String(o.suggested_followup_question).trim().slice(0, 500);

    const dedupeKey = `deep:${args.meetingId}:${kind}:${sha(founderQuote).slice(0, 14)}`;

    // Persist contradiction row.
    await admin.schema("deal_intel").from("meeting_contradiction").upsert(
      {
        meeting_id: args.meetingId,
        section: args.section,
        kind,
        confidence: conf,
        severity: severity,
        founder_quote: founderQuote,
        records_quote: recordsQuote,
        records_source: { input_hash: inputHash },
        suggested_followup_question: follow,
        explanation_jsonb: { why_it_matters: why },
        dedupe_key: dedupeKey,
      },
      { onConflict: "meeting_id,dedupe_key" },
    );

    // Emit event card (attention lane).
    // Keep deep contradictions independent from fast-lane spam caps.
    // We only cap *deep* cards (and allow a higher default).
    const deepMaxPerMin = Math.max(1, Math.min(40, Number(process.env.LIVE_ASSISTANT_MAX_DEEP_CONTRADICTIONS_PER_MIN || 12)));
    const recentDeep = await admin
      .schema("deal_intel")
      .from("meeting_assistant_event")
      .select("id, source_map")
      .eq("meeting_id", args.meetingId)
      .eq("kind", "contradiction")
      .gte("created_at", new Date(Date.now() - 60_000).toISOString())
      .limit(250);
    if (!recentDeep.error) {
      const rows = (recentDeep.data ?? []) as Array<{ id: string; source_map: unknown }>;
      const deepCount = rows.filter((r) => {
        const sm = r.source_map && typeof r.source_map === "object" ? (r.source_map as Record<string, unknown>) : {};
        const k = typeof sm.kind === "string" ? sm.kind : "";
        return k.startsWith("deep_");
      }).length;
      if (deepCount >= deepMaxPerMin) continue;
    }

    // Resolve which persisted `meeting_claim` this founder_quote came from. Best-effort:
    // exact equality first (case-insensitive), then substring containment in either direction.
    // When this hits, the dedupe key becomes `cclaim:{meetingId}:{claim_id}` — the same key
    // the slow / auto-verify paths use — so duplicate cards for the same utterance collapse.
    const fqLower = founderQuote.toLowerCase().trim();
    let resolvedClaimId: string | null = null;
    let resolvedClaimSuperseded = false;
    if (fqLower.length >= 12) {
      let best: { id: string; len: number; superseded: boolean } | null = null;
      for (const c of recentClaims) {
        if (!c.text) continue;
        const cl = c.text.toLowerCase();
        if (cl === fqLower || cl.includes(fqLower) || fqLower.includes(cl)) {
          const len = c.text.length;
          if (!best || len > best.len) best = { id: c.id, len, superseded: !!c.superseded_by_claim_id };
        }
      }
      if (best) {
        resolvedClaimId = best.id;
        resolvedClaimSuperseded = best.superseded;
      }
    }

    // Honor supersession: when the matcher already replaced this utterance with a
    // corrected one, late deep contradictions on the stale claim are silent. The earlier
    // (correctly emitted) cards stay, but we don't add a new duplicate one minutes later.
    if (resolvedClaimSuperseded) continue;

    // Build claim context when we resolved the founder quote to a persisted claim. This
    // gives us the answering tracked question + inferred topic, so we can drop deep flags
    // whose `records_quote` doesn't share a token with the inferred metric — same anti-
    // hallucination rule as the slow path's fact-path token grounding.
    let resolvedContext: Awaited<ReturnType<typeof buildClaimContext>> | null = null;
    if (resolvedClaimId) {
      try {
        resolvedContext = await buildClaimContext(admin, {
          meetingId: args.meetingId,
          meetingClaimId: resolvedClaimId,
          claimText: founderQuote,
        });
      } catch {
        resolvedContext = null;
      }
    }
    if (
      resolvedContext &&
      resolvedContext.inferredTopic.metricFamily &&
      resolvedContext.inferredTopic.confidence >= 0.6 &&
      recordsQuote
    ) {
      const haystack = [
        founderQuote,
        resolvedContext.inferredTopic.metricFamily,
        resolvedContext.answeringQuestion?.text ?? "",
        resolvedContext.answeringQuestion?.askedSpanText ?? "",
        ...resolvedContext.selfLabels,
      ]
        .join(" \n ")
        .toLowerCase();
      const recordTokens = recordsQuote
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t && t.length >= 4);
      const overlap = recordTokens.some((t) => haystack.includes(t));
      if (!overlap) continue;
    }

    // Use the shared fact-anchored key for the *event card* so it collapses with cards from
    // fast/middle/slow paths for the same fact. Priority order:
    //   1. resolved `meeting_claim_id` (cclaim:) — collapses with auto-verify + slow for the
    //      same utterance regardless of metric extraction.
    //   2. metric family + normalized value (cmetric:) — collapses across paraphrases of the
    //      same number when no claim id resolved.
    //   3. topic-token fallback (ctxt:) — last resort.
    // The DB row above keeps the founder-quote-anchored `deep:` key because
    // `meeting_contradiction.dedupe_key` has its own unique constraint and is intentionally
    // per-quote.
    const parsedFounderNum = normalizeNumberFromText(founderQuote);
    const eventDedupeKey = resolvedClaimId
      ? contradictionFactDedupeKey(args.meetingId, { meetingClaimId: resolvedClaimId })
      : parsedFounderNum
        ? contradictionFactDedupeKey(args.meetingId, {
            metricFamily: metricFamily(founderQuote),
            normalizedValue: parsedFounderNum.value,
            founderQuote,
          })
        : contradictionFactDedupeKey(args.meetingId, { founderQuote });
    const deepBody = formatMemoContradictionBody({
      headline: "Deep path: possible mismatch with CRM or deal records.",
      recordsSnapshot: recordsQuote,
      fieldPath: null,
      whyItMatters: why,
      followUps: follow ? [follow] : [],
      relatedQuestion: resolvedContext?.answeringQuestion?.text ?? null,
    });
    await createMeetingAssistantEvent(admin, {
      meeting_id: args.meetingId,
      kind: "contradiction",
      severity: severity === "high" ? "high" : severity === "med" ? "med" : "low",
      title: "Deep contradiction",
      body: deepBody,
      source_map: {
        lane: "attention",
        kind: `deep_${kind}`,
        meeting_claim_id: resolvedClaimId,
        section: args.section,
        confidence: conf,
        verify_query: `Verify: ${founderQuote.slice(0, 200)}`,
        dedupe_key: eventDedupeKey,
        contradiction_row_dedupe_key: dedupeKey,
        answers_question_id: resolvedContext?.answeringQuestion?.id ?? null,
        metric_family: resolvedContext?.inferredTopic.metricFamily ?? null,
        topic_source: resolvedContext?.inferredTopic.source ?? null,
      },
    });

    if (follow) {
      await upsertMeetingTrackedQuestion(admin, {
        meetingId: args.meetingId,
        text: follow,
        section: args.section,
        importanceWeight: 0.72 + conf * 0.22,
        state: "needs_followup",
        provenance: "contradiction",
        venue: "in_meeting",
        dedupeKey: `deep_tq:${dedupeKey}`,
        metadata: { deep_kind: kind, founder_quote: founderQuote.slice(0, 280) },
      });
    }
    }

    await admin.schema("deal_intel").from("meeting_contradiction_batch").update({ status: "done", error: null }).eq("id", batchId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[deep-contradictions] batch failed", msg);
    await admin
      .schema("deal_intel")
      .from("meeting_contradiction_batch")
      .update({ status: "failed", error: msg.slice(0, 500) })
      .eq("id", batchId);
  }
}

