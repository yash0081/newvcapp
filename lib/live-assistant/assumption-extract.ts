import type { SupabaseClient } from "@supabase/supabase-js";
import { vertexRunWithText } from "@/lib/vertex";
import { parseJsonFromResponseOrNull, parseJsonFromResponseWithRepair } from "@/lib/gemini";
import { getLiveAssistantModel } from "@/lib/live-assistant/model-env";
import {
  stableKeyAssumption,
  upsertMeetingTrackedQuestion,
} from "@/lib/live-assistant/tracked-questions";

const MODEL = getLiveAssistantModel("fast");

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Domain nouns that, when present in a generic-looking ("section: other") claim, mean it's
 * still about something investable. Without one of these we drop the claim before paying
 * for an LLM call — that's how we stop the extractor from inventing assumptions about
 * meta-statements like "the data is reliable" that don't actually have a topic.
 */
const DOMAIN_NOUN_RE =
  /\b(customer|enterprise|partner|investor|fund|funding|raised|revenue|product|team|launch|regulator|regulation|market|tam|sam|som|growth|churn|retention|hire|hiring|engineer|sales|gtm|pricing|contract|pilot|deployment|integration)\b/i;

/**
 * Topic tokens used to anchor the extractor LLM. We pass these alongside each claim so the
 * model has to surface assumptions that share at least one with the claim — and we re-check
 * the same constraint in TS after parsing. This is how "the source of information is
 * reliable and provides consistent data" gets dropped: it shares no topic token with a
 * claim about "we did $5M ARR last quarter".
 */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "have", "has", "had", "are", "was", "were", "but",
  "from", "into", "about", "they", "them", "their", "our", "your", "you", "yours", "ours", "its",
  "what", "which", "than", "then", "also", "just", "very", "much", "many", "more", "most", "some",
  "any", "all", "we", "us", "be", "is", "of", "in", "on", "at", "to", "by", "as", "or", "if",
  "so", "do", "did", "does", "done", "been", "will", "would", "could", "should", "can", "got",
  "yes", "no", "not", "out", "up", "down", "off", "now",
]);

function topicTokens(text: string, max = 6): string[] {
  const tokens = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
  if (!tokens.length) return [];
  // Bias toward the more distinctive tokens by frequency-counting then sorting alphabetically
  // (deterministic): take the first N unique tokens, preserving original-text order so the
  // most subject-y ones (typically appearing earliest in the claim) come first.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    unique.push(t);
    if (unique.length >= max) break;
  }
  return unique;
}

function shareToken(haystack: string, claimTokens: string[]): boolean {
  if (!claimTokens.length) return false;
  const lower = haystack.toLowerCase();
  for (const t of claimTokens) {
    if (lower.includes(t)) return true;
  }
  return false;
}

/**
 * Pick the first non-"other" section label, falling back to "other" if every label is "other"
 * or the array is empty. Today the extractor was indexing `section_labels[0]` literally,
 * which always picked "other" for claims classified as the catch-all.
 */
function preferredSection(sectionLabels: readonly string[] | null | undefined): string {
  const labels = (sectionLabels ?? []).map((s) => String(s));
  for (const s of labels) {
    if (s && s !== "other") return s;
  }
  return labels[0] || "other";
}

export async function runMeetingAssumptionExtract(admin: SupabaseClient, meetingId: string): Promise<void> {
  const { data: st } = await admin
    .schema("deal_intel")
    .from("meeting_question_engine_state")
    .select("last_assumption_run_at")
    .eq("meeting_id", meetingId)
    .maybeSingle();
  const lastMs = st?.last_assumption_run_at ? new Date(String(st.last_assumption_run_at)).getTime() : 0;
  if (lastMs && Date.now() - lastMs < 55_000) return;

  const watermark = new Date(Math.max(0, lastMs - 120_000)).toISOString();

  // Tighter SQL pull: only investable claims with substantive text and >= medium classifier
  // confidence. We also drop pure-`opinion` intent rows because investors rarely push back
  // on "we believe" / "we think" with assumption-inversion questions.
  const claimsRes = await admin
    .schema("deal_intel")
    .from("meeting_claim")
    .select("id, text, section_labels, confidence, raw_classifier_output, updated_at")
    .eq("meeting_id", meetingId)
    .is("superseded_by_claim_id", null)
    .gte("updated_at", watermark)
    .gte("confidence", 0.55)
    .order("updated_at", { ascending: false })
    .limit(40);

  if (claimsRes.error) {
    if (!String(claimsRes.error.message || "").includes("does not exist")) {
      console.error("runMeetingAssumptionExtract claims", claimsRes.error);
    }
    return;
  }

  type RawClaim = {
    id: string;
    text: string;
    section_labels: string[] | null;
    raw_classifier_output: { intent?: string } | null;
  };
  const rawClaims = (claimsRes.data ?? []) as RawClaim[];

  // Second-pass TypeScript filter for things SQL can't easily express: text length, intent,
  // and the "section is `other` AND no domain noun in text" guard.
  const claims = rawClaims
    .map((c) => ({
      id: c.id,
      text: String(c.text || ""),
      section_labels: Array.isArray(c.section_labels) ? c.section_labels : [],
      intent: typeof c.raw_classifier_output?.intent === "string" ? c.raw_classifier_output.intent : "claim",
    }))
    .filter((c) => {
      if (c.text.trim().length < 60) return false;
      if (c.intent === "opinion") return false;
      const primary = (c.section_labels[0] ?? "other") as string;
      if (primary === "other" && !DOMAIN_NOUN_RE.test(c.text)) return false;
      return true;
    });

  if (!claims.length) {
    await admin
      .schema("deal_intel")
      .from("meeting_question_engine_state")
      .upsert(
        { meeting_id: meetingId, last_assumption_run_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        { onConflict: "meeting_id" },
      );
    return;
  }

  // Compute topic tokens up front so we can pass them to the LLM AND re-validate the model
  // output against the same set after parsing.
  const claimTopics = new Map<string, string[]>();
  for (const c of claims) claimTopics.set(c.id, topicTokens(c.text));

  const payload = claims.map((c) => ({
    claim_id: c.id,
    text: c.text.slice(0, 500),
    sections: c.section_labels.slice(0, 6),
    topic_tokens: claimTopics.get(c.id) ?? [],
  }));

  // We only want LOAD-BEARING assumptions: ones a sharp investor would actually push on.
  // The token-overlap rule is what stops the model from emitting "the source of information
  // is reliable and provides consistent data" when the claim was about ARR or hiring or TAM.
  const prompt = `For each claim, surface AT MOST 1 implicit assumption that the company's plan
genuinely depends on. Skip every assumption that is generic, untestable, or that
no realistic investor would actually ask about.

Return JSON only:
{ "assumptions": [
  {
    "claim_id": "uuid",
    "assumption_text": "<= 200 chars: the load-bearing assumption",
    "dependency_type": "market|team|product|customer|financial|regulatory|other",
    "materiality": 0.0,         // would the deal thesis change if this is wrong? (0 = no, 1 = yes)
    "plausibility": 0.0,        // realistic probability this could actually be wrong (0 = always true, 1 = a coin flip)
    "failure_mode": "<= 160 chars: concrete thing that breaks first if it is wrong",
    "confidence": 0.0
  }
]}

Hard rules (each MUST hold or skip the assumption):
- materiality >= 0.7  (must move the investment thesis)
- plausibility >= 0.4 (must be a non-trivial real-world risk)
- failure_mode must name a SPECIFIC thing that breaks first
  (revenue, hiring funnel, regulatory approval, etc.) - no platitudes.
- assumption_text MUST mention at least one of the claim's "topic_tokens"
  (or a near synonym). If you cannot find a load-bearing assumption that
  references the actual topic of the claim, return nothing for that claim.
- Skip "what if you can't hire engineers at all", "what if customers stop buying",
  "what if the data isn't reliable", "what if the source is wrong", or any other
  doomsday / meta-statement phrasing unless materiality and plausibility BOTH >= 0.7
  AND it ties to a specific topic_token.
- One assumption per claim, max. Prefer 0.

Claims:
${JSON.stringify(payload).slice(0, 12000)}`;

  let raw: string;
  try {
    raw = await vertexRunWithText(MODEL, prompt, false);
  } catch (e) {
    console.error("assumption extract LLM", e);
    return;
  }

  const parsed = (parseJsonFromResponseOrNull(raw) ?? (await parseJsonFromResponseWithRepair(raw))) as {
    assumptions?: unknown;
  };
  const arr = Array.isArray(parsed?.assumptions) ? parsed.assumptions : [];

  type CandidateAssumption = {
    claimId: string;
    assumptionText: string;
    dependencyType: string;
    materiality: number;
    plausibility: number;
    failureMode: string;
    confidence: number;
    priority: number;
  };

  // Belt + suspenders: even if the model returns multiple per claim or sneaks past the
  // hard rules, drop them here and keep only the strongest candidate per claim.
  const bestByClaim = new Map<string, CandidateAssumption>();
  for (const item of arr) {
    const r = (item && typeof item === "object" ? (item as Record<string, unknown>) : {}) as Record<string, unknown>;
    const claimId = String(r.claim_id ?? "");
    const assumptionText = String(r.assumption_text ?? "").trim().slice(0, 600);
    const dependencyType = String(r.dependency_type ?? "other").slice(0, 64);
    const materiality = clamp01(typeof r.materiality === "number" ? r.materiality : 0);
    const plausibility = clamp01(typeof r.plausibility === "number" ? r.plausibility : 0);
    const failureMode = String(r.failure_mode ?? "").trim().slice(0, 240);
    const confidence = clamp01(typeof r.confidence === "number" ? r.confidence : 0.55);
    if (!claimId || !assumptionText) continue;
    if (materiality < 0.7) continue;
    if (plausibility < 0.4) continue;
    if (confidence < 0.55) continue;
    if (!failureMode) continue;

    // Topic-token gate: the LLM's assumption_text must share at least one token with the
    // claim's topic_tokens. This is what kills generic "the data is reliable" platitudes
    // attached to unrelated claims.
    const topics = claimTopics.get(claimId) ?? [];
    if (!shareToken(assumptionText, topics) && !shareToken(failureMode, topics)) continue;

    const priority = materiality * plausibility;
    const prev = bestByClaim.get(claimId);
    if (!prev || priority > prev.priority) {
      bestByClaim.set(claimId, {
        claimId,
        assumptionText,
        dependencyType,
        materiality,
        plausibility,
        failureMode,
        confidence,
        priority,
      });
    }
  }

  for (const a of bestByClaim.values()) {
    const stableKey = stableKeyAssumption(a.claimId, a.assumptionText);
    await admin.schema("deal_intel").from("meeting_claim_assumption").upsert(
      {
        meeting_id: meetingId,
        claim_id: a.claimId,
        assumption_text: a.assumptionText,
        dependency_type: a.dependencyType,
        confidence: a.confidence,
        stable_key: stableKey,
      },
      { onConflict: "claim_id,stable_key" },
    );

    const claimRow = claims.find((c) => c.id === a.claimId);
    const section = preferredSection(claimRow?.section_labels ?? null);
    // The candidate already required a non-empty failure_mode, so this template always runs.
    // The deterministic fallback was removed because the only path that produced the literal
    // "What breaks if this assumption is false: '...'? (section: other)" template was the
    // generic case where the extractor had no real failure mode to report — now those rows
    // are filtered out upstream.
    const qText = `If "${a.assumptionText}" turns out to be wrong, ${a.failureMode} - how have you stress-tested this?`.slice(0, 1200);
    const dedupeKey = `inv:${stableKey}`;
    await upsertMeetingTrackedQuestion(admin, {
      meetingId,
      text: qText,
      section,
      // Anchor importance on materiality (does it move the thesis?) rather than the
      // extractor's confidence in itself.
      importanceWeight: 0.5 + 0.4 * a.materiality + 0.1 * a.plausibility,
      state: "unanswered",
      provenance: "assumption_inversion",
      venue: "in_meeting",
      dedupeKey,
      metadata: {
        assumption_stable_key: stableKey,
        claim_id: a.claimId,
        dependency_type: a.dependencyType,
        materiality: a.materiality,
        plausibility: a.plausibility,
        failure_mode: a.failureMode,
        extractor_confidence: a.confidence,
      },
      syncEvent: { title: "Assumption check", lane: "memo", severity: "low" },
    });
  }

  await admin
    .schema("deal_intel")
    .from("meeting_question_engine_state")
    .upsert(
      { meeting_id: meetingId, last_assumption_run_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { onConflict: "meeting_id" },
    );
}
