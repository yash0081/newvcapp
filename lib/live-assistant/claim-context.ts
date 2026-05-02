import type { SupabaseClient } from "@supabase/supabase-js";
import { metricFamily as metricFamilyFromKey } from "@/lib/live-assistant/deal-intel-grounding";

/**
 * Per-claim context bundle used to constrain every downstream LLM call (auto-verify, slow
 * reasoning, deep contradictions, KPI middle path). Built lazily — never persisted.
 *
 * Why this exists:
 * - Without context, the slow contradiction LLM saw `new_quote = "$215 billion"` plus 100
 *   canonical facts and was free to pick `fact_path = market.tam` because the number was
 *   close. With context, we tell the LLM "this answers a tracked revenue question" and we
 *   pre-filter `canonical_facts` to the revenue family so TAM is never even shown.
 *
 * Topic inference precedence (highest signal first):
 *   1. `answeringQuestion` exists       → derive metric family from question text + section.
 *   2. Lexical metric label in claim    → derive family from the most specific match.
 *   3. Lexical metric label in last     → derive family from the host's recent ask.
 *      host turn before the claim
 *   4. Otherwise                        → unknown; emitters should refuse to flag.
 */
export type ClaimTopicSource = "answering_question" | "self_label" | "host_turn" | "unknown";

export type ClaimContextInferredTopic = {
  metricFamily: string | null;
  factPathPrefixes: string[];
  source: ClaimTopicSource;
  confidence: number;
};

export type ClaimContext = {
  meetingClaimId: string;
  claimText: string;
  answeringQuestion: {
    id: string;
    text: string;
    section: string | null;
    askedSpanText: string | null;
  } | null;
  hostPriorText: string | null;
  selfLabels: string[];
  inferredTopic: ClaimContextInferredTopic;
  /** Forward link maintained by the matcher when this claim corrects an earlier one. */
  supersedesClaimIds: string[];
  /**
   * Meeting-relative start time (ms) for this utterance, healed from `meeting_semantic_chunk`
   * when the claim row still has `t_start_ms = 0` (schema default). Downstream dialogue windows
   * must use this — raw `t_start_ms = 0` makes host-prior / span queries return empty.
   */
  utteranceTStartMs: number | null;
};

/**
 * Family lookup matches `metricFamily(...)` plus a few extra topical buckets that are
 * common in CRM facts (TAM, valuation, headcount). Each value is a list of fact_path
 * substrings — we whitelist a `canonical_facts` row when *any* prefix is a substring of
 * its `fact_path` (case-insensitive). Token-overlap fallback inside the contradiction
 * grounding catches anything the prefix list misses.
 */
const FAMILY_FACT_PATH_PREFIXES: Record<string, string[]> = {
  revenue: ["traction.revenue", "traction.arr", "traction.mrr", "traction.bookings", "traction.gmv", "traction.acv", "company_facts.revenue", "deal_fact_node.revenue", "deal_fact_node.arr", "deal_fact_node.mrr", "claim.ingested"],
  funding: ["traction.funding", "traction.raised", "traction.valuation", "traction.round", "company_facts.funding", "deal_fact_node.funding", "deal_fact_node.raised", "deal_fact_node.valuation"],
  customers: ["traction.customers", "traction.users", "traction.logos", "traction.accounts", "traction.seats", "company_facts.customers", "company_facts.users", "deal_fact_node.customers", "deal_fact_node.users"],
  growth: ["traction.growth", "traction.churn", "traction.retention", "traction.nrr", "traction.grr", "company_facts.growth", "deal_fact_node.growth"],
  runway: ["traction.runway", "traction.burn", "company_facts.runway", "company_facts.burn", "deal_fact_node.runway", "deal_fact_node.burn"],
  headcount: ["traction.headcount", "traction.fte", "traction.employees", "company_facts.headcount", "team.headcount", "deal_fact_node.headcount"],
  tam: ["market.tam", "market.sam", "market.som", "market.size", "company_facts.tam", "deal_fact_node.tam", "deal_fact_node.market"],
};

/** Public so callers (tests, other modules) can re-use the same whitelist. */
export function factPathPrefixesForFamily(family: string | null): string[] {
  if (!family) return [];
  return FAMILY_FACT_PATH_PREFIXES[family] ?? [];
}

const METRIC_LABEL_PATTERNS: Array<{ family: string; re: RegExp }> = [
  { family: "tam", re: /\b(tam|sam|som|addressable\s+market|market\s+size)\b/i },
  { family: "revenue", re: /\b(arr|mrr|annual\s+recurring\s+revenue|monthly\s+recurring\s+revenue|revenue|bookings|gmv|acv|arpa|arpu|top[\s-]?line)\b/i },
  { family: "funding", re: /\b(funding|raise[ds]?|raising|round|valuation|seed|series\s*[a-d])\b/i },
  { family: "customers", re: /\b(customers?|logos?|accounts?|seats?|users?|paid\s+users?|active\s+users?)\b/i },
  { family: "growth", re: /\b(growth\s*rate|growth|churn|nrr|grr|retention|net\s+revenue\s+retention|gross\s+revenue\s+retention)\b/i },
  { family: "runway", re: /\b(runway|burn(?:[\s-]?rate)?|cash\s+out)\b/i },
  { family: "headcount", re: /\b(headcount|fte|employees?|team\s+size)\b/i },
];

/**
 * Pick the most specific metric family lexically present in `text`. Order in
 * METRIC_LABEL_PATTERNS matters: TAM wins over revenue when both could match because the
 * "market size" wording is more specific than the bare "revenue" stem.
 */
/** Exported for canonical verifier dialogue-window fallback when DB timing was wrong. */
export function detectMetricFamilyFromText(text: string): { family: string; label: string } | null {
  if (!text) return null;
  for (const { family, re } of METRIC_LABEL_PATTERNS) {
    const m = text.match(re);
    if (m) return { family, label: m[0].toLowerCase() };
  }
  return null;
}

function collectSelfLabels(claimText: string, chunkText?: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [claimText, chunkText ?? ""]) {
    if (!t) continue;
    for (const { re } of METRIC_LABEL_PATTERNS) {
      const m = t.match(re);
      if (m) {
        const label = m[0].toLowerCase();
        if (!seen.has(label)) {
          seen.add(label);
          out.push(label);
        }
      }
    }
  }
  return out.slice(0, 6);
}

/** Lazy build — every emitter calls this at the start of its per-claim work. */
export async function buildClaimContext(
  admin: SupabaseClient,
  args: { meetingId: string; meetingClaimId: string | null | undefined; claimText: string; chunkText?: string },
): Promise<ClaimContext> {
  const meetingClaimId = String(args.meetingClaimId ?? "").trim();
  const claimText = String(args.claimText ?? "");
  const selfLabels = collectSelfLabels(claimText, args.chunkText);

  let answering: ClaimContext["answeringQuestion"] = null;
  let hostPriorText: string | null = null;
  let supersedes: string[] = [];

  // Most operations require a persisted claim id. Skip silently when missing — the emitter
  // can still call us for self-label / host-turn fallback inference, but the strongest
  // signal (answering question) won't be available.
  let utteranceTStartMs: number | null = null;

  if (meetingClaimId) {
    // Strongest signal: the latest match row that says this claim answers a tracked
    // question. We read the matcher's own `answers_question_id` / `answers_question_text`
    // when it's set (matcher-write-answers-link migration), then fall back to the
    // generic question/claim join.
    const matchRes = await admin
      .schema("deal_intel")
      .from("meeting_question_claim_match")
      .select("question_id, relation, scores, created_at")
      .eq("claim_id", meetingClaimId)
      .in("relation", ["answers", "partial"])
      .order("created_at", { ascending: false })
      .limit(1);
    if (!matchRes.error && matchRes.data?.length) {
      const row = matchRes.data[0] as {
        question_id: string;
        scores: Record<string, unknown> | null;
      };
      const scores = (row.scores && typeof row.scores === "object" ? row.scores : {}) as Record<string, unknown>;
      const qid = typeof scores.answers_question_id === "string" ? scores.answers_question_id : String(row.question_id);
      const qText = typeof scores.answers_question_text === "string" ? scores.answers_question_text : null;
      const hostText = typeof scores.host_asked_text === "string" ? scores.host_asked_text : null;

      // Fetch full question row for section + canonical text when the match scores
      // didn't carry it.
      const qRes = await admin
        .schema("deal_intel")
        .from("meeting_tracked_question")
        .select("id, text, section")
        .eq("id", qid)
        .maybeSingle();
      const qRow = qRes.data as { id: string; text: string; section: string | null } | null;
      if (qRow) {
        answering = {
          id: String(qRow.id),
          text: qText ?? String(qRow.text ?? ""),
          section: qRow.section ?? null,
          askedSpanText: hostText,
        };

        if (!answering.askedSpanText) {
          // Pull the most recent confirmed host-asked span for this question if scores
          // didn't carry the verbatim text.
          const spanRes = await admin
            .schema("deal_intel")
            .from("meeting_question_span")
            .select("text, t_end_ms")
            .eq("meeting_id", args.meetingId)
            .eq("linked_tracked_question_id", qRow.id)
            .eq("confirmed_by_llm", true)
            .order("t_end_ms", { ascending: false })
            .limit(1);
          const sRow = spanRes.data && spanRes.data[0] ? (spanRes.data[0] as { text: string }) : null;
          if (sRow?.text) answering.askedSpanText = String(sRow.text).slice(0, 600);
        }
      }
    }

    // Best-effort: load the persisted claim to get t_start_ms (for prior-host-chunk lookup)
    // and any supersession link the matcher wrote earlier.
    const cRes = await admin
      .schema("deal_intel")
      .from("meeting_claim")
      .select("t_start_ms, superseded_by_claim_id, chunk_id")
      .eq("id", meetingClaimId)
      .maybeSingle();
    const cRow = cRes.data as {
      t_start_ms: number | null;
      superseded_by_claim_id: string | null;
      chunk_id: string | null;
    } | null;
    let tStartMs = cRow && typeof cRow.t_start_ms === "number" ? cRow.t_start_ms : null;
    if (cRow?.superseded_by_claim_id) supersedes = [String(cRow.superseded_by_claim_id)];

    // Heal timing: `t_start_ms` defaults to 0 in the schema; when it was never set, host-prior
    // lookup uses `.lt(t_start_ms, 0)` and returns nothing — we lose the host's question entirely.
    if ((tStartMs == null || tStartMs <= 0) && cRow?.chunk_id) {
      const chRes = await admin
        .schema("deal_intel")
        .from("meeting_semantic_chunk")
        .select("t_start_ms")
        .eq("id", cRow.chunk_id)
        .maybeSingle();
      const chMs =
        chRes.data && typeof (chRes.data as { t_start_ms?: unknown }).t_start_ms === "number"
          ? (chRes.data as { t_start_ms: number }).t_start_ms
          : null;
      if (chMs != null && chMs > 0) tStartMs = chMs;
    }

    utteranceTStartMs = tStartMs != null && tStartMs > 0 ? tStartMs : null;

    if (tStartMs != null && tStartMs > 0) {
      const hostRes = await admin
        .schema("deal_intel")
        .from("meeting_semantic_chunk")
        .select("text, t_start_ms, speaker")
        .eq("meeting_id", args.meetingId)
        .like("speaker", "host:%")
        .lt("t_start_ms", tStartMs)
        .order("t_start_ms", { ascending: false })
        .limit(2);
      if (!hostRes.error && hostRes.data?.length) {
        const rows = hostRes.data as Array<{ text: string }>;
        const joined = rows
          .map((r) => String(r.text ?? "").trim())
          .filter(Boolean)
          .reverse()
          .join(" ")
          .slice(0, 600);
        if (joined) hostPriorText = joined;
      }

      // Q&A bridge: when the matcher hasn't yet linked this claim to a tracked question
      // (it batches on a 4s+ cadence and only fires for questions in the tracked set),
      // synthesize an `answeringQuestion` from the most recent host question span. This
      // is the signal that lets a bare-numeric guest reply ("100 billion dollars") inherit
      // the metric topic from the host's just-spoken question ("what's the annual revenue?").
      if (!answering) {
        const HOST_ASK_WINDOW_MS = 45_000;
        const lo = tStartMs - HOST_ASK_WINDOW_MS;
        const spanRes = await admin
          .schema("deal_intel")
          .from("meeting_question_span")
          .select("text, t_end_ms, linked_tracked_question_id")
          .eq("meeting_id", args.meetingId)
          .gte("t_end_ms", lo)
          .lt("t_end_ms", tStartMs + 500)
          .order("t_end_ms", { ascending: false })
          .limit(1);
        const sp = spanRes.data?.[0] as
          | { text: string; t_end_ms: number; linked_tracked_question_id: string | null }
          | undefined;
        if (sp?.text) {
          const askText = String(sp.text).slice(0, 600);
          answering = {
            id: sp.linked_tracked_question_id ? String(sp.linked_tracked_question_id) : "",
            text: askText,
            section: null,
            askedSpanText: askText,
          };
        } else if (hostPriorText) {
          // Fallback: no detected question span, but the host's last semantic chunk *looks*
          // like an ask (ends with `?` or starts with a wh-/aux word). Treat it as the
          // verbatim question — this catches short host turns Deepgram didn't punctuate.
          const t = hostPriorText.trim();
          const looksAsk = /\?\s*$/.test(t) ||
            /^\s*(what|how|when|where|who|which|why|do|does|did|is|are|can|could|will|would|have|has|tell|describe|explain)\b/i.test(t);
          if (looksAsk && t.length >= 6) {
            const askText = t.slice(0, 600);
            answering = { id: "", text: askText, section: null, askedSpanText: askText };
          }
        }
      }
    }
  }

  const inferredTopic = inferTopic({ claimText, chunkText: args.chunkText, answering, hostPriorText, selfLabels });

  return {
    meetingClaimId: meetingClaimId || "",
    claimText,
    answeringQuestion: answering,
    hostPriorText,
    selfLabels,
    inferredTopic,
    supersedesClaimIds: supersedes,
    utteranceTStartMs,
  };
}

function inferTopic(args: {
  claimText: string;
  chunkText?: string;
  answering: ClaimContext["answeringQuestion"];
  hostPriorText: string | null;
  selfLabels: string[];
}): ClaimContextInferredTopic {
  if (args.answering) {
    const haystack = `${args.answering.text} ${args.answering.askedSpanText ?? ""} ${args.answering.section ?? ""}`;
    const hit = detectMetricFamilyFromText(haystack);
    const fam = hit?.family ?? metricFamilyFromKey(args.answering.section ?? args.answering.text);
    const family = fam && fam !== "metric" ? fam : null;
    if (family) {
      // Synthesized-from-span answers (no tracked-question id) aren't quite as strong as
      // matcher-confirmed links — but a verbatim host question with a metric label is
      // still well above `>= 0.6` gates emitters use, so promote to 0.7+.
      const confidence = args.answering.id ? 0.85 : 0.75;
      return {
        metricFamily: family,
        factPathPrefixes: factPathPrefixesForFamily(family),
        source: "answering_question",
        confidence,
      };
    }
    // Verbatim host ask present but no metric label matched: still a strong dialogue
    // signal (carries the actual host question into the LLM prompt block). We refuse to
    // emit a metric family or fact prefixes (no whitelist filtering), but mark source as
    // `answering_question` so the slow-path bare-numeric short-circuit doesn't fire and
    // the LLM gets to reason with the host's verbatim sentence.
    if (args.answering.askedSpanText && args.answering.askedSpanText.trim().length >= 6) {
      return {
        metricFamily: null,
        factPathPrefixes: [],
        source: "answering_question",
        confidence: 0.7,
      };
    }
  }

  // Bare-numeric guest replies have no in-claim metric label; lexical self-labels only
  // exist if the chunk text accidentally bundled the host's question (rare). For those
  // cases, prefer the host's prior turn over self-labels — the host just told us what
  // metric they were asking about.
  const claimIsBareNumeric = isBareNumericClaim(args.claimText);
  if (claimIsBareNumeric && args.hostPriorText) {
    const hostHit = detectMetricFamilyFromText(args.hostPriorText);
    if (hostHit) {
      return {
        metricFamily: hostHit.family,
        factPathPrefixes: factPathPrefixesForFamily(hostHit.family),
        source: "host_turn",
        confidence: 0.6,
      };
    }
  }

  const selfHit = detectMetricFamilyFromText(`${args.claimText} ${args.chunkText ?? ""}`);
  if (selfHit) {
    return {
      metricFamily: selfHit.family,
      factPathPrefixes: factPathPrefixesForFamily(selfHit.family),
      source: "self_label",
      confidence: 0.6,
    };
  }

  if (args.hostPriorText) {
    const hostHit = detectMetricFamilyFromText(args.hostPriorText);
    if (hostHit) {
      return {
        metricFamily: hostHit.family,
        factPathPrefixes: factPathPrefixesForFamily(hostHit.family),
        source: "host_turn",
        confidence: 0.45,
      };
    }
  }

  return {
    metricFamily: null,
    factPathPrefixes: [],
    source: "unknown",
    confidence: 0,
  };
}

/**
 * Second pass after the dialogue window is loaded: if DB timing/span rows failed but the
 * transcript clearly shows a `[host]:` ask about revenue (etc.) before the guest's answer,
 * infer the metric family so fact filtering + the verifier LLM aren't stuck at "unknown".
 */
export function resolveEffectiveTopicForVerifier(
  ctx: ClaimContext,
  dialogueWindow: string,
): ClaimContextInferredTopic {
  if (ctx.inferredTopic.metricFamily) return ctx.inferredTopic;

  const fromAnswering = ctx.answeringQuestion
    ? detectMetricFamilyFromText(`${ctx.answeringQuestion.askedSpanText ?? ""} ${ctx.answeringQuestion.text}`)
    : null;
  if (fromAnswering) {
    return {
      metricFamily: fromAnswering.family,
      factPathPrefixes: factPathPrefixesForFamily(fromAnswering.family),
      source: "answering_question",
      confidence: Math.max(ctx.inferredTopic.confidence, 0.85),
    };
  }

  if (dialogueWindow.trim()) {
    let lastHost = "";
    for (const line of dialogueWindow.split("\n")) {
      const m = line.match(/^\[host\]:\s*(.+)$/i);
      if (m) lastHost = m[1].trim();
    }
    if (lastHost) {
      const hit = detectMetricFamilyFromText(lastHost);
      if (hit) {
        return {
          metricFamily: hit.family,
          factPathPrefixes: factPathPrefixesForFamily(hit.family),
          source: "host_turn",
          confidence: Math.max(ctx.inferredTopic.confidence, 0.76),
        };
      }
    }
  }

  return ctx.inferredTopic;
}

/** Pre-filter `canonical_facts` (or any path-keyed list) to the topic prefixes when known. */
export function filterFactsByTopic<T extends { fact_path?: string | null }>(
  facts: readonly T[],
  topic: ClaimContextInferredTopic,
  opts?: { minKeep?: number },
): T[] {
  if (!topic.factPathPrefixes.length) return [...facts];
  const minKeep = Math.max(0, opts?.minKeep ?? 10);
  const lowered = topic.factPathPrefixes.map((p) => p.toLowerCase());
  const keep = facts.filter((f) => {
    const path = String(f.fact_path ?? "").toLowerCase();
    if (!path) return false;
    return lowered.some((p) => path.includes(p));
  });
  if (keep.length === 0 && minKeep > 0) return facts.slice(0, minKeep);
  return keep;
}

const COMPACT_FACT_PREFIX_RE = /^(\S+?):/;

/** Same as `filterFactsByTopic` but for the compacted "path: value" strings used by auto-verify. */
export function filterCompactFactsByTopic(
  facts: readonly string[],
  topic: ClaimContextInferredTopic,
  opts?: { minKeep?: number },
): string[] {
  if (!topic.factPathPrefixes.length) return [...facts];
  const minKeep = Math.max(0, opts?.minKeep ?? 10);
  const lowered = topic.factPathPrefixes.map((p) => p.toLowerCase());
  const keep = facts.filter((line) => {
    const m = line.match(COMPACT_FACT_PREFIX_RE);
    const path = (m ? m[1] : "").toLowerCase();
    if (!path) return false;
    return lowered.some((p) => path.includes(p));
  });
  if (keep.length === 0 && minKeep > 0) return facts.slice(0, minKeep);
  return keep;
}

/** Lightweight check used by emitters: is this claim just a number/quantity with no anchor? */
export function isBareNumericClaim(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (t.length > 80) return false;
  return /^\$?\s*[\d.,\s]+(?:\s*(?:k|m|b|thousand|million|billion|trillion))?\s*[\.\!\?]?$/i.test(t);
}

/** Render a short prompt block to inject into LLM calls. Empty when context is unknown. */
export function renderClaimContextPromptBlock(ctx: ClaimContext | null): string {
  if (!ctx) return "";
  const lines: string[] = [];
  if (ctx.answeringQuestion) {
    lines.push(`- This claim is the spoken response to tracked question: "${ctx.answeringQuestion.text.slice(0, 240)}"${ctx.answeringQuestion.section ? ` (section: ${ctx.answeringQuestion.section})` : ""}`);
    if (ctx.answeringQuestion.askedSpanText) {
      lines.push(`- Host asked aloud: "${ctx.answeringQuestion.askedSpanText.slice(0, 240)}"`);
    }
  } else if (ctx.hostPriorText) {
    lines.push(`- Host's most recent turn before this claim: "${ctx.hostPriorText.slice(0, 200)}"`);
  }
  if (ctx.selfLabels.length) {
    lines.push(`- Metric labels lexically present in claim/chunk: ${ctx.selfLabels.join(", ")}`);
  }
  if (ctx.inferredTopic.metricFamily) {
    lines.push(`- Inferred metric family: ${ctx.inferredTopic.metricFamily} (source: ${ctx.inferredTopic.source}, confidence: ${ctx.inferredTopic.confidence.toFixed(2)})`);
  } else {
    lines.push("- Inferred metric family: unknown");
  }
  if (!lines.length) return "";
  return `CLAIM_CONTEXT:\n${lines.join("\n")}\n\nHARD RULES from CLAIM_CONTEXT:\n- Only flag a contradiction when the conflicting fact is in the same metric family as the inferred topic.\n- Do NOT infer the metric from the number alone (e.g. do NOT assume a bare "$215B" means TAM, market size, quarterly revenue, or any unrelated metric).\n- When inferred metric family is "unknown", do not flag any contradictions.`;
}
