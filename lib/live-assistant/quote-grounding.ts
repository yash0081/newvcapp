/**
 * Quote-grounding helpers for LLM-emitted contradiction/KPI cards.
 *
 * Every LLM that talks about a "founder said …" or "they claimed …" card runs through
 * `findVerbatimSpan` so we can reject (or rewrite) outputs whose quoted text never
 * actually appeared in the transcript. This is what stops a "founder said $1T in funding"
 * utterance from being reported as "TAM = $1T contradiction" — the LLM-supplied quote /
 * metric label is no longer trusted blindly.
 */

import { normalizeNumberFromText } from "@/lib/live-assistant/fast-crm-compare";

const MIN_FUZZY_WINDOW = 12;

function normalize(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, '"')
    .replace(/[^a-z0-9$%.,\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(s: string): Set<string> {
  return new Set(
    normalize(s)
      .split(" ")
      .map((t) => t.replace(/[^a-z0-9]/g, ""))
      .filter((t) => t.length >= 3),
  );
}

/**
 * Try to find `needle` (or a >=12-char window from it) inside `haystack`. Returns the
 * actual matched substring from the original haystack so callers can show the verbatim
 * quote rather than the LLM's paraphrase. Returns null when the needle is wholly absent
 * or so different we should drop the flag.
 */
export function findVerbatimSpan(haystack: string, needle: string): { matched: string } | null {
  if (!haystack || !needle) return null;
  const hayN = normalize(haystack);
  const needN = normalize(needle);
  if (!hayN || !needN) return null;

  // Full-string match (cheap; covers most real LLM quote returns).
  let idx = hayN.indexOf(needN);
  if (idx >= 0) {
    return { matched: extractOriginal(haystack, hayN, idx, needN.length) };
  }

  // Sliding window: try progressively shorter windows from the start of the needle so a
  // light paraphrase ("our ARR is roughly five million" vs "we're at five million ARR")
  // still anchors, but a wholly invented metric like "TAM" never aligns.
  const tokens = needN.split(" ").filter(Boolean);
  for (let take = tokens.length; take >= 3; take--) {
    for (let start = 0; start + take <= tokens.length; start++) {
      const window = tokens.slice(start, start + take).join(" ");
      if (window.length < MIN_FUZZY_WINDOW) continue;
      idx = hayN.indexOf(window);
      if (idx >= 0) {
        return { matched: extractOriginal(haystack, hayN, idx, window.length) };
      }
    }
  }

  return null;
}

function extractOriginal(haystack: string, hayN: string, normIdx: number, normLen: number): string {
  const start = Math.max(0, Math.min(haystack.length - 1, normIdx));
  const end = Math.min(haystack.length, start + Math.max(normLen, 12));
  return haystack.slice(start, end).trim() || haystack.slice(0, Math.min(haystack.length, 200)).trim();
}

/**
 * Confirm the LLM's `normalizedValue` is within ~5% of a number actually parseable from
 * the quoted span. Family is currently advisory (used to widen tolerance for percentages).
 * Returns true when there is no number in the span (we can't disprove) so callers should
 * combine this with `findVerbatimSpan` for a real grounding gate.
 */
export function assertGroundedNumber(quote: string, normalizedValue: number, family: string): boolean {
  if (!Number.isFinite(normalizedValue)) return false;
  const parsed = normalizeNumberFromText(quote);
  if (!parsed) return true;
  const tolerance = family === "growth" || family === "churn" ? 0.1 : 0.05;
  if (parsed.value === 0) return Math.abs(normalizedValue) <= 1;
  const ratio = Math.abs(parsed.value - normalizedValue) / Math.abs(parsed.value);
  return ratio <= tolerance;
}

/**
 * Lexical-overlap test between an LLM-supplied label (e.g. "TAM", "ARR") and the matched
 * quote. Used to drop cards where the model invented a metric category that has no
 * lexical anchor in the actual utterance ("TAM" attributed to a "we raised $1T" sentence).
 */
export function labelMatchesQuote(label: string, quote: string): boolean {
  const lTokens = tokenSet(label);
  if (!lTokens.size) return false;
  const qTokens = tokenSet(quote);
  for (const t of lTokens) {
    if (qTokens.has(t)) return true;
    // Allow common abbrev expansions: "tam" vs "total addressable market"
    if (t === "tam" && (qTokens.has("addressable") || qTokens.has("market"))) return true;
    if (t === "arr" && (qTokens.has("annual") || qTokens.has("recurring") || qTokens.has("revenue"))) return true;
    if (t === "mrr" && (qTokens.has("monthly") || qTokens.has("recurring") || qTokens.has("revenue"))) return true;
    if (t === "cac" && (qTokens.has("acquisition") || qTokens.has("cost"))) return true;
    if (t === "ltv" && (qTokens.has("lifetime") || qTokens.has("value"))) return true;
  }
  return false;
}
