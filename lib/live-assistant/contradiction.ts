import { vertexRunWithText } from "@/lib/vertex";
import { parseJsonFromResponseOrNull, parseJsonFromResponseWithRepair } from "@/lib/gemini";
import type { ClaimHit } from "@/lib/live-assistant/tools";
import { getLiveAssistantModel } from "@/lib/live-assistant/model-env";
import { findVerbatimSpan } from "@/lib/live-assistant/quote-grounding";
import { kpiCanonicalDedupeKey, metricFamily } from "@/lib/live-assistant/deal-intel-grounding";
import type { ClaimContext } from "@/lib/live-assistant/claim-context";
import { renderClaimContextPromptBlock } from "@/lib/live-assistant/claim-context";

const BIG_MODEL = getLiveAssistantModel("big");

// Stop-words for contradiction topic-token fallback. Keep small; we want this deterministic
// and language-agnostic enough to keep useful tokens like "enterprise", "customers", "ARR".
const CONTRADICTION_TOPIC_STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "with", "that", "this", "have", "has", "had", "are", "was", "were", "but",
  "from", "into", "about", "they", "them", "their", "our", "your", "you", "yours", "ours", "its",
  "his", "her", "him", "she", "what", "which", "than", "then", "also", "just", "very", "much",
  "many", "more", "most", "some", "any", "all", "we", "us", "i", "me", "my", "be", "is", "of",
  "in", "on", "at", "to", "by", "as", "or", "if", "so", "do", "did", "does", "done", "been",
  "will", "would", "could", "should", "can", "cant", "wont", "didnt", "wasnt", "isnt", "got",
]);

function normalizeFactPathFragment(path: string): string {
  return path.toLowerCase().replace(/\s+/g, "_").slice(0, 80);
}

function topicTokensFromQuote(quote: string): string {
  if (!quote) return "_";
  const tokens = quote
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !CONTRADICTION_TOPIC_STOPWORDS.has(t));
  if (!tokens.length) return "_";
  // Sort + dedupe to make the key independent of restated word order.
  const uniq = [...new Set(tokens)].sort();
  return uniq.slice(0, 6).join("_").slice(0, 60);
}

export type ContradictionAnchor = {
  /**
   * `meeting_claim.id` for the spoken utterance that triggered this contradiction. When set
   * this becomes the canonical dedupe anchor — every card emitted off the same utterance
   * (auto-verify "new info", slow "Possible contradiction", deep "Deep contradiction" when
   * we can resolve a claim id) collapses to one row regardless of metric extraction.
   */
  meetingClaimId?: string | null;
  factPath?: string | null;
  metricFamily?: string | null;
  /**
   * Normalized numeric value for the fact (USD base units, ratio for percent, raw for count).
   * When provided alongside `metricFamily`, the dedupe key collapses across all paraphrases of
   * the same number — e.g. "$5M ARR" from the fast path and "five million in revenue" from
   * the middle path will hash to the same `cmetric:{family}:{bucket}` key.
   */
  normalizedValue?: number | null;
  /** CRM `claim_id` (deal-side prior claim that the spoken utterance conflicts with). */
  claimId?: string | null;
  founderQuote?: string | null;
};

/**
 * Cross-path stable key for a contradiction so the fast/middle/slow/deep emitters all collapse
 * onto a single `meeting_assistant_event` for the same underlying fact. Anchored, in priority
 * order:
 *   1. spoken-utterance `meeting_claim_id`        (cclaim: — primary; collapses all kinds emitted
 *                                                  off the same utterance, regardless of metric
 *                                                  extraction success)
 *   2. canonical `fact_path`                      (cfact: — when no claim id is in scope)
 *   3. CRM `claim_id`                             (ccrm:  — deal-side claim being contradicted)
 *   4. metric family + 3-sig-fig value bucket     (cmetric: — fast/middle/deep numerics)
 *   5. metric family alone                        (cmetric: — fallback when value unknown)
 *   6. normalized topic tokens                    (ctxt: — last resort, non-numeric)
 *
 * Used as `source_map.dedupe_key` so `createMeetingAssistantEvent`'s recent-rows dedupe in
 * `lib/live-assistant/tools.ts` short-circuits cross-path duplicates without new infra.
 */
export function contradictionFactDedupeKey(meetingId: string, anchor: ContradictionAnchor): string {
  if (anchor.meetingClaimId && anchor.meetingClaimId.trim()) {
    return `cclaim:${meetingId}:${anchor.meetingClaimId.trim().slice(0, 60)}`;
  }
  if (anchor.factPath && anchor.factPath.trim()) {
    return `cfact:${meetingId}:${normalizeFactPathFragment(anchor.factPath.trim())}`;
  }
  if (anchor.claimId && anchor.claimId.trim()) {
    return `ccrm:${meetingId}:${anchor.claimId.trim().slice(0, 60)}`;
  }
  if (anchor.metricFamily && anchor.metricFamily.trim()) {
    const fam = anchor.metricFamily.toLowerCase().trim().slice(0, 60);
    if (anchor.normalizedValue != null && Number.isFinite(anchor.normalizedValue)) {
      const bucket = kpiCanonicalDedupeKey(meetingId, fam, anchor.normalizedValue);
      return `cmetric:${meetingId}:${fam}:${bucket}`;
    }
    return `cmetric:${meetingId}:${fam}`;
  }
  return `ctxt:${meetingId}:${topicTokensFromQuote(anchor.founderQuote ?? "")}`;
}

/** Re-export so callers don't need a separate import for the family classifier. */
export { metricFamily };

/**
 * Slow-path analog of `labelMatchesQuote`. Splits `fact_path` (e.g. `traction.arr`,
 * `market.tam`, `company_facts.revenue`) into its leaf tokens and confirms that at least
 * one token (or a known abbreviation expansion) appears in the claim text, the answering
 * question text, or the inferred topic family/labels. Returns true when no `ctx` is
 * available so we don't break legacy callers that pass no context.
 */
function factPathLexicallyMatchesClaim(factPath: string, claimText: string, ctx: ClaimContext | null): boolean {
  if (!factPath) return true;
  const leaves = factPath
    .toLowerCase()
    .split(/[._\-/]+/)
    .map((t) => t.trim())
    .filter((t) => t && t.length >= 2 && !["the", "and", "for", "of", "in"].includes(t));
  if (!leaves.length) return true;

  const haystackParts: string[] = [];
  if (claimText) haystackParts.push(claimText.toLowerCase());
  if (ctx?.answeringQuestion?.text) haystackParts.push(ctx.answeringQuestion.text.toLowerCase());
  if (ctx?.answeringQuestion?.askedSpanText) haystackParts.push(ctx.answeringQuestion.askedSpanText.toLowerCase());
  if (ctx?.hostPriorText) haystackParts.push(ctx.hostPriorText.toLowerCase());
  if (ctx?.inferredTopic.metricFamily) haystackParts.push(ctx.inferredTopic.metricFamily.toLowerCase());
  for (const lab of ctx?.selfLabels ?? []) haystackParts.push(lab.toLowerCase());
  const hay = haystackParts.join(" \n ");
  if (!hay) return true;

  for (const tok of leaves) {
    if (hay.includes(tok)) return true;
    // Common expansions so leaf "tam" passes when the claim says "addressable market", etc.
    if (tok === "tam" && (hay.includes("addressable") || hay.includes("market size"))) return true;
    if (tok === "arr" && (hay.includes("annual recurring") || hay.includes("revenue"))) return true;
    if (tok === "mrr" && (hay.includes("monthly recurring") || hay.includes("revenue"))) return true;
    if (tok === "revenue" && (hay.includes("arr") || hay.includes("mrr") || hay.includes("top line"))) return true;
    if (tok === "customers" && (hay.includes("logos") || hay.includes("accounts") || hay.includes("users"))) return true;
    if (tok === "headcount" && (hay.includes("employees") || hay.includes("team size") || hay.includes("fte"))) return true;
  }
  return false;
}

/** Minimum model confidence to surface a contradiction card (aligns with prompt rules). */
const _rawMinConf = Number(process.env.DEAL_INTEL_CONTRADICTION_MIN_CONFIDENCE ?? 0.55);
const MIN_CONTRADICTION_CONFIDENCE = Number.isFinite(_rawMinConf)
  ? Math.min(0.95, Math.max(0.35, _rawMinConf))
  : 0.55;

export type ContradictionSeverity = "low" | "med" | "high";

export type ContradictionFlag = {
  quote: string;
  conflicts_with: {
    fact_path?: string | null;
    canonical_value?: string | null;
    claim_id?: string | null;
    claim_quote?: string | null;
  };
  severity: ContradictionSeverity;
  confidence: number; // 0..1
  suggested_followup_question?: string | null;
};

export function shouldAttemptContradiction(deltaText: string): boolean {
  const s = (deltaText || "").toLowerCase();
  if (!s.trim()) return false;

  // Numbers / units / dates
  if (/\d/.test(s)) return true;
  if (/\b(arr|mrr|revenue|runway|churn|cac|ltv|gm|gross margin|burn|customers?|users?)\b/.test(s)) return true;

  // Commitments / future assertions
  if (/\b(will|plan to|committed|launch|raise|ship by|guarantee|we have|we are at)\b/.test(s)) return true;

  return false;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function isSeverity(s: string): s is ContradictionSeverity {
  return ["low", "med", "high"].includes(s);
}

/**
 * Verify contradictions between new transcript text and a small set of candidates.
 * This intentionally does NOT do retrieval; call `matchClaimsHybrid` and supply candidates.
 *
 * When `context` is provided, the prompt is constrained by the inferred metric topic and
 * any LLM flag whose `fact_path` does not share a token with the claim/question/inferred
 * topic is dropped (analog of `labelMatchesQuote` for the slow path).
 */
export async function verifyContradictions(opts: {
  new_quote: string;
  canonical_facts: Array<{ fact_path: string; canonical_value_text: string | null }>;
  candidate_claims: ClaimHit[];
  context?: ClaimContext | null;
}): Promise<ContradictionFlag[]> {
  const newQuote = String(opts.new_quote || "").trim().slice(0, 1200);
  if (!newQuote) return [];

  const ctx = opts.context ?? null;
  const contextBlock = renderClaimContextPromptBlock(ctx);

  const facts = (opts.canonical_facts ?? []).slice(0, 40).map((f) => ({
    fact_path: f.fact_path,
    canonical_value_text: f.canonical_value_text,
  }));
  const claims = (opts.candidate_claims ?? []).slice(0, 25).map((c) => ({
    claim_id: c.id,
    key: c.key,
    claim_type: c.claim_type,
    quote: c.quote,
  }));

  const prompt = `You are a meeting assistant that flags contradictions conservatively.\n\n${contextBlock ? `${contextBlock}\n\n` : ""}Task:\n- Compare the NEW transcript quote against the canonical facts and prior claims (includes CRM traction/solution/problem snapshots, deal_fact_node paths, and ingested claims).\n- For KPIs (ARR, revenue, funding, customers, growth, etc.): if nothing in the facts list clearly matches, do NOT invent a conflict—treat as no conflicting record.\n- Return contradiction flags ONLY when you believe there is a real mismatch with a specific fact or prior claim.\n- Prefer precision over recall.\n\nOutput ONLY valid JSON (no markdown) with this shape:\n{\n  \"flags\": [\n    {\n      \"quote\": string,\n      \"conflicts_with\": {\n        \"fact_path\"?: string|null,\n        \"canonical_value\"?: string|null,\n        \"claim_id\"?: string|null,\n        \"claim_quote\"?: string|null\n      },\n      \"severity\": \"low\"|\"med\"|\"high\",\n      \"confidence\": number,\n      \"suggested_followup_question\"?: string|null\n    }\n  ]\n}\n\nRules:\n- If the NEW quote is vague, do not flag.\n- If multiple candidates are related but not clearly conflicting, do not flag.\n- Only flag if confidence >= ${MIN_CONTRADICTION_CONFIDENCE}.\n\nNEW quote:\n${newQuote}\n\nCanonical facts:\n${JSON.stringify(facts, null, 2)}\n\nCandidate prior claims:\n${JSON.stringify(claims, null, 2)}`;

  const text = await vertexRunWithText(BIG_MODEL, prompt, false);
  const parsed = (parseJsonFromResponseOrNull(text) ?? (await parseJsonFromResponseWithRepair(text))) as {
    flags?: unknown;
  };

  // Build fact + claim lookup so we can reject any LLM-invented `fact_path` / `claim_id` / `claim_quote`.
  const knownFactPaths = new Set(facts.map((f) => f.fact_path));
  const knownClaimIds = new Set(claims.map((c) => c.claim_id));
  const claimQuotesText = claims.map((c) => c.quote).join("\n");

  const rawFlags = Array.isArray(parsed?.flags) ? parsed.flags : [];
  const out: ContradictionFlag[] = [];
  for (const f of rawFlags) {
    const obj = f as Partial<ContradictionFlag> & { conflicts_with?: unknown };
    const conf = clamp01(typeof obj.confidence === "number" ? obj.confidence : 0);
    if (conf < MIN_CONTRADICTION_CONFIDENCE) continue;
    const sev = typeof obj.severity === "string" && isSeverity(obj.severity) ? obj.severity : "low";
    const cw = (obj.conflicts_with && typeof obj.conflicts_with === "object" ? obj.conflicts_with : {}) as Record<
      string,
      unknown
    >;

    // ---- Quote grounding: reject flags whose `quote` doesn't actually appear in the
    // transcript. The model is encouraged to copy verbatim, but it sometimes paraphrases
    // or fabricates a quote that fits its theory. Using the matched substring (rather
    // than the LLM string) also keeps the user-facing card honest.
    const llmQuote = String(obj.quote ?? "").trim();
    const grounded = llmQuote ? findVerbatimSpan(newQuote, llmQuote) : { matched: newQuote };
    if (!grounded) continue;

    // ---- Fact path / claim grounding: drop anything that points to a fact_path the
    // model invented or a claim_id we never sent it. Allowed to be null/empty.
    const rawFactPath = cw.fact_path == null ? null : String(cw.fact_path);
    const factPath = rawFactPath && knownFactPaths.has(rawFactPath) ? rawFactPath : null;
    if (rawFactPath && !factPath) continue;

    const rawClaimId = cw.claim_id == null ? null : String(cw.claim_id);
    const claimId = rawClaimId && knownClaimIds.has(rawClaimId) ? rawClaimId : null;
    if (rawClaimId && !claimId) continue;

    // ---- Fact-path token grounding (slow-path equivalent of `labelMatchesQuote`):
    // when the LLM picked a `fact_path`, its leaf tokens must lexically anchor in either
    // the claim text, the answering question text, or the inferred metric topic. This is
    // what stops the LLM from attributing a bare "$215B" to `market.tam` purely because
    // the number was in range — without context the model has no way to know what metric
    // the speaker meant, and the safest behavior is to drop the flag rather than
    // hallucinate the metric.
    if (factPath && !factPathLexicallyMatchesClaim(factPath, grounded.matched, ctx)) continue;

    // ---- Claim quote grounding: if the LLM cites a `claim_quote`, verify it's actually a
    // substring of one of the candidate claims we sent.
    const rawClaimQuote = cw.claim_quote == null ? null : String(cw.claim_quote);
    if (rawClaimQuote && !findVerbatimSpan(claimQuotesText, rawClaimQuote)) continue;

    // Require *some* anchor — if everything in conflicts_with is null we have nothing to
    // disagree with, which usually means the model made up a contradiction.
    if (!factPath && !claimId && !rawClaimQuote && !cw.canonical_value) continue;

    out.push({
      quote: grounded.matched.slice(0, 1200),
      conflicts_with: {
        fact_path: factPath,
        canonical_value: cw.canonical_value == null ? null : String(cw.canonical_value),
        claim_id: claimId,
        claim_quote: rawClaimQuote,
      },
      severity: sev,
      confidence: conf,
      suggested_followup_question:
        obj.suggested_followup_question == null ? null : String(obj.suggested_followup_question).slice(0, 400),
    });
  }

  return out;
}

