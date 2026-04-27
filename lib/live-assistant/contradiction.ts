import { vertexRunWithText } from "@/lib/vertex";
import { parseJsonFromResponseOrNull, parseJsonFromResponseWithRepair } from "@/lib/gemini";
import type { ClaimHit } from "@/lib/live-assistant/tools";

const BIG_MODEL =
  process.env.GEMINI_MODEL_FLASH?.trim() ||
  process.env.GEMINI_MODEL_FLASH_LITE?.trim() ||
  "gemini-2.5-flash";

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
 */
export async function verifyContradictions(opts: {
  new_quote: string;
  canonical_facts: Array<{ fact_path: string; canonical_value_text: string | null }>;
  candidate_claims: ClaimHit[];
}): Promise<ContradictionFlag[]> {
  const newQuote = String(opts.new_quote || "").trim().slice(0, 1200);
  if (!newQuote) return [];

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

  const prompt = `You are a meeting assistant that flags contradictions conservatively.\n\nTask:\n- Compare the NEW transcript quote against the canonical facts and prior claims.\n- Return contradiction flags ONLY when you believe there is a real mismatch.\n- Prefer precision over recall.\n\nOutput ONLY valid JSON (no markdown) with this shape:\n{\n  \"flags\": [\n    {\n      \"quote\": string,\n      \"conflicts_with\": {\n        \"fact_path\"?: string|null,\n        \"canonical_value\"?: string|null,\n        \"claim_id\"?: string|null,\n        \"claim_quote\"?: string|null\n      },\n      \"severity\": \"low\"|\"med\"|\"high\",\n      \"confidence\": number,\n      \"suggested_followup_question\"?: string|null\n    }\n  ]\n}\n\nRules:\n- If the NEW quote is vague, do not flag.\n- If multiple candidates are related but not clearly conflicting, do not flag.\n- Only flag if confidence >= ${MIN_CONTRADICTION_CONFIDENCE}.\n\nNEW quote:\n${newQuote}\n\nCanonical facts:\n${JSON.stringify(facts, null, 2)}\n\nCandidate prior claims:\n${JSON.stringify(claims, null, 2)}`;

  const text = await vertexRunWithText(BIG_MODEL, prompt, false);
  const parsed = (parseJsonFromResponseOrNull(text) ?? (await parseJsonFromResponseWithRepair(text))) as {
    flags?: unknown;
  };

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
    out.push({
      quote: String(obj.quote ?? newQuote).slice(0, 1200),
      conflicts_with: {
        fact_path: cw.fact_path == null ? null : String(cw.fact_path),
        canonical_value: cw.canonical_value == null ? null : String(cw.canonical_value),
        claim_id: cw.claim_id == null ? null : String(cw.claim_id),
        claim_quote: cw.claim_quote == null ? null : String(cw.claim_quote),
      },
      severity: sev,
      confidence: conf,
      suggested_followup_question:
        obj.suggested_followup_question == null ? null : String(obj.suggested_followup_question).slice(0, 400),
    });
  }

  return out;
}

